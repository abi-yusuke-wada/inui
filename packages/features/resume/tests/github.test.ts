import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchPullRequests, UpstreamError } from '../src/github.ts';

const TOKEN = 'ghp_' + 'x'.repeat(36);
const SECRET_BODY = 'test-only-upstream-secret-body';

function pull(number: number, overrides: Record<string, unknown> = {}, owner = 'example', name = 'inui') {
  return {
    number, title: `PR ${number}`, url: `https://github.com/${owner}/${name}/pull/${number}`, headRefName: `feat/pr-${number}`,
    isDraft: false, reviewDecision: null, updatedAt: `2026-11-1${number % 10}T00:00:00Z`,
    commits: { nodes: [{ commit: { statusCheckRollup: null } }] }, ...overrides,
  };
}
const rollup = (state: string) => ({ commits: { nodes: [{ commit: { statusCheckRollup: { state } } }] } });
/** 検索の応答。issueCountは条件に合う全件数で、nodesは上限までの分。 */
const search = (nodes: unknown[], count = nodes.length) => ({ issueCount: count, nodes });

/** 要求を記録し、用意した応答を返す。実際の通信はしない。 */
function fakeFetch(handler: (init?: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), ...(init ? { init } : {}) });
    return handler(init);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

test('自分が作った未完了のPRを、リポジトリごとの検索を1回の要求にまとめて読む', async () => {
  const { fetchImpl, calls } = fakeFetch(() => Response.json({ data: {
    r0: search([
      pull(1, { reviewDecision: 'APPROVED', ...rollup('SUCCESS') }),
      pull(3, { reviewDecision: 'CHANGES_REQUESTED', ...rollup('FAILURE'), isDraft: true }),
      pull(2, { reviewDecision: 'REVIEW_REQUIRED', ...rollup('PENDING') }),
    ]),
    // 上限を超えた分は、件数だけを返す。
    r1: search([pull(4, { ...rollup('ERROR') }, 'Example', 'Notes'), pull(5, { ...rollup('EXPECTED') }, 'example', 'notes')], 7),
  } }));
  // 大文字と小文字だけが違う同じリポジトリは、1回だけ検索する。
  const pulls = await fetchPullRequests(TOKEN, [
    { owner: 'example', name: 'inui' }, { owner: 'example', name: 'notes' }, { owner: 'EXAMPLE', name: 'INUI' },
  ], { fetchImpl });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, 'https://api.github.com/graphql');
  assert.equal(calls[0]?.init?.method, 'POST');
  assert.equal(calls[0]?.init?.redirect, 'error');
  assert.equal((calls[0]?.init?.headers as Record<string, string> | undefined)?.Authorization, `Bearer ${TOKEN}`);
  const request = JSON.parse(String(calls[0]?.init?.body));
  assert.deepEqual(request.variables, {
    q0: 'repo:example/inui is:pr is:open author:@me archived:false', q1: 'repo:example/notes is:pr is:open author:@me archived:false',
  });
  // 更新の新しい順に並べ、レビューとチェックの状態を画面用の値へ置き換える。
  assert.deepEqual(pulls.get('example/inui')?.pullRequests.map((item) => [item.number, item.review, item.checks, item.draft]), [
    [3, 'changes_requested', 'failure', true], [2, 'review_required', 'pending', false], [1, 'approved', 'success', false],
  ]);
  assert.deepEqual(pulls.get('example/notes')?.pullRequests.map((item) => [item.number, item.review, item.checks]), [[5, 'none', 'pending'], [4, 'none', 'failure']]);
  assert.deepEqual([pulls.get('example/inui')?.omitted, pulls.get('example/notes')?.omitted], [0, 5]);
  assert.deepEqual(pulls.get('example/inui')?.pullRequests[0], {
    number: 3, title: 'PR 3', url: 'https://github.com/example/inui/pull/3', branch: 'feat/pr-3', draft: true,
    review: 'changes_requested', checks: 'failure', updatedAt: '2026-11-13T00:00:00Z',
  });
});

