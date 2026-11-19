import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
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

test('1回に渡せるSQLは1文だけで、2文目以降は黙って捨てずに失敗させる', async (t) => {
  const db = memoryDatabase(t);
  // 文の後ろの空白・セミコロン・コメントは受け付ける。
  await db.run('CREATE TABLE notes (id TEXT PRIMARY KEY, body TEXT) STRICT; -- メモ\n');
  await db.run("INSERT INTO notes VALUES ('a', 'セミコロン;を含む値');");
  for (const run of [
    () => db.query('SELECT * FROM notes; SELECT 1'),
    () => db.run("INSERT INTO notes VALUES ('b', 'b'); DELETE FROM notes"),
    () => db.batch([{ sql: "INSERT INTO notes VALUES ('c', 'c'); DROP TABLE notes" }]),
  ]) {
    await assert.rejects(run(), /1文だけ/);
  }
  assert.deepEqual((await db.query('SELECT id, body FROM notes')).map((row) => ({ ...row })), [{ id: 'a', body: 'セミコロン;を含む値' }]);
  // 1要素に2文を書いたマイグレーションは、適用も記録もしない。
  const twoStatements: Migration = { id: 'links/001', up: ['CREATE TABLE links (id TEXT) STRICT; ALTER TABLE links ADD COLUMN url TEXT'] };
  await assert.rejects(migrate(db, [twoStatements]), /1文だけ/);
  assert.deepEqual(await tables(db), ['notes', 'schema_migrations']);
  assert.deepEqual(await db.query('SELECT id FROM schema_migrations'), []);
});

test('安全な範囲を超える64ビットの整数も読み、範囲内の整数は従来どおり数値で返す', async (t) => {
  const db = memoryDatabase(t);
  await db.run('CREATE TABLE counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL) STRICT');
  await db.run('INSERT INTO counters VALUES (?, ?), (?, ?)', ['large', 9007199254740993n, 'small', 42]);
  assert.deepEqual((await db.query('SELECT name, value FROM counters ORDER BY name')).map((row) => [row.name, row.value]),
    [['large', 9007199254740993n], ['small', 42]]);
  // 列名が __proto__ でも、行のプロトタイプは書き換わらない。
  const [row] = await db.query('SELECT 1 AS __proto__');
  assert.equal(Object.getPrototypeOf(row), null);
  assert.equal(row?.__proto__, 1);
});

test('別の接続が書き込み中なら、待たずに失敗させる（同期APIで待つとサーバー全体が止まるため）', async (t) => {
  const path = join(temporaryDirectory(t), 'app.sqlite');
  const db = openLocalDatabase(path);
  t.after(() => db.close());
  await db.run('CREATE TABLE notes (id TEXT PRIMARY KEY) STRICT');
  const holder = new DatabaseSync(path);
  t.after(() => holder.close());
  holder.exec('BEGIN IMMEDIATE');
  const started = performance.now();
  await assert.rejects(db.run("INSERT INTO notes VALUES ('a')"), /locked|busy/i);
  assert.ok(performance.now() - started < 1000);
  holder.exec('ROLLBACK');
  await db.run("INSERT INTO notes VALUES ('a')");
});

test('upが失敗しても、別のプロセスが先に適用していれば適用済みとして扱う', async (t) => {
  const path = join(temporaryDirectory(t), 'app.sqlite');
  const first = openLocalDatabase(path);
  const second = openLocalDatabase(path);
  t.after(async () => { await first.close(); await second.close(); });
  const failing: Migration = {
    id: NOTES.id,
    // 表の形を確かめている間に、2つ目の接続が同じマイグレーションを適用し、確かめた前提が崩れる。
    up: async () => {
      await migrate(second, [NOTES]);
      throw new Error('前提が崩れた');
    },
  };
  assert.deepEqual(await migrate(first, [failing]), []);
  assert.deepEqual(await tables(first), ['notes', 'schema_migrations']);
  // 先に適用されていなければ、upの失敗をそのまま返す。
  const broken: Migration = { id: 'tags/001', up: async () => { throw new Error('前提が崩れた'); } };
  await assert.rejects(migrate(first, [broken]), /前提が崩れた/);
});

test('トランザクションの開始・確定・取り消しは、文として受け付けない', async (t) => {
  const db = memoryDatabase(t);
  await db.run('CREATE TABLE notes (id TEXT PRIMARY KEY) STRICT');
  for (const sql of ['BEGIN', 'COMMIT', 'end transaction', 'ROLLBACK', 'SAVEPOINT s1', 'RELEASE s1', '-- 確定する\n  COMMIT', '/* c */ COMMIT;']) {
    await assert.rejects(db.run(sql), /batchに任せて/, sql);
    await assert.rejects(db.batch([{ sql: "INSERT INTO notes VALUES ('a')" }, { sql }]), /batchに任せて/, sql);
  }
  // 途中で確定されず、まとめて取り消されている。
  assert.deepEqual(await db.query('SELECT id FROM notes'), []);
  // マイグレーションの途中で確定させて、記録だけが残ることもない。
  const committing: Migration = { id: 'broken/001', up: ['COMMIT', 'CREATE TABLE broken ('] };
  await assert.rejects(migrate(db, [committing]), /batchに任せて/);
  assert.deepEqual(await db.query('SELECT id FROM schema_migrations'), []);
  assert.deepEqual(await tables(db), ['notes', 'schema_migrations']);
});
