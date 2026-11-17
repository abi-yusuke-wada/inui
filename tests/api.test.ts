import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { DecisionError } from '@inui/core';
import { TaskStore } from '@inui/feature-tasks/server';
import { BoardStore } from '@inui/feature-whiteboard/server';
import { createApp } from '../src/api.ts';
import { createLogger } from '../src/logger.ts';

const ORIGIN = 'http://127.0.0.1:8766';
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const JSON_HEADERS = { Origin: ORIGIN, 'Content-Type': 'application/json' };

/** 実際のJSON出力を捕捉し、ログへ渡してよい情報だけか確認する。 */
function captureLogger() {
  const records: Record<string, unknown>[] = [];
  const logger = createLogger({ level: 'debug', now: () => new Date('2026-11-11T00:00:00Z'),
    write: (line) => { records.push(JSON.parse(line) as Record<string, unknown>); },
  });
  return { logger, records };
}
function memoryStore(t: TestContext) {
  const store = new TaskStore(':memory:');
  t.after(() => store.close());
  return store;
}
function memoryBoards(t: TestContext) {
  const boards = new BoardStore(':memory:');
  t.after(() => boards.close());
  return boards;
}
function harness(t: TestContext, routeIntent: (text: string) => Promise<unknown> = async () => (
  { kind: 'screen', intent: 'task_board', ui: 'task_board' }
)) {
  const store = memoryStore(t);
  const app = createApp({ taskStore: store, boardStore: memoryBoards(t), routeIntent });
  const send = (method: string, path: string, body?: unknown) => app.request(ORIGIN + path, {
    method, headers: JSON_HEADERS, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return {
    store, app,
    get: (path: string) => app.request(ORIGIN + path),
    post: (path: string, body: unknown) => send('POST', path, body),
    patch: (path: string, body: unknown) => send('PATCH', path, body),
    remove: (path: string) => send('DELETE', path),
  };
}

test('Intentでタスク画面を開くだけでは保存せず、明示した追加・完了・削除だけを保存する', async (t) => {
  let input = '';
  const h = harness(t, async (text) => { input = text; return { kind: 'screen', intent: 'task_board', ui: 'task_board' }; });
  const opened = await h.post('/api/intent', { text: ' やることをメモしておきたい ' });
  assert.equal(opened.status, 200);
  assert.deepEqual(await opened.json(), { kind: 'screen', intent: 'task_board', ui: 'task_board' });
  assert.equal(input, 'やることをメモしておきたい');
  assert.equal(h.store.list().length, 0);
  const created = await h.post('/api/tasks/local', { title: '  ADRの下書きを書く  ' });
  assert.equal(created.status, 201);
  const { task } = await created.json();
  assert.equal(task.title, 'ADRの下書きを書く');
  assert.equal(task.done, false);
  assert.deepEqual((await (await h.get('/api/tasks/local')).json()).tasks, [task]);
  const doing = await h.patch('/api/tasks/local/' + task.id, { status: 'doing' });
  assert.equal(doing.status, 200);
  assert.deepEqual([(await doing.json()).task.status, h.store.list()[0]?.done], ['doing', false]);
  const completed = await h.patch('/api/tasks/local/' + task.id, { done: true });
  assert.equal(completed.status, 200);
  assert.deepEqual([(await completed.json()).task.status, h.store.list()[0]?.status], ['done', 'done']);
  assert.equal((await h.remove('/api/tasks/local/' + task.id)).status, 200);
  assert.equal(h.store.list().length, 0);
  assert.equal((await h.remove('/api/tasks/local/' + task.id)).status, 404);
});

test('タスクの件名・完了状態・ID・余分キーを検証し、不正な入力を保存しない', async (t) => {
  const h = harness(t);
  for (const body of [{ title: '' }, { title: ' '.repeat(3) }, { title: 'a'.repeat(201) }, { title: 42 },
    { title: '件名', done: true }, { title: '件名', tool: 'delete_all' }, [], null]) {
    assert.equal((await h.post('/api/tasks/local', body)).status, 400);
  }
  assert.equal(h.store.list().length, 0);
  const { task } = await (await h.post('/api/tasks/local', { title: 'a'.repeat(200) })).json();
  for (const body of [{ done: 'true' }, { done: 1 }, { done: true, title: '変更' }, {}, { status: 'backlog' },
    { status: 'closed' }, { status: 'done', done: true }, { status: ['done'] }]) {
    assert.equal((await h.patch('/api/tasks/local/' + task.id, body)).status, 400);
  }
  assert.equal((await h.patch('/api/tasks/local/not-a-uuid', { done: true })).status, 400);
  assert.equal((await h.patch('/api/tasks/local/00000000-0000-4000-8000-000000000000', { done: true })).status, 404);
  assert.equal((await h.get('/api/tasks/local?status=done')).status, 400);
  assert.equal(h.store.list()[0]?.done, false);
  for (const text of ['', ' '.repeat(4), 'a'.repeat(2001), 42]) {
    assert.equal((await h.post('/api/intent', { text })).status, 400);
  }
  assert.equal((await h.post('/api/intent', { text: 'タスク', ui: 'task_board' })).status, 400);
});

test('未許可のIntent・UI・Toolや削除した申請画面を拒否して保存しない', async (t) => {
  for (const decision of [
    { kind: 'screen', intent: 'task_board', ui: 'markdown_view' },
    { kind: 'screen', intent: 'delete_all', ui: 'delete_all' },
    { kind: 'screen', intent: 'leave_request', ui: 'leave_request' },
    { kind: 'screen', intent: 'task_board', ui: 'task_board', tool: 'save' },
    { kind: 'notice', intent: 'other', message: '任意' },
  ]) {
    const h = harness(t, async () => decision);
    assert.equal((await h.post('/api/intent', { text: '自分のタスクを確認したい' })).status, 502);
    assert.equal(h.store.list().length, 0);
  }
  const h = harness(t);
  for (const path of ['/api/applications', '/api/applications/leave']) {
    assert.equal((await h.get(path)).status, 404);
  }
});

test('推論の失敗を400/502/503/504へ分け、生の例外を表示しない', async (t) => {
  for (const [code, expected] of [
    ['invalid_input', 400], ['invalid_response', 502], ['unavailable', 503], ['timeout', 504],
  ] as const) {
    const h = harness(t, async () => { throw new DecisionError(code); });
    const response = await h.post('/api/intent', { text: 'タスク' });
    assert.equal(response.status, expected);
    assert.equal((await response.json()).error.code, code);
  }
  const h = harness(t, async () => { throw new Error('secret-token-value'); });
  const response = await h.post('/api/intent', { text: 'タスク' });
  assert.equal(response.status, 503);
  assert.ok(!(await response.text()).includes('secret-token-value'));
});

test('初回失敗と再試行成功を要求ID・状態・時間で追跡し、入力や例外をログへ含めない', async (t) => {
  const store = memoryStore(t);
  const { logger, records } = captureLogger();
  const requestIds: string[] = [];
  let calls = 0;
  const app = createApp({ taskStore: store, boardStore: memoryBoards(t), logger, routeIntent: async () => {
    calls++;
    if (calls === 1) throw new DecisionError('timeout');
    if (calls === 2) throw new Error('test-only-private-exception');
    return { kind: 'screen', intent: 'schedule_compare', ui: 'schedule_compare' };
  } });
  for (const status of [504, 503, 200, 400]) {
    const response = await app.request(ORIGIN + '/api/intent', {
      method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: status === 400 ? '' : 'test-only-private-input' }),
    });
    assert.equal(response.status, status);
    const requestId = response.headers.get('X-Request-Id') ?? '';
    assert.match(requestId, REQUEST_ID);
    requestIds.push(requestId);
  }
  assert.equal(calls, 3);
  assert.equal(records.length, 4);
  assert.equal(new Set(requestIds).size, 4);
  for (const [index, record] of records.entries()) {
    const keys = ['elapsed_ms', 'event', 'http_status', 'level', 'message', 'method', 'request_id', 'route', 'timestamp'];
    if (index !== 2) keys.push('error_code');
    assert.deepEqual(Object.keys(record).sort(), keys.sort());
    assert.equal(record.timestamp, '2026-11-11T00:00:00.000Z');
    assert.equal(record.event, 'intent_request');
    assert.equal(record.request_id, requestIds[index]);
    assert.equal(record.method, 'POST');
    assert.equal(record.route, '/api/intent');
    assert.equal(record.http_status, [504, 503, 200, 400][index]);
    assert.equal(record.level, ['error', 'error', 'info', 'warn'][index]);
    assert.equal(record.error_code, ['timeout', 'unavailable', undefined, 'invalid_input'][index]);
    assert.equal(typeof record.message, 'string');
    assert.equal(typeof record.elapsed_ms, 'number');
    assert.ok(Number.isSafeInteger(record.elapsed_ms) && (record.elapsed_ms as number) >= 0);
  }
  assert.equal(JSON.stringify(records).includes('test-only-private'), false);
  assert.equal((await app.request(ORIGIN + '/api/employees')).status, 200);
  assert.equal(records.length, 5);
  assert.equal(records[4]?.event, 'http_request');
  assert.equal(store.list().length, 0);
});

