import assert from 'node:assert/strict';
import test from 'node:test';
import { createLogger, logLevel } from '../src/logger.ts';
import type { LogEvent, LogFields, LogLevel } from '../src/logger.ts';

const FIXED_TIME = '2026-11-11T14:00:00.000Z';
const REQUEST_ID = '12345678-1234-4234-8234-123456789abc';

test('時刻・レベル・固定イベント・検証したメタデータを1行JSONにする', () => {
  const lines: string[] = [];
  const levels: LogLevel[] = [];
  const logger = createLogger({ now: () => new Date(FIXED_TIME), write: (line, level) => {
    lines.push(line); levels.push(level);
  } });
  logger.error('intent_request', {
    request_id: REQUEST_ID, method: 'POST', route: '/api/intent', http_status: 504,
    elapsed_ms: 25001, port: 8766, error_code: 'timeout',
  });
  assert.equal(lines.length, 1);
  assert.equal(lines[0]?.includes('\n'), false);
  assert.deepEqual(levels, ['error']);
  assert.deepEqual(JSON.parse(lines[0] ?? ''), {
    timestamp: FIXED_TIME, level: 'error', event: 'intent_request', message: '画面の振り分けを処理しました。',
    request_id: REQUEST_ID, method: 'POST', route: '/api/intent', http_status: 504,
    elapsed_ms: 25001, port: 8766, error_code: 'timeout',
  });
});

test('指定レベル未満では時計も出力先も呼ばず、不正な設定値はinfoへ戻す', () => {
  let clockCalls = 0;
  const lines: string[] = [];
  const logger = createLogger({ level: 'warn', now: () => { clockCalls++; return new Date(FIXED_TIME); },
    write: (line) => lines.push(line) });
  logger.debug('http_request');
  logger.info('server_started');
  assert.equal(clockCalls, 0);
  assert.deepEqual(lines, []);
  logger.warn('http_request');
  logger.error('server_failed');
  assert.equal(clockCalls, 2);
  assert.deepEqual(lines.map((line) => JSON.parse(line).level), ['warn', 'error']);
  for (const value of ['debug', 'info', 'warn', 'error'] as const) assert.equal(logLevel(value), value);
  for (const value of [undefined, '', 'DEBUG', ' debug ', 'test-only-private-value']) assert.equal(logLevel(value), 'info');
  const defaults: LogLevel[] = [];
  const defaultLogger = createLogger({ write: (_line, level) => defaults.push(level) });
  defaultLogger.debug('http_request');
  defaultLogger.info('server_started');
  assert.deepEqual(defaults, ['info']);
});

test('入力・認証ヘッダー・例外・未知イベントと不正メタデータを出力しない', () => {
  const lines: string[] = [];
  const logger = createLogger({ now: () => new Date(FIXED_TIME), write: (line) => lines.push(line) });
  const privateText = 'test-only-private-token\n偽のログ行';
  logger.info('http_request', {
    body: privateText, headers: { Authorization: privateText }, stack: privateText, error: new Error(privateText),
    message: privateText, timestamp: privateText, level: privateText, event: privateText,
    request_id: privateText, method: privateText, route: `/api/schedules?text=${privateText}`,
    http_status: NaN, elapsed_ms: Infinity, port: 80, error_code: privateText,
  } as LogFields);
  logger.info(privateText as LogEvent);
  assert.equal(lines.length, 1);
  assert.equal(lines[0]?.includes('private'), false);
  assert.deepEqual(JSON.parse(lines[0] ?? ''), {
    timestamp: FIXED_TIME, level: 'info', event: 'http_request', message: 'HTTPリクエストを処理しました。',
  });
  for (const fields of [
    { http_status: 600, elapsed_ms: -1, port: 65536 },
    { http_status: 200.5, elapsed_ms: NaN, port: 8766.5 },
    { http_status: 99, port: 1023 },
  ]) logger.warn('http_request', fields);
  assert.ok(lines.every((line) => !Object.hasOwn(JSON.parse(line), 'http_status')
    && !Object.hasOwn(JSON.parse(line), 'elapsed_ms') && !Object.hasOwn(JSON.parse(line), 'port')));
});

test('出力先・時計・JSON整形の失敗を業務処理へ伝えない', (t) => {
  assert.doesNotThrow(() => createLogger({ write: () => { throw new Error('test-only-output-failure'); } }).info('server_started'));
  assert.doesNotThrow(() => createLogger({ now: () => { throw new Error('test-only-clock-failure'); } }).error('server_failed'));
  assert.doesNotThrow(() => createLogger({ now: () => new Date(NaN) }).warn('http_request'));
  const output: string[] = [];
  const stringify = t.mock.method(JSON, 'stringify', () => { throw new Error('test-only-format-failure'); });
  try {
    assert.doesNotThrow(() => createLogger({ write: (line) => output.push(line) }).info('server_started'));
  } finally { stringify.mock.restore(); }
  assert.deepEqual(output, []);
});

test('既定の出力先はdebug・infoが標準出力、warn・errorが標準エラー', (t) => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  t.mock.method(console, 'log', (line: string) => { stdout.push(line); });
  t.mock.method(console, 'error', (line: string) => { stderr.push(line); });
  const logger = createLogger({ level: 'debug', now: () => new Date(FIXED_TIME) });
  logger.debug('http_request');
  logger.info('server_started');
  logger.warn('http_request');
  logger.error('server_failed');
  assert.deepEqual(stdout.map((line) => JSON.parse(line).level), ['debug', 'info']);
  assert.deepEqual(stderr.map((line) => JSON.parse(line).level), ['warn', 'error']);
});
