import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MAX_TITLE_LENGTH } from './types.ts';
import type { LocalTask } from './types.ts';

/** 単一の利用者が自由に作るタスクを、実SQLiteファイルへ保存する。 */
export class TaskStore {
  private readonly db: DatabaseSync;
  private readonly now: () => Date;

  constructor(path: string, { now = () => new Date() }: { now?: () => Date } = {}) {
    // タスクの内容を含むため、新しく作るディレクトリは所有者だけが開けるようにする。
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.now = now;
    this.db = new DatabaseSync(path);
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS local_tasks (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND ${MAX_TITLE_LENGTH}),
          done INTEGER NOT NULL CHECK(done IN (0, 1)),
          created_at TEXT NOT NULL
        ) STRICT;
      `);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  private static toTask(row: Record<string, unknown>): LocalTask {
    return { id: row.id as string, title: row.title as string, done: row.done === 1, createdAt: row.created_at as string };
  }

  /** 未完了を先に、それぞれ作成順で返す。 */
  list(): LocalTask[] {
    return this.db.prepare('SELECT id, title, done, created_at FROM local_tasks ORDER BY done, created_at, id')
      .all().map((row) => TaskStore.toTask(row));
  }

  add(title: string): LocalTask {
    const task: LocalTask = { id: randomUUID(), title, done: false, createdAt: this.now().toISOString() };
    this.db.prepare('INSERT INTO local_tasks (id, title, done, created_at) VALUES (?, ?, 0, ?)')
      .run(task.id, task.title, task.createdAt);
    return task;
  }

  /** 完了・未完了を切り替える。存在しないIDではundefinedを返す。 */
  setDone(id: string, done: boolean): LocalTask | undefined {
    this.db.prepare('UPDATE local_tasks SET done = ? WHERE id = ?').run(done ? 1 : 0, id);
    const row = this.db.prepare('SELECT id, title, done, created_at FROM local_tasks WHERE id = ?').get(id);
    return row ? TaskStore.toTask(row) : undefined;
  }

  remove(id: string): boolean {
    return Number(this.db.prepare('DELETE FROM local_tasks WHERE id = ?').run(id).changes) > 0;
  }

  /** 検証をやり直す明示コマンドからのみ、タスクを空に戻す。 */
  reset(): void {
    this.db.exec('DELETE FROM local_tasks');
  }

  close(): void { this.db.close(); }
}
