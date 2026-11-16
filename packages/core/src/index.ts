export const LOCAL_MODEL = 'nli-deberta-large';

export type Intent =
  | 'markdown_view'
  | 'task_board'
  | 'whiteboard'
  | 'schedule_compare'
  | 'unsupported_feature'
  | 'unsupported_operation'
  | 'clarify';

type ScreenIntent = Extract<Intent, 'markdown_view' | 'task_board' | 'whiteboard' | 'schedule_compare'>;
type NoticeIntent = Exclude<Intent, ScreenIntent>;

export type RoutingDecision =
  | { [Name in ScreenIntent]: { kind: 'screen'; intent: Name; ui: Name } }[ScreenIntent]
  | { kind: 'notice'; intent: NoticeIntent; message: string };

type DecisionErrorCode = 'invalid_input' | 'invalid_response' | 'unavailable' | 'timeout';

const ERROR_MESSAGES: Record<DecisionErrorCode, string> = {
  invalid_input: '入力は空白を除いて1〜2000文字で指定してください。',
  invalid_response: '判定結果を確認できませんでした。もう一度お試しください。',
  unavailable: '判定サービスに接続できません。時間をおいてお試しください。',
  timeout: '判定に時間がかかっています。もう一度お試しください。',
};

/** 接続先の本文や例外の詳細を含まない、利用者へ返せる判定エラー。 */
export class DecisionError extends Error {
  readonly code: DecisionErrorCode;

  constructor(code: DecisionErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'DecisionError';
    this.code = code;
  }
}

// Issue #10で題材を、利用者（システムエンジニア）が普段使う文書・タスク・予定へ入れ替えた。
// 予定比較と対象外操作の説明は、申請を題材にした19入力で採用したものを基準にしている。
const LOCAL_CRITERIA = {
  markdown_view: '利用者はMarkdown（マークダウン）ファイルやREADME・ADRなどの文書を、読みやすく表示して読みたい。',
  task_board: '利用者は自分のタスク、GitHubのIssue、レビュー待ちや自分が出したプルリクエスト（プルリク）、Backlogの課題を一覧で確認したい、またはやることを書き留めたい。',
  whiteboard: '利用者はホワイトボードを開いて、手書きで絵や図を描きたい、または描いた絵を見返したい。',
  schedule_compare: '利用者は複数の社員のスケジュールや予定を確認・比較したい。',
  unsupported_feature: '利用者は会議室予約や経費精算など、文書の表示・タスクの確認・ホワイトボード・社員の予定比較以外の、具体的に名前を挙げたサービスを利用したい。',
  unsupported_operation: '利用者はプルリクエストをマージする、IssueやPRを作成・クローズする、文書を編集する、または会議や予定を登録・削除したい。',
  unspecified_request: '利用者は動作だけを述べており、文書・タスク・ホワイトボード・予定など、何を扱いたいかの対象を示していない。',
};

type WireIntent = keyof typeof LOCAL_CRITERIA;
const WIRE_INTENTS = Object.keys(LOCAL_CRITERIA) as WireIntent[];
// local-jevは確率を小数4桁へ丸めるため、候補それぞれの丸め誤差だけを許す。
const PROBABILITY_TOLERANCE = WIRE_INTENTS.length * 0.00005 + Number.EPSILON;

const NOTICE_MESSAGES: Record<NoticeIntent, string> = {
  unsupported_feature: 'この機能には対応していません。Markdownの表示、タスクの確認、ホワイトボード、予定の比較を利用できます。',
  unsupported_operation: 'この操作には対応していません。PRのマージ、Issue・PRの作成やクローズ、予定の登録・削除は行えません。',
  clarify: 'Markdownの表示、タスクの確認、ホワイトボード、予定の比較のどれを行いたいか入力してください。',
};

/** 入力を検証し、前後の空白だけを取り除く。 */
function normalizeText(text: string): string {
  if (typeof text !== 'string') throw new DecisionError('invalid_input');
  const normalized = text.trim();
  if (normalized.length < 1 || normalized.length > 2000) throw new DecisionError('invalid_input');
  return normalized;
}

/** 固定モデル・7候補のChoiceリクエストを作る。人名や業務引数は抽出しない。 */
export function buildLocalRequest(text: string) {
  return {
    model: LOCAL_MODEL,
    state: normalizeText(text),
    questions: {
      intent: {
        type: 'choice' as const,
        instructions: '入力の利用者が何を求めているかを、候補の説明に従って分類してください。',
        criteria: { ...LOCAL_CRITERIA },
      },
    },
  };
}

/** JSONのオブジェクトかを判定する。配列とnullは受け付けない。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 必須キーがすべて自身のプロパティで存在し、余分なキーがないことを確認する。 */
function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

