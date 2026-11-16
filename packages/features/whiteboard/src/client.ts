import { ApiError, isRecord } from '@inui/feature-kit/web';
import { MAX_NAME_LENGTH } from './types.ts';
import type { Board, BoardSummary } from './types.ts';

export type { Board, BoardScene, BoardSummary } from './types.ts';
export { MAX_NAME_LENGTH } from './types.ts';

const isSummary = (value: unknown): value is BoardSummary => isRecord(value)
  && typeof value.id === 'string' && value.id.length > 0
  && typeof value.name === 'string' && value.name.length >= 1 && value.name.length <= MAX_NAME_LENGTH
  && typeof value.updatedAt === 'string';

export function parseBoards(value: unknown): BoardSummary[] {
  if (!isRecord(value) || !Array.isArray(value.boards) || !value.boards.every(isSummary)) throw new ApiError('invalid');
  return value.boards;
}

export function parseBoardSummary(value: unknown): BoardSummary {
  if (!isRecord(value) || !isSummary(value.board)) throw new ApiError('invalid');
  return value.board;
}

/** 要求したボードの描画内容だけを受け取る。要素の中身はExcalidrawのrestoreで検証させる。 */
export function parseBoard(value: unknown, id: string): Board {
  if (!isRecord(value) || !isSummary(value.board) || value.board.id !== id) throw new ApiError('invalid');
  const scene = (value.board as unknown as Record<string, unknown>).scene;
  if (!isRecord(scene) || !Array.isArray(scene.elements) || !scene.elements.every(isRecord)
      || !isRecord(scene.files) || !isRecord(scene.appState)) throw new ApiError('invalid');
  return value.board as unknown as Board;
}