test('チェックがないPRはnone、権限不足などで一部が読めなかった場合はunknownにする', async () => {
  const repositories = [{ owner: 'example', name: 'inui' }];
  const complete = fakeFetch(() => Response.json({ data: { r0: search([pull(1)]) } }));
  assert.equal((await fetchPullRequests(TOKEN, repositories, { fetchImpl: complete.fetchImpl })).get('example/inui')?.pullRequests[0]?.checks, 'none');
  const partial = fakeFetch(() => Response.json({
    data: { r0: search([pull(1, { commits: { nodes: [{ commit: { statusCheckRollup: null } }] } })]) },
    errors: [{ type: 'FORBIDDEN', message: SECRET_BODY }],
  }));
  assert.equal((await fetchPullRequests(TOKEN, repositories, { fetchImpl: partial.fetchImpl })).get('example/inui')?.pullRequests[0]?.checks, 'unknown');
});

test('連携先の失敗や不正な応答は固定のコードへ置き換え、本文や例外を持ち込まない', async () => {
  const repositories = [{ owner: 'example', name: 'inui' }];
  const cases: [() => Response | Promise<Response>, string][] = [
    [() => new Response(SECRET_BODY, { status: 401 }), 'upstream_auth'],
    [() => new Response(SECRET_BODY, { status: 403 }), 'upstream_auth'],
    [() => new Response(SECRET_BODY, { status: 502 }), 'upstream_unavailable'],
    [() => { throw new Error(SECRET_BODY); }, 'upstream_unavailable'],
    [() => new Response(SECRET_BODY, { status: 200 }), 'upstream_invalid'],
    [() => Response.json({ data: null, errors: [{ message: SECRET_BODY }] }), 'upstream_invalid'],
    [() => Response.json({ data: { r0: { issueCount: 0, nodes: 'x' } } }), 'upstream_invalid'],
    [() => Response.json({ data: { r0: search(Array.from({ length: 21 }, (_, index) => pull(index + 1))) } }), 'upstream_invalid'],
    // 全件数がない応答・件数が矛盾する応答は受け付けない。
    [() => Response.json({ data: { r0: { nodes: [pull(1)] } } }), 'upstream_invalid'],
    [() => Response.json({ data: { r0: search([pull(1), pull(2)], 1) } }), 'upstream_invalid'],
    // 別のリポジトリ・別のサイトへのリンク、制御文字、未知の状態は受け付けない。
    [() => Response.json({ data: { r0: search([pull(1, { url: 'https://github.com/other/repo/pull/1' })]) } }), 'upstream_invalid'],
    [() => Response.json({ data: { r0: search([pull(1, { url: `https://evil.example/${SECRET_BODY}` })]) } }), 'upstream_invalid'],
    [() => Response.json({ data: { r0: search([pull(1, { title: 'line\u0000break' })]) } }), 'upstream_invalid'],
    [() => Response.json({ data: { r0: search([pull(1, { reviewDecision: 'DISMISSED' })]) } }), 'upstream_invalid'],
    [() => Response.json({ data: { r0: search([pull(1, rollup('UNKNOWN'))]) } }), 'upstream_invalid'],
  ];
  for (const [handler, code] of cases) {
    const { fetchImpl } = fakeFetch(handler);
    await assert.rejects(fetchPullRequests(TOKEN, repositories, { fetchImpl }), (error) => {
      assert.ok(error instanceof UpstreamError);
      assert.equal(error.code, code);
      assert.ok(!String(error.message).includes(SECRET_BODY));
      return true;
    });
  }
});

test('応答しない場合は期限で打ち切り、検索に余分な条件を入れられる名前では要求しない', async () => {
  const { fetchImpl } = fakeFetch((init) => new Promise((_, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
  }));
  await assert.rejects(fetchPullRequests(TOKEN, [{ owner: 'example', name: 'inui' }], { fetchImpl, timeoutMs: 20 }),
    (error) => error instanceof UpstreamError && error.code === 'upstream_timeout');
  const never = fakeFetch(() => Response.json({}));
  await assert.rejects(fetchPullRequests(TOKEN, [{ owner: 'example', name: 'inui is:issue' }], { fetchImpl: never.fetchImpl }),
    (error) => error instanceof UpstreamError && error.code === 'upstream_invalid');
  assert.deepEqual(await fetchPullRequests(TOKEN, [], { fetchImpl: never.fetchImpl }), new Map());
  assert.equal(never.calls.length, 0);
});
