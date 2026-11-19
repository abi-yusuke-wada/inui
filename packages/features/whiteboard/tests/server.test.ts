import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { Hono } from 'hono';
import { RequestError } from '@inui/feature-kit/server';
import { BoardStore, createWhiteboardRoutes } from '../src/server.ts';

const SCENE = {
  elements: [{ id: 'e1', type: 'freedraw', version: 3, points: [[0, 0], [10, 12]] }],
  files: {},
  appState: { viewBackgroundColor: '#ffffff' },
};

function app(t: TestContext) {
  let tick = 0;
  const store = new BoardStore(':memory:', { now: () => new Date(Date.UTC(2026, 10, 17, 0, 0, tick++)) });
  t.after(() => store.close());
  const root = new Hono();
  root.route('/api', createWhiteboardRoutes({ store }));
  root.onError((error, c) => error instanceof RequestError
    ? c.json({ error: { code: error.code } }, error.status)
    : c.json({ error: { code: 'internal_error' } }, 500));
  const send = (method: string, path: string, body?: unknown) => root.request('http://127.0.0.1/api' + path, {
    method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  return { store, send };
}

test('ボードを作成・保存・再読み込み・改名・削除し、一覧は更新の新しい順に返す', async (t) => {
  const { send } = app(t);
  const created = await send('POST', '/whiteboards', { name: '  設計のラフ  ' });
  assert.equal(created.status, 201);
  const { board } = await created.json();
  assert.equal(board.name, '設計のラフ');
  assert.equal(Object.hasOwn(board, 'scene'), false);
  const second = (await (await send('POST', '/whiteboards', { name: '会議メモ' })).json()).board;
  assert.deepEqual((await (await send('GET', '/whiteboards/' + board.id)).json()).board.scene,
    { elements: [], files: {}, appState: {} });
  assert.equal((await send('PATCH', '/whiteboards/' + board.id, { scene: SCENE })).status, 200);
  const loaded = (await (await send('GET', '/whiteboards/' + board.id)).json()).board;
  assert.deepEqual(loaded.scene, SCENE);
  // 保存したボードが一覧の先頭に来る。
  assert.deepEqual((await (await send('GET', '/whiteboards')).json()).boards.map((item: { id: string }) => item.id), [board.id, second.id]);
  assert.equal((await (await send('PATCH', '/whiteboards/' + board.id, { name: '設計のラフ v2' })).json()).board.name, '設計のラフ v2');
  assert.deepEqual((await (await send('GET', '/whiteboards/' + board.id)).json()).board.scene, SCENE);
  assert.equal((await send('DELETE', '/whiteboards/' + board.id)).status, 200);
  assert.equal((await send('GET', '/whiteboards/' + board.id)).status, 404);
  assert.equal((await send('DELETE', '/whiteboards/' + board.id)).status, 404);
});

test('名前・描画内容の形・ID・余分キーを検証し、不正な内容を保存しない', async (t) => {
  const { send, store } = app(t);
  for (const body of [{ name: '' }, { name: ' ' }, { name: 'a'.repeat(101) }, { name: 1 }, { name: 'x', scene: SCENE }]) {
    assert.equal((await send('POST', '/whiteboards', body)).status, 400);
  }
  const { board } = await (await send('POST', '/whiteboards', { name: 'a'.repeat(100) })).json();
  for (const scene of [
    { ...SCENE, elements: 'x' }, { ...SCENE, elements: [1] }, { ...SCENE, files: [] },
    // 外部を読み込む値や、色の後ろに別の指定を続ける値は受け付けない。
    ...['url(https://example.com/x)', 'url(//example.com/x)', 'red;background:url(x)', 'expression(alert(1))',
      'rgb(1,2,3) url(x)', 'a'.repeat(31)].map((color) => ({ ...SCENE, appState: { viewBackgroundColor: color } })),
    { ...SCENE, appState: { theme: 'dark' } }, { ...SCENE, tool: 'delete_all' },
    { ...SCENE, elements: Array.from({ length: 20_001 }, () => ({})) },
  ]) {
    assert.equal((await send('PATCH', '/whiteboards/' + board.id, { scene })).status, 400);
  }
  assert.equal((await send('PATCH', '/whiteboards/' + board.id, {})).status, 400);
  assert.equal((await send('PATCH', '/whiteboards/not-a-uuid', { name: 'x' })).status, 400);
  assert.equal((await send('PATCH', '/whiteboards/00000000-0000-4000-8000-000000000000', { name: 'x' })).status, 404);
  assert.equal((await send('GET', '/whiteboards?all=1')).status, 400);
  assert.deepEqual(store.get(board.id)?.scene, { elements: [], files: {}, appState: {} });
});

test('Excalidrawの背景色の入力欄が受け付ける色（16進・色名・色の関数）を保存できる', async (t) => {
  const { send, store } = app(t);
  const { board } = await (await send('POST', '/whiteboards', { name: '背景色' })).json();
  for (const color of ['#fff', '#ffeeaa80', 'transparent', 'red', 'rgb(255, 0, 0)', 'rgba(0,0,0,0.5)', 'hsl(120 50% 50% / 0.4)']) {
    const scene = { ...SCENE, appState: { viewBackgroundColor: color } };
    assert.equal((await send('PATCH', '/whiteboards/' + board.id, { scene })).status, 200, color);
    assert.equal(store.get(board.id)?.scene.appState.viewBackgroundColor, color);
  }
});

test('画像を含む描画も上限までは保存し、上限を超える本文は受け付けない', async (t) => {
  const { send } = app(t);
  const { board } = await (await send('POST', '/whiteboards', { name: '画像' })).json();
  const image = { id: 'f1', mimeType: 'image/png', dataURL: 'data:image/png;base64,' + 'A'.repeat(2 * 1024 * 1024), created: 1 };
  const scene = { ...SCENE, files: { f1: image } };
  assert.equal((await send('PATCH', '/whiteboards/' + board.id, { scene })).status, 200);
  const huge = { ...SCENE, files: { f1: { ...image, dataURL: 'data:image/png;base64,' + 'A'.repeat(9 * 1024 * 1024) } } };
  assert.equal((await send('PATCH', '/whiteboards/' + board.id, { scene: huge })).status, 413);
});

test('実ファイルを開き直しても保存したボードが残り、resetで空に戻る', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'inui-boards-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'app.sqlite');
  const first = new BoardStore(path);
  const board = first.create('ラフ');
  first.update(board.id, { scene: SCENE });
  first.close();
  const second = new BoardStore(path);
  try {
    assert.deepEqual(second.get(board.id)?.scene, SCENE);
    second.reset();
    assert.deepEqual(second.list(), []);
  } finally { second.close(); }
});
