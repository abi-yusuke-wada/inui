/** 外部の応答本文や例外を画面へ渡さず、失敗の種類だけを保持する。 */
export class ApiError extends Error {
  kind: 'http' | 'network' | 'invalid' | 'timeout' | 'aborted';
  status: number | undefined;
  code: string | undefined;
  constructor(kind: ApiError['kind'], status?: number, code?: string) {
    super('操作を完了できませんでした。');
    this.name = 'ApiError';
    this.kind = kind;
    this.status = status;
    this.code = code;
  }
}

/** 次の要求や画面の破棄後に、以前の応答を反映しないための境界。 */
export class LatestRequest {
  private controller: AbortController | undefined;
  begin() {
    this.cancel();
    const controller = new AbortController();
    this.controller = controller;
    return {
      signal: controller.signal,
      isCurrent: () => this.controller === controller && !controller.signal.aborted,
    };
  }
  cancel() {
    this.controller?.abort();
    this.controller = undefined;
  }
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** エラーの種類は本文を読まずにヘッダーから受け取り、固定形式のコードだけを採用する。 */
function errorCode(response: Response): string | undefined {
  const code = response.headers?.get?.('X-Error-Code');
  return typeof code === 'string' && /^[a-z_]{1,40}$/.test(code) ? code : undefined;
}

/** 同一オリジンのAPIを呼び、エラー本文を表示用の情報に使わない。 */
export async function fetchJson(
  url: string,
  options: {
    method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
    body?: unknown;
    signal?: AbortSignal;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  } = {},
): Promise<unknown> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) controller.abort();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs ?? 30_000);
  try {
    if (controller.signal.aborted) throw new ApiError('aborted');
    let response: Response;
    try {
      response = await (options.fetchImpl ?? globalThis.fetch)(url, {
        method: options.method ?? 'GET',
        credentials: 'same-origin',
        redirect: 'error',
        ...(options.body === undefined ? {} : {
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(options.body),
        }),
        signal: controller.signal,
      });
    } catch {
      throw new ApiError(timedOut ? 'timeout' : controller.signal.aborted ? 'aborted' : 'network');
    }
    // エラー本文は読まず、表示用の情報に使わない。
    if (!response.ok) throw new ApiError('http', response.status, errorCode(response));
    try {
      return await response.json();
    } catch {
      throw new ApiError(timedOut ? 'timeout' : 'invalid');
    }
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
  }
}

export function errorMessage(error: unknown, action: string): string {
  if (error instanceof ApiError && error.status === 400) return '入力内容を確認して、もう一度お試しください。';
  if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
    return 'この操作を利用できません。ページを再読み込みしてお試しください。';
  }
  if (error instanceof ApiError && (error.kind === 'timeout' || error.status === 504)) {
    return action + 'に時間がかかっています。時間をおいてお試しください。';
  }
  return action + 'ができませんでした。接続を確認して、もう一度お試しください。';
}
