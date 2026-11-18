import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { migrate, openLocalDatabase } from '../src/db.ts';
import type { Migration } from '../src/db.ts';

function memoryDatabase(t: TestContext) {
  const db = openLocalDatabase(':memory:');
  t.after(() => db.close());
  return db;
}

function temporaryDirectory(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'inui-db-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

async function tables(db: ReturnType<typeof openLocalDatabase>): Promise<string[]> {
  return (await db.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")).map((row) => row.name as string);
}

const NOTES: Migration = { id: 'notes/001', up: ['CREATE TABLE notes (id TEXT PRIMARY KEY, body TEXT NOT NULL) STRICT'] };

test('引数を渡してSQLを実行し、行と変更した行数を返す', async (t) => {
  const db = memoryDatabase(t);
  await db.run('CREATE TABLE notes (id TEXT PRIMARY KEY, body TEXT NOT NULL, size INTEGER NOT NULL) STRICT');
  assert.deepEqual(await db.run('INSERT INTO notes VALUES (?, ?, ?), (?, ?, ?)', ['a', 'メモ', 1, 'b', 'いいえ', 2]), { changes: 2 });
  assert.deepEqual(await db.run('UPDATE notes SET size = size + 1'), { changes: 2 });
  assert.deepEqual((await db.query('SELECT id, size FROM notes WHERE body = ?', ['メモ'])).map((row) => ({ ...row })), [{ id: 'a', size: 2 }]);
  assert.deepEqual((await db.query('DELETE FROM notes WHERE id = ? RETURNING id', ['b'])).map((row) => row.id), ['b']);
  await assert.rejects(db.query('SELECT * FROM missing'));
});

test('batchは途中の文が失敗したらすべて取り消し、その後も使い続けられる', async (t) => {
  const db = memoryDatabase(t);
  await db.run('CREATE TABLE notes (id TEXT PRIMARY KEY, body TEXT NOT NULL) STRICT');
  await assert.rejects(db.batch([
    { sql: 'INSERT INTO notes VALUES (?, ?)', args: ['a', '1件目'] },
    { sql: 'INSERT INTO notes VALUES (?, ?)', args: ['a', '同じID'] },
  ]));
  assert.deepEqual(await db.query('SELECT * FROM notes'), []);
  await db.batch([
    { sql: 'INSERT INTO notes VALUES (?, ?)', args: ['a', '1件目'] },
    { sql: "UPDATE notes SET body = body || '（更新）'" },
  ]);
  assert.deepEqual((await db.query('SELECT body FROM notes')).map((row) => row.body), ['1件目（更新）']);
});

test('マイグレーションを渡した順に1回だけ適用し、適用の記録を残す', async (t) => {
  const db = memoryDatabase(t);
  const seen: string[][] = [];
  const migrations: Migration[] = [NOTES, {
    id: 'notes/002',
    // 関数のupは、適用前の表の形を見てSQLを決められる。
    up: async (current) => {
      seen.push(await tables(current));
      return ['ALTER TABLE notes ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0'];
    },
  }];
  const now = () => new Date('2026-11-18T00:00:00Z');
  assert.deepEqual(await migrate(db, migrations, { now }), ['notes/001', 'notes/002']);
  assert.deepEqual(seen, [['notes', 'schema_migrations']]);
  assert.deepEqual((await db.query('SELECT id, applied_at FROM schema_migrations ORDER BY id')).map((row) => ({ ...row })), [
    { id: 'notes/001', applied_at: '2026-11-18T00:00:00.000Z' }, { id: 'notes/002', applied_at: '2026-11-18T00:00:00.000Z' },
  ]);
  assert.deepEqual(await migrate(db, migrations, { now }), []);
  assert.equal(seen.length, 1);
  assert.deepEqual((await db.query('PRAGMA table_info(notes)')).map((row) => row.name), ['id', 'body', 'pinned']);
});

test('失敗したマイグレーションは表の変更も記録も残さず、後続を適用しない', async (t) => {
  const db = memoryDatabase(t);
  const broken: Migration = { id: 'tags/001', up: ['CREATE TABLE tags (id TEXT PRIMARY KEY) STRICT', 'CREATE TABLE broken ('] };
  const later: Migration = { id: 'links/001', up: ['CREATE TABLE links (id TEXT PRIMARY KEY) STRICT'] };
  await assert.rejects(migrate(db, [NOTES, broken, later]));
  assert.deepEqual(await tables(db), ['notes', 'schema_migrations']);
  assert.deepEqual((await db.query('SELECT id FROM schema_migrations')).map((row) => row.id), ['notes/001']);
  // 直したマイグレーションは、次の起動で残りの分から適用される。
  const fixed: Migration = { id: 'tags/001', up: ['CREATE TABLE tags (id TEXT PRIMARY KEY) STRICT'] };
  assert.deepEqual(await migrate(db, [NOTES, fixed, later]), ['tags/001', 'links/001']);
  assert.deepEqual(await tables(db), ['links', 'notes', 'schema_migrations', 'tags']);
});

test('idが空・重複したマイグレーションの一覧は、何も適用せずに拒否する', async (t) => {
  const db = memoryDatabase(t);
  await assert.rejects(migrate(db, [NOTES, { id: 'notes/001', up: ['CREATE TABLE other (id TEXT) STRICT'] }]));
  await assert.rejects(migrate(db, [{ id: '', up: ['CREATE TABLE other (id TEXT) STRICT'] }]));
  assert.deepEqual(await tables(db), []);
});

test('別のプロセスが先に適用したマイグレーションは、重ねて適用せずに適用済みとして扱う', async (t) => {
  const path = join(temporaryDirectory(t), 'app.sqlite');
  const first = openLocalDatabase(path);
  const second = openLocalDatabase(path);
  t.after(async () => { await first.close(); await second.close(); });
  const later: Migration = { id: 'links/001', up: ['CREATE TABLE links (id TEXT PRIMARY KEY) STRICT'] };
  const racing: Migration = {
    id: NOTES.id,
    // 1つ目の接続が適用するSQLを決めた直後に、2つ目の接続が同じマイグレーションを適用する。
    up: async () => {
      assert.deepEqual(await migrate(second, [NOTES]), ['notes/001']);
      return NOTES.up as string[];
    },
  };
  assert.deepEqual(await migrate(first, [racing, later]), ['links/001']);
  assert.deepEqual(await tables(first), ['links', 'notes', 'schema_migrations']);
  assert.deepEqual((await first.query('SELECT id FROM schema_migrations ORDER BY id')).map((row) => row.id), ['links/001', 'notes/001']);
});

test('ローカルのDBファイルを置くディレクトリは、所有者だけが開けるように作る', async (t) => {
  const path = join(temporaryDirectory(t), 'data', 'app.sqlite');
  const db = openLocalDatabase(path);
  await db.close();
  assert.equal(statSync(join(path, '..')).mode & 0o777, 0o700);
});
