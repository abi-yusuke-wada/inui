import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeRedaction, redact } from '../src/redaction.ts';

test('Teamsの1対1の会話を段落ごとに分け、人名とメールを伏せる', () => {
  const result = analyzeRedaction('連絡先を教えてください。\r\n　\r\n山田さんに確認しました。\r\ndemo@example.invalid', 'teams-direct', '');
  assert.equal(redact(result.markdown, result.candidates).map(({ text }) => text).join(''),
    '- 連絡先を教えてください。\n\n- Aさんに確認しました。\n  [メール]');
});

test('Teamsのグループで発言者・本文の氏名・一意な姓を同じ仮名にする', () => {
  const source = '山田花子\n佐藤太郎さん、お願いします。\n\n佐藤太郎\n山田さん、了解です。';
  const result = analyzeRedaction(source, 'teams-group', '');
  assert.equal(redact(result.markdown, result.candidates).map(({ text }) => text).join(''),
    '**Aさん**\n\nBさん、お願いします。\n\n**Bさん**\n\nAさん、了解です。');
});

test('同じ姓の発言者が複数いれば、本文の呼び方をどちらにも紐づけない', () => {
  const source = '山田花子\nお願いします。\n\n山田太郎\n山田さんに確認しました。';
  const result = analyzeRedaction(source, 'teams-group', '');
  assert.equal(redact(result.markdown, result.candidates).map(({ text }) => text).join(''),
    '**Aさん**\n\nお願いします。\n\n**Bさん**\n\nCさんに確認しました。');
});

test('Backlogの架空の担当者と識別情報を置き換え、候補を解除した語は残す', () => {
  const source = '# 青空案件 (v2)\n\n担当者：山田 花子\n\n山田様へ: 03-1234-5678\nhttps://example.invalid/view\nAPI key: demo-placeholder';
  const result = analyzeRedaction(source, 'backlog', '青空案件\n青空案件 (v2)\n');
  const fragments = redact(result.markdown, result.candidates.filter(({ replacement }) => replacement !== '[URL]'));
  assert.equal(fragments.map(({ text }) => text).join(''),
    '# [伏せ字]\n\n担当者：Aさん\n\nAさんへ: [電話番号]\nhttps://example.invalid/view\nAPI key: [認証情報]');
  assert.deepEqual(fragments.filter(({ redacted }) => redacted).map(({ text }) => text),
    ['[伏せ字]', 'Aさん', 'Aさん', '[電話番号]', '[認証情報]']);
});

test('空の入力には結果を出さず、入力中のHTMLは文字列として保持する', () => {
  const empty = analyzeRedaction('  \r\n　', 'teams-direct', '');
  assert.deepEqual(empty, { markdown: '', candidates: [] });
  const result = analyzeRedaction('<b>担当者様</b>', 'backlog', '');
  assert.deepEqual(redact(result.markdown, result.candidates), [{ text: '<b>担当者様</b>', redacted: false }]);
});

test('引用符内の空白とエスケープを含む認証情報を値全体で伏せる', () => {
  const source = [
    'パスワード: "sample words only"',
    "token = 'another \\'quoted\\' value'",
    'API key: "unclosed sample value',
    '補足: 公開用の説明',
  ].join('\n');
  const result = analyzeRedaction(source, 'backlog', '');
  assert.equal(redact(result.markdown, result.candidates).map(({ text }) => text).join(''),
    'パスワード: "[認証情報]"\ntoken = \'[認証情報]\'\nAPI key: "[認証情報]\n補足: 公開用の説明');
});

test('複数行の認証情報は閉じ引用符までを一つの値として伏せる', () => {
  const source = 'パスワード: "example line 1\nexample line 2"\n補足: 公開用の説明';
  const result = analyzeRedaction(source, 'backlog', '');
  assert.deepEqual(result.candidates, [{ terms: ['example line 1\nexample line 2'], replacement: '[認証情報]' }]);
  assert.equal(redact(result.markdown, result.candidates).map(({ text }) => text).join(''),
    'パスワード: "[認証情報]"\n補足: 公開用の説明');
});

