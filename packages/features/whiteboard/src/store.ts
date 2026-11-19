import { randomUUID } from 'node:crypto';
import type { Database, Migration } from '@inui/feature-kit/db';
import { EMPTY_SCENE, MAX_NAME_LENGTH } from './types.ts';
import type { Board, BoardScene, BoardSummary } from './types.ts';

/** ボードの表。マイグレーションの仕組みより前に作られた表（同じ形）は、そのまま引き継ぐ。 */
export const boardMigrations: readonly Migration[] = [{
  id: 'whiteboard/001-whiteboards',
  up: [`CREATE TABLE IF NOT EXISTS whiteboards (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND ${MAX_NAME_LENGTH}),
    scene TEXT NOT NULL CHECK(json_valid(scene)),
    updated_at TEXT NOT NULL
  ) STRICT`],
}];

/** ホワイトボードを、名前と描画内容（JSON）の組で保存する。表はboardMigrationsで作っておく。 */
export class BoardStore {
  private readonly db: Database;
  private readonly now: () => Date;

  constructor(db: Database, { now = () => new Date() }: { now?: () => Date } = {}) {
    this.db = db;
    this.now = now;
  }

  /** 最後に更新したボードを先に返す。描画内容は含めない。 */
  async list(): Promise<BoardSummary[]> {
    const rows = await this.db.query('SELECT id, name, updated_at FROM whiteboards ORDER BY updated_at DESC, id');
    return rows.map((row) => ({ id: row.id as string, name: row.name as string, updatedAt: row.updated_at as string }));
  }

  async get(id: string): Promise<Board | undefined> {
    const [row] = await this.db.query('SELECT id, name, scene, updated_at FROM whiteboards WHERE id = ?', [id]);
    if (!row) return undefined;
    return { id: row.id as string, name: row.name as string, updatedAt: row.updated_at as string,
      scene: JSON.parse(row.scene as string) as BoardScene };
  }

  async create(name: string): Promise<Board> {
    const board: Board = { id: randomUUID(), name, updatedAt: this.now().toISOString(), scene: EMPTY_SCENE };
    await this.db.run('INSERT INTO whiteboards (id, name, scene, updated_at) VALUES (?, ?, ?, ?)',
      [board.id, board.name, JSON.stringify(board.scene), board.updatedAt]);
    return board;
  }

  /**
   * 名前・描画内容のうち、指定したものだけを更新する。存在しないIDではundefinedを返す。
   * 読み込みと書き込みの間に別の更新が入らないよう、1つの文で更新する。
   */
  async update(id: string, change: { name?: string; scene?: BoardScene }): Promise<BoardSummary | undefined> {
    const [row] = await this.db.query(`UPDATE whiteboards
      SET name = COALESCE(?, name), scene = COALESCE(?, scene), updated_at = ?
      WHERE id = ? RETURNING id, name, updated_at`,
    [change.name ?? null, change.scene === undefined ? null : JSON.stringify(change.scene), this.now().toISOString(), id]);
    return row ? { id: row.id as string, name: row.name as string, updatedAt: row.updated_at as string } : undefined;
  }

  async remove(id: string): Promise<boolean> {
    return (await this.db.run('DELETE FROM whiteboards WHERE id = ?', [id])).changes > 0;
  }

  /** 検証をやり直す明示コマンドからのみ、ボードを空に戻す。 */
  async reset(): Promise<void> {
    await this.db.run('DELETE FROM whiteboards');
  }
}
