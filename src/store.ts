import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import type { Application, ApplicationStatus, ExpenseInput, LeaveInput } from './types.ts';

export const DEFAULT_DB_PATH = fileURLToPath(new URL('../.local-poc/app.sqlite', import.meta.url));
const SUBMITTED_ON = '2026-11-02';

/** 単一の検証利用者の申請を実SQLiteファイルへ保存する。 */
export class LocalStore {
  private readonly db: DatabaseSync;

  constructor(path = DEFAULT_DB_PATH) {
    // 申請内容を含むため、新しく作るディレクトリは所有者だけが開けるようにする。
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS applications (
        id TEXT PRIMARY KEY, type TEXT NOT NULL CHECK(type IN ('leave','expense')),
        submitted_on TEXT NOT NULL, date TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','approved','returned')),
        period TEXT CHECK(period IN ('full_day','am','pm')), reason TEXT,
        amount INTEGER CHECK(amount > 0), description TEXT
      ) STRICT;
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
    `);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (!this.db.prepare("SELECT value FROM metadata WHERE key = 'seeded'").get()) {
        this.seed();
        this.db.prepare("INSERT INTO metadata (key, value) VALUES ('seeded', '1')").run();
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      this.db.close();
      throw error;
    }
  }

  /** 初回データは固定IDで作り、再起動時に重複させない。 */
  private seed(): void {
    this.insert({ id: 'seed-leave', type: 'leave', submittedOn: '2026-10-27', date: '2026-10-30', status: 'approved', period: 'full_day' });
    this.insert({ id: 'seed-expense', type: 'expense', submittedOn: '2026-10-29', date: '2026-10-28', status: 'pending', amount: 880, description: '交通費' });
  }

  private insert(application: Application): void {
    this.db.prepare(`INSERT INTO applications
      (id, type, submitted_on, date, status, period, reason, amount, description)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(application.id, application.type, application.submittedOn, application.date, application.status,
        application.period ?? null, application.reason ?? null, application.amount ?? null, application.description ?? null);
  }

  /** 保存済み申請を状態で絞り、固定順で返す。 */
  list(status?: ApplicationStatus): Application[] {
    const query = `SELECT id, type, submitted_on, date, status, period, reason, amount, description
      FROM applications ${status ? 'WHERE status = ?' : ''} ORDER BY submitted_on, id`;
    const rows = status ? this.db.prepare(query).all(status) : this.db.prepare(query).all();
    return rows.map((row) => ({
      id: row.id as string, type: row.type as Application['type'], submittedOn: row.submitted_on as string,
      date: row.date as string, status: row.status as ApplicationStatus,
      ...(row.period !== null ? { period: row.period as Application['period'] & string } : {}),
      ...(row.reason !== null ? { reason: row.reason as string } : {}),
      ...(row.amount !== null ? { amount: row.amount as number } : {}),
      ...(row.description !== null ? { description: row.description as string } : {}),
    }));
  }

  /** 確定された休暇申請だけを追加する。 */
  addLeave(input: LeaveInput): Application {
    const application: Application = { ...input, id: randomUUID(), type: 'leave', submittedOn: SUBMITTED_ON, status: 'pending' };
    this.insert(application);
    return application;
  }

  /** 確定された経費申請だけを追加する。 */
  addExpense(input: ExpenseInput): Application {
    const application: Application = { ...input, id: randomUUID(), type: 'expense', submittedOn: SUBMITTED_ON, status: 'pending' };
    this.insert(application);
    return application;
  }

  /** 検証をやり直す明示コマンドからのみ初期データへ戻す。 */
  reset(): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec('DELETE FROM applications');
      this.seed();
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  close(): void { this.db.close(); }
}
