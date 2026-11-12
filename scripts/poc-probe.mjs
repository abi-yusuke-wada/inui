import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';
import { CASES } from './jev-probe.mjs';
import { LOCAL_MODEL, buildLocalRequest, parseLocalResponse } from '../packages/core/src/index.ts';
import { selectPeople } from '../src/people.ts';
import { appPort, appOrigin } from '../src/local-config.ts';

const REVISION = 'cf44676c28ba7312e5c5f8f8d2c22b3e0c9cdae2';
const ENGINE_TRANSPORT = 'in-process-local-jev-engine';
const SCREENS = ['leave_request', 'expense_request', 'application_status', 'schedule_compare'];
const NOTICES = ['unsupported_feature', 'unsupported_operation', 'clarify'];
const noAmbiguity = (selectedIds) => ({ selectedIds, ambiguous: [], unknownNames: [] });

// 既存13件の期待値は参照し、予定比較の4件と対象外操作の2件だけを加える。
export const POC_CASES = [
  ...CASES.map((sample) => ({ ...sample, expectedPeople: null })),
  {
    id: 'schedule-fullnames', text: '山田太郎さんと佐藤花子さんのスケジュールを確認したい', expected: 'schedule_compare',
    expectedPeople: noAmbiguity(['person-yamada-taro', 'person-sato-hanako']),
  },
  {
    id: 'schedule-unique-surnames', text: '佐藤さんと鈴木さんの予定を見たい', expected: 'schedule_compare',
    expectedPeople: noAmbiguity(['person-sato-hanako', 'person-suzuki-ichiro']),
  },
  {
    id: 'schedule-ambiguous-surname', text: '山田さんと佐藤さんの予定を見たい', expected: 'schedule_compare',
    expectedPeople: {
      selectedIds: ['person-sato-hanako'],
      ambiguous: [{ name: '山田', candidateIds: ['person-yamada-taro', 'person-yamada-hanako'] }], unknownNames: [],
    },
  },
  {
    id: 'schedule-unknown-person', text: '田村さんと佐藤花子さんの予定を確認したい', expected: 'schedule_compare',
    expectedPeople: { selectedIds: ['person-sato-hanako'], ambiguous: [], unknownNames: ['田村'] },
  },
  { id: 'unsupported-schedule-delete', text: '山田太郎さんの予定を削除したい', expected: 'unsupported_operation', expectedPeople: null },
  { id: 'unsupported-schedule-create', text: '佐藤さんと鈴木さんの会議を登録したい', expected: 'unsupported_operation', expectedPeople: null },
];

/** 現コアの質問を入力と結び付け、Python側へそのまま渡す。 */
export function requests() {
  return POC_CASES.map((sample) => ({ ...sample, request: buildLocalRequest(sample.text) }));
}

/** 候補説明・入力・期待値を含む同一データか、保存結果の再生時にも確認する。 */
export function requestsDigest() {
  return createHash('sha256').update(JSON.stringify(requests())).digest('hex');
}

class ProbeError extends Error {
  constructor(code, httpStatus) { super(code); this.code = code; this.httpStatus = httpStatus; }
}

