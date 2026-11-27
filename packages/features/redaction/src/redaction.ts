export type SourceFormat = 'teams-direct' | 'teams-group' | 'backlog';

type Candidate = {
  terms: string[];
  replacement: string;
};

const namePattern = /^[\p{Script=Han}\p{Script=Katakana}々]{2,12}(?:[ \t　]+[\p{Script=Han}\p{Script=Katakana}々]{1,12})?$/u;
const commonTitles = new Set(['利用者', '担当者', '管理者', '関係者', '参加者', '社員', '先生']);
const structuredFields = /^(?:担当者|投稿者|作成者|コメント者)[ \t　]*[:：][ \t　]*(.+)$/gmu;

function formatSource(source: string, format: SourceFormat) {
  const names: string[] = [];
  const text = source.replace(/\r\n?/g, '\n').trim();
  if (format === 'backlog') {
    for (const match of text.matchAll(structuredFields)) {
      const name = match[1]?.trim();
      if (name && namePattern.test(name)) names.push(name);
    }
    return { markdown: text, names };
  }
  const blocks = text.split(/\n(?:[ \t　]*\n)+/u);
  const markdown = blocks.map((block) => {
    const [firstLine = '', ...body] = block.split('\n');
    const name = firstLine.trim();
    if (format === 'teams-group' && body.length > 0 && namePattern.test(name)) {
      names.push(name);
      return '**' + name + '**\n\n' + body.join('\n');
    }
    return '- ' + [firstLine, ...body].join('\n  ');
  }).join('\n\n');
  return { markdown: text ? markdown : '', names };
}

function identifyPeople(text: string, names: string[]): Candidate[] {
  const people = new Map<string, Set<string>>();
  for (const name of names) {
    const key = name.replace(/[ \t　]+/gu, '');
    let terms = people.get(key);
    if (!terms) {
      terms = new Set();
      people.set(key, terms);
    }
    terms.add(name);
    if (text.includes(key)) terms.add(key);
  }

  const knownNames = [...people.keys()];
  for (const match of text.matchAll(/([\p{Script=Han}\p{Script=Katakana}々]{2,12})(?:さん|様)/gu)) {
    const [term, name] = match;
    if (!name || commonTitles.has(name)) continue;
    // 姓とみられる呼び方は、発言者・担当者の候補が1人に絞れる場合にだけ同じ仮名にする。
    const matches = knownNames.filter((known) => known.startsWith(name));
    const key = people.has(name) || matches.length !== 1 ? name : (matches[0] ?? name);
    let terms = people.get(key);
    if (!terms) {
      terms = new Set();
      people.set(key, terms);
    }
    terms.add(term);
  }

  return [...people.values()].map((terms, index) => ({
    terms: [...terms],
    replacement: (index < 26 ? String.fromCharCode(65 + index) : '人物' + (index + 1)) + 'さん',
  }));
}

const fixedPatterns = [
  { pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, replacement: '[メール]' },
  { pattern: /https?:\/\/[^\s<>"'）)】、。]+/giu, replacement: '[URL]' },
  { pattern: /\b0\d{1,4}-\d{1,4}-\d{3,4}\b/g, replacement: '[電話番号]' },
  {
    pattern: /(?:api[ _-]?key|\btoken\b|トークン|パスワード)[ \t　]*[:：=][ \t　]*["']?([^\s"'<>、。]+)/giu,
    replacement: '[認証情報]',
  },
];

export function analyzeRedaction(source: string, format: SourceFormat, additionalTerms: string) {
  const { markdown, names } = formatSource(source, format);
  const candidates = identifyPeople(markdown, names);
  const registered = new Set(additionalTerms.split(/\r?\n/u).map((term) => term.trim()).filter(Boolean));
  for (const term of registered) {
    if (markdown.includes(term)) candidates.push({ terms: [term], replacement: '[伏せ字]' });
  }
  for (const { pattern, replacement } of fixedPatterns) {
    const terms = new Set<string>();
    for (const match of markdown.matchAll(pattern)) terms.add(match[1] ?? match[0]);
    for (const term of terms) candidates.push({ terms: [term], replacement });
  }
  return { markdown, candidates };
}

export function redact(markdown: string, candidates: Candidate[]) {
  const replacements = new Map<string, string>();
  for (const { terms, replacement } of candidates) {
    for (const term of terms) {
      if (!replacements.has(term)) replacements.set(term, replacement);
    }
  }
  if (replacements.size === 0) return [{ text: markdown, redacted: false }];

  // 同じ位置から始まる語が重なる場合は長い方を優先する。
  const alternatives = [...replacements.keys()].sort((a, b) => b.length - a.length)
    .map((term) => term.replace(/[.*+?^$(){}|[\]\\]/g, '\\$&'));
  const fragments: { text: string; redacted: boolean }[] = [];
  let cursor = 0;
  for (const match of markdown.matchAll(new RegExp(alternatives.join('|'), 'gu'))) {
    const term = match[0];
    if (cursor < match.index) fragments.push({ text: markdown.slice(cursor, match.index), redacted: false });
    fragments.push({ text: replacements.get(term) ?? term, redacted: true });
    cursor = match.index + term.length;
  }
  if (cursor < markdown.length) fragments.push({ text: markdown.slice(cursor), redacted: false });
  return fragments;
}
