import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** SQLへ渡す値と、受け取る値。ローカルのSQLiteとTurso（libSQL）の両方で扱える型に限る。 */
export type SqlValue = null | number | bigint | string | Uint8Array;
export type Row = Record<string, SqlValue>;
export interface Statement {
  sql: string;
  args?: readonly SqlValue[];
}

/**
 * 業務機能が使うDBの操作。ローカルではnode:sqlite、部署展開ではTurso（HTTPS接続）で実装できるよう、
 * すべて非同期にする。複数の文をまとめて確定する方法はbatchだけとし、途中で応答を待ちながら
 * 進めるトランザクションは持たない（HTTP接続では、まとめて送れば1往復で済むため）。
 */
export interface Database {
  /** 行を返す文（SELECT・RETURNING付きの更新等）を実行する。 */
  query(sql: string, args?: readonly SqlValue[]): Promise<Row[]>;
  /** 行を返さない文を実行し、変更した行数を返す。 */
  run(sql: string, args?: readonly SqlValue[]): Promise<{ changes: number }>;
  /** 複数の文を1つのトランザクションで実行する。途中で失敗したら、すべて取り消す。 */
  batch(statements: readonly Statement[]): Promise<void>;
  close(): Promise<void>;
}

/** 別の接続が書き込み中のとき、失敗にせず待つ時間。 */
const BUSY_TIMEOUT_MS = 5000;

/** ローカルのSQLiteファイル（テストでは ':memory:'）を開く。 */
export function openLocalDatabase(path: string): Database {
  // 業務データを含むため、新しく作るディレクトリは所有者だけが開けるようにする。
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path, { timeout: BUSY_TIMEOUT_MS });
  return {
    async query(sql, args = []) {
      return db.prepare(sql).all(...args) as Row[];
    },
    async run(sql, args = []) {
      return { changes: Number(db.prepare(sql).run(...args).changes) };
    },
    async batch(statements) {
      // 文の間で待たない（awaitしない）ため、同じプロセスの別の操作がトランザクションへ割り込まない。
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const { sql, args = [] } of statements) db.prepare(sql).run(...args);
        db.exec('COMMIT');
      } catch (error) {
        // SQLiteが自動で取り消した場合はROLLBACKが失敗するため、元の例外を残す。
        if (db.isTransaction) db.exec('ROLLBACK');
        throw error;
      }
    },
    async close() {
      db.close();
    },
  };
}

/**
 * テーブル定義の変更。idは適用済みの記録に使うため、適用した後は変更しない。
 * upは適用するSQLで、今の表の形を見て決める必要がある場合（この仕組みより前に作られた表の
 * 引き継ぎ等）は関数にする。
 */
export interface Migration {
  readonly id: string;
  readonly up: readonly string[] | ((db: Database) => Promise<readonly string[]>);
}

/**
 * 未適用のマイグレーションを渡した順に、1件ずつ1つのトランザクションで適用し、適用したidを返す。
 * 適用の記録を各トランザクションの先頭で追加するため、別のプロセスが同じマイグレーションを先に
 * 適用していた場合は、記録の重複で全体が取り消され、適用済みとして扱う。
 */
export async function migrate(db: Database, migrations: readonly Migration[],
  { now = () => new Date() }: { now?: () => Date } = {}): Promise<string[]> {
  const ids = migrations.map((migration) => migration.id);
  if (ids.some((id) => id.length === 0) || new Set(ids).size !== ids.length) {
    throw new Error('マイグレーションのidが空か、重複しています。');
  }
  await db.run(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  ) STRICT`);
  const applied = new Set((await db.query('SELECT id FROM schema_migrations')).map((row) => row.id));
  const done: string[] = [];
  for (const migration of migrations) {
    if (applied.has(migration.id)) continue;
    const statements = typeof migration.up === 'function' ? await migration.up(db) : migration.up;
    try {
      await db.batch([
        { sql: 'INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)', args: [migration.id, now().toISOString()] },
        ...statements.map((sql) => ({ sql })),
      ]);
    } catch (error) {
      const recorded = await db.query('SELECT 1 FROM schema_migrations WHERE id = ?', [migration.id]);
      if (recorded.length === 0) throw error;
      continue;
    }
    done.push(migration.id);
  }
  return done;
}
