import { useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent } from 'react';
import { Feedback } from '@inui/feature-kit/react';
import { renderDiagram } from './mermaid.ts';
import { createMarkdownRenderer, MAX_MARKDOWN_BYTES } from './render.ts';
import type { RenderedMarkdown } from './render.ts';

const ACCEPTED = /\.(?:md|markdown)$/i;

/** 図の描画に失敗したときは、定義をそのまま文字として表示する。 */
function showDiagramSource(block: HTMLElement, code: string) {
  const note = document.createElement('p');
  note.className = 'md-diagram-error';
  note.textContent = '図を表示できませんでした。定義をそのまま表示します。';
  const pre = document.createElement('pre');
  const codeElement = document.createElement('code');
  codeElement.textContent = code;
  pre.append(codeElement);
  block.replaceChildren(note, pre);
}

/**
 * 手元のMarkdownファイルをブラウザ内だけで読み、読みやすく表示する。
 * ファイルの内容はサーバーへ送らない。
 */
export default function MarkdownViewer() {
  const renderer = useMemo(() => createMarkdownRenderer(window), []);
  const [doc, setDoc] = useState<{ name: string; rendered: RenderedMarkdown; load: number }>();
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState(false);
  const [reading, setReading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const article = useRef<HTMLElement>(null);
  const loads = useRef(0);

  // 受付欄の外へ落としたファイルを、ブラウザが開いて画面を離れないようにする。
  useEffect(() => {
    const prevent = (event: globalThis.DragEvent) => {
      if (event.dataTransfer?.types.includes('Files')) event.preventDefault();
    };
    window.addEventListener('dragover', prevent);
    window.addEventListener('drop', prevent);
    return () => {
      window.removeEventListener('dragover', prevent);
      window.removeEventListener('drop', prevent);
    };
  }, []);

  useEffect(() => {
    const container = article.current;
    if (!doc || !container) return;
    let cancelled = false;
    const blocks = [...container.querySelectorAll<HTMLElement>('.md-mermaid')];
    void (async () => {
      for (const block of blocks) {
        const index = Number(block.dataset.diagram);
        const code = doc.rendered.diagrams[index];
        if (code === undefined) continue;
        block.textContent = '図を描画しています…';
        try {
          const svg = await renderDiagram(code, `inui-diagram-${doc.load}-${index}`);
          if (cancelled) return;
          block.innerHTML = renderer.sanitizeSvg(svg);
        } catch {
          if (cancelled) return;
          showDiagramSource(block, code);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [doc, renderer]);

  async function open(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    if (files.length > 1) { setError('ファイルは1件ずつ開いてください。'); return; }
    if (!ACCEPTED.test(file.name)) { setError('Markdownファイル（.md・.markdown）を選んでください。'); return; }
    if (file.size > MAX_MARKDOWN_BYTES) { setError('5MBまでのファイルを開けます。'); return; }
    const load = ++loads.current;
    setReading(true);
    setError('');
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
      if (load !== loads.current) return;
      setDoc({ name: file.name, rendered: renderer.render(text), load });
    } catch {
      if (load === loads.current) setError('ファイルを読み込めませんでした。UTF-8で保存したMarkdownか確認してください。');
    } finally {
      if (load === loads.current) setReading(false);
    }
  }

  function drop(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    setDragging(false);
    void open(event.dataTransfer.files);
  }

  const toc = doc?.rendered.headings.filter((heading) => heading.level <= 3) ?? [];
  return <div className="panel markdown-panel">
    <div className="panel-heading"><p className="eyebrow">MARKDOWN</p><h2>Markdownを読む</h2>
      <p>手元のMarkdownファイルを、読みやすい形で表示します。ファイルの内容はこの画面の中だけで扱い、サーバーへは送りません。</p></div>
    <section className={'drop-zone' + (dragging ? ' drop-zone-active' : '')} aria-label="Markdownファイルの受付"
      onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)} onDrop={drop}>
      <p>{doc ? `表示中: ${doc.name}` : 'ここにMarkdownファイルをドロップ'}</p>
      <button className="button button-subtle" type="button" onClick={() => fileInput.current?.click()}>
        {doc ? '別のファイルを選ぶ' : 'ファイルを選ぶ'}
      </button>
      <input ref={fileInput} className="visually-hidden" type="file" accept=".md,.markdown,text/markdown" tabIndex={-1}
        aria-label="Markdownファイルを選ぶ"
        onChange={(event) => { void open(event.target.files); event.target.value = ''; }} />
    </section>
    {reading && <p className="loading-line" role="status"><span className="loading-dot" />ファイルを読み込んでいます…</p>}
    {error && <Feedback message={error} />}
    {/* 目次（h1〜h3）がない文書は、本文が狭い目次の列に入らないよう1列で表示する。 */}
    {doc && <div className={'markdown-layout' + (toc.length > 0 ? '' : ' markdown-layout-single')}>
      {toc.length > 0 && <nav className="markdown-toc" aria-label="目次">
        <p className="toc-title">目次</p>
        <ol>{toc.map((heading) =>
          <li key={heading.id} className={'toc-level-' + heading.level}><a href={'#' + heading.id}>{heading.text}</a></li>)}</ol>
      </nav>}
      {/* 変換後のHTMLはDOMPurifyで無害化済み（render.ts）。 */}
      <article ref={article} className="markdown-body" aria-label={doc.name}
        // biome-ignore lint/security/noDangerouslySetInnerHtml: markdown-itで生のHTMLを無効にし、DOMPurifyで無害化したHTMLだけを入れる。
        dangerouslySetInnerHTML={{ __html: doc.rendered.html }} />
    </div>}
  </div>;
}
