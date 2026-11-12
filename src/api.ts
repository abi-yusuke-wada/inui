import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { createIntentRouter, DecisionError } from '@inui/core';
import type { RoutingDecision } from '@inui/core';
import { appOrigin, DEFAULT_APP_PORT } from './local-config.ts';
import { logRoute } from './logger.ts';
import type { Logger } from './logger.ts';
import { DEFAULT_DATE, listEmployees, listSchedules, selectPeople } from './people.ts';
import type { LocalStore } from './store.ts';
import type { ApplicationStatus, ExpenseInput, LeaveInput } from './types.ts';

const MAX_BODY_BYTES = 16 * 1024;
const SCREEN_INTENTS = ['leave_request', 'expense_request', 'application_status', 'schedule_compare'];
const NOTICES = {
  unsupported_feature: 'この機能は今回の対象に含まれていません。',
  unsupported_operation: 'この操作は今回の対象に含まれていません。',
  clarify: '目的を特定できませんでした。申請の種類や確認したいことを入力してください。',
};
type Store = Pick<LocalStore, 'list' | 'addLeave' | 'addExpense'>;
interface AppOptions {
  store: Store;
  routeIntent?: (text: string) => Promise<unknown>;
  port?: number;
  logger?: Logger;
}

class RequestError extends Error {
  readonly status: ContentfulStatusCode;
  readonly code: string;
  constructor(status: ContentfulStatusCode, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function invalidInput(): never {
  throw new RequestError(400, 'invalid_input', '入力の形式や値を確認してください。');
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function keysAre(value: Record<string, unknown>, allowed: readonly string[]): boolean {
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

function optionalText(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > 500) invalidInput();
  return value.trim();
}

/** Content-Lengthに依存せず、読み取り中の本文サイズを制限する。 */
async function readJson(c: Context): Promise<unknown> {
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
      if (size > MAX_BODY_BYTES) {
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

/** 判定を画面の固定対応表へ照合し、Toolや自由なUI指定を拒否する。 */
function checkedDecision(value: unknown): RoutingDecision {
  if (!isRecord(value) || Object.keys(value).length !== 3 || typeof value.intent !== 'string') {
    throw new DecisionError('invalid_response');
  }
  if (value.kind === 'screen' && keysAre(value, ['kind', 'intent', 'ui'])
      && SCREEN_INTENTS.includes(value.intent) && value.ui === value.intent) {
    return { kind: 'screen', intent: value.intent, ui: value.ui } as RoutingDecision;
  }
  if (value.kind === 'notice' && keysAre(value, ['kind', 'intent', 'message'])
      && Object.hasOwn(NOTICES, value.intent) && typeof value.message === 'string') {
    const intent = value.intent as keyof typeof NOTICES;
    return { kind: 'notice', intent, message: NOTICES[intent] };
  }
  throw new DecisionError('invalid_response');
}

/** 同一オリジンのローカルAPIを、推論と保存を差し替え可能な形で作る。 */
export function createApp({ store, routeIntent = createIntentRouter(), port = DEFAULT_APP_PORT, logger }: AppOptions) {
  const allowedHosts = [new URL(appOrigin(port)).host, `localhost:${port}`];
  const app = new Hono();
  app.use('*', async (c, next) => {
    const requestId = randomUUID();
    const started = performance.now();
    c.header('X-Request-Id', requestId);
    await next();
    const status = c.res.status;
    const path = c.req.path;
    const route = logRoute(path);
    const errorCode = c.error instanceof RequestError || c.error instanceof DecisionError
      ? c.error.code : status >= 500 ? 'internal_error' : status === 404 ? 'not_found' : undefined;
    const level = status >= 500 ? 'error' : status >= 400 ? 'warn' : path.startsWith('/api/') ? 'info' : 'debug';
    // URLや本文は渡さず、固定の経路名とサーバーが発行したIDで処理を追う。
    try {
      logger?.[level](path === '/api/intent' && c.req.method === 'POST' ? 'intent_request' : 'http_request', {
        request_id: requestId, method: c.req.method, route, http_status: status,
        elapsed_ms: Math.round(performance.now() - started), ...(errorCode ? { error_code: errorCode } : {}),
      });
    } catch { /* ログ出力の失敗で業務操作の応答を変更しない。 */ }
  });
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    const url = new URL(c.req.url);
    const host = c.req.header('Host');
    if (url.protocol !== 'http:' || !allowedHosts.includes(url.host)
        || (host !== undefined && host.toLowerCase() !== url.host)) {
      throw new RequestError(403, 'invalid_host', 'ローカルの検証用アドレスから開いてください。');
    }
    if (c.req.method === 'POST' && c.req.header('Origin') !== url.origin) {
      throw new RequestError(403, 'invalid_origin', '同じ画面から操作をやり直してください。');
    }
    await next();
  });

  app.post('/api/intent', async (c) => {
    const body = await readJson(c);
    if (!isRecord(body) || !keysAre(body, ['text']) || typeof body.text !== 'string'
        || body.text.trim().length === 0 || body.text.trim().length > 2000) invalidInput();
    let decision: RoutingDecision;
    try {
      decision = checkedDecision(await routeIntent(body.text.trim()));
    } catch (error) {
      if (error instanceof DecisionError) throw error;
      throw new RequestError(503, 'unavailable', '判定に接続できませんでした。時間をおいて再試行してください。');
    }
    return c.json(decision.kind === 'screen' && decision.intent === 'schedule_compare'
      ? { ...decision, people: selectPeople(body.text) } : decision);
  });

  app.get('/api/applications', (c) => {
    const query = new URL(c.req.url).searchParams;
    const status = query.get('status');
    if ([...query.keys()].some((key) => key !== 'status') || query.getAll('status').length > 1
        || (status !== null && !['pending', 'approved', 'returned'].includes(status))) invalidInput();
    return c.json({ applications: store.list(status === null ? undefined : status as ApplicationStatus) });
  });

  app.post('/api/applications/leave', async (c) => {
    const body = await readJson(c);
    if (!isRecord(body) || !keysAre(body, ['date', 'period', 'reason']) || !isValidDate(body.date)
        || !['full_day', 'am', 'pm'].includes(body.period as string)) invalidInput();
    const reason = optionalText(body.reason);
    const input: LeaveInput = { date: body.date, period: body.period as LeaveInput['period'],
      ...(reason !== undefined ? { reason } : {}) };
    return c.json({ application: store.addLeave(input) }, 201);
  });

  app.post('/api/applications/expense', async (c) => {
    const body = await readJson(c);
    if (!isRecord(body) || !keysAre(body, ['date', 'amount', 'description']) || !isValidDate(body.date)
        || typeof body.amount !== 'number' || !Number.isSafeInteger(body.amount) || body.amount < 1) invalidInput();
    const description = optionalText(body.description);
    const input: ExpenseInput = { date: body.date, amount: body.amount,
      ...(description !== undefined ? { description } : {}) };
    return c.json({ application: store.addExpense(input) }, 201);
  });

  app.get('/api/employees', (c) => {
    if (new URL(c.req.url).search) invalidInput();
    return c.json({ employees: listEmployees() });
  });

  app.get('/api/schedules', (c) => {
    const query = new URL(c.req.url).searchParams;
    const date = query.get('date') ?? DEFAULT_DATE;
    const rawIds = query.get('personIds');
    const ids = rawIds ? rawIds.split(',') : [];
    const known = new Set(listEmployees().map((person) => person.id));
    if ([...query.keys()].some((key) => !['date', 'personIds'].includes(key))
        || query.getAll('date').length > 1 || query.getAll('personIds').length > 1
        || !isValidDate(date) || ids.length > known.size || new Set(ids).size !== ids.length
        || ids.some((id) => !known.has(id))) invalidInput();
    return c.json(listSchedules(date, ids));
  });

  app.notFound((c) => c.json({ error: { code: 'not_found', message: '指定された操作はありません。' } }, 404));
  app.onError((error, c) => {
    if (error instanceof RequestError) {
      return c.json({ error: { code: error.code, message: error.message } }, error.status);
    }
    if (error instanceof DecisionError) {
      const status = { invalid_input: 400, invalid_response: 502, unavailable: 503, timeout: 504 } as const;
      const messages = {
        invalid_input: '入力を確認してください。', invalid_response: '判定結果を確認できませんでした。',
        unavailable: '判定に接続できませんでした。', timeout: '判定に時間がかかりすぎました。再試行できます。',
      };
      return c.json({ error: { code: error.code, message: messages[error.code] } }, status[error.code]);
    }
    return c.json({ error: { code: 'internal_error', message: '処理を完了できませんでした。画面からやり直してください。' } }, 500);
  });
  return app;
}
