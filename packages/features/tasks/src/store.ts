import { randomUUID } from 'node:crypto';
import type { Database, Migration, Row } from '@inui/feature-kit/db';
import { MAX_TITLE_LENGTH } from './types.ts';
import type { LocalTask, TaskStatus } from './types.ts';

const STATUS_CHECK = "CHECK(status IN ('todo', 'doing', 'done'))";
const COLUMNS = 'id, title, status, created_at';

/**
 * 自分のタスクの表。doneの列は、看板の列（status）を加える前の版との互換のため、statusと同じ内容で保つ。
 * マイグレーションの仕組みより前に作られた表は、そのまま引き継ぐ。看板の列がない表には列を加え、
 * 未完了をtodo、完了をdoneにする。
 */
export const taskMigrations: readonly Migration[] = [{
  id: 'tasks/001-local-tasks',
  up: async (db) => {
    const columns = (await db.query('PRAGMA table_info(local_tasks)')).map((row) => row.name);
    if (columns.length === 0) {
      return [`CREATE TABLE local_tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND ${MAX_TITLE_LENGTH}),
        done INTEGER NOT NULL CHECK(done IN (0, 1)),
        created_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'todo' ${STATUS_CHECK}
      ) STRICT`];
    }
    if (columns.includes('status')) return [];
    return [
      `ALTER TABLE local_tasks ADD COLUMN status TEXT NOT NULL DEFAULT 'todo' ${STATUS_CHECK}`,
      "UPDATE local_tasks SET status = 'done' WHERE done = 1",
    ];
  },
}];

function toTask(row: Row): LocalTask {
  const status = row.status as TaskStatus;
  return { id: row.id as string, title: row.title as string, status, done: status === 'done', createdAt: row.created_at as string };
}

/** 単一の利用者が自由に作るタスクを保存する。表はtaskMigrationsで作っておく。 */
export class TaskStore {
  private readonly db: Database;
  private readonly now: () => Date;

  constructor(db: Database, { now = () => new Date() }: { now?: () => Date } = {}) {
    this.db = db;
    this.now = now;
  }

  /** todo・doing・doneの順に、それぞれ作成順で返す。作成日時が同じものは追加した順（rowid）にする（idはランダムなため）。 */
  async list(): Promise<LocalTask[]> {
    const rows = await this.db.query(`SELECT ${COLUMNS} FROM local_tasks
      ORDER BY CASE status WHEN 'todo' THEN 0 WHEN 'doing' THEN 1 ELSE 2 END, created_at, rowid`);
    return rows.map(toTask);
  }

  async add(title: string): Promise<LocalTask> {
    const task: LocalTask = { id: randomUUID(), title, status: 'todo', done: false, createdAt: this.now().toISOString() };
    await this.db.run("INSERT INTO local_tasks (id, title, done, created_at, status) VALUES (?, ?, 0, ?, 'todo')",
      [task.id, task.title, task.createdAt]);
    return task;
  }

  /** 看板の列を移す。存在しないIDではundefinedを返す。 */
  async setStatus(id: string, status: TaskStatus): Promise<LocalTask | undefined> {
    const [row] = await this.db.query(`UPDATE local_tasks SET status = ?, done = ? WHERE id = ? RETURNING ${COLUMNS}`,
      [status, status === 'done' ? 1 : 0, id]);
    return row ? toTask(row) : undefined;
  }

  /** Todo表示のチェック。完了にするとdone、外すとtodoへ戻す。 */
  setDone(id: string, done: boolean): Promise<LocalTask | undefined> {
    return this.setStatus(id, done ? 'done' : 'todo');
  }

  async remove(id: string): Promise<boolean> {
    return (await this.db.run('DELETE FROM local_tasks WHERE id = ?', [id])).changes > 0;
  }

  /** 検証をやり直す明示コマンドからのみ、タスクを空に戻す。 */
  async reset(): Promise<void> {
    await this.db.run('DELETE FROM local_tasks');
  }
}
