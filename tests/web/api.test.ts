import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, LatestRequest, errorMessage, fetchJson, parseDecision, parseEmployees, parseSchedules, validDate } from '../../src/web/api.ts';

test('新しい要求と画面の破棄は、以前の応答の反映を無効にする', () => {
  const gate = new LatestRequest();
  const first = gate.begin();
  assert.equal(first.isCurrent(), true);
  const second = gate.begin();
  assert.equal(first.signal.aborted, true);
  assert.equal(first.isCurrent(), false);
  assert.equal(second.isCurrent(), true);
  gate.cancel();
  assert.equal(second.isCurrent(), false);
});

test('予定比較の人名選択を保持し、未許可画面や不正な社員選択を拒否する', () => {
  const people = { selectedIds: ['a', 'b'], ambiguous: [{ name: '山田', candidateIds: ['a', 'c'] }], unknownNames: ['田中'] };
  const decision = parseDecision({ kind: 'screen', intent: 'schedule_compare', ui: 'schedule_compare', people });
  assert.equal(decision.kind, 'screen');
  if (decision.kind !== 'screen') throw new Error('予定比較の画面が返されませんでした。');
  assert.deepEqual(decision.people, people);
  assert.throws(() => parseDecision({ kind: 'screen', intent: 'schedule_compare', ui: 'admin' }), ApiError);
  assert.throws(() => parseDecision({ kind: 'screen', intent: 'schedule_compare', ui: 'schedule_compare', people: { ...people, selectedIds: ['a', 'a'] } }), ApiError);
  assert.throws(() => parseEmployees({ employees: [{ id: 'a', name: '山田太郎' }, { id: 'a', name: '別人' }] }), ApiError);
});

test('予定の応答が異なる日付や社員、逆転した時間を含む場合は表示しない', () => {
  const data = {
    date: '2026-11-02',
    employees: [{ id: 'a', name: '山田太郎' }, { id: 'b', name: '佐藤花子' }],
    events: [{ id: 'event', personId: 'a', title: '打合せ', start: '10:00', end: '11:00' }],
  };
  assert.deepEqual(parseSchedules(data, data.date, ['a', 'b']), data);
  assert.throws(() => parseSchedules(data, '2026-11-03', ['a', 'b']), ApiError);
  assert.throws(() => parseSchedules(data, data.date, ['a', 'c']), ApiError);
  assert.throws(() => parseSchedules({ ...data, events: [{ ...data.events[0], personId: 'c' }] }, data.date, ['a', 'b']), ApiError);
  assert.throws(() => parseSchedules({ ...data, events: [{ ...data.events[0], end: '09:00' }] }, data.date, ['a', 'b']), ApiError);
});

test('存在しない日付を補正せず拒否する', () => {
  assert.equal(validDate('2026-11-02'), true);
  assert.equal(validDate('2028-02-29'), true);
  assert.equal(validDate('2026-02-29'), false);
  assert.equal(validDate('2026-04-31'), false);
});

test('HTTPエラー本文を取得・表示用エラーへ含めず、保存POSTを自動再試行しない', async () => {
  let calls = 0;
  let readBody = false;
  const fake = async (_url: string | URL | Request, options?: RequestInit) => {
    calls++;
    assert.equal(options?.method, 'POST');
    assert.equal(options?.credentials, 'same-origin');
    assert.equal(options?.redirect, 'error');
    return {
      ok: false, status: 500,
      json: async () => { readBody = true; return { error: '秘密を含む外部本文' }; },
    } as Response;
  };
  await assert.rejects(fetchJson('/api/applications/leave', { method: 'POST', body: { date: '2026-11-03' }, fetchImpl: fake }), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.kind, 'http');
    assert.equal(error.status, 500);
    assert.equal(error.message.includes('秘密'), false);
    return true;
  });
  assert.equal(calls, 1);
  assert.equal(readBody, false);
});

test('HTTP504は本文を読まず時間超過として案内し、分類POSTを自動再試行しない', async () => {
  let calls = 0;
  let bodyReads = 0;
  const privateDetail = 'テスト用の非公開上流情報';
  await assert.rejects(fetchJson('/api/intent', {
    method: 'POST', body: { text: '山田太郎さんと佐藤花子さんの予定を見たい' },
    fetchImpl: async () => {
      calls++;
      return {
        ok: false, status: 504,
        json: async () => { bodyReads++; throw new Error(privateDetail); },
      } as unknown as Response;
    },
  }), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.kind, 'http');
    assert.equal(error.status, 504);
    assert.equal(errorMessage(error, '画面の表示'), '画面の表示に時間がかかっています。時間をおいてお試しください。');
    assert.equal(error.message.includes(privateDetail), false);
    return true;
  });
  assert.equal(calls, 1);
  assert.equal(bodyReads, 0);
});

test('時間超過の案内を入力・権限・接続・応答形式の失敗と区別する', () => {
  const action = '画面の表示';
  const timeoutMessage = '画面の表示に時間がかかっています。時間をおいてお試しください。';
  const connectionMessage = '画面の表示ができませんでした。接続を確認して、もう一度お試しください。';
  assert.equal(errorMessage(new ApiError('timeout'), action), timeoutMessage);
  assert.equal(errorMessage(new ApiError('http', 400), action), '入力内容を確認して、もう一度お試しください。');
  for (const status of [401, 403]) {
    assert.equal(errorMessage(new ApiError('http', status), action), 'この操作を利用できません。ページを再読み込みしてお試しください。');
  }
  for (const error of [new ApiError('http', 500), new ApiError('http', 502), new ApiError('http', 503), new ApiError('network'), new ApiError('invalid')]) {
    assert.equal(errorMessage(error, action), connectionMessage);
  }
});

test('既に取り消した要求はネットワークへ送らない', async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  await assert.rejects(fetchJson('/api/intent', { signal: controller.signal, fetchImpl: async () => {
    calls++; return new Response('{}');
  } }), (error: unknown) => error instanceof ApiError && error.kind === 'aborted');
  assert.equal(calls, 0);
});

test('通信例外の内容を表示用エラーへ含めない', async () => {
  await assert.rejects(fetchJson('/api/intent', { fetchImpl: async () => {
    throw new Error('外部例外に含まれる非公開情報');
  } }), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.kind, 'network');
    assert.equal(error.message.includes('非公開情報'), false);
    return true;
  });
});

test('通信の期限切れを取り消しやJSONエラーと区別する', async () => {
  await assert.rejects(fetchJson('/api/intent', { timeoutMs: 1, fetchImpl: async (_url, options) =>
    await new Promise<Response>((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new Error('abort')), { once: true });
    }),
  }), (error: unknown) => error instanceof ApiError && error.kind === 'timeout');
});
