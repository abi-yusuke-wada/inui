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

// 画像ノード（img:）・URL・CSSのurl()を含む図。Mermaidは描画の途中で画像を読み込むため（securityLevelがstrictでも）、
// 描画後のSVGを無害化しても外部への通信を防げない。こうした図は描画せず、呼び出し元で定義をそのまま表示する。
const EXTERNAL_REFERENCE = /\bimg\s*:|url\s*\(|\/\//i;

/** 1文字の符号位置を、範囲外なら置き換え文字にして返す。 */
function codePoint(value: number): string {
  return Number.isInteger(value) && value >= 0 && value <= 0x10ffff ? String.fromCodePoint(value) : '\ufffd';
}

/**
 * MermaidやCSSが後で元に戻すエスケープを展開する。YAML・JSONの \u・\x、CSSの \75 のような16進、
 * Mermaidの #117; と HTMLの &#117; の文字参照、その他の \/ などを、検査のために元の文字へ戻す。
 */
export function decodeEscapes(text: string): string {
  return text
    .replace(/\\u\{([0-9a-f]{1,6})\}|\\u([0-9a-f]{4})|\\U([0-9a-f]{8})|\\x([0-9a-f]{2})/gi,
      (_match, braced: string | undefined, short: string | undefined, long: string | undefined, byte: string | undefined) =>
        codePoint(Number.parseInt(braced ?? short ?? long ?? byte ?? '', 16)))
    .replace(/\\([0-9a-f]{1,6})\s?/gi, (_match, hex: string) => codePoint(Number.parseInt(hex, 16)))
    .replace(/&?#(x[0-9a-f]{1,6}|\d{1,7});/gi, (_match, reference: string) =>
      codePoint(reference[0] === 'x' || reference[0] === 'X' ? Number.parseInt(reference.slice(1), 16) : Number(reference)))
    .replace(/\\(.)/g, '$1');
}

/** 図の定義を検証してからSVGへ変換する。不正な定義や外部を参照する定義では描画を試みない。 */
export async function renderDiagram(code: string, id: string): Promise<string> {
  // frontmatterの設定（themeCSS等）やCSSは、エスケープを元に戻してから使われるため、戻した文字列も検査する。
  if (EXTERNAL_REFERENCE.test(code) || EXTERNAL_REFERENCE.test(decodeEscapes(code))) throw new Error('external_reference');
  const mermaid = await loadMermaid();
  await mermaid.parse(code);
  const { svg } = await mermaid.render(id, code);
  return svg;
}
