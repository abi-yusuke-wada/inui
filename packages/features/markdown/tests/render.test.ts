import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import type { WindowLike } from 'dompurify';
import { createMarkdownRenderer } from '../src/render.ts';

/** JSDOM上の変換結果をDOMとして調べる（実ブラウザの描画ではない）。 */
function setup(t: test.TestContext) {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://127.0.0.1:8766/' });
  t.after(() => dom.window.close());
  const renderer = createMarkdownRenderer(dom.window as unknown as WindowLike);
  const parse = (html: string) => {
    const container = dom.window.document.createElement('div');
    container.innerHTML = html;
    return container;
  };
  return { renderer, parse };
}

test('見出し・表・入れ子のコードブロックを変換し、目次用の見出しを返す', (t) => {
  const { renderer, parse } = setup(t);
  const source = [
    '# 設計の記録', '', '## 背景', '', '| 案 | 費用 |', '| --- | --- |', '| A | なし |', '',
    '### `詳細`の扱い', '', '````markdown', '```ts', 'const a = 1;', '```', '````', '',
  ].join('\n');
  const result = renderer.render(source);
  const root = parse(result.html);
  assert.deepEqual(result.headings, [
    { id: 'md-h-1', level: 1, text: '設計の記録' },
    { id: 'md-h-2', level: 2, text: '背景' },
    { id: 'md-h-3', level: 3, text: '詳細の扱い' },
  ]);
  assert.equal(root.querySelector('h2')?.id, 'md-h-2');
  assert.equal(root.querySelectorAll('table td').length, 2);
  // 外側のフェンスの中身は、内側のフェンスを含めてそのままコードとして表示する。
  assert.equal(root.querySelector('pre code')?.textContent, '```ts\nconst a = 1;\n```\n');
  assert.deepEqual(result.diagrams, []);
});

test('生のHTML・スクリプト・危険なリンクを実行可能な形で出力しない', (t) => {
  const { renderer, parse } = setup(t);
  const result = renderer.render([
    '<script>alert(1)</script>', '', '<img src=x onerror=alert(1)>', '',
    '[危険](javascript:alert(1)) [データ](data:text/html;base64,PHNjcmlwdD4=) [外部](https://example.com/doc)', '',
    '[文書内](#md-h-1)',
  ].join('\n'));
  const root = parse(result.html);
  assert.equal(root.querySelectorAll('script, img, iframe, style').length, 0);
  assert.equal([...root.querySelectorAll('*')].some((element) =>
    [...element.attributes].some((attribute) => attribute.name.startsWith('on'))), false);
  // 生のHTMLは文字として表示する。
  assert.match(root.textContent ?? '', /<script>alert\(1\)<\/script>/);
  const links = [...root.querySelectorAll('a')];
  assert.deepEqual(links.map((link) => link.getAttribute('href')), ['https://example.com/doc', '#md-h-1']);
  assert.equal(links[0]?.getAttribute('target'), '_blank');
  assert.equal(links[0]?.getAttribute('rel'), 'noopener noreferrer');
  assert.equal(links[1]?.hasAttribute('target'), false);
});

test('画像は読み込まず代替テキストを表示する', (t) => {
  const { renderer, parse } = setup(t);
  const root = parse(renderer.render('![構成図](https://example.com/tracker.png) ![](local.png)').html);
  assert.equal(root.querySelectorAll('img').length, 0);
  assert.deepEqual([...root.querySelectorAll('.md-image-alt')].map((node) => node.textContent), ['[画像: 構成図]', '[画像]']);
  assert.equal(root.innerHTML.includes('tracker.png'), false);
});

test('Mermaidのフェンスは描画用の枠と定義に分け、HTMLとしては出力しない', (t) => {
  const { renderer, parse } = setup(t);
  const result = renderer.render('```mermaid\nflowchart TD\n  A["<b>入力</b>"] --> B\n```\n\n```mermaid\ngraph LR\n  X --> Y\n```');
  const root = parse(result.html);
  assert.deepEqual(result.diagrams, ['flowchart TD\n  A["<b>入力</b>"] --> B\n', 'graph LR\n  X --> Y\n']);
  assert.deepEqual([...root.querySelectorAll('.md-mermaid')].map((node) => node.getAttribute('data-diagram')), ['0', '1']);
  assert.equal(root.querySelector('b'), null);
});

test('Mermaidが生成したSVGからスクリプトとイベント属性を取り除く', (t) => {
  const { renderer, parse } = setup(t);
  const root = parse(renderer.sanitizeSvg(
    '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script><g><text>入力</text></g>'
    + '<foreignObject><div onclick="alert(1)">ラベル</div></foreignObject></svg>',
  ));
  assert.equal(root.querySelectorAll('script').length, 0);
  assert.equal(root.querySelector('svg')?.hasAttribute('onload'), false);
  assert.equal(root.querySelector('text')?.textContent, '入力');
  assert.equal(root.innerHTML.includes('onclick'), false);
  // MermaidのHTMLラベル（foreignObjectの中のHTML）は、無害化した上で残す。
  assert.equal(root.querySelector('foreignObject div')?.textContent, 'ラベル');
});

test('外部の画像やURLを参照する図は、Mermaidを読み込む前に描画を断る', async () => {
  const { renderDiagram } = await import('../src/mermaid.ts');
  for (const code of [
    'flowchart LR\n  A@{ img: "https://example.org/pixel.png", label: "画像" }',
    'flowchart LR\n  A@{ img : "//example.org/pixel.png" }',
    'flowchart LR\n  A --> B\n  classDef x fill:url(https://example.org/a.svg)',
    'flowchart LR\n  A["https://example.org"] --> B',
    // 設定のCSS（YAMLのエスケープ）、CSSのエスケープ、文字参照で隠した url( や // も見つける。
    '---\nconfig:\n  themeCSS: ".node rect { fill: \\u0075rl(https:\\u002f\\u002fexample.org/x) }"\n---\nflowchart LR\n  A --> B',
    'flowchart LR\n  A --> B\n  classDef x fill:\\75 rl(https:\\2f\\2f example.org/a.svg)',
    'flowchart LR\n  A --> B\n  style A fill:#117;rl(https:#47;#47;example.org/a.svg)',
    '%%{init: {"themeCSS": "a { background: &#x75;rl(https:\\/\\/example.org/x) }"}}%%\nflowchart LR\n  A --> B',
  ]) {
    await assert.rejects(renderDiagram(code, 'test-diagram'), /external_reference/);
  }
});

test('外部参照の検査のため、YAML・CSSのエスケープと文字参照を元の文字に戻す', async () => {
  const { decodeEscapes } = await import('../src/mermaid.ts');
  assert.equal(decodeEscapes('\\u0075rl( \\x2f\\x2f \\u{1F600}'), 'url( // \u{1F600}');
  assert.equal(decodeEscapes('\\75 rl( \\2f\\2f'), 'url( //');
  assert.equal(decodeEscapes('#117;rl( &#x2F;&#47; &#1114112;'), 'url( // \ufffd');
  assert.equal(decodeEscapes('a\\/b\\/'), 'a/b/');
  // 通常の図の定義はそのまま残る。
  assert.equal(decodeEscapes('flowchart LR\n  A[開始] --> B[終了]'), 'flowchart LR\n  A[開始] --> B[終了]');
});
