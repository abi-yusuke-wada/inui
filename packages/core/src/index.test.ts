import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  LOCAL_MODEL,
  DecisionError,
  buildLocalRequest,
  createIntentRouter,
  parseLocalResponse,
} from './index.ts';

const wireIntents = [
  'leave_request', 'expense_request', 'application_status', 'schedule_compare',
  'unsupported_feature', 'unsupported_operation', 'unspecified_application',
] as const;
type WireIntent = typeof wireIntents[number];

/** 通信契約のテスト用応答。分類精度の実測には使わない。 */
function responseBody(choice: WireIntent = 'leave_request') {
  return {
    model: LOCAL_MODEL,
    answers: {
      intent: {
        type: 'choice',
        choice: choice as string,
        confidence: 0.7,
        probabilities: Object.fromEntries(wireIntents.map((intent) => [intent, intent === choice ? 0.7 : 0.05])),
      },
    },
    usage: { input_tokens: 12, output_tokens: 1 },
  };
}

/** エラーの種類と、外部の詳細を含まない固定メッセージを確認する。 */
function isDecisionError(code: DecisionError['code']) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof DecisionError);
    assert.equal(error.code, code);
    assert.equal(error.name, 'DecisionError');
    assert.equal(error.message, new DecisionError(code).message);
    assert.equal(Object.hasOwn(error, 'cause'), false);
    return true;
  };
}

/** 注入用のfetchを作り、テストで外部通信を発生させない。 */
function fakeFetch(implementation: (input: string | URL | Request, init?: RequestInit) => Promise<Response>): typeof fetch {
  return implementation;
}

test('リクエストは入力の前後空白を除き、固定モデル・7候補だけを送る', () => {
  const request = buildLocalRequest(' \n 有給を取りたい \t ');
  assert.equal(request.model, LOCAL_MODEL);
  assert.equal(request.state, '有給を取りたい');
  assert.deepEqual(Object.keys(request), ['model', 'state', 'questions']);
  assert.deepEqual(Object.keys(request.questions), ['intent']);
  assert.equal(request.questions.intent.type, 'choice');
  assert.deepEqual(Object.keys(request.questions.intent.criteria), wireIntents);
  assert.equal(Object.hasOwn(request.questions.intent.criteria, 'clarify'), false);
  assert.equal(buildLocalRequest('あ'.repeat(2000)).state.length, 2000);
});

test('採用済み質問を保持し、予定比較と対象外の説明だけを拡張する', async () => {
  const probe = await import(new URL('../../../scripts/jev-probe.mjs', import.meta.url).href);
  const previous = probe.buildRequest('有給を取りたい', { model: LOCAL_MODEL });
  const current = buildLocalRequest('有給を取りたい');
  assert.equal(current.questions.intent.instructions, previous.questions.intent.instructions);
  for (const intent of ['leave_request', 'expense_request', 'application_status', 'unspecified_application'] as const) {
    assert.equal(current.questions.intent.criteria[intent], previous.questions.intent.criteria[intent]);
  }
  assert.match(current.questions.intent.criteria.schedule_compare, /予定.*比較/);
  assert.match(current.questions.intent.criteria.unsupported_feature, /予定比較以外/);
  assert.match(current.questions.intent.criteria.unsupported_operation, /予定を登録・削除/);
  assert.equal(Object.keys(previous.questions.intent.criteria).length, 6);
});

test('リクエストを変更しても次の呼び出しの候補説明を汚染しない', () => {
  const request = buildLocalRequest('有給を取りたい');
  const original = request.questions.intent.criteria.leave_request;
  request.questions.intent.criteria.leave_request = '改変した説明';
  assert.equal(buildLocalRequest('有給を取りたい').questions.intent.criteria.leave_request, original);
});

for (const input of ['', ' \n\t ', 'あ'.repeat(2001), null, 123, {}, []]) {
  test(`不正な入力を拒否する: ${typeof input} / ${typeof input === 'string' ? input.length : '-'}`, async () => {
    assert.throws(() => buildLocalRequest(input as string), isDecisionError('invalid_input'));
    let called = false;
    const router = createIntentRouter({ fetchImpl: fakeFetch(async () => {
      called = true;
      return Response.json(responseBody());
    }) });
    await assert.rejects(router(input as string), isDecisionError('invalid_input'));
    assert.equal(called, false);
  });
}

for (const intent of wireIntents.slice(0, 4)) {
  test(`許可した画面に対応付ける: ${intent}`, () => {
    assert.deepEqual(parseLocalResponse(responseBody(intent)), { kind: 'screen', intent, ui: intent });
  });
}

for (const [wire, canonical] of [
  ['unsupported_feature', 'unsupported_feature'],
  ['unsupported_operation', 'unsupported_operation'],
  ['unspecified_application', 'clarify'],
] as const) {
  test(`案内を固定メッセージへ対応付ける: ${wire}`, () => {
    const result = parseLocalResponse(responseBody(wire));
    assert.equal(result.kind, 'notice');
    assert.equal(result.intent, canonical);
    assert.equal(Object.hasOwn(result, 'ui'), false);
    if (result.kind === 'notice') {
      assert.ok(result.message.length > 0);
      assert.doesNotMatch(result.message, /unspecified_application/);
    }
  });
}

