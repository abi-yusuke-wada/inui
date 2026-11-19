export type UpstreamErrorCode = 'upstream_auth' | 'upstream_unavailable' | 'upstream_timeout' | 'upstream_invalid';

/** 連携先の失敗。URL・応答本文・例外の内容は保持しない。 */
export class UpstreamError extends Error {
  readonly code: UpstreamErrorCode;
  constructor(code: UpstreamErrorCode) {
    super(code);
    this.name = 'UpstreamError';
    this.code = code;
  }
}

export interface UpstreamOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export const DEFAULT_UPSTREAM_TIMEOUT_MS = 10_000;

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** 読み取り専用のGETだけを行い、リダイレクトに従わず、本文の受信まで期限を設ける。 */
export async function getJson(
  url: string,
  headers: Record<string, string>,
  { fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_UPSTREAM_TIMEOUT_MS }: UpstreamOptions = {},
): Promise<unknown> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    let response: Response;
    try {
      response = await fetchImpl(url, { method: 'GET', headers, redirect: 'error', signal: controller.signal });
    } catch {
      throw new UpstreamError(timedOut ? 'upstream_timeout' : 'upstream_unavailable');
    }
    if (!response.ok) {
      // 本文は読まずに接続を解放する。
      controller.abort();
      throw new UpstreamError(response.status === 401 || response.status === 403 ? 'upstream_auth' : 'upstream_unavailable');
    }
    try {
      return await response.json();
    } catch {
      throw new UpstreamError(timedOut ? 'upstream_timeout' : 'upstream_invalid');
    }
  } finally {
    clearTimeout(timer);
  }
}

/** ISO 8601形式の日時かを確かめる（値の変換はしない）。 */
export function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 40
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && Number.isFinite(Date.parse(value));
}

/** 表示する文字列の長さを制限し、制御文字を含むものは受け付けない。 */
export function isText(value: unknown, max = 500): value is string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 連携先の文字列に含まれる制御文字を拒否するため。
  return typeof value === 'string' && value.length >= 1 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
}