/** ポートだけを設定可能にし、接続先のホストはloopbackへ固定する。 */
function selectedOrigin(port) {
  try { return appOrigin(appPort(port === undefined ? undefined : { INUI_POC_PORT: String(port) })); }
  catch { throw new ProbeError('invalid_port'); }
}
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) => isRecord(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const elapsedValid = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** APIから受けた自由な本文は記録せず、許可した判断と辞書の選択だけを照合する。 */
function parseApiDecision(body, sample) {
  if (!isRecord(body)) throw new ProbeError('invalid_response');
  if (body.kind === 'screen' && SCREENS.includes(body.intent) && body.ui === body.intent
      && exactKeys(body, body.intent === 'schedule_compare' ? ['kind', 'intent', 'ui', 'people'] : ['kind', 'intent', 'ui'])) {
    if (body.intent === 'schedule_compare' && !isDeepStrictEqual(body.people, selectPeople(sample.text))) {
      throw new ProbeError('invalid_people');
    }
    return { kind: 'screen', intent: body.intent, ui: body.ui,
      ...(body.intent === 'schedule_compare' ? { people: body.people } : {}) };
  }
  if (body.kind === 'notice' && NOTICES.includes(body.intent) && typeof body.message === 'string'
      && exactKeys(body, ['kind', 'intent', 'message'])) {
    return { kind: 'notice', intent: body.intent };
  }
  throw new ProbeError('invalid_response');
}

/** 成否を現行の期待値で計算する。ファイル内のmatchedや期待値は採用しない。 */
function resultFor(sample, decision, elapsed, extra = {}) {
  const people = decision.intent === 'schedule_compare' ? selectPeople(sample.text) : null;
  const intentMatched = decision.intent === sample.expected;
  const peopleMatched = sample.expectedPeople === null ? null : isDeepStrictEqual(people, sample.expectedPeople);
  return {
    sampleID: sample.id, text: sample.text, expected: sample.expected, actual: decision.intent,
    matched: intentMatched && peopleMatched !== false, intent_matched: intentMatched,
    people_matched: peopleMatched, elapsed_ms: elapsed, people, ...extra,
  };
}

/** 正常・対象外と曖昧入力・人名選択を別集計する。時間はこの呼出経路に限る。 */
function report(transport, metadata, results) {
  const normal = results.filter((row) => SCREENS.includes(row.expected));
  const abnormal = results.filter((row) => !SCREENS.includes(row.expected));
  const people = results.filter((row) => POC_CASES.find((sample) => sample.id === row.sampleID)?.expectedPeople !== null);
  const times = results.map((row) => row.elapsed_ms).filter(elapsedValid).sort((a, b) => a - b);
  const count = (rows) => ({ matched: rows.filter((row) => row.matched).length, total: rows.length });
  return {
    transport, metadata,
    summary: {
      ...count(results), normal: count(normal), abnormal: count(abnormal),
      people: { matched: people.filter((row) => row.people_matched === true).length, total: people.length },
      criterion_met: results.length === 19 && results.every((row) => row.matched),
      elapsed_ms: times.length ? {
        mean: times.reduce((sum, value) => sum + value, 0) / times.length,
        median: times.length % 2 ? times[Math.floor(times.length / 2)] : (times[times.length / 2 - 1] + times[times.length / 2]) / 2,
        max: times.at(-1),
      } : null,
    },
    results,
  };
}

/** 再生時の実行条件を限定し、別のモデルや質問の結果を現コアの実測へ混ぜない。 */
function checkMetadata(metadata) {
  const keys = ['model', 'transport', 'response_conversion', 'http_route_executed', 'torch_threads',
    'torch_interop_threads', 'warmup', 'runtime', 'device', 'dtype', 'hf_model', 'hf_revision',
    'temperature', 'model_load_ms', 'requests_sha256', 'case_count', 'peak_rss'];
  if (!exactKeys(metadata, keys) || metadata.model !== LOCAL_MODEL || metadata.transport !== ENGINE_TRANSPORT
      || metadata.response_conversion !== 'SystemOneResponse.model_validate(raw).model_dump()'
      || metadata.http_route_executed !== false || metadata.torch_threads !== 4 || metadata.torch_interop_threads !== 1
      || metadata.warmup !== false || metadata.device !== 'cpu' || metadata.dtype !== 'torch.float32'
      || metadata.hf_revision !== REVISION || metadata.requests_sha256 !== requestsDigest() || metadata.case_count !== 19
      || typeof metadata.hf_model !== 'string' || !elapsedValid(metadata.model_load_ms)
      || !exactKeys(metadata.runtime, ['local-jev', 'torch', 'transformers'])
      || !Object.values(metadata.runtime).every((value) => typeof value === 'string' && value.length > 0)
      || !isRecord(metadata.temperature)
      || !Object.values(metadata.temperature).every((value) => typeof value === 'number' && Number.isFinite(value) && value > 0)
      || !exactKeys(metadata.peak_rss, ['value', 'unit', 'platform', 'scope'])
      || !elapsedValid(metadata.peak_rss.value) || !['KiB', 'bytes', 'platform-native'].includes(metadata.peak_rss.unit)
      || typeof metadata.peak_rss.platform !== 'string'
      || metadata.peak_rss.scope !== 'Python process through 19 Engine calls; not a deployed Lambda measurement') {
    throw new ProbeError('invalid_metadata');
  }
}

/** 完全な19件のJSONLだけを受け付け、coreと人名処理で独立に再検証する。 */
export function replay(jsonl) {
  let records;
  try { records = jsonl.trim().split('\n').map((line) => JSON.parse(line)); }
  catch { throw new ProbeError('invalid_replay'); }
  if (records.length !== 20 || !exactKeys(records[0], ['type', 'metadata']) || records[0].type !== 'metadata') {
    throw new ProbeError('invalid_replay');
  }
  const metadata = records[0].metadata;
  checkMetadata(metadata);
  const results = POC_CASES.map((sample, index) => {
    const record = records[index + 1];
    if (!exactKeys(record, ['type', 'sampleID', 'rawResponse', 'elapsed_ms', 'truncated'])
        || record.type !== 'result' || record.sampleID !== sample.id || !elapsedValid(record.elapsed_ms)) {
      throw new ProbeError('invalid_replay');
    }
    const decision = parseLocalResponse(record.rawResponse);
    const row = resultFor(sample, decision, record.elapsed_ms, { truncated: record.truncated, rawResponse: record.rawResponse });
    // 短い検証入力が省略された結果や、省略有無が不明な結果は合格にしない。
    if (record.truncated !== false) {
      row.matched = false;
      row.error = 'truncated_or_unknown';
    }
    return row;
  });
  return report(ENGINE_TRANSPORT, metadata, results);
}

/** 業務保存を呼ばず、同一OriginのIntent受付だけを30秒ずつ確認する。 */
export async function probeHttp({ fetchImpl = globalThis.fetch, port } = {}) {
  const origin = selectedOrigin(port);
  const results = [];
  for (const sample of POC_CASES) {
    const started = performance.now();
    const controller = new AbortController();
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => { reject(new ProbeError('timeout')); controller.abort(); }, 30_000);
    });
    try {
      const operation = async () => {
        const response = await fetchImpl(`${origin}/api/intent`, {
          method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: sample.text }), redirect: 'error', signal: controller.signal,
        });
        if (!response.ok) throw new ProbeError('http_error', response.status);
        return parseApiDecision(await response.json(), sample);
      };
      const decision = await Promise.race([operation(), deadline]);
      results.push(resultFor(sample, decision, Math.round(performance.now() - started)));
    } catch (error) {
      results.push({ sampleID: sample.id, text: sample.text, expected: sample.expected, actual: null,
        matched: false, intent_matched: false, people_matched: sample.expectedPeople === null ? null : false,
        elapsed_ms: Math.round(performance.now() - started), error: error instanceof ProbeError ? error.code : 'request_failed',
        http_status: error instanceof ProbeError && Number.isInteger(error.httpStatus) ? error.httpStatus : null });
    } finally { clearTimeout(timer); }
  }
  return report('http-local-poc-api', {
    endpoint: `${origin}/api/intent`, expected_model: LOCAL_MODEL, requests_sha256: requestsDigest(),
    runtime: null, hf_revision: null, server_configuration_observed: false,
    measurement_scope: 'Intent受付のみ。ブラウザ・画面表示・業務保存・正式なIssue #15の測定を含まない。',
  }, results);
}