test('7候補の小数4桁への丸めと最大値の同率を許す', () => {
  const rounded = responseBody();
  rounded.answers.intent.confidence = 0.1429;
  rounded.answers.intent.probabilities = Object.fromEntries(wireIntents.map((intent) => [intent, 0.1429]));
  assert.equal(parseLocalResponse(rounded).intent, 'leave_request');
  const outsideTolerance = structuredClone(rounded);
  outsideTolerance.answers.intent.probabilities.leave_request = 0.143;
  assert.throws(() => parseLocalResponse(outsideTolerance), isDecisionError('invalid_response'));
});

test('使用量はゼロと安全な整数の上限を許す', () => {
  const body = responseBody();
  body.usage = { input_tokens: 0, output_tokens: Number.MAX_SAFE_INTEGER };
  assert.equal(parseLocalResponse(body).intent, 'leave_request');
});

const corruptions: [string, (body: any) => unknown][] = [
  ['別モデル', (body) => { body.model = 'jev-1.14.0'; return body; }],
  ['内部clarifyを直接返す', (body) => { body.answers.intent.choice = 'clarify'; return body; }],
  ['未知の候補', (body) => { body.answers.intent.choice = 'delete_everything'; return body; }],
  ['配列の候補', (body) => { body.answers.intent.choice = ['leave_request']; return body; }],
  ['Choice以外', (body) => { body.answers.intent.type = 'tool'; return body; }],
  ['負のconfidence', (body) => { body.answers.intent.confidence = -0.1; return body; }],
  ['1を超えるconfidence', (body) => { body.answers.intent.confidence = 1.1; return body; }],
  ['NaNのconfidence', (body) => { body.answers.intent.confidence = NaN; return body; }],
  ['文字列のconfidence', (body) => { body.answers.intent.confidence = '0.7'; return body; }],
  ['確率欠落', (body) => { delete body.answers.intent.probabilities.schedule_compare; return body; }],
  ['未知の確率', (body) => { body.answers.intent.probabilities.clarify = 0; return body; }],
  ['負の確率', (body) => { body.answers.intent.probabilities.leave_request = -0.1; return body; }],
  ['無限の確率', (body) => { body.answers.intent.probabilities.leave_request = Infinity; return body; }],
  ['文字列の確率', (body) => { body.answers.intent.probabilities.leave_request = '0.7'; return body; }],
  ['確率の合計不足', (body) => { body.answers.intent.probabilities.leave_request = 0.6; return body; }],
  ['確率の合計過多', (body) => { body.answers.intent.probabilities.leave_request = 0.8; return body; }],
  ['最大確率以外の選択', (body) => { body.answers.intent.choice = 'schedule_compare'; return body; }],
  ['負の使用量', (body) => { body.usage.input_tokens = -1; return body; }],
  ['小数の使用量', (body) => { body.usage.output_tokens = 0.5; return body; }],
  ['文字列の使用量', (body) => { body.usage.input_tokens = '12'; return body; }],
  ['安全整数を超える使用量', (body) => { body.usage.output_tokens = Number.MAX_SAFE_INTEGER + 1; return body; }],
  ['本文配列', () => []],
  ['本文null', () => null],
  ['answers配列', (body) => { body.answers = []; return body; }],
  ['intent欠落', (body) => { delete body.answers.intent; return body; }],
  ['usage欠落', (body) => { delete body.usage; return body; }],
];

for (const [name, corrupt] of corruptions) {
  test(`不正応答を拒否する: ${name}`, () => {
    assert.throws(() => parseLocalResponse(corrupt(responseBody())), isDecisionError('invalid_response'));
  });
}

for (const location of ['body', 'answers', 'intent', 'usage'] as const) {
  for (const key of ['Tool', 'UI', 'args']) {
    test(`未許可フィールドを拒否する: ${location}.${key}`, () => {
      const body: any = responseBody();
      const target = location === 'body' ? body : location === 'intent' ? body.answers.intent : body[location];
      target[key] = { execute: true };
      assert.throws(() => parseLocalResponse(body), isDecisionError('invalid_response'));
    });
  }
}

for (const baseUrl of ['http://127.0.0.1:8765', 'http://localhost:8766/', 'http://[::1]:8767', 'https://localhost']) {
  test(`loopbackだけに固定リクエストを送る: ${baseUrl}`, async () => {
    let called = false;
    const router = createIntentRouter({ baseUrl, fetchImpl: fakeFetch(async (input, init) => {
      called = true;
      assert.equal(input, new URL('/v1/systemone', baseUrl).href);
      assert.equal(init?.method, 'POST');
      assert.equal(init?.redirect, 'error');
      assert.deepEqual(init?.headers, { 'Content-Type': 'application/json' });
      assert.deepEqual(JSON.parse(init?.body as string), buildLocalRequest('予定を比べたい'));
      assert.ok(init?.signal instanceof AbortSignal);
      return Response.json(responseBody('schedule_compare'));
    }) });
    assert.deepEqual(await router(' 予定を比べたい '), { kind: 'screen', intent: 'schedule_compare', ui: 'schedule_compare' });
    assert.equal(called, true);
  });
}

