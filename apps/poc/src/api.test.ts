import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { DecisionError } from '@inui/core';
import { createApp } from './api.ts';
import { LocalStore } from './store.ts';

const ORIGIN = 'http://127.0.0.1:3000';
const leave = { date: '2026-11-03', period: 'full_day' };
function harness(t: TestContext, routeIntent: (text: string) => Promise<unknown> = async () => (
  { kind: 'screen', intent: 'leave_request', ui: 'leave_request' }
)) {
  const store = new LocalStore(':memory:');
  t.after(() => store.close());
  const app = createApp({ store, routeIntent });
  return {
    store, app,
    get: (path: string) => app.request(ORIGIN + path),
    post: (path: string, body: unknown) => app.request(ORIGIN + path, {
      method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }),
  };
}

test('Intentからフォームを開くだけでは保存せず、明示POST後に一覧へ現れる', async (t) => {
  let input = '';
  const h = harness(t, async (text) => { input = text; return { kind: 'screen', intent: 'leave_request', ui: 'leave_request' }; });
  assert.equal((await h.post('/api/intent', { text: ' 明日有給を取りたい ' })).status, 200);
  assert.equal(input, '明日有給を取りたい');
  assert.equal(h.store.list().length, 2);
  const response = await h.post('/api/applications/leave', leave);
  assert.equal(response.status, 201);
  const { application } = await response.json();
  assert.equal(application.status, 'pending');
  assert.equal(application.submittedOn, '2026-11-02');
  assert.equal((await h.get('/api/applications')).status, 200);
  assert.equal(h.store.list().length, 3);
  assert.equal((await (await h.get('/api/applications?status=returned')).json()).applications.length, 0);
  assert.equal((await h.post('/api/applications/expense', { date: '2026-11-01', amount: 1200 })).status, 201);
});

test('実在日付・正整数・区分・型・余分キー・文字数を検証し、不正入力を保存しない', async (t) => {
  const h = harness(t);
  for (const body of [
    { ...leave, date: '2026-02-29' }, { ...leave, date: '2026-04-31' }, { ...leave, date: '2026-13-01' },
    { ...leave, date: '0000-01-01' }, { ...leave, period: ['full_day'] }, { ...leave, period: 'all' },
    { ...leave, tool: 'save_without_confirmation' }, { ...leave, reason: 'a'.repeat(501) },
  ]) assert.equal((await h.post('/api/applications/leave', body)).status, 400);
  for (const amount of [0, -1, 1.5, '1200', Number.MAX_SAFE_INTEGER + 1, null]) {
    assert.equal((await h.post('/api/applications/expense', { date: '2026-11-01', amount })).status, 400);
  }
  for (const text of ['', ' '.repeat(4), 'a'.repeat(2001), 42]) {
    assert.equal((await h.post('/api/intent', { text })).status, 400);
  }
  assert.equal((await h.post('/api/intent', { text: '有給', ui: 'leave_request' })).status, 400);
  assert.equal(h.store.list().length, 2);
  assert.equal((await h.post('/api/applications/leave', { date: '2024-02-29', period: 'am' })).status, 201);
});

test('未許可のIntent・UI・Toolを拒否して保存しない', async (t) => {
  for (const decision of [
    { kind: 'screen', intent: 'leave_request', ui: 'application_status' },
    { kind: 'screen', intent: 'delete_all', ui: 'delete_all' },
    { kind: 'screen', intent: 'leave_request', ui: 'leave_request', tool: 'save' },
    { kind: 'notice', intent: 'other', message: '任意' },
  ]) {
    const h = harness(t, async () => decision);
    assert.equal((await h.post('/api/intent', { text: '有給を取りたい' })).status, 502);
    assert.equal(h.store.list().length, 2);
  }
});

test('推論の失敗を400/502/503/504へ分け、生の例外を表示しない', async (t) => {
  for (const [code, expected] of [
    ['invalid_input', 400], ['invalid_response', 502], ['unavailable', 503], ['timeout', 504],
  ] as const) {
    const h = harness(t, async () => { throw new DecisionError(code); });
    const response = await h.post('/api/intent', { text: '有給' });
    assert.equal(response.status, expected);
    assert.equal((await response.json()).error.code, code);
  }
  const h = harness(t, async () => { throw new Error('secret-token-value'); });
  const response = await h.post('/api/intent', { text: '有給' });
  assert.equal(response.status, 503);
  assert.ok(!(await response.text()).includes('secret-token-value'));
});

test('loopback Host・同一Origin・JSON・本文上限を強制し、CORSを許可しない', async (t) => {
  const h = harness(t);
  assert.equal((await h.app.request('http://external.example:3000/api/employees')).status, 403);
  assert.equal((await h.app.request(ORIGIN + '/api/employees', { headers: { Host: 'external.example:3000' } })).status, 403);
  for (const origin of [undefined, 'null', 'http://external.example', 'http://localhost:3000']) {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (origin !== undefined) headers.Origin = origin;
    const response = await h.app.request(ORIGIN + '/api/applications/leave', { method: 'POST', headers, body: JSON.stringify(leave) });
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
  }
  assert.equal((await h.app.request(ORIGIN + '/api/intent', { method: 'POST', headers: { Origin: ORIGIN }, body: '{}' })).status, 415);
  assert.equal((await h.app.request(ORIGIN + '/api/intent', { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body: '{' })).status, 400);
  assert.equal((await h.post('/api/intent', { text: 'a'.repeat(17000) })).status, 413);
  assert.equal(h.store.list().length, 2);
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
  assert.equal(h.store.list().length, 2);
});

test('DBの例外本文をHTTP応答へ含めない', async () => {
  const store = new LocalStore(':memory:');
  const app = createApp({ store, routeIntent: async () => null });
  store.close();
  const response = await app.request(ORIGIN + '/api/applications');
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: { code: 'internal_error', message: '処理を完了できませんでした。画面からやり直してください。' } });
});
