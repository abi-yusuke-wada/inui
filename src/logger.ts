export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogEvent = 'server_started' | 'server_stopped' | 'server_failed'
  | 'intent_request' | 'http_request' | 'data_reset' | 'data_reset_failed';

export interface LogFields {
  request_id?: string;
  method?: string;
  route?: string;
  http_status?: number;
  elapsed_ms?: number;
  port?: number;
  error_code?: string;
}

export interface Logger {
  debug(event: LogEvent, fields?: LogFields): void;
  info(event: LogEvent, fields?: LogFields): void;
  warn(event: LogEvent, fields?: LogFields): void;
  error(event: LogEvent, fields?: LogFields): void;
}

const PRIORITY: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const MESSAGES: Record<LogEvent, string> = {
  server_started: 'アプリを起動しました。',
  server_stopped: 'アプリを停止しました。',
  server_failed: 'アプリの起動・実行に失敗しました。',
  intent_request: '画面の振り分けを処理しました。',
  http_request: 'HTTPリクエストを処理しました。',
  data_reset: '検証用申請データを初期状態へ戻しました。',
  data_reset_failed: '検証用申請データを初期化できませんでした。',
};
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'CONNECT', 'TRACE']);
const ROUTES = new Set([
  '/', '/legacy', '/app.js', '/app.css', '/api/intent', '/api/applications',
  '/api/applications/leave', '/api/applications/expense', '/api/employees', '/api/schedules', 'other',
]);
const ERROR_CODES = new Set([
  'invalid_input', 'invalid_content_type', 'body_too_large', 'invalid_host', 'invalid_origin',
  'unavailable', 'invalid_response', 'timeout', 'not_found', 'internal_error',
  'startup_failed', 'listen_failed', 'shutdown_failed', 'reset_failed',
]);
const FIELD_CHECKS: Record<keyof LogFields, (value: unknown) => boolean> = {
  request_id: (value) => typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value),
  method: (value) => typeof value === 'string' && METHODS.has(value),
  route: (value) => typeof value === 'string' && ROUTES.has(value),
  http_status: (value) => typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599,
  elapsed_ms: (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0,
  port: (value) => typeof value === 'number' && Number.isInteger(value) && value >= 1024 && value <= 65535,
  error_code: (value) => typeof value === 'string' && ERROR_CODES.has(value),
};

/** 環境値は既知のレベルだけを使い、不正値を出力せずinfoへ戻す。 */
export function logLevel(value?: string): LogLevel {
  return value === 'debug' || value === 'info' || value === 'warn' || value === 'error' ? value : 'info';
}

/** 未知のURLやクエリ文字列を、記録用の経路名へ持ち込まない。 */
export function logRoute(path: string): string {
  return ROUTES.has(path) ? path : 'other';
}

function writeLine(line: string, level: LogLevel): void {
  if (level === 'warn' || level === 'error') console.error(line);
  else console.log(line);
}

/** 許可したメタデータだけを1行JSONへ整え、本文や例外の丸ごと出力を防ぐ。 */
export function createLogger({ level = 'info', write = writeLine, now = () => new Date() }: {
  level?: LogLevel;
  write?: (line: string, level: LogLevel) => void;
  now?: () => Date;
} = {}): Logger {
  const minimum = PRIORITY[logLevel(level)];
  function emit(current: LogLevel, event: LogEvent, fields: LogFields = {}): void {
    if (PRIORITY[current] < minimum) return;
    try {
      if (typeof event !== 'string' || !Object.hasOwn(MESSAGES, event)) return;
      const record: Record<string, string | number> = {
        timestamp: now().toISOString(), level: current, event, message: MESSAGES[event],
      };
      for (const key of Object.keys(FIELD_CHECKS) as (keyof LogFields)[]) {
        const value = fields[key];
        if (value !== undefined && FIELD_CHECKS[key](value)) record[key] = value;
      }
      write(JSON.stringify(record), current);
    } catch { /* ログ出力の障害でAPIや起動処理を失敗させない。 */ }
  }
  return {
    debug: (event, fields) => emit('debug', event, fields),
    info: (event, fields) => emit('info', event, fields),
    warn: (event, fields) => emit('warn', event, fields),
    error: (event, fields) => emit('error', event, fields),
  };
}