for (const baseUrl of [
  'https://api.typesafe.ai', 'http://example.com', 'http://127.0.0.2', 'http://localhost.example.com',
  '/relative', 'file:///tmp/local', 'http://user:pass@localhost', 'http://localhost/path',
  'http://localhost?key=value', 'http://localhost#fragment',
]) {
  test(`許可しない接続先を拒否する: ${baseUrl}`, () => {
    assert.throws(() => createIntentRouter({ baseUrl }), isDecisionError('unavailable'));
  });
}

for (const timeoutMs of [0, -1, 1.5, Infinity, NaN, 2_147_483_648]) {
  test(`不正なtimeout設定を拒否する: ${timeoutMs}`, () => {
    assert.throws(() => createIntentRouter({ timeoutMs }), isDecisionError('unavailable'));
  });
}

test('既定接続先を使い、上流例外の詳細を漏らさない', async () => {
  const router = createIntentRouter({ fetchImpl: fakeFetch(async (input) => {
    assert.equal(input, 'http://127.0.0.1:8765/v1/systemone');
    throw new Error('upstream-private-detail');
  }) });
  await assert.rejects(router('有給を取りたい'), isDecisionError('unavailable'));
});

test('HTTPエラーは本文を読まず、固定エラーへ変換する', async () => {
  let bodyRead = false;
  const router = createIntentRouter({ fetchImpl: fakeFetch(async () => ({
    ok: false,
    status: 500,
    json: async () => { bodyRead = true; throw new Error('upstream-private-detail'); },
  }) as unknown as Response) });
  await assert.rejects(router('有給を取りたい'), isDecisionError('unavailable'));
  assert.equal(bodyRead, false);
});

test('JSON読取失敗の詳細を漏らさない', async () => {
  const router = createIntentRouter({ fetchImpl: fakeFetch(async () => ({
    ok: true,
    json: async () => { throw new Error('upstream-private-detail'); },
  }) as unknown as Response) });
  await assert.rejects(router('有給を取りたい'), isDecisionError('invalid_response'));
});

test('HTTP成功でも契約違反は画面へ渡さない', async () => {
  const router = createIntentRouter({ fetchImpl: fakeFetch(async () => Response.json({ ...responseBody(), ui: 'admin' })) });
  await assert.rejects(router('有給を取りたい'), isDecisionError('invalid_response'));
});

test('fetchが停止しabortを無視しても期限で終了する', async () => {
  let signal: AbortSignal | null | undefined;
  const router = createIntentRouter({ timeoutMs: 5, fetchImpl: fakeFetch((_input, init) => {
    signal = init?.signal;
    return new Promise<Response>(() => {});
  }) });
  await assert.rejects(router('有給を取りたい'), isDecisionError('timeout'));
  assert.equal(signal?.aborted, true);
});

test('ヘッダー受信後にJSON本文が停止しても期限で終了する', async () => {
  let signal: AbortSignal | null | undefined;
  let bodyRead = false;
  const router = createIntentRouter({ timeoutMs: 5, fetchImpl: fakeFetch(async (_input, init) => {
    signal = init?.signal;
    return {
      ok: true,
      json: () => { bodyRead = true; return new Promise(() => {}); },
    } as unknown as Response;
  }) });
  await assert.rejects(router('有給を取りたい'), isDecisionError('timeout'));
  assert.equal(bodyRead, true);
  assert.equal(signal?.aborted, true);
});

test('完了した通信のタイマーは解除される', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal: AbortSignal | null | undefined;
  const router = createIntentRouter({ fetchImpl: fakeFetch(async (_input, init) => {
    signal = init?.signal;
    return Response.json(responseBody());
  }) });
  await router('有給を取りたい');
  t.mock.timers.tick(25_000);
  assert.equal(signal?.aborted, false);
});

test('既定の期限は25秒で、本文読取も残り時間に含める', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let bodyRead = false;
  const router = createIntentRouter({ fetchImpl: fakeFetch(async () => ({
    ok: true,
    json: () => { bodyRead = true; return new Promise(() => {}); },
  }) as unknown as Response) });
  const pending = router('有給を取りたい');
  // fetchが返した後の本文待機へ進める。
  await Promise.resolve();
  assert.equal(bodyRead, true);
  t.mock.timers.tick(24_999);
  let settled = false;
  void pending.then(() => { settled = true; }, () => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);
  const rejection = assert.rejects(pending, isDecisionError('timeout'));
  t.mock.timers.tick(1);
  await rejection;
});
