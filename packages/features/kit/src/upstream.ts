/**
 * 業務機能が連携先（GitHub等）を読むときの共通の部品。
 * 要求の組み立てと応答の検証は、各機能に置く。ここには、どの連携先でも同じ送信の方針とエラーの種類だけを置く。
 */

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

export interface UpstreamRequest {
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
}

export const DEFAULT_UPSTREAM_TIMEOUT_MS = 10_000;

/**
 * 連携先へ要求を1回だけ送り、応答のJSONを返す。リダイレクトに従わず、本文の受信まで期限を設ける。
 * 失敗は固定のコードへ置き換え、HTTPの状態が成功でなければ本文を読まずに接続を解放する。
 */
export async function requestJson(
  url: string,
  { method, headers, body }: UpstreamRequest,
  { fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_UPSTREAM_TIMEOUT_MS }: UpstreamOptions = {},
): Promise<unknown> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method, headers, redirect: 'error', signal: controller.signal, ...(body === undefined ? {} : { body }),
      });
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
