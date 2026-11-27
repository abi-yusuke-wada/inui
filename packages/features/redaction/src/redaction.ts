export type SourceFormat = 'teams-direct' | 'teams-group' | 'backlog';

type Candidate = {
  terms: string[];
  replacement: string;
};

const namePattern = /^[\p{Script=Han}\p{Script=Katakana}々]{2,12}(?:[ \t　]+[\p{Script=Han}\p{Script=Katakana}々]{1,12})?$/u;
const commonTitles = new Set(['利用者', '担当者', '管理者', '関係者', '参加者', '社員', '先生']);
const headingSuffix = /(?:事項|概要|詳細|手順|状況|結果|補足|備考|議題|課題)$/u;
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
  const blocks = text.split(/\n(?:[^\S\n]*\n)+/u);
  const markdown = blocks.map((block) => {
    const [firstLine = '', ...body] = block.split('\n');
    const name = firstLine.trim();
    // 貼り付けた本文中の見出しを、空行だけを根拠に発言者にしない。
    if (format === 'teams-group' && headingSuffix.test(name)) return block;
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
];

const credentialLabel = /(?:\b(?:[a-z_][a-z0-9_]*_)?(?:api[ _-]?key|token|password)\b|トークン|パスワード)[ \t　]*[:：=][ \t　]*/giu;
const bareCredential = /^[^\s"'<>、。]+/u;

function findClosingQuotes(text: string, valueStarts: number[]) {
  const closings = new Map<number, number>();
  // 後ろの値から決め、途中の引用符が「閉じる次の値」を開くものかを判定できるようにする。
  for (const start of [...valueStarts].sort((a, b) => b - a)) {
    const quote = text[start];
    if (quote !== '"' && quote !== "'") continue;
    for (let end = start + 1; end < text.length; end++) {
      if (text[end] === '\\') {
        end++;
        continue;
      }
      if (text[end] !== quote) continue;
      // 閉じる次の値を開く引用符なら、今の値は閉じていない。
      // 次の値が閉じない引用符は、今の値の閉じ引用符として値全体を伏せる。
      if (!closings.has(end)) closings.set(start, end);
      break;
    }
  }
  return closings;
}

function readCredentialValue(text: string, start: number, closings: ReadonlyMap<number, number>): string | undefined {
  const quote = text[start];
  if (quote !== '"' && quote !== "'") return bareCredential.exec(text.slice(start))?.[0];

  const end = closings.get(start);
  if (end !== undefined) return text.slice(start + 1, end);

  // 閉じ引用符がなければ、現在の行の残りを伏せる。
  const lineEnd = text.indexOf('\n', start + 1);
  return text.slice(start + 1, lineEnd === -1 ? undefined : lineEnd);
}

export function analyzeRedaction(source: string, format: SourceFormat, additionalTerms: string) {
  const { markdown, names } = formatSource(source, format);
  const candidates = identifyPeople(markdown, names);
  const detected = new Set(candidates.flatMap(({ terms }) => terms));
  function addCandidate(term: string, replacement: string) {
    if (detected.has(term)) return;
    detected.add(term);
    candidates.push({ terms: [term], replacement });
  }

  for (const line of additionalTerms.split(/\r?\n/u)) {
    const term = line.trim();
    if (term && markdown.includes(term)) addCandidate(term, '[伏せ字]');
  }
  for (const { pattern, replacement } of fixedPatterns) {
    for (const [term] of markdown.matchAll(pattern)) addCandidate(term, replacement);
  }
  const credentialStarts = Array.from(markdown.matchAll(credentialLabel), (match) => match.index + match[0].length);
  const closings = findClosingQuotes(markdown, credentialStarts);
  for (const start of credentialStarts) {
    const term = readCredentialValue(markdown, start, closings);
    if (term) addCandidate(term, '[認証情報]');
  }
  return { markdown, candidates };
}

export function redact(markdown: string, candidates: Candidate[]) {
  const replacements = new Map<string, string>();
  for (const { terms, replacement } of candidates) {
    for (const term of terms) {
      if (term && !replacements.has(term)) replacements.set(term, replacement);
    }
  }

  // 同じ位置では、最も長い語の範囲と置き換え先を使う。
  const starts = new Map<number, { end: number; replacement: string }>();
  for (const [term, replacement] of [...replacements].sort(([a], [b]) => b.length - a.length)) {
    for (let start = markdown.indexOf(term); start !== -1; start = markdown.indexOf(term, start + 1)) {
      if (!starts.has(start)) starts.set(start, { end: start + term.length, replacement });
    }
  }
  if (starts.size === 0) return [{ text: markdown, redacted: false }];

  const fragments: { text: string; redacted: boolean }[] = [];
  let cursor = 0;
  let start = 0;
  while (start < markdown.length) {
    const match = starts.get(start);
    if (!match) {
      start++;
      continue;
    }

    // 開始位置の違う候補も、重なっている範囲を連結してから一度だけ伏せる。
    let end = match.end;
    for (let index = start + 1; index < end; index++) {
      end = Math.max(end, starts.get(index)?.end ?? end);
    }
    if (cursor < start) fragments.push({ text: markdown.slice(cursor, start), redacted: false });
    fragments.push({ text: match.replacement, redacted: true });
    cursor = end;
    start = end;
  }
  if (cursor < markdown.length) fragments.push({ text: markdown.slice(cursor), redacted: false });
  return fragments;
}