test('英語のラベルと接頭辞付きの環境変数名から認証情報を検出する', () => {
  const source = 'INUI_GITHUB_TOKEN=example-token\nPASSWORD=example-passphrase\nSERVICE_API_KEY="example key"';
  const result = analyzeRedaction(source, 'backlog', '');
  assert.equal(redact(result.markdown, result.candidates).map(({ text }) => text).join(''),
    'INUI_GITHUB_TOKEN=[認証情報]\nPASSWORD=[認証情報]\nSERVICE_API_KEY="[認証情報]"');
});

test('閉じていない認証情報の次に別の代入がある場合は各行の値を伏せる', () => {
  const source = 'TOKEN="unclosed example\nPASSWORD="another example"';
  const result = analyzeRedaction(source, 'backlog', '');
  assert.equal(redact(result.markdown, result.candidates).map(({ text }) => text).join(''),
    'TOKEN="[認証情報]\nPASSWORD="[認証情報]"');
});

test('値の中のラベルに続く引用符で値が閉じない場合は、そこまでを一つの値として伏せる', () => {
  const source = 'TOKEN="example line one\nexample line two PASSWORD="\n補足: 公開用の説明';
  const result = analyzeRedaction(source, 'backlog', '');
  assert.deepEqual(result.candidates, [{ terms: ['example line one\nexample line two PASSWORD='], replacement: '[認証情報]' }]);
  assert.equal(redact(result.markdown, result.candidates).map(({ text }) => text).join(''),
    'TOKEN="[認証情報]"\n補足: 公開用の説明');
});

test('異なる位置から始まる候補が連続して重なっても全体を伏せる', () => {
  const source = '前: 青空銀行決済基盤本番、青空銀行決済基盤本番、後';
  const result = analyzeRedaction(source, 'backlog', '青空銀行\n銀行決済基盤\n基盤本番');
  assert.equal(redact(result.markdown, result.candidates).map(({ text }) => text).join(''),
    '前: [伏せ字]、[伏せ字]、後');
});

test('同じ語の出現が重なる場合も、隣り合う場合も、対象をすべて伏せる', () => {
  const candidate = { terms: ['ana'], replacement: '[伏せ字]' };
  assert.deepEqual(redact('banana', [candidate]), [
    { text: 'b', redacted: false },
    { text: '[伏せ字]', redacted: true },
  ]);
  assert.deepEqual(redact('anaana', [candidate]), [
    { text: '[伏せ字]', redacted: true },
    { text: '[伏せ字]', redacted: true },
  ]);
});

test('ノーブレークスペースだけの区切り行でもTeamsの発言者を両方伏せる', () => {
  const source = '山田花子\n確認しました。\n\u00a0\n佐藤太郎\n対応します。';
  const result = analyzeRedaction(source, 'teams-group', '');
  assert.equal(redact(result.markdown, result.candidates).map(({ text }) => text).join(''),
    '**Aさん**\n\n確認しました。\n\n**Bさん**\n\n対応します。');
});

test('Teamsの発言中の見出しを本文に残し、次の発言者は伏せる', () => {
  const source = [
    '山田花子\n確認事項は次のとおりです。',
    '確認事項\n見直しが必要です。',
    '対応手順\n手順を見直します。',
    '佐藤太郎\n内容を確認しました。',
  ].join('\n\n');
  const result = analyzeRedaction(source, 'teams-group', '');
  assert.deepEqual(result.candidates.map(({ terms }) => terms), [['山田花子'], ['佐藤太郎']]);
  assert.equal(redact(result.markdown, result.candidates).map(({ text }) => text).join(''),
    '**Aさん**\n\n確認事項は次のとおりです。\n\n確認事項\n見直しが必要です。\n\n対応手順\n手順を見直します。\n\n**Bさん**\n\n内容を確認しました。');
});

test('手動登録と自動検出が同じ語なら一つの候補にまとめ、解除を出力に反映する', () => {
  const source = '連絡先は sample@example.invalid です。';
  const result = analyzeRedaction(source, 'backlog', 'sample@example.invalid\nsample@example.invalid');
  assert.deepEqual(result.candidates, [{ terms: ['sample@example.invalid'], replacement: '[伏せ字]' }]);
  assert.equal(redact(result.markdown, result.candidates).map(({ text }) => text).join(''),
    '連絡先は [伏せ字] です。');
  assert.deepEqual(redact(result.markdown, result.candidates.slice(1)), [{ text: source, redacted: false }]);
});
