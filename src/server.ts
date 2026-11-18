import { readFile } from 'node:fs/promises';
import { serve } from '@hono/node-server';
import { createApp } from './api.ts';
import { LocalStore } from './store.ts';
import { appPort } from './local-config.ts';
import { createLogger, logLevel } from './logger.ts';
import type { Logger } from './logger.ts';

const assets = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/legacy': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/app.css': ['app.css', 'text/css; charset=utf-8'],
} as const;

/** 起動失敗も生の例外を表示せず、IPv4 loopbackで開始する。 */
function start(logger: Logger): void {
  const port = appPort();
  const store = new LocalStore();
  const app = createApp({ store, port, logger });
  for (const [route, [filename, contentType]] of Object.entries(assets)) {
    app.get(route, async (c) => {
      const content = await readFile(new URL(`./public/${filename}`, import.meta.url));
      return c.body(content, 200, { 'Content-Type': contentType });
    });
  }
  // ポートを切り替えても、公開するインターフェースはloopbackから広げない。
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port }, () => {
    logger.info('server_started', { port });
  });
  let closing = false;
  function close(): void {
    if (closing) return;
    closing = true;
    server.close(() => {
      try {
        store.close();
        logger.info('server_stopped', { port });
      } catch {
        logger.error('server_failed', { port, error_code: 'shutdown_failed' });
        process.exitCode = 1;
      }
    });
  }
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
  server.on('error', () => {
    logger.error('server_failed', { port, error_code: 'listen_failed' });
    if (!closing) {
      closing = true;
      try { store.close(); } catch { logger.error('server_failed', { port, error_code: 'shutdown_failed' }); }
    }
    process.exitCode = 1;
  });
}
const logger = createLogger({ level: logLevel(process.env.LOG_LEVEL) });
try { start(logger); } catch {
  logger.error('server_failed', { error_code: 'startup_failed' });
  process.exitCode = 1;
}
