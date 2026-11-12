import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { CASES } from '../../scripts/jev-probe.mjs';
import { POC_CASES, requests, requestsDigest, replay, probeHttp, diagnose, diagnoseWeb, runCli } from '../../scripts/poc-probe.mjs';

const SAVED_FILE = new URL('../../docs/poc-nli-responses-2026-11-10.jsonl', import.meta.url);
const savedText = await readFile(SAVED_FILE, 'utf8');
const savedRecords = savedText.trim().split('\n').map((line) => JSON.parse(line));
const ORIGIN = 'http://127.0.0.1:8766';
const PRIVATE_DETAIL = 'test-only-private-upstream-detail';

/** 保存した結果を複製し、回帰テスト同士で変更を共有しない。 */
function changedReplay(change) {
  const records = structuredClone(savedRecords);
  change(records);
  return records.map((record) => JSON.stringify(record)).join('\n');
}

/** 標準出力と診断出力を分け、意図しない本文の漏出も確認する。 */
function capture() {
  const lines = [];
  const status = [];
  return { lines, status, port: 8766, write: (line) => lines.push(line), writeStatus: (line) => status.push(line) };
}

test('旧13入力の期待値を維持し、予定比較を含む19入力と人名4期待を通信せず取得する', async () => {
  const current = requests();
  assert.equal(current.length, 19);
  assert.equal(new Set(current.map((sample) => sample.id)).size, 19);
  assert.deepEqual(current.slice(0, 13).map(({ id, text, expected }) => ({ id, text, expected })), CASES);
  assert.equal(current.filter((sample) => sample.expectedPeople !== null).length, 4);
  assert.ok(current.every((sample) => sample.request.model === 'nli-deberta-large'
    && sample.request.state === sample.text && Object.keys(sample.request.questions.intent.criteria).length === 7));
  const output = capture();
  const rc = await runCli(['--requests'], { ...output, fetchImpl: async () => assert.fail('入力の取得で通信しない') });
  assert.equal(rc, 0);
  assert.equal(output.lines.length, 1);
  assert.deepEqual(JSON.parse(output.lines[0]), current);
  assert.deepEqual(output.status, []);
  assert.equal(savedRecords[0].metadata.requests_sha256, requestsDigest());
});

test('保存した実NLI応答19件を現コアで再生し、正常・異常・人名を独立に集計する', async () => {
  const result = replay(savedText);
  assert.equal(result.transport, 'in-process-local-jev-engine');
  assert.equal(result.metadata.http_route_executed, false);
  assert.equal(result.summary.criterion_met, true);
  assert.equal(result.summary.matched, 19);
  assert.deepEqual(result.summary.normal, { matched: 13, total: 13 });
  assert.deepEqual(result.summary.abnormal, { matched: 6, total: 6 });
  assert.deepEqual(result.summary.people, { matched: 4, total: 4 });
  assert.ok(result.results.every((row) => row.truncated === false));
  const output = capture();
  assert.equal(await runCli(['--replay', SAVED_FILE.pathname], {
    ...output, fetchImpl: async () => assert.fail('保存結果の再生で通信しない'),
  }), 0);
  assert.equal(output.lines.length, 1);
  assert.deepEqual(JSON.parse(output.lines[0]), result);
  assert.deepEqual(output.status, []);
});

test('欠落・重複・質問のdigest差・Tool混入を含む保存結果を拒否する', () => {
  const corruptions = [
    (records) => records.pop(),
    (records) => { records[2].sampleID = records[1].sampleID; },
    (records) => { records[0].metadata.requests_sha256 = 'wrong-digest'; },
    (records) => { records[1].rawResponse.Tool = PRIVATE_DETAIL; },
  ];
  for (const corrupt of corruptions) {
    assert.throws(() => replay(changedReplay(corrupt)), (error) => {
      assert.equal(error.message.includes(PRIVATE_DETAIL), false);
      return true;
    });
  }
});

test('有効な契約でも誤分類やtruncatedのtrue・不明を合格にしない', () => {
  const wrong = replay(changedReplay((records) => {
    const expense = records.find((record) => record.sampleID === 'expense-no-values');
    records[1].rawResponse.answers.intent = structuredClone(expense.rawResponse.answers.intent);
  }));
  assert.equal(wrong.summary.criterion_met, false);
  assert.equal(wrong.summary.matched, 18);
  assert.equal(wrong.results[0].actual, 'expense_request');
  assert.equal(wrong.results[0].intent_matched, false);
  for (const truncated of [true, null]) {
    const result = replay(changedReplay((records) => { records[1].truncated = truncated; }));
    assert.equal(result.summary.criterion_met, false);
    assert.equal(result.summary.matched, 18);
    assert.equal(result.results[0].error, 'truncated_or_unknown');
  }
});

