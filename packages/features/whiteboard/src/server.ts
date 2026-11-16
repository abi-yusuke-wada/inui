import { Hono } from 'hono';
import { checkQuery, invalidInput, isRecord, keysAre, readJson, RequestError } from '@inui/feature-kit/server';
import type { BoardStore } from './store.ts';
import { MAX_ELEMENTS, MAX_NAME_LENGTH, MAX_SCENE_BYTES } from './types.ts';
import type { BoardScene } from './types.ts';

export { BoardStore } from './store.ts';

const BOARD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const COLOR = /^(?:#[0-9a-fA-F]{3,8}|transparent)$/;

function boardId(value: string): string {
  if (!BOARD_ID.test(value)) invalidInput();
  return value;
}

function notFound(): never {
  throw new RequestError(404, 'board_not_found', '指定したボードは見つかりませんでした。');
}

function boardName(value: unknown): string {
  if (typeof value !== 'string') invalidInput();
  const name = value.trim();
  if (name.length < 1 || name.length > MAX_NAME_LENGTH) invalidInput();
  return name;
}

/**
 * 描画内容は形だけを確かめて保存する。要素の中身はExcalidrawの形式のまま扱い、
 * 表示時にExcalidrawのrestoreで検証・補正させる。
 */
function boardScene(value: unknown): BoardScene {
  if (!isRecord(value) || !keysAre(value, ['elements', 'files', 'appState'])
      || !Array.isArray(value.elements) || value.elements.length > MAX_ELEMENTS
      || !value.elements.every(isRecord) || !isRecord(value.files) || !isRecord(value.appState)
      || !keysAre(value.appState, ['viewBackgroundColor'])
      || (value.appState.viewBackgroundColor !== undefined
        && (typeof value.appState.viewBackgroundColor !== 'string' || !COLOR.test(value.appState.viewBackgroundColor)))) {
    invalidInput();
  }
  return value as unknown as BoardScene;
}

/** ホワイトボードの一覧・作成・読み込み・保存・削除を提供する。保存は利用者の操作でだけ行う。 */
export function createWhiteboardRoutes({ store }: { store: Pick<BoardStore, 'list' | 'get' | 'create' | 'update' | 'remove'> }): Hono {
  const routes = new Hono();

  routes.get('/whiteboards', (c) => {
    checkQuery(c, []);
    return c.json({ boards: store.list() });
  });

  routes.post('/whiteboards', async (c) => {
    const body = await readJson(c);
    if (!isRecord(body) || !keysAre(body, ['name'])) invalidInput();
    const { scene: _scene, ...board } = store.create(boardName(body.name));
    return c.json({ board }, 201);
  });

  routes.get('/whiteboards/:id', (c) => {
    checkQuery(c, []);
    const board = store.get(boardId(c.req.param('id')));
    if (!board) notFound();
    return c.json({ board });
  });

  routes.patch('/whiteboards/:id', async (c) => {
    const id = boardId(c.req.param('id'));
    const body = await readJson(c, MAX_SCENE_BYTES);
    if (!isRecord(body) || !keysAre(body, ['name', 'scene']) || (body.name === undefined && body.scene === undefined)) invalidInput();
    const board = store.update(id, {
      ...(body.name === undefined ? {} : { name: boardName(body.name) }),
      ...(body.scene === undefined ? {} : { scene: boardScene(body.scene) }),
    });
    if (!board) notFound();
    return c.json({ board });
  });

  routes.delete('/whiteboards/:id', (c) => {
    if (!store.remove(boardId(c.req.param('id')))) notFound();
    return c.json({ deleted: true });
  });

  return routes;
}
