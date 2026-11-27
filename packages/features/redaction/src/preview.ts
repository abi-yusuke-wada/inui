import { analyzeRedaction, redact } from './redaction.ts';
import type { SourceFormat } from './redaction.ts';

const examples: Record<SourceFormat, { text: string; terms: string }> = {
  'teams-direct': {
    text: '青空案件の資料を確認できますか？\n\n山田さんに聞きました。連絡先は demo@example.invalid です。',
    terms: '青空案件',
  },
  'teams-group': {
    text: '山田花子\n青空案件の資料を出しました。佐藤太郎さん、確認をお願いします。\n\n佐藤太郎\n山田さん、ありがとうございます。',
    terms: '青空案件',
  },
  backlog: {
    text: '# 青空案件の確認\n\n担当者：山田 花子\n\n山田さんに確認をお願いします。\n資料: https://example.invalid/docs',
    terms: '青空案件',
  },
};

function element<T extends Element>(id: string): T {
  const value = document.querySelector<T>('#' + id);
  if (!value) throw new Error('プレビューに必要な要素がありません。');
  return value;
}

const source = element<HTMLTextAreaElement>('source');
const terms = element<HTMLTextAreaElement>('terms');
const format = element<HTMLSelectElement>('format');
const output = element<HTMLPreElement>('output');
const confirm = element<HTMLInputElement>('confirmed');
const copy = element<HTMLButtonElement>('copy');
const status = element<HTMLSpanElement>('status');
const candidateList = element<HTMLDivElement>('candidates');

function resetConfirmation(markdown: string) {
  confirm.checked = false;
  confirm.disabled = !markdown;
  copy.disabled = true;
  status.textContent = '';
}

function invalidate() {
  output.replaceChildren();
  candidateList.textContent = '候補を探すとここに表示します。';
  resetConfirmation('');
}

source.addEventListener('input', invalidate);
terms.addEventListener('input', invalidate);
format.addEventListener('change', invalidate);

function analyze() {
  const formatValue = format.value as SourceFormat;
  const { markdown, candidates } = analyzeRedaction(source.value, formatValue, terms.value);
  const selected = new Set(candidates);

  function updateOutput() {
    output.replaceChildren(...redact(markdown, candidates.filter((candidate) => selected.has(candidate))).map(({ text, redacted }) => {
      if (!redacted) return document.createTextNode(text);
      const mark = document.createElement('mark');
      mark.textContent = text;
      return mark;
    }));
    resetConfirmation(markdown);
  }

  candidateList.replaceChildren();
  for (const candidate of candidates) {
    const label = document.createElement('label');
    label.className = 'check';
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.checked = true;
    check.addEventListener('change', () => {
      if (check.checked) selected.add(candidate);
      else selected.delete(candidate);
      updateOutput();
    });
    label.append(check, candidate.terms.join('、') + ' → ' + candidate.replacement);
    candidateList.append(label);
  }
  if (candidates.length === 0) candidateList.textContent = markdown ? '候補は見つかりませんでした。出力を確認してください。' : '元の文章を入力してください。';
  updateOutput();
}

element<HTMLButtonElement>('analyze').addEventListener('click', analyze);
element<HTMLButtonElement>('sample').addEventListener('click', () => {
  const example = examples[format.value as SourceFormat];
  source.value = example.text;
  terms.value = example.terms;
  analyze();
});

confirm.addEventListener('change', () => { copy.disabled = !confirm.checked; });
copy.addEventListener('click', async () => {
  const text = output.textContent;
  if (!confirm.checked || !text) return;
  try {
    await navigator.clipboard.writeText(text);
    if (output.textContent === text && confirm.checked) status.textContent = 'コピーしました。';
  } catch {
    if (output.textContent !== text || !confirm.checked) return;
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(output);
    selection?.removeAllRanges();
    selection?.addRange(range);
    status.textContent = '選択した出力を手動でコピーしてください。';
  }
});
