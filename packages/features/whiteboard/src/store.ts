import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { EMPTY_SCENE, MAX_NAME_LENGTH } from './types.ts';
import type { Board, BoardScene, BoardSummary } from './types.ts';

/** ホワイトボードを、名前と描画内容（JSON）の組でSQLiteへ保存する。 */
export class BoardStore {
  private readonly db: DatabaseSync;
  private readonly now: () => Date;

  constructor(path: string, { now = () => new Date() }: { now?: () => Date } = {}) {
    // 描いた内容を含むため、新しく作るディレクトリは所有者だけが開けるようにする。
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.now = now;
    this.db = new DatabaseSync(path);
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS whiteboards (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND ${MAX_NAME_LENGTH}),
          scene TEXT NOT NULL CHECK(json_valid(scene)),
          updated_at TEXT NOT NULL
        ) STRICT;
      `);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  /** 最後に更新したボードを先に返す。描画内容は含めない。 */
  list(): BoardSummary[] {
    return this.db.prepare('SELECT id, name, updated_at FROM whiteboards ORDER BY updated_at DESC, id').all()
      .map((row) => ({ id: row.id as string, name: row.name as string, updatedAt: row.updated_at as string }));
  }

  get(id: string): Board | undefined {
    const row = this.db.prepare('SELECT id, name, scene, updated_at FROM whiteboards WHERE id = ?').get(id);
    if (!row) return undefined;
    return { id: row.id as string, name: row.name as string, updatedAt: row.updated_at as string,
      scene: JSON.parse(row.scene as string) as BoardScene };
  }

  create(name: string): Board {
    const board: Board = { id: randomUUID(), name, updatedAt: this.now().toISOString(), scene: EMPTY_SCENE };
    this.db.prepare('INSERT INTO whiteboards (id, name, scene, updated_at) VALUES (?, ?, ?, ?)')
      .run(board.id, board.name, JSON.stringify(board.scene), board.updatedAt);
    return board;
  }

  /** 名前・描画内容のうち、指定したものだけを更新する。存在しないIDではundefinedを返す。 */
  update(id: string, change: { name?: string; scene?: BoardScene }): BoardSummary | undefined {
    const current = this.get(id);
    if (!current) return undefined;
    const updatedAt = this.now().toISOString();
    this.db.prepare('UPDATE whiteboards SET name = ?, scene = ?, updated_at = ? WHERE id = ?')
      .run(change.name ?? current.name, JSON.stringify(change.scene ?? current.scene), updatedAt, id);
    return { id, name: change.name ?? current.name, updatedAt };
  }

  remove(id: string): boolean {
    return Number(this.db.prepare('DELETE FROM whiteboards WHERE id = ?').run(id).changes) > 0;
  }

  /** 検証をやり直す明示コマンドからのみ、ボードを空に戻す。 */
  reset(): void {
    this.db.exec('DELETE FROM whiteboards');
  }

  close(): void { this.db.close(); }
}
