import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MAX_TITLE_LENGTH } from './types.ts';
import type { LocalTask, TaskStatus } from './types.ts';

const STATUS_CHECK = "CHECK(status IN ('todo', 'doing', 'done'))";

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
          created_at TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'todo' ${STATUS_CHECK}
        ) STRICT;
      `);
      this.migrate();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  /**
   * 看板の列（status）がない以前の表を移行する。未完了はtodo、完了はdoneにする。
   * doneの列は、以前の版との互換のためstatusと同じ内容で保つ。
   */
  private migrate(): void {
    const columns = this.db.prepare('PRAGMA table_info(local_tasks)').all().map((row) => row.name);
    if (columns.includes('status')) return;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec(`ALTER TABLE local_tasks ADD COLUMN status TEXT NOT NULL DEFAULT 'todo' ${STATUS_CHECK}`);
      this.db.exec("UPDATE local_tasks SET status = 'done' WHERE done = 1");
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private static toTask(row: Record<string, unknown>): LocalTask {
    const status = row.status as TaskStatus;
    return { id: row.id as string, title: row.title as string, status, done: status === 'done', createdAt: row.created_at as string };
  }

  /** todo・doing・doneの順に、それぞれ作成順で返す。作成日時が同じものは追加した順（rowid）にする（idはランダムなため）。 */
  list(): LocalTask[] {
    return this.db.prepare(`SELECT id, title, status, created_at FROM local_tasks
      ORDER BY CASE status WHEN 'todo' THEN 0 WHEN 'doing' THEN 1 ELSE 2 END, created_at, rowid`)
      .all().map((row) => TaskStore.toTask(row));
  }

  add(title: string): LocalTask {
    const task: LocalTask = { id: randomUUID(), title, status: 'todo', done: false, createdAt: this.now().toISOString() };
    this.db.prepare("INSERT INTO local_tasks (id, title, done, created_at, status) VALUES (?, ?, 0, ?, 'todo')")
      .run(task.id, task.title, task.createdAt);
    return task;
  }

  /** 看板の列を移す。存在しないIDではundefinedを返す。 */
  setStatus(id: string, status: TaskStatus): LocalTask | undefined {
    this.db.prepare('UPDATE local_tasks SET status = ?, done = ? WHERE id = ?').run(status, status === 'done' ? 1 : 0, id);
    const row = this.db.prepare('SELECT id, title, status, created_at FROM local_tasks WHERE id = ?').get(id);
    return row ? TaskStore.toTask(row) : undefined;
  }

  /** Todo表示のチェック。完了にするとdone、外すとtodoへ戻す。 */
  setDone(id: string, done: boolean): LocalTask | undefined {
    return this.setStatus(id, done ? 'done' : 'todo');
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
