import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { Hono } from 'hono';
import { RequestError } from '@inui/feature-kit/server';
import { createTaskRoutes, readTaskSources, TaskStore } from '../src/server.ts';
import type { TaskSources } from '../src/server.ts';

const GITHUB_TOKEN = 'ghp_' + 'x'.repeat(36);
const SECRET_BODY = 'test-only-upstream-secret-body';

function issue(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id, number: id, title: `Issue ${id}`, state: 'open',
    html_url: `https://github.com/example/inui/issues/${id}`,
    repository_url: 'https://api.github.com/repos/example/inui',
    updated_at: `2026-11-1${id % 10}T00:00:00Z`, ...overrides,
  };
}
function pull(id: number) {
  return issue(id, { html_url: `https://github.com/example/inui/pull/${id}`, pull_request: { url: 'x' } });
}

/** 連携先への要求を記録し、URLごとに用意した応答を返す。実際の通信はしない。 */
function fakeFetch(handler: (url: URL, init?: RequestInit) => Response | Promise<Response>) {
  const calls: { url: URL; init?: RequestInit }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, ...(init ? { init } : {}) });
    return handler(url, init);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function app(t: TestContext, sources: TaskSources, fetchImpl?: typeof fetch, timeoutMs?: number) {
  const store = new TaskStore(':memory:');
  t.after(() => store.close());
  const root = new Hono();
  root.route('/api', createTaskRoutes({ store, sources,
    upstream: { ...(fetchImpl ? { fetchImpl } : {}), ...(timeoutMs ? { timeoutMs } : {}) } }));
  root.onError((error, c) => error instanceof RequestError
    ? c.json({ error: { code: error.code, message: error.message } }, error.status)
    : c.json({ error: { code: 'internal_error' } }, 500));
  return (path: string) => root.request('http://127.0.0.1' + path);
}

test('環境変数の設定がなければGitHubへ接続せず、未設定であることだけを返す（Backlogの経路は持たない）', async (t) => {
  const { fetchImpl, calls } = fakeFetch(() => Response.json({}));
  const get = app(t, readTaskSources({}), fetchImpl);
  assert.deepEqual(await (await get('/api/tasks/github')).json(), { configured: false });
  assert.equal((await get('/api/tasks/backlog')).status, 404);
  assert.equal(calls.length, 0);
});

test('設定値の形式を検証し、値そのものは保持・応答しない', async (t) => {
  assert.deepEqual(readTaskSources({ INUI_GITHUB_TOKEN: 'short' }).invalid, ['github']);
  // 以前のBacklogの設定が残っていても読まない。
  const valid = readTaskSources({ INUI_GITHUB_TOKEN: GITHUB_TOKEN, INUI_BACKLOG_SPACE: 'example.backlog.jp', INUI_BACKLOG_API_KEY: 'k'.repeat(64) });
  assert.deepEqual(valid, { github: { token: GITHUB_TOKEN }, invalid: [] });
  const { fetchImpl, calls } = fakeFetch(() => Response.json({}));
  const response = await app(t, readTaskSources({ INUI_GITHUB_TOKEN: 'short-secret' }), fetchImpl)('/api/tasks/github');
  assert.equal(response.status, 503);
  const text = await response.text();
  assert.equal(JSON.parse(text).error.code, 'invalid_config');
  assert.equal(text.includes('short-secret'), false);
  assert.equal(calls.length, 0);
});

test('GitHubは自分に関係する未完了のIssue・PRを3条件で検索し、重複をまとめる', async (t) => {
  const { fetchImpl, calls } = fakeFetch((url) => {
    const query = url.searchParams.get('q') ?? '';
    if (query.includes('assignee:@me')) return Response.json({ items: [issue(1), issue(2)] });
    if (query.includes('author:@me')) return Response.json({ items: [pull(3)] });
    return Response.json({ items: [pull(3), pull(4)] });
  });
  const response = await app(t, { github: { token: GITHUB_TOKEN }, invalid: [] }, fetchImpl)('/api/tasks/github');
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.configured, true);
  assert.deepEqual(body.tasks.map((task: { key: string }) => task.key),
    ['example/inui#4', 'example/inui#3', 'example/inui#2', 'example/inui#1']);
  const three = body.tasks.find((task: { key: string }) => task.key === 'example/inui#3');
  assert.equal(three.kind, 'pull_request');
  assert.deepEqual(three.reasons, ['authored', 'review_requested']);
  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.equal(call.url.origin + call.url.pathname, 'https://api.github.com/search/issues');
    assert.match(call.url.searchParams.get('q') ?? '', /^is:open /);
    assert.equal(call.init?.method, 'GET');
    assert.equal(call.init?.redirect, 'error');
    assert.equal((call.init?.headers as Record<string, string>).Authorization, `Bearer ${GITHUB_TOKEN}`);
  }
});

test('連携先の失敗は固定コードへ置き換え、本文や例外を返さない', async (t) => {
  const cases: [() => Response | Promise<Response>, number, string][] = [
    [() => new Response(SECRET_BODY, { status: 401 }), 502, 'upstream_auth'],
    [() => new Response(SECRET_BODY, { status: 500 }), 502, 'upstream_unavailable'],
    [() => { throw new Error(SECRET_BODY); }, 502, 'upstream_unavailable'],
    [() => new Response(SECRET_BODY, { status: 200 }), 502, 'upstream_invalid'],
    [() => Response.json({ items: [issue(1, { html_url: 'https://evil.example/' + SECRET_BODY })] }), 502, 'upstream_invalid'],
    [() => Response.json({ items: [issue(1, { title: 'line\u0000break' })] }), 502, 'upstream_invalid'],
  ];
  for (const [handler, status, code] of cases) {
    const { fetchImpl } = fakeFetch(handler);
    const response = await app(t, { github: { token: GITHUB_TOKEN }, invalid: [] }, fetchImpl)('/api/tasks/github');
    assert.equal(response.status, status);
    const text = await response.text();
    assert.equal(JSON.parse(text).error.code, code);
    assert.equal(text.includes(SECRET_BODY), false);
  }
});

test('連携先が応答しない場合は期限で打ち切る', async (t) => {
  const { fetchImpl } = fakeFetch((_url, init) => new Promise((_, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
  }));
  const response = await app(t, { github: { token: GITHUB_TOKEN }, invalid: [] }, fetchImpl, 20)('/api/tasks/github');
  assert.equal(response.status, 504);
  assert.equal((await response.json()).error.code, 'upstream_timeout');
});
