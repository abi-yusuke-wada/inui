import { readFile } from 'node:fs/promises';
import { serve } from '@hono/node-server';
import { readTaskSources, TaskStore } from '@inui/feature-tasks/server';
import { BoardStore } from '@inui/feature-whiteboard/server';
import { createApp } from './api.ts';
import { APP_NAME, appPort, buildId, DEFAULT_DB_PATH } from './local-config.ts';
import { createLogger, logLevel } from './logger.ts';
import type { Logger } from './logger.ts';

const assets = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/legacy': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/app.css': ['app.css', 'text/css; charset=utf-8'],
} as const;
// 遅延読み込みする画面のチャンク。esbuildが生成した名前だけを配信する。
const CHUNK = /^[A-Za-z0-9_-]{1,100}\.(?:js|css)$/;
// ホワイトボード（Excalidraw）のCSSとフォント。ビルド時に dist/public/excalidraw/ へコピーしたものだけを配信する。
const FONT_FAMILY = /^[A-Za-z]{1,40}$/;
const FONT_FILE = /^[A-Za-z0-9_-]{1,120}\.woff2$/;

/** 起動失敗も生の例外を表示せず、IPv4 loopbackで開始する。 */
function start(logger: Logger, build: string): void {
  const port = appPort();
  const store = new TaskStore(DEFAULT_DB_PATH);
  const boards = new BoardStore(DEFAULT_DB_PATH);
  // 連携先の認証情報は環境変数からだけ読み、値はログへ出さない。
  const app = createApp({ taskStore: store, boardStore: boards, taskSources: readTaskSources(process.env), port, logger });
  for (const [route, [filename, contentType]] of Object.entries(assets)) {
    app.get(route, async (c) => {
      const content = await readFile(new URL(`./public/${filename}`, import.meta.url));
      return c.body(content, 200, { 'Content-Type': contentType });
    });
  }
  app.get('/api/health', (c) => c.json({ app: APP_NAME, build }));
  app.get('/excalidraw/index.css', async (c) => {
    const content = await readFile(new URL('./public/excalidraw/index.css', import.meta.url)).catch(() => undefined);
    if (!content) return c.notFound();
    return c.body(content, 200, { 'Content-Type': 'text/css; charset=utf-8' });
  });
  app.get('/excalidraw/fonts/:family/:file', async (c) => {
    const { family, file } = c.req.param();
    if (!FONT_FAMILY.test(family) || !FONT_FILE.test(file)) return c.notFound();
    const content = await readFile(new URL(`./public/excalidraw/fonts/${family}/${file}`, import.meta.url)).catch(() => undefined);
    if (!content) return c.notFound();
    return c.body(content, 200, { 'Content-Type': 'font/woff2' });
  });
  app.get('/assets/:file', async (c) => {
    const file = c.req.param('file');
    if (!CHUNK.test(file)) return c.notFound();
    const content = await readFile(new URL(`./public/assets/${file}`, import.meta.url)).catch(() => undefined);
    if (!content) return c.notFound();
    return c.body(content, 200, {
      'Content-Type': file.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8',
    });
  });
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
        boards.close();
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
      try { store.close(); boards.close(); } catch { logger.error('server_failed', { port, error_code: 'shutdown_failed' }); }
    }
    process.exitCode = 1;
  });
}
const logger = createLogger({ level: logLevel(process.env.LOG_LEVEL) });
try { start(logger, await buildId(new URL('./', import.meta.url))); } catch {
  logger.error('server_failed', { error_code: 'startup_failed' });
  process.exitCode = 1;
}
