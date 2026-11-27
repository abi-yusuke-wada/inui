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
