import type { MermaidConfig } from 'mermaid';

let ready: Promise<typeof import('mermaid').default> | undefined;

/**
 * Mermaidの初期設定。スクリプトやクリック操作を無効にする（strict）。
 * 図の側（frontmatterや%%{init}%%）から変えられないキー（secure）に、CSSへ入る設定を加える。
 * これらは外部の画像を読み込むCSSを入れる経路になるため、図の側の値は使わない（既定の6つは残す）。
 */
export const MERMAID_CONFIG: MermaidConfig = {
  startOnLoad: false,
  securityLevel: 'strict',
  theme: 'neutral',
  secure: ['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'suppressErrorRendering', 'maxEdges',
    'themeCSS', 'themeVariables', 'fontFamily', 'altFontFamily'],
};

/** Mermaidは図を含む文書を開いたときだけ読み込む。 */
function loadMermaid() {
  ready ??= import('mermaid').then(({ default: mermaid }) => {
    mermaid.initialize(MERMAID_CONFIG);
    return mermaid;
  }).catch((error: unknown) => {
    ready = undefined;
    throw error;
  });
  return ready;
}

// 画像ノード（img:）・URL・CSSで画像や外部のCSSを読む記法を含む図。Mermaidは描画の途中で画像を読み込むため
// （securityLevelがstrictでも）、描画後のSVGを無害化しても外部への通信を防げない。こうした図は描画せず、
// 呼び出し元で定義をそのまま表示する。URLは、ブラウザが https:/ や https:example.org も外部のURLとして扱うため、
// スラッシュの数によらずスキームで見つける。
const EXTERNAL_REFERENCE = /\bimg\s*:|\b(?:url|image|image-set|cross-fade)\s*\(|@import|\/\/|\b(?:https?|ftp|wss?):/i;

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
    // CSSの文字列やYAMLでは、\ と改行の組は行の継続として取り除かれる。
    .replace(/\\\r?\n/g, '')
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