/** 固定の2サービスだけを確認し、応答本文や外部例外の詳細は表示しない。 */
export async function diagnose({ fetchImpl = globalThis.fetch, port } = {}) {
  const origin = selectedOrigin(port);
  const checks = [];
  for (const service of ['app', 'local-jev']) {
    try {
      const response = await fetchImpl(service === 'app' ? `${origin}/api/employees` : 'http://127.0.0.1:8765/v1/systemone', {
        ...(service === 'local-jev' ? {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(buildLocalRequest(POC_CASES[0].text)),
        } : {}),
        redirect: 'error', signal: AbortSignal.timeout(service === 'app' ? 2_000 : 25_000),
      });
      if (!response.ok) { checks.push({ service, ok: false, http_status: response.status }); continue; }
      if (service === 'local-jev') parseLocalResponse(await response.json());
      checks.push({ service, ok: true, http_status: response.status });
    } catch (error) {
      const codes = ['ECONNREFUSED', 'ECONNRESET', 'EPERM', 'EACCES', 'ETIMEDOUT', 'EAI_AGAIN'];
      const code = codes.includes(error?.cause?.code) ? error.cause.code
        : error?.name === 'TimeoutError' ? 'timeout' : 'connection_or_contract_error';
      checks.push({ service, ok: false, error: code });
    }
  }
  return { ok: checks.every((check) => check.ok), checks };
}