test('ログ出力の失敗でIntentの成功応答を失敗に変更しない', async (t) => {
  const app = createApp({ taskStore: memoryStore(t), boardStore: memoryBoards(t),
    routeIntent: async () => ({ kind: 'screen', intent: 'markdown_view', ui: 'markdown_view' }),
    logger: createLogger({ write: () => { throw new Error('test-only-diagnostic-failure'); } }),
  });
  const response = await app.request(ORIGIN + '/api/intent', {
    method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'READMEを読みたい' }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { kind: 'screen', intent: 'markdown_view', ui: 'markdown_view' });
});

test('APIと静的配信の完了を区別し、URL・ヘッダー・タスクの内容をログへ出さない', async (t) => {
  const store = memoryStore(t);
  const { logger, records } = captureLogger();
  const app = createApp({ taskStore: store, boardStore: memoryBoards(t), logger });
  app.get('/', (c) => c.text('テスト用画面'));
  const privateDetail = 'test-only-private-request-data';
  const requests = [
    { path: '/api/tasks/local', status: 200, level: 'info', route: '/api/tasks/local', code: undefined },
    { path: '/api/tasks/github', status: 200, level: 'info', route: '/api/tasks/github', code: undefined },
    { path: '/api/schedules?date=2026-11-03&personIds=person-yamada-taro,person-sato-hanako', status: 200, level: 'info', route: '/api/schedules', code: undefined },
    { path: '/api/employees?private=' + privateDetail, status: 400, level: 'warn', route: '/api/employees', code: 'invalid_input' },
    { path: '/' + privateDetail, status: 404, level: 'warn', route: 'other', code: 'not_found' },
    { path: '/api/employees', status: 403, level: 'warn', route: '/api/employees', code: 'invalid_host', host: privateDetail + '.example:8766' },
    { path: '/api/employees', status: 200, level: 'info', route: '/api/employees', code: undefined },
    { path: '/', status: 200, level: 'debug', route: '/', code: undefined },
  ];
  for (const [index, request] of requests.entries()) {
    const response = await app.request(ORIGIN + request.path, {
      headers: { 'X-Request-Id': privateDetail, Authorization: 'Bearer ' + privateDetail,
        ...(request.host ? { Host: request.host } : {}) },
    });
    assert.equal(response.status, request.status);
    const requestId = response.headers.get('X-Request-Id') ?? '';
    assert.match(requestId, REQUEST_ID);
    assert.notEqual(requestId, privateDetail);
    const record = records[index];
    assert.ok(record);
    assert.equal(record.request_id, requestId);
    assert.equal(record.event, 'http_request');
    assert.equal(record.method, 'GET');
    assert.equal(record.route, request.route);
    assert.equal(record.level, request.level);
    assert.equal(record.http_status, request.status);
    assert.equal(record.error_code, request.code);
  }
  const saved = await app.request(ORIGIN + '/api/tasks/local', {
    method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ title: privateDetail }),
  });
  assert.equal(saved.status, 201);
  assert.equal(records.at(-1)?.route, '/api/tasks/local');
  assert.equal(records.at(-1)?.level, 'info');
  const { task } = await saved.json();
  const updated = await app.request(ORIGIN + '/api/tasks/local/' + task.id, {
    method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify({ done: true }),
  });
  assert.equal(updated.status, 200);
  // タスクIDは経路名へ残さない。
  assert.equal(records.at(-1)?.route, '/api/tasks/local/:id');
  assert.equal(records.at(-1)?.method, 'PATCH');
  assert.equal(JSON.stringify(records).includes(task.id), false);
  assert.equal(store.list().length, 1);
  assert.equal(JSON.stringify(records).includes(privateDetail), false);
  assert.equal(JSON.stringify(records).includes('佐藤花子'), false);
  assert.equal(JSON.stringify(records).includes('Authorization'), false);
});