/** 有限な0以上1以下の確率だけを受け付ける。 */
function isProbability(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

/** トークン使用量は非負の安全な整数だけを受け付ける。 */
function isTokenCount(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** 検証済みのwire候補を、事前実装した画面か固定の案内へ対応付ける。 */
function toDecision(choice: WireIntent): RoutingDecision {
  switch (choice) {
    case 'markdown_view':
      return { kind: 'screen', intent: choice, ui: choice };
    case 'task_board':
      return { kind: 'screen', intent: choice, ui: choice };
    case 'whiteboard':
      return { kind: 'screen', intent: choice, ui: choice };
    case 'schedule_compare':
      return { kind: 'screen', intent: choice, ui: choice };
    case 'unsupported_feature':
    case 'unsupported_operation':
      return { kind: 'notice', intent: choice, message: NOTICE_MESSAGES[choice] };
    case 'unspecified_request':
      return { kind: 'notice', intent: 'clarify', message: NOTICE_MESSAGES.clarify };
  }
}

/**
 * ローカルHTTP応答のモデル・候補・確率・使用量を検証してから判断を返す。
 * モデルからのTool・UI・argsなど、契約にないフィールドは受け付けない。
 */
export function parseLocalResponse(body: unknown): RoutingDecision {
  if (!isRecord(body) || !hasExactKeys(body, ['model', 'answers', 'usage']) || body.model !== LOCAL_MODEL) {
    throw new DecisionError('invalid_response');
  }
  const answers = body.answers;
  const usage = body.usage;
  if (!isRecord(answers) || !hasExactKeys(answers, ['intent']) ||
      !isRecord(usage) || !hasExactKeys(usage, ['input_tokens', 'output_tokens']) ||
      !isTokenCount(usage.input_tokens) || !isTokenCount(usage.output_tokens)) {
    throw new DecisionError('invalid_response');
  }
  const answer = answers.intent;
  if (!isRecord(answer) || !hasExactKeys(answer, ['type', 'choice', 'confidence', 'probabilities']) ||
      answer.type !== 'choice' || typeof answer.choice !== 'string' ||
      !Object.hasOwn(LOCAL_CRITERIA, answer.choice) || !isProbability(answer.confidence)) {
    throw new DecisionError('invalid_response');
  }
  const probabilities = answer.probabilities;
  if (!isRecord(probabilities) || !hasExactKeys(probabilities, WIRE_INTENTS) ||
      !WIRE_INTENTS.every((intent) => isProbability(probabilities[intent]))) {
    throw new DecisionError('invalid_response');
  }
  const values = WIRE_INTENTS.map((intent) => probabilities[intent] as number);
  if (Math.abs(values.reduce((sum, value) => sum + value, 0) - 1) > PROBABILITY_TOLERANCE ||
      (probabilities[answer.choice] as number) < Math.max(...values)) {
    throw new DecisionError('invalid_response');
  }
  return toDecision(answer.choice as WireIntent);
}

/** 認証情報やパスを含まないloopback URLだけを接続先として受け付ける。 */
function localEndpoint(baseUrl: string): string {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    throw new DecisionError('unavailable');
  }
  if (!['http:', 'https:'].includes(base.protocol) ||
      !['localhost', '127.0.0.1', '[::1]'].includes(base.hostname) ||
      base.username || base.password || base.search || base.hash || base.pathname !== '/') {
    throw new DecisionError('unavailable');
  }
  return new URL('/v1/systemone', base).href;
}

/**
 * サーバー側で固定ローカルモデルを呼ぶルーターを作る。公式APIや環境のキーは参照しない。
 * fetchの完了に加えJSON本文の読み取りもタイムアウトの対象とする。
 */
export function createIntentRouter({
  baseUrl = 'http://127.0.0.1:8765',
  timeoutMs = 25_000,
  fetchImpl = globalThis.fetch,
}: { baseUrl?: string; timeoutMs?: number; fetchImpl?: typeof fetch } = {}) {
  const endpoint = localEndpoint(baseUrl);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647 || typeof fetchImpl !== 'function') {
    throw new DecisionError('unavailable');
  }

  return async (text: string): Promise<RoutingDecision> => {
    const request = buildLocalRequest(text);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new DecisionError('timeout'));
        controller.abort();
      }, timeoutMs);
    });
    const operation = async (): Promise<RoutingDecision> => {
      let response: Response;
      try {
        response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request),
          redirect: 'error',
          signal: controller.signal,
        });
      } catch {
        throw new DecisionError('unavailable');
      }
      if (!response.ok) {
        // 本文を読まないため、通信を中止して接続を解放する（再試行で接続が残り続けないようにする）。
        controller.abort();
        throw new DecisionError('unavailable');
      }
      // 推論サーバーが入力を切り詰めた場合は、短縮前と異なる判定になりうるため結果を使わない。
      if (response.headers?.get('x-local-jev-truncated') === 'true') {
        controller.abort();
        throw new DecisionError('invalid_input');
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new DecisionError('invalid_response');
      }
      return parseLocalResponse(body);
    };
    try {
      return await Promise.race([operation(), deadline]);
    } finally {
      clearTimeout(timer);
    }
  };
}
