import MarkdownIt from 'markdown-it';
import createDOMPurify from 'dompurify';
import type { WindowLike } from 'dompurify';

export interface Heading { id: string; level: number; text: string }
export interface RenderedMarkdown { html: string; headings: Heading[]; diagrams: string[] }
interface RenderEnv { headings: Heading[]; diagrams: string[] }
/** markdown-itのenvは任意の値の入れ物のため、このモジュールで入れた形として扱う。 */
const renderEnv = (env: unknown): RenderEnv => env as RenderEnv;

export const MAX_MARKDOWN_BYTES = 5 * 1024 * 1024;
const MERMAID_INFO = /^mermaid(?:\s|$)/i;

/**
 * Markdownを、生のHTMLを解釈せずに変換し、DOMPurifyで無害化したHTMLを返す。
 * 画像は外部への通信を起こさないよう読み込まず、代替テキストだけを表示する。
 */
export function createMarkdownRenderer(window: WindowLike) {
  const purify = createDOMPurify(window);
  // 文書外へのリンクは新しいタブで開き、遷移元の情報を渡さない。
  purify.addHook('afterSanitizeAttributes', (node) => {
    if (node.nodeName !== 'A') return;
    const href = node.getAttribute('href');
    if (href === null || href.startsWith('#')) return;
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  });

  const md = new MarkdownIt({ html: false, linkify: true, typographer: false });
  md.renderer.rules.image = (tokens, index, options, env) => {
    const alt = md.renderer.renderInlineAsText(tokens[index]?.children ?? [], options, env).trim();
    return `<span class="md-image-alt">[画像${alt ? `: ${md.utils.escapeHtml(alt)}` : ''}]</span>`;
  };
  const defaultFence = md.renderer.rules.fence;
  md.renderer.rules.fence = (tokens, index, options, env, self) => {
    const token = tokens[index];
    if (token && MERMAID_INFO.test(token.info.trim())) {
      const { diagrams } = renderEnv(env);
      diagrams.push(token.content);
      return `<div class="md-mermaid" data-diagram="${diagrams.length - 1}"></div>\n`;
    }
    return defaultFence ? defaultFence(tokens, index, options, env, self) : self.renderToken(tokens, index, options);
  };
  // 目次から移動できるよう、見出しに文書内で一意なIDを付ける。
  md.core.ruler.push('inui_heading_ids', (state) => {
    const env = renderEnv(state.env);
    state.tokens.forEach((token, index) => {
      if (token.type !== 'heading_open') return;
      const id = `md-h-${env.headings.length + 1}`;
      token.attrSet('id', id);
      const inline = state.tokens[index + 1];
      const text = inline?.children ? md.renderer.renderInlineAsText(inline.children, md.options, state.env).trim() : '';
      env.headings.push({ id, level: Number(token.tag.slice(1)), text: text || '（見出し）' });
    });
  });

  return {
    render(source: string): RenderedMarkdown {
      const env: RenderEnv = { headings: [], diagrams: [] };
      const html = md.render(source, env as unknown as Record<string, unknown>);
      const sanitized = purify.sanitize(html, {
        FORBID_TAGS: ['img', 'style', 'form', 'input', 'button', 'iframe'],
        ALLOW_DATA_ATTR: false,
        ADD_ATTR: ['data-diagram', 'target'],
      });
      return { html: sanitized, headings: env.headings, diagrams: env.diagrams };
    },
    /** Mermaidが生成したSVGも、画面へ入れる前に無害化する。 */
    sanitizeSvg(svg: string): string {
      return purify.sanitize(svg, {
        USE_PROFILES: { svg: true, svgFilters: true, html: true },
        ADD_TAGS: ['foreignObject'],
        FORBID_TAGS: ['script', 'iframe', 'img', 'image'],
      });
    },
  };
}

export type MarkdownRenderer = ReturnType<typeof createMarkdownRenderer>;