test('loopback Host・同一Origin・JSON・本文上限を強制し、CORSを許可しない', async (t) => {
  const h = harness(t);
  for (const base of ['http://127.0.0.1:3000', 'http://localhost:3000', 'http://external.example:8766']) {
    assert.equal((await h.app.request(base + '/api/employees')).status, 403);
  }
  assert.equal((await h.app.request(ORIGIN + '/api/employees', { headers: { Host: 'external.example:8766' } })).status, 403);
  // 外部サイトのフレームに埋め込ませない。
  const framed = await h.app.request(ORIGIN + '/api/employees');
  assert.equal(framed.headers.get('Content-Security-Policy'), "frame-ancestors 'none'");
  assert.equal(framed.headers.get('X-Frame-Options'), 'DENY');
  for (const origin of [undefined, 'null', 'http://external.example', 'http://localhost:8766', 'http://127.0.0.1:3000']) {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (origin !== undefined) headers.Origin = origin;
    for (const method of ['POST', 'PATCH', 'DELETE']) {
      const response = await h.app.request(ORIGIN + '/api/tasks/local' + (method === 'POST' ? '' : '/00000000-0000-4000-8000-000000000000'),
        { method, headers, body: method === 'DELETE' ? null : JSON.stringify(method === 'POST' ? { title: '件名' } : { done: true }) });
      assert.equal(response.status, 403);
      assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
    }
  }
  assert.equal((await h.app.request(ORIGIN + '/api/intent', { method: 'POST', headers: { Origin: ORIGIN }, body: '{}' })).status, 415);
  assert.equal((await h.app.request(ORIGIN + '/api/intent', { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body: '{' })).status, 400);
  assert.equal((await h.post('/api/intent', { text: 'a'.repeat(17000) })).status, 413);
  assert.equal((await h.post('/api/tasks/local', { title: 'a'.repeat(17000) })).status, 413);
  assert.equal(h.store.list().length, 0);
});

