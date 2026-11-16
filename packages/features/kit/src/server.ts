import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

const DEFAULT_MAX_BODY_BYTES = 16 * 1024;

/** 利用者へ返してよい固定のコードと案内文だけを持つ、業務APIの失敗。 */
export class RequestError extends Error {
  readonly status: ContentfulStatusCode;
  readonly code: string;
  constructor(status: ContentfulStatusCode, code: string, message: string) {
    super(message);
    this.name = 'RequestError';
    this.status = status;
    this.code = code;
  }
}

export function invalidInput(): never {
  throw new RequestError(400, 'invalid_input', '入力の形式や値を確認してください。');
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 許可したキー以外を含まないことを確認する（必須かどうかは呼び出し側で調べる）。 */
export function keysAre(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

/** 日付文字列を暦と照合し、存在しない日付を受理しない。 */
export function isValidDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const lastDay = days[month - 1];
  return lastDay !== undefined && day <= lastDay;
}

/** クエリに許可外のキーや重複したキーがないことを確認する。 */
export function checkQuery(c: Context, allowed: readonly string[]): URLSearchParams {
  const query = new URL(c.req.url).searchParams;
  if ([...query.keys()].some((key) => !allowed.includes(key))
      || allowed.some((key) => query.getAll(key).length > 1)) invalidInput();
  return query;
}

/** Content-Lengthに依存せず、読み取り中の本文サイズを制限する。 */
export async function readJson(c: Context, maxBytes = DEFAULT_MAX_BODY_BYTES): Promise<unknown> {
  if (c.req.header('Content-Type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
    throw new RequestError(415, 'invalid_content_type', 'JSON形式で送信してください。');
  }
  const reader = c.req.raw.body?.getReader();
  if (!reader) invalidInput();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new RequestError(413, 'body_too_large', '送信する内容が大きすぎます。');
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (error) {
    if (error instanceof RequestError) throw error;
    return invalidInput();
  } finally {
    reader.releaseLock();
  }
}
