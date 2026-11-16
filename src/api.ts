import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { createIntentRouter, DecisionError } from '@inui/core';
import type { RoutingDecision } from '@inui/core';
import { invalidInput, isRecord, keysAre, readJson, RequestError } from '@inui/feature-kit/server';
import { createScheduleRoutes, selectPeople } from '@inui/feature-schedule/server';
import { createTaskRoutes } from '@inui/feature-tasks/server';
import type { TaskSources, TaskStore } from '@inui/feature-tasks/server';
import { createWhiteboardRoutes } from '@inui/feature-whiteboard/server';
import type { BoardStore } from '@inui/feature-whiteboard/server';
import { appOrigin, DEFAULT_APP_PORT } from './local-config.ts';
import { logRoute } from './logger.ts';
import type { Logger } from './logger.ts';

const SCREEN_INTENTS = ['markdown_view', 'task_board', 'whiteboard', 'schedule_compare'];
const NOTICES = {
  unsupported_feature: 'この機能は今回の対象に含まれていません。',
  unsupported_operation: 'この操作は今回の対象に含まれていません。',
  clarify: '目的を特定できませんでした。文書・タスク・ホワイトボード・予定のどれを扱いたいか入力してください。',
};
const SAFE_METHODS = ['GET', 'HEAD'];
interface AppOptions {
  taskStore: Pick<TaskStore, 'list' | 'add' | 'setDone' | 'remove'>;
  boardStore: Pick<BoardStore, 'list' | 'get' | 'create' | 'update' | 'remove'>;
  taskSources?: TaskSources;
  upstreamFetch?: typeof fetch;
  routeIntent?: (text: string) => Promise<unknown>;
  port?: number;
  logger?: Logger;
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
export function createApp({
  taskStore, boardStore, taskSources = { invalid: [] }, upstreamFetch, routeIntent = createIntentRouter(), port = DEFAULT_APP_PORT, logger,
}: AppOptions) {
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
    // 外部サイトのフレームに埋め込ませず、意図しない操作の送信を防ぐ。
    c.header('Content-Security-Policy', "frame-ancestors 'none'");
    c.header('X-Frame-Options', 'DENY');
    const url = new URL(c.req.url);
    const host = c.req.header('Host');
    if (url.protocol !== 'http:' || !allowedHosts.includes(url.host)
        || (host !== undefined && host.toLowerCase() !== url.host)) {
      throw new RequestError(403, 'invalid_host', 'ローカルの検証用アドレスから開いてください。');
    }
    if (!SAFE_METHODS.includes(c.req.method) && c.req.header('Origin') !== url.origin) {
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

  app.route('/api', createScheduleRoutes());
  app.route('/api', createTaskRoutes({
    store: taskStore, sources: taskSources, upstream: upstreamFetch ? { fetchImpl: upstreamFetch } : {},
  }));
  app.route('/api', createWhiteboardRoutes({ store: boardStore }));

  app.notFound((c) => c.json({ error: { code: 'not_found', message: '指定された操作はありません。' } }, 404));
  app.onError((error, c) => {
    if (error instanceof RequestError) {
      // 画面が本文を読まずに失敗の種類を区別できるよう、固定のコードをヘッダーにも入れる。
      c.header('X-Error-Code', error.code);
      return c.json({ error: { code: error.code, message: error.message } }, error.status);
    }
    if (error instanceof DecisionError) {
      const status = { invalid_input: 400, invalid_response: 502, unavailable: 503, timeout: 504 } as const;
      const messages = {
        invalid_input: '入力を確認してください。', invalid_response: '判定結果を確認できませんでした。',
        unavailable: '判定に接続できませんでした。', timeout: '判定に時間がかかりすぎました。再試行できます。',
      };
      c.header('X-Error-Code', error.code);
      return c.json({ error: { code: error.code, message: messages[error.code] } }, status[error.code]);
    }
    return c.json({ error: { code: 'internal_error', message: '処理を完了できませんでした。画面からやり直してください。' } }, 500);
  });
  return app;
}
