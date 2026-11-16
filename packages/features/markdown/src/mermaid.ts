let ready: Promise<typeof import('mermaid').default> | undefined;

/** Mermaidは図を含む文書を開いたときだけ読み込み、スクリプトやクリック操作を無効にして初期化する。 */
function loadMermaid() {
  ready ??= import('mermaid').then(({ default: mermaid }) => {
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'neutral' });
    return mermaid;
  }).catch((error: unknown) => {
    ready = undefined;
    throw error;
  });
  return ready;
}

/** 図の定義を検証してからSVGへ変換する。不正な定義では描画を試みない。 */
export async function renderDiagram(code: string, id: string): Promise<string> {
  const mermaid = await loadMermaid();
  await mermaid.parse(code);
  const { svg } = await mermaid.render(id, code);
  return svg;
}