/** 配信を本文受信まで確認し、公開ビルドとの一致だけを記録する。推論は呼ばない。 */
export async function diagnoseWeb({ fetchImpl = globalThis.fetch, readAsset = readFile, timeoutMs = 3000, port } = {}) {
  const origin = selectedOrigin(port);
  const checks = [];
  const assets = [
    ['/', 'index.html', 'text/html'], ['/legacy', 'index.html', 'text/html'],
    ['/app.js', 'app.js', 'text/javascript'], ['/app.css', 'app.css', 'text/css'],
  ];
  for (const [path, filename, contentType] of assets) {
    const started = performance.now();
    const controller = new AbortController();
    let timer;
    let httpStatus;
    try {
      let expected;
      try { expected = await readAsset(new URL(`../dist/public/${filename}`, import.meta.url)); }
      catch { throw new ProbeError('build_missing'); }
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => { reject(new ProbeError('timeout')); controller.abort(); }, timeoutMs);
      });
      const operation = async () => {
        const response = await fetchImpl(`${origin}${path}`, { redirect: 'error', signal: controller.signal });
        httpStatus = response.status;
        if (!response.ok) throw new ProbeError('http_error');
        const typeMatched = response.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase() === contentType;
        const body = new Uint8Array(await response.arrayBuffer());
        const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
        const contentMatched = digest(body) === digest(expected);
        return { ok: typeMatched && contentMatched, bytes: body.byteLength,
          content_type_matched: typeMatched, content_matched: contentMatched };
      };
      const result = await Promise.race([operation(), deadline]);
      checks.push({ path, http_status: httpStatus, ...result, elapsed_ms: Math.round(performance.now() - started) });
    } catch (error) {
      const codes = ['ECONNREFUSED', 'ECONNRESET', 'EPERM', 'EACCES', 'ETIMEDOUT', 'EAI_AGAIN'];
      checks.push({ path, ok: false, http_status: httpStatus ?? null,
        error: error instanceof ProbeError ? error.code : codes.includes(error?.cause?.code) ? error.cause.code : 'request_failed',
        elapsed_ms: Math.round(performance.now() - started) });
    } finally { clearTimeout(timer); controller.abort(); }
  }
  return { origin, ok: checks.every((check) => check.ok), checks };
}

/** CLIは安全なエラー種別だけを出し、読み込んだ本文や上流例外を表示しない。 */
export async function runCli(args, { write = console.log, writeStatus = console.error, fetchImpl = globalThis.fetch, port } = {}) {
  try {
    if (args.length === 1 && args[0] === '--requests') { write(JSON.stringify(requests())); return 0; }
    if (args.length === 1 && args[0] === '--web-diagnose') {
      const output = await diagnoseWeb({ fetchImpl, port });
      write(JSON.stringify(output));
      for (const check of output.checks) {
        writeStatus(`${check.path}: ${check.http_status ? `HTTP ${check.http_status}, ` : ''}${check.ok ? '配信完了・ビルドと一致' : check.error ?? '形式または内容がビルドと不一致'}`);
      }
      return output.ok ? 0 : 1;
    }
    if (args.length === 1 && args[0] === '--diagnose') {
      const output = await diagnose({ fetchImpl, port });
      write(JSON.stringify(output));
      for (const check of output.checks) writeStatus(`${check.service}: ${check.http_status ? `HTTP ${check.http_status}` : check.error}`);
      return output.ok ? 0 : 1;
    }
    let output;
    if (args.length === 2 && args[0] === '--replay') output = replay(await readFile(args[1], 'utf8'));
    else if (args.length === 0) output = await probeHttp({ fetchImpl, port });
    else throw new ProbeError('invalid_arguments');
    write(JSON.stringify(output));
    if (args.length === 0) {
      writeStatus(`HTTP確認: ${output.summary.matched}/${output.summary.total}件一致`);
      for (const row of output.results.filter((result) => !result.matched)) {
        writeStatus(`${row.sampleID}: ${row.http_status ? `HTTP ${row.http_status}` : row.error ?? `期待=${row.expected}, 実際=${row.actual}`}`);
      }
    }
    return output.summary.criterion_met ? 0 : 1;
  } catch (error) {
    write(JSON.stringify({ ...report(args[0] === '--replay' ? ENGINE_TRANSPORT : 'not-run', null, []),
      error: error instanceof ProbeError ? error.code : 'validation_failed',
      message: error instanceof ProbeError && error.code === 'invalid_port'
        ? 'INUI_POC_PORTには1024〜65535の整数を指定してください。'
        : '検証を完了できませんでした。入力ファイルとローカルの設定を確認してください。' }));
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runCli(process.argv.slice(2));
}
