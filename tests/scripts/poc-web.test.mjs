import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { JSDOM, VirtualConsole } from 'jsdom';

const publicDirectory = new URL('../../dist/public/', import.meta.url);
const [html, entry, css] = await Promise.all([
  readFile(new URL('index.html', publicDirectory), 'utf8'),
  readFile(new URL('app.js', publicDirectory), 'utf8'),
  readFile(new URL('app.css', publicDirectory), 'utf8'),
]);
// JSDOMはES moduleを実行できないため、配信するapp.jsと静的にimportするチャンクを1つのscriptへまとめる。
// 業務画面の遅延読み込み（動的import）は初期表示では読まないため、外部のまま残す。
const bundle = (await build({
  entryPoints: [fileURLToPath(new URL('app.js', publicDirectory))], bundle: true, write: false,
  format: 'iife', platform: 'browser', logLevel: 'silent',
  plugins: [{ name: 'keep-lazy-chunks', setup(builder) {
    builder.onResolve({ filter: /.*/ }, (args) => args.kind === 'dynamic-import' ? { path: args.path, external: true } : undefined);
  } }],
})).outputFiles[0].text;

/** 固定時間の待機をせず、描画完了か期限まで短く確認する。 */
async function waitFor(condition, timeoutMs = 2000) {
  const deadline = performance.now() + timeoutMs;
  while (!condition()) {
    if (performance.now() >= deadline) assert.fail('production bundleの初期描画が期限内に完了しませんでした。');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('生成したHTMLは存在する同一オリジンのmodule・CSSと一つのrootを参照する', () => {
  const dom = new JSDOM(html, { url: 'http://127.0.0.1:8766/' });
  try {
    const document = dom.window.document;
    assert.equal(document.querySelectorAll('#root').length, 1);
    const scripts = [...document.querySelectorAll('script[src]')];
    assert.equal(scripts.length, 1);
    assert.equal(scripts[0].type, 'module');
    assert.equal(scripts[0].getAttribute('src'), '/app.js');
    const stylesheets = [...document.querySelectorAll('link[rel="stylesheet"]')];
    assert.equal(stylesheets.length, 1);
    assert.equal(stylesheets[0].getAttribute('href'), '/app.css');
    for (const resource of [scripts[0].src, stylesheets[0].href]) {
      assert.equal(new URL(resource).origin, dom.window.location.origin);
    }
    assert.ok(entry.trim().length > 0);
    assert.ok(css.trim().length > 0);
  } finally { dom.window.close(); }
});

test('app.jsとチャンクが参照するチャンクは、すべてassets/に出力されている', async () => {
  const assets = new URL('assets/', publicDirectory);
  const names = new Set(await readdir(assets));
  const sources = [['app.js', entry], ...await Promise.all([...names].map(async (name) => [name, await readFile(new URL(name, assets), 'utf8')]))];
  let references = 0;
  for (const [name, source] of sources) {
    for (const [, target] of source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*)["'](?:\.\/assets\/|\.\/)([A-Za-z0-9_-]+\.js)["']/g)) {
      references++;
      assert.ok(names.has(target), `${name}が参照する${target}がありません。`);
    }
  }
  assert.ok(references > 0);
  // ホワイトボードのCSSとフォントは、外部のCDNではなくアプリから配信する。
  const excalidrawCss = await readFile(new URL('excalidraw/index.css', publicDirectory), 'utf8');
  assert.match(excalidrawCss, /url\(".\/fonts\/Assistant\/Assistant-Regular\.woff2"\)/);
  await readFile(new URL('excalidraw/fonts/Assistant/Assistant-Regular.woff2', publicDirectory));
  // 業務画面は遅延読み込みのチャンクとして分かれている。
  for (const screen of ['MarkdownViewer', 'TaskBoard', 'Whiteboard', 'Canvas', 'Schedules']) {
    assert.ok([...names].some((name) => name.startsWith(screen + '-')), screen + 'のチャンクがありません。');
  }
});

for (const pathname of ['/', '/legacy']) {
  test(`production bundleをHTMLへmountし、初期fetchやJSエラーを起こさない: ${pathname}`, async () => {
    const errors = [];
    const requests = [];
    const virtualConsole = new VirtualConsole();
    virtualConsole.on('jsdomError', (error) => errors.push(error.message));
    virtualConsole.on('error', (...args) => errors.push(args.map(String).join(' ')));
    const dom = new JSDOM(html, {
      url: `http://127.0.0.1:8766${pathname}`,
      runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole,
    });
    try {
      dom.window.fetch = async (...args) => {
        requests.push(args);
        throw new Error('初期描画でAPIやNLIを呼び出してはいけません。');
      };
      dom.window.addEventListener('error', (event) => errors.push(event.message));
      dom.window.addEventListener('unhandledrejection', (event) => errors.push(String(event.reason)));
      const document = dom.window.document;
      const style = document.createElement('style');
      style.textContent = css;
      document.head.append(style);
      // JSDOMはmodule資源を自動実行しないため、配信bundleを解析済みDOMで評価する。
      // ソースAppのimportは使わない。実ブラウザ・TCPによる資源配信の検証とは分ける。
      dom.window.eval(bundle);
      await waitFor(() => document.querySelector('#root h1') !== null || errors.length > 0);
      assert.deepEqual(errors, [], 'production bundleの実行でエラーが発生しました。');
      const root = document.getElementById('root');
      assert.ok(root.children.length > 0);
      const heading = root.querySelector('h1');
      assert.ok(heading && heading.textContent.trim().length > 0);
      const computed = dom.window.getComputedStyle(heading);
      assert.notEqual(computed.display, 'none');
      assert.notEqual(computed.visibility, 'hidden');
      assert.deepEqual(requests, [], '初期表示はAPIやNLIの完了を待たない必要があります。');
    } finally { dom.window.close(); }
  });
}
