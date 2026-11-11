import { readFile } from 'node:fs/promises';
import { serve } from '@hono/node-server';
import { createApp } from './api.ts';
import { LocalStore } from './store.ts';

const assets = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/legacy': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/app.css': ['app.css', 'text/css; charset=utf-8'],
} as const;

/** 起動失敗も生の例外を表示せず、固定のローカル設定で開始する。 */
function start(): void {
  const store = new LocalStore();
  const app = createApp({ store });
  for (const [route, [filename, contentType]] of Object.entries(assets)) {
    app.get(route, async (c) => {
      const content = await readFile(new URL(`./public/${filename}`, import.meta.url));
      return c.body(content, 200, { 'Content-Type': contentType });
    });
  }
  // 公開するインターフェースやポートを引数・環境変数で変更しない。
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 3000 }, () => {
    console.log('検証用PoC: http://127.0.0.1:3000');
  });
  let closing = false;
  function close(): void {
    if (closing) return;
    closing = true;
    server.close(() => { store.close(); });
  }
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
  server.on('error', () => {
    console.error('ローカルサーバーを起動できませんでした。');
    if (!closing) { closing = true; store.close(); }
    process.exitCode = 1;
  });
}
try { start(); } catch {
  console.error('ローカルサーバーを起動できませんでした。');
  process.exitCode = 1;
}