test('ポートを変更しても選択したloopback Hostと同一Originだけを許可する', async (t) => {
  const store = memoryStore(t);
  const app = createApp({ taskStore: store, boardStore: memoryBoards(t), port: 18766,
    routeIntent: async () => ({ kind: 'screen', intent: 'task_board', ui: 'task_board' }) });
  const origin = 'http://127.0.0.1:18766';
  for (const base of [origin, 'http://localhost:18766']) {
    assert.equal((await app.request(base + '/api/employees')).status, 200);
    assert.equal((await app.request(base + '/api/intent', {
      method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '自分のタスクを確認したい' }),
    })).status, 200);
  }
  for (const base of [ORIGIN, 'http://localhost:8766', 'http://external.example:18766', 'https://127.0.0.1:18766']) {
    assert.equal((await app.request(base + '/api/employees')).status, 403);
  }
  assert.equal((await app.request(origin + '/api/employees', { headers: { Host: '127.0.0.1:8766' } })).status, 403);
  for (const crossOrigin of [ORIGIN, 'http://localhost:18766', 'http://external.example:18766']) {
    const response = await app.request(origin + '/api/intent', {
      method: 'POST', headers: { Origin: crossOrigin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '自分のタスクを確認したい' }),
    });
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
  }
  assert.equal(store.list().length, 0);
});

test('予定比較の人名は選択・曖昧・未知に分け、日付や対象を自動補完しない', async (t) => {
  const h = harness(t, async () => ({ kind: 'screen', intent: 'schedule_compare', ui: 'schedule_compare' }));
  const response = await h.post('/api/intent', { text: '明日の山田さんと佐藤花子と田中さんの予定を確認したい' });
  const decision = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(decision.people.selectedIds, ['person-sato-hanako']);
  assert.equal(decision.people.ambiguous[0].name, '山田');
  assert.deepEqual(decision.people.unknownNames, ['田中']);
  assert.equal(decision.date, undefined);
  assert.equal((await (await h.get('/api/employees')).json()).employees.length, 4);
  const empty = await (await h.get('/api/schedules')).json();
  assert.equal(empty.date, '2026-11-02');
  assert.deepEqual(empty.employees, []);
  assert.deepEqual(empty.events, []);
  const schedules = await (await h.get('/api/schedules?date=2026-11-03&personIds=person-yamada-taro,person-sato-hanako')).json();
  assert.equal(schedules.employees.length, 2);
  assert.ok(schedules.events.every((event: { personId: string }) => ['person-yamada-taro', 'person-sato-hanako'].includes(event.personId)));
  for (const query of ['date=2026-02-29', 'personIds=unknown', 'personIds=person-yamada-taro,person-yamada-taro', 'date=2026-11-02&date=2026-11-03', 'tool=delete']) {
    assert.equal((await h.get('/api/schedules?' + query)).status, 400);
  }
  // 予定比較以外の画面には人名の選択を付けない。
  const tasks = harness(t);
  assert.deepEqual(await (await tasks.post('/api/intent', { text: '山田さんのタスク' })).json(),
    { kind: 'screen', intent: 'task_board', ui: 'task_board' });
});

test('DBの例外本文をHTTP応答へ含めない', async () => {
  const store = new TaskStore(':memory:');
  const { logger, records } = captureLogger();
  const app = createApp({ taskStore: store, boardStore: new BoardStore(':memory:'), logger, routeIntent: async () => null });
  store.close();
  const response = await app.request(ORIGIN + '/api/tasks/local');
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: { code: 'internal_error', message: '処理を完了できませんでした。画面からやり直してください。' } });
  assert.equal(records.length, 1);
  assert.equal(records[0]?.level, 'error');
  assert.equal(records[0]?.error_code, 'internal_error');
  assert.equal(records[0]?.http_status, 500);
  assert.equal(records[0]?.request_id, response.headers.get('X-Request-Id'));
});
