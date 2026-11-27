import assert from 'node:assert/strict';
import test from 'node:test';
import { isText, isTimestamp, requestJson, UpstreamError } from '../src/upstream.ts';

const URL_ = 'https://upstream.example/api';
const SECRET_BODY = 'test-only-upstream-secret-body';

/** 要求を記録し、用意した応答を返す。実際の通信はしない。 */
function fakeFetch(handler: (init?: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), ...(init ? { init } : {}) });
    return handler(init);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

/** 中止されるまで本文を送り終えない応答。中止されたら本文の受信も失敗させる。 */
function endlessBody(init: RequestInit | undefined, status = 200): Response {
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"items":['));
      init?.signal?.addEventListener('abort', () => controller.error(new Error('aborted')));
    },
  }), { status });
}

const rejectsWith = (promise: Promise<unknown>, code: string) => assert.rejects(promise, (error) => {
  assert.ok(error instanceof UpstreamError);
  assert.equal(error.code, code);
  assert.ok(!String(error.message).includes(SECRET_BODY));
  return true;
});

test('GETとPOSTを、リダイレクトに従わず中止できる形で送り、応答のJSONを返す', async () => {
  const { fetchImpl, calls } = fakeFetch(() => Response.json({ ok: true }));
  const headers = { Authorization: 'Bearer test-only-token' };
  assert.deepEqual(await requestJson(URL_, { method: 'GET', headers }, { fetchImpl }), { ok: true });
  assert.deepEqual(await requestJson(URL_, { method: 'POST', headers, body: '{"query":"q"}' }, { fetchImpl }), { ok: true });
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.url, URL_);
    assert.equal(call.init?.redirect, 'error');
    assert.ok(call.init?.signal instanceof AbortSignal);
    assert.deepEqual(call.init?.headers, headers);
  }
  assert.equal(calls[0]?.init?.method, 'GET');
  // GETでは本文を送らない。
  assert.equal(Object.hasOwn(calls[0]?.init ?? {}, 'body'), false);
  assert.equal(calls[1]?.init?.method, 'POST');
  assert.equal(calls[1]?.init?.body, '{"query":"q"}');
});

test('失敗は固定のコードへ置き換え、本文や例外の内容を持ち込まない', async () => {
  const cases: [() => Response | Promise<Response>, string][] = [
    [() => new Response(SECRET_BODY, { status: 401 }), 'upstream_auth'],
    [() => new Response(SECRET_BODY, { status: 403 }), 'upstream_auth'],
    [() => new Response(SECRET_BODY, { status: 404 }), 'upstream_unavailable'],
    [() => new Response(SECRET_BODY, { status: 500 }), 'upstream_unavailable'],
    [() => { throw new Error(SECRET_BODY); }, 'upstream_unavailable'],
    [() => new Response(SECRET_BODY, { status: 200 }), 'upstream_invalid'],
  ];
  for (const [handler, code] of cases) {
    const { fetchImpl } = fakeFetch(handler);
    await rejectsWith(requestJson(URL_, { method: 'GET', headers: {} }, { fetchImpl }), code);
  }
});

test('成功でない応答は本文を読まずに要求を中止する', async () => {
  let signal: AbortSignal | undefined;
  const { fetchImpl } = fakeFetch((init) => {
    signal = init?.signal ?? undefined;
    return endlessBody(init, 500);
  });
  await rejectsWith(requestJson(URL_, { method: 'GET', headers: {} }, { fetchImpl, timeoutMs: 5_000 }), 'upstream_unavailable');
  assert.equal(signal?.aborted, true);
});

test('応答が始まらない場合も、本文を送り終えない場合も、期限で打ち切る', async () => {
  const silent = fakeFetch((init) => new Promise((_, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
  }));
  await rejectsWith(requestJson(URL_, { method: 'GET', headers: {} }, { fetchImpl: silent.fetchImpl, timeoutMs: 20 }), 'upstream_timeout');
  const slow = fakeFetch((init) => endlessBody(init));
  await rejectsWith(requestJson(URL_, { method: 'GET', headers: {} }, { fetchImpl: slow.fetchImpl, timeoutMs: 20 }), 'upstream_timeout');
});

test('日時はISO 8601形式で、実在するものだけを受け付ける', () => {
  for (const value of ['2026-11-27T09:30:00Z', '2026-11-27T09:30:00.123Z', '2026-11-27T18:30:00+09:00']) {
    assert.equal(isTimestamp(value), true, value);
  }
  for (const value of ['2026-13-01T00:00:00Z', '2026-11-27T25:00:00Z', '2026-11-27', '2026-11-27T09:30:00',
    `2026-11-27T09:30:00.${'1'.repeat(30)}Z`, 1_764_235_800_000, null]) {
    assert.equal(isTimestamp(value), false, String(value));
  }
});

test('表示する文字列は長さを制限し、制御文字を含むものは受け付けない', () => {
  assert.equal(isText('PR 1'), true);
  assert.equal(isText('あ'.repeat(500)), true);
  assert.equal(isText('あ'.repeat(501)), false);
  assert.equal(isText('feat/x', 6), true);
  assert.equal(isText('feat/xy', 6), false);
  for (const value of ['', 'line\u0000break', 'tab\tseparated', 'delete\u007f', 42, undefined]) {
    assert.equal(isText(value), false, String(value));
  }
});