test('HTTP成功の注入では同一OriginのIntent受付へ19回だけPOSTし、業務保存を呼ばない', async () => {
  let calls = 0;
  const result = await probeHttp({ port: 8766, fetchImpl: async (url, init) => {
    const sample = POC_CASES[calls++];
    assert.equal(url, `${ORIGIN}/api/intent`);
    assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'error');
    assert.deepEqual(init.headers, { Origin: ORIGIN, 'Content-Type': 'application/json' });
    assert.deepEqual(JSON.parse(init.body), { text: sample.text });
    assert.ok(init.signal instanceof AbortSignal);
    const body = ['unsupported_feature', 'unsupported_operation', 'clarify'].includes(sample.expected)
      ? { kind: 'notice', intent: sample.expected, message: '通信テスト用の固定案内' }
      : { kind: 'screen', intent: sample.expected, ui: sample.expected,
        ...(sample.expectedPeople ? { people: sample.expectedPeople } : {}) };
    return Response.json(body);
  } });
  assert.equal(calls, 19);
  assert.equal(result.summary.criterion_met, true);
  assert.equal(result.transport, 'http-local-poc-api');
  assert.equal(result.metadata.server_configuration_observed, false);
  // この成功は注入通信の契約確認に限り、実NLIや実HTTPの成功を表さない。
  assert.equal(result.metadata.runtime, null);
});

test('HTTP503を19件とstderrへ記録し、上流本文や例外の詳細を出力しない', async () => {
  const output = capture();
  let calls = 0;
  let bodyReads = 0;
  const rc = await runCli([], { ...output, fetchImpl: async (url, init) => {
    calls += 1;
    assert.equal(url, `${ORIGIN}/api/intent`);
    assert.equal(init.method, 'POST');
    return { ok: false, status: 503, json: async () => {
      bodyReads += 1;
      throw new Error(PRIVATE_DETAIL);
    } };
  } });
  assert.equal(rc, 1);
  assert.equal(calls, 19);
  assert.equal(bodyReads, 0);
  assert.equal(output.lines.length, 1);
  const result = JSON.parse(output.lines[0]);
  assert.equal(result.summary.matched, 0);
  assert.equal(result.summary.total, 19);
  assert.ok(result.results.every((row) => row.error === 'http_error' && row.http_status === 503));
  assert.equal(output.status.length, 20);
  assert.match(output.status[0], /0\/19/);
  assert.ok(output.status.slice(1).every((line) => line.endsWith('HTTP 503')));
  assert.equal(JSON.stringify(output).includes(PRIVATE_DETAIL), false);
});

test('app HTTP200とlocal-jev ECONNREFUSEDを区別し、診断CLIでも安全な情報だけを返す', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(url);
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal instanceof AbortSignal);
    if (url === `${ORIGIN}/api/employees`) {
      assert.equal(init.method, undefined);
      return { ok: true, status: 200, json: async () => assert.fail('app診断で本文を読まない') };
    }
    assert.equal(url, 'http://127.0.0.1:8765/v1/systemone');
    assert.equal(init.method, 'POST');
    assert.deepEqual(init.headers, { 'Content-Type': 'application/json' });
    assert.equal(JSON.parse(init.body).model, 'nli-deberta-large');
    throw new Error(PRIVATE_DETAIL, { cause: { code: 'ECONNREFUSED', message: PRIVATE_DETAIL } });
  };
  const expected = { ok: false, checks: [
    { service: 'app', ok: true, http_status: 200 },
    { service: 'local-jev', ok: false, error: 'ECONNREFUSED' },
  ] };
  assert.deepEqual(await diagnose({ fetchImpl, port: 8766 }), expected);
  const output = capture();
  assert.equal(await runCli(['--diagnose'], { ...output, fetchImpl }), 1);
  assert.equal(calls.length, 4);
  assert.deepEqual(JSON.parse(output.lines[0]), expected);
  assert.deepEqual(output.status, ['app: HTTP 200', 'local-jev: ECONNREFUSED']);
  assert.equal(JSON.stringify(output).includes(PRIVATE_DETAIL), false);
});

test('Web診断はHTML・JS・CSSの受信完了とビルド一致を確認し、推論や保存を呼ばない', async () => {
  const files = { 'index.html': '<html>固定テスト画面</html>', 'app.js': 'testBundle();', 'app.css': 'body { color: black; }' };
  const calls = [];
  const output = await diagnoseWeb({
    port: 8766,
    readAsset: async (url) => Buffer.from(files[url.pathname.split('/').at(-1)]),
    fetchImpl: async (url, init) => {
      calls.push(url);
      assert.equal(init.redirect, 'error');
      assert.ok(init.signal instanceof AbortSignal);
      const path = new URL(url).pathname;
      const filename = path === '/' || path === '/legacy' ? 'index.html' : path.slice(1);
      const contentType = { 'index.html': 'text/html; charset=utf-8', 'app.js': 'text/javascript', 'app.css': 'text/css' }[filename];
      return new Response(files[filename], { headers: { 'Content-Type': contentType } });
    },
  });
  assert.equal(output.ok, true);
  assert.deepEqual(calls, ['/', '/legacy', '/app.js', '/app.css'].map((path) => ORIGIN + path));
  assert.ok(output.checks.every((check) => check.http_status === 200 && check.content_matched && check.content_type_matched && check.bytes > 0));
});

