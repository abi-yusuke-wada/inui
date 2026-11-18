import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, LatestRequest, errorMessage, fetchJson, parseDecision } from '../../src/web/api.ts';

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

test('許可した3画面だけを開き、画面への引数や削除した画面を拒否する', () => {
  for (const screen of ['markdown_view', 'task_board', 'whiteboard'] as const) {
    assert.deepEqual(parseDecision({ kind: 'screen', intent: screen, ui: screen }), { kind: 'screen', intent: screen, ui: screen });
  }
  assert.throws(() => parseDecision({ kind: 'screen', intent: 'task_board', ui: 'admin' }), ApiError);
  // 画面へ人名などの引数を渡す経路は持たない（予定比較とともに廃止）。
  const people = { selectedIds: ['a'], ambiguous: [], unknownNames: [] };
  assert.throws(() => parseDecision({ kind: 'screen', intent: 'task_board', ui: 'task_board', people }), ApiError);
  for (const removed of ['schedule_compare', 'leave_request', 'expense_request', 'application_status']) {
    assert.throws(() => parseDecision({ kind: 'screen', intent: removed, ui: removed }), ApiError);
  }
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
      ok: false, status: 502, headers: new Headers({ 'X-Error-Code': 'upstream_auth' }),
      json: async () => { readBody = true; return { error: '秘密を含む外部本文' }; },
    } as Response;
  };
  await assert.rejects(fetchJson('/api/tasks/local', { method: 'POST', body: { title: '件名' }, fetchImpl: fake }), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.kind, 'http');
    assert.equal(error.status, 502);
    assert.equal(error.code, 'upstream_auth');
    assert.equal(error.message.includes('秘密'), false);
    return true;
  });
  // 固定形式でないコードは採用しない。
  await assert.rejects(fetchJson('/api/tasks/github', { fetchImpl: async () => ({
    ok: false, status: 502, headers: new Headers({ 'X-Error-Code': '秘密 <b>' }), json: async () => ({}),
  } as Response) }), (error: unknown) => error instanceof ApiError && error.code === undefined);
  assert.equal(calls, 1);
  assert.equal(readBody, false);
});

test('HTTP504は本文を読まず時間超過として案内し、分類POSTを自動再試行しない', async () => {
  let calls = 0;
  let bodyReads = 0;
  const privateDetail = 'テスト用の非公開上流情報';
  await assert.rejects(fetchJson('/api/intent', {
    method: 'POST', body: { text: '自分のタスクを確認したい' },
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
  // 判定以外（タスクの追加等）の入力エラーは、入力内容の確認を案内する。
  assert.equal(errorMessage(new ApiError('http', 400), 'タスクの追加'), '入力内容を確認して、もう一度お試しください。');
  // 判定（画面の表示）の入力エラーでは、入力を短くしての再試行を案内する。
  assert.equal(errorMessage(new ApiError('http', 400), '画面の表示'),
    '入力が長すぎるか、内容を判定できませんでした。入力を短くして、もう一度お試しください。');
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
