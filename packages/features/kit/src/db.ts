import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SQLOutputValue, StatementSync } from 'node:sqlite';

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

// トランザクションの開始・確定・取り消しの文。
const TRANSACTION_CONTROL = /^(?:BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\b/i;

/**
 * 空白とコメント（「--」から行末まで、「/*」から「*\/」まで）を読み飛ばした位置を返す。
 * SQLiteと同じく、閉じていないコメントは末尾までとみなす。正規表現の後戻りで時間が延びないよう、
 * 1文字ずつ進めて入力の長さに比例する時間で終える。
 */
function skipSpaceAndComments(sql: string, from = 0): number {
  let index = from;
  while (index < sql.length) {
    if (/\s/.test(sql.charAt(index))) {
      index++;
    } else if (sql.startsWith('--', index)) {
      const end = sql.indexOf('\n', index);
      index = end < 0 ? sql.length : end + 1;
    } else if (sql.startsWith('/*', index)) {
      const end = sql.indexOf('*/', index + 2);
      index = end < 0 ? sql.length : end + 2;
    } else {
      break;
    }
  }
  return index;
}

/**
 * 1つの文だけを準備する。node:sqliteは最初の文だけを準備し、2つ目以降を黙って捨てるため、
 * 残りがあれば失敗させる（Tursoへの要求も1要素1文になる）。トランザクションの区切りはbatchだけが行い、
 * 文の中で確定・取り消しをさせない（途中で確定されると、まとめて確定する約束が守れないため）。
 */
function prepareOne(db: DatabaseSync, sql: string): StatementSync {
  if (TRANSACTION_CONTROL.test(sql.slice(skipSpaceAndComments(sql)))) {
    throw new Error('トランザクションの開始・確定・取り消しはbatchに任せてください。');
  }
  const statement = db.prepare(sql);
  // 準備した1文の後ろに残ってよいのは、空白とコメントだけ。
  const start = sql.indexOf(statement.sourceSQL);
  if (start < 0 || skipSpaceAndComments(sql, start + statement.sourceSQL.length) < sql.length) {
    throw new Error('SQLは1回に1文だけ渡してください。');
  }
  return statement;
}

/** 64ビットの整数も読めるようにし、安全な範囲のものは従来どおりnumberにする。 */
function toRow(row: Record<string, SQLOutputValue>): Row {
  // 列名が __proto__ でも、プロトタイプを書き換えないようにする。
  const result: Row = Object.create(null);
  for (const [key, value] of Object.entries(row)) {
    result[key] = typeof value === 'bigint' && value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value) : value;
  }
  return result;
}

/**
 * ローカルのSQLiteファイル（テストでは ':memory:'）を開く。
 * node:sqliteは同期APIで、ロックを待つ間はサーバー全体が止まるため、別の接続が書き込み中なら待たずに失敗させる。
 */
export function openLocalDatabase(path: string): Database {
  // 業務データを含むため、新しく作るディレクトリは所有者だけが開けるようにする。
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  return {
    async query(sql, args = []) {
      const statement = prepareOne(db, sql);
      statement.setReadBigInts(true);
      return statement.all(...args).map(toRow);
    },
    async run(sql, args = []) {
      return { changes: Number(prepareOne(db, sql).run(...args).changes) };
    },
    async batch(statements) {
      // 文の間で待たない（awaitしない）ため、同じプロセスの別の操作がトランザクションへ割り込まない。
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const { sql, args = [] } of statements) prepareOne(db, sql).run(...args);
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
 * upは適用するSQL（1要素に1文）で、今の表の形を見て決める必要がある場合（この仕組みより前に作られた表の
 * 引き継ぎ等）は関数にする。
 */
export interface Migration {
  readonly id: string;
  readonly up: readonly string[] | ((db: Database) => Promise<readonly string[]>);
}

/**
 * 未適用のマイグレーションを渡した順に、1件ずつ1つのトランザクションで適用し、適用したidを返す。
 * 適用の記録を各トランザクションの先頭で追加するため、別のプロセスが同じマイグレーションを先に
 * 適用していた場合は、記録の重複で全体が取り消され、適用済みとして扱う。upが失敗した場合も、
 * 別のプロセスが先に適用していないかを確かめてから失敗にする。
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
    try {
      const statements = typeof migration.up === 'function' ? await migration.up(db) : migration.up;
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