test('Web診断は本文が終わらない200応答・別ビルド・不正MIME・接続拒否を切り分ける', async () => {
  let calls = 0;
  const output = await diagnoseWeb({
    port: 8766,
    timeoutMs: 5, readAsset: async () => Buffer.from('expected'),
    fetchImpl: async () => {
      switch (calls++) {
        case 0: return { ok: true, status: 200, headers: new Headers({ 'Content-Type': 'text/html' }), arrayBuffer: () => new Promise(() => {}) };
        case 1: return new Response(PRIVATE_DETAIL, { headers: { 'Content-Type': 'text/html' } });
        case 2: return new Response('expected', { headers: { 'Content-Type': 'text/plain' } });
        default: throw new Error(PRIVATE_DETAIL, { cause: { code: 'ECONNREFUSED' } });
      }
    },
  });
  assert.equal(output.ok, false);
  assert.equal(output.checks[0].http_status, 200);
  assert.equal(output.checks[0].error, 'timeout');
  assert.equal(output.checks[1].content_matched, false);
  assert.equal(output.checks[2].content_type_matched, false);
  assert.equal(output.checks[2].content_matched, true);
  assert.equal(output.checks[3].error, 'ECONNREFUSED');
  assert.equal(JSON.stringify(output).includes(PRIVATE_DETAIL), false);
});

test('18766をHTTPの送信先・Origin・診断・Web配信確認で共有し、NLI接続先は8765のままにする', async () => {
  const origin = 'http://127.0.0.1:18766';
  let intentCalls = 0;
  const report = await probeHttp({ port: 18766, fetchImpl: async (url, init) => {
    intentCalls += 1;
    assert.equal(url, `${origin}/api/intent`);
    assert.equal(init.headers.Origin, origin);
    return new Response(null, { status: 503 });
  } });
  assert.equal(intentCalls, 19);
  assert.equal(report.metadata.endpoint, `${origin}/api/intent`);
  const diagnosed = [];
  const output = capture();
  assert.equal(await runCli(['--diagnose'], { ...output, port: 18766, fetchImpl: async (url) => {
    diagnosed.push(url);
    return Response.json(url.includes(':18766/') ? { employees: [] } : savedRecords[1].rawResponse);
  } }), 0);
  assert.deepEqual(diagnosed, [`${origin}/api/employees`, 'http://127.0.0.1:8765/v1/systemone']);
  const paths = [];
  const web = await diagnoseWeb({
    port: 18766, readAsset: async () => Buffer.from('fixed test asset'),
    fetchImpl: async (url) => {
      assert.equal(new URL(url).origin, origin);
      const path = new URL(url).pathname;
      paths.push(path);
      const type = path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html';
      return new Response('fixed test asset', { headers: { 'Content-Type': type } });
    },
  });
  assert.equal(web.ok, true);
  assert.equal(web.origin, origin);
  assert.deepEqual(paths, ['/', '/legacy', '/app.js', '/app.css']);
});

test('不正ポートはHTTP通信の前に拒否し、CLIは環境の実値を含まない固定日本語エラーにする', async () => {
  const noFetch = async () => assert.fail('不正ポートで通信しない');
  for (const port of [0, 1023, 65536, 8766.5, '8766/raw-private-setting']) {
    for (const check of [probeHttp, diagnose, diagnoseWeb]) {
      await assert.rejects(check({ port, fetchImpl: noFetch }), (error) => error.code === 'invalid_port');
    }
    for (const args of [[], ['--diagnose'], ['--web-diagnose']]) {
      const output = capture();
      assert.equal(await runCli(args, { ...output, port, fetchImpl: noFetch }), 1);
      const result = JSON.parse(output.lines[0]);
      assert.equal(result.error, 'invalid_port');
      assert.equal(result.message, 'INUI_POC_PORTには1024〜65535の整数を指定してください。');
      assert.equal(JSON.stringify(output).includes('raw-private-setting'), false);
    }
  }
});

test('不正引数では通信せず、安全な失敗reportと終了1を返す', async () => {
  for (const args of [['--invalid'], ['--replay'], ['--requests', 'extra'], ['--diagnose', 'extra']]) {
    const output = capture();
    assert.equal(await runCli(args, { ...output, fetchImpl: async () => assert.fail('引数エラーで通信しない') }), 1);
    assert.equal(output.lines.length, 1);
    const result = JSON.parse(output.lines[0]);
    assert.equal(result.error, 'invalid_arguments');
    assert.equal(result.summary.criterion_met, false);
    assert.deepEqual(result.results, []);
    assert.equal(typeof result.message, 'string');
    assert.deepEqual(output.status, []);
  }
});
