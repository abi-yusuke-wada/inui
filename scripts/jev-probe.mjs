import { pathToFileURL } from 'node:url';

export const MODEL = 'jev-1.14.0';
const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const CRITERIA = {
  leave_request: '休暇・有給・半休の申請フォームを開く要求。',
  expense_request: '交通費の経費精算フォームを開く要求。',
  application_status: '自分が提出した申請の一覧や状態を確認する要求。状態による絞り込みも含む。',
  unsupported_feature: '休暇申請・交通費精算・申請状況の確認以外の機能や申請書を求めている。',
  unsupported_operation: '申請の取り下げ・修正・承認・差し戻しなど、今回扱わない操作を求めている。',
  clarify: '申請の種類や目的が不明で、対象の画面を特定できない。再入力が必要。',
};

// MVP.mdの9入力と、対象外・曖昧な4入力。ここではIntentだけを比較する。
export const CASES = [
  { id: 'leave-no-date', text: '有給を取りたい', expected: 'leave_request' },
  { id: 'leave-tomorrow', text: '明日有給を取りたい', expected: 'leave_request' },
  { id: 'leave-afternoon', text: '11月10日の午後に半休を取りたい', expected: 'leave_request' },
  { id: 'expense-no-values', text: '交通費を精算したい', expected: 'expense_request' },
  { id: 'expense-yesterday', text: '昨日の交通費1,200円を精算したい', expected: 'expense_request' },
  { id: 'expense-dated', text: '2026年10月30日の電車代640円を申請したい', expected: 'expense_request' },
  { id: 'status-all', text: '申請の状況を見たい', expected: 'application_status' },
  { id: 'status-pending', text: '承認待ちの申請を見せて', expected: 'application_status' },
  { id: 'status-returned', text: '差し戻された申請はある？', expected: 'application_status' },
  { id: 'unsupported-travel', text: '出張を申請したい', expected: 'unsupported_feature' },
  { id: 'unsupported-room', text: '会議室を予約したい', expected: 'unsupported_feature' },
  { id: 'unsupported-cancel', text: '申請を取り下げたい', expected: 'unsupported_operation' },
  { id: 'clarify-application', text: '申請したい', expected: 'clarify' },
];

class ProbeError extends Error {}

export function buildRequest(text) {
  return {
    model: MODEL,
    state: text,
    questions: {
      intent: {
        type: 'choice',
        instructions: '入力の利用者が何を求めているかを、候補の説明に従って分類してください。',
        criteria: { ...CRITERIA },
      },
    },
  };
}

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isProbability = (value) => Number.isFinite(value) && value >= 0 && value <= 1;
const isTokenCount = (value) => Number.isSafeInteger(value) && value >= 0;

export function validateResponse(body) {
  const answer = body?.answers?.intent;
  const probabilities = answer?.probabilities;
  const names = Object.keys(CRITERIA);
  if (
    !isRecord(body) || body.model !== MODEL ||
    !isRecord(answer) || answer.type !== 'choice' ||
    !Object.hasOwn(CRITERIA, answer.choice) || !isProbability(answer.confidence) ||
    !isRecord(probabilities) || Object.keys(probabilities).length !== names.length ||
    !names.every((name) => Object.hasOwn(probabilities, name) && isProbability(probabilities[name])) ||
    !isRecord(body.usage) || !isTokenCount(body.usage.input_tokens) || !isTokenCount(body.usage.output_tokens)
  ) {
    throw new ProbeError('Jevの応答が検証用の契約に一致しません。');
  }
  // 確率の合計にはJSONの小数表現による丸め誤差だけを許す。
  if (Math.abs(names.reduce((sum, name) => sum + probabilities[name], 0) - 1) > 0.000001) {
    throw new ProbeError('Jevの確率の合計が1ではありません。');
  }
  if (probabilities[answer.choice] < Math.max(...names.map((name) => probabilities[name]))) {
    throw new ProbeError('Jevの選択と最大確率の候補が一致しません。');
  }
  return {
    model: body.model,
    answer,
    usage: { input_tokens: body.usage.input_tokens, output_tokens: body.usage.output_tokens },
  };
}

async function requestDecision(text, apiKey, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(buildRequest(text)),
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    // 外部例外や応答本文は認証情報を含む可能性があるため出力しない。
    throw new ProbeError('Jevへの接続が失敗またはタイムアウトしました。');
  }
  if (!response.ok) {
    const status = Number.isInteger(response.status) ? response.status : 'unknown';
    throw new ProbeError(`Jev APIのHTTPエラー: ${status}`);
  }
  let body;
  try {
    body = await response.json();
  } catch {
    throw new ProbeError('Jevの応答をJSONとして読み取れません。');
  }
  return validateResponse(body);
}

export async function runProbe({ live = false, apiKey, fetchImpl = globalThis.fetch, write = console.log } = {}) {
  if (live && (typeof apiKey !== 'string' || apiKey.trim() === '')) {
    write(JSON.stringify({ error: '実接続にはTYPESAFE_API_KEYが必要です。キーの値は出力しません。' }));
    return 1;
  }
  let failures = 0;
  for (const sample of CASES) {
    if (!live) {
      write(JSON.stringify({ case_id: sample.id, expected: sample.expected, status: 'not_run', request: buildRequest(sample.text) }));
      continue;
    }
    const started = performance.now();
    let result;
    try {
      result = await requestDecision(sample.text, apiKey, fetchImpl);
    } catch (error) {
      const message = error instanceof ProbeError ? error.message : '検証処理に失敗しました。';
      write(JSON.stringify({ case_id: sample.id, status: 'error', error: message }));
      return 1;
    }
    const matched = result.answer.choice === sample.expected;
    if (!matched) failures += 1;
    write(JSON.stringify({
      case_id: sample.id, text: sample.text, expected: sample.expected,
      actual: result.answer.choice, matched, model: result.model,
      confidence: result.answer.confidence, probabilities: result.answer.probabilities,
      usage: result.usage, elapsed_ms: Math.round(performance.now() - started),
    }));
  }
  return failures === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const mode = args[0] ?? '--dry-run';
  if (args.length > 1 || !['--dry-run', '--live'].includes(mode)) {
    console.error('使い方: node scripts/jev-probe.mjs [--dry-run|--live]');
    process.exitCode = 1;
  } else {
    process.exitCode = await runProbe({
      live: mode === '--live',
      apiKey: mode === '--live' ? process.env.TYPESAFE_API_KEY : undefined,
    });
  }
}
