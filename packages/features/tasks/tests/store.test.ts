import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { migrate, openLocalDatabase } from '@inui/feature-kit/db';
import { TaskStore, taskMigrations } from '../src/store.ts';

/** メモリ上のDBに表を作り、タスクの保存先を返す。 */
async function memoryStore(t: TestContext, options: { now?: () => Date } = {}) {
  const db = openLocalDatabase(':memory:');
  t.after(() => db.close());
  await migrate(db, taskMigrations);
  return new TaskStore(db, options);
}

function temporaryFile(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'inui-tasks-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, 'app.sqlite');
}

test('実ファイルを開き直しても追加・完了を保持し、resetで空に戻す', async (t) => {
  const path = temporaryFile(t);
  let tick = 0;
  const now = () => new Date(Date.UTC(2026, 10, 16, 0, 0, tick++));
  const first = openLocalDatabase(path);
  assert.deepEqual(await migrate(first, taskMigrations), ['tasks/001-local-tasks']);
  const store = new TaskStore(first, { now });
  assert.deepEqual(await store.list(), []);
  const write = await store.add('ADRを書く');
  const review = await store.add('PRを確認する');
  assert.equal((await store.setDone(write.id, true))?.done, true);
  assert.equal(await store.setDone('00000000-0000-4000-8000-000000000000', true), undefined);
  await first.close();
  const second = openLocalDatabase(path);
  try {
    assert.deepEqual(await migrate(second, taskMigrations), []);
    const reopened = new TaskStore(second, { now });
    // 未完了を先に、作成順で並べる。
    assert.deepEqual((await reopened.list()).map((task) => [task.title, task.done]), [['PRを確認する', false], ['ADRを書く', true]]);
    assert.equal((await reopened.list())[0]?.createdAt, review.createdAt);
    assert.equal(await reopened.remove(review.id), true);
    assert.equal(await reopened.remove(review.id), false);
    await reopened.reset();
    assert.deepEqual(await reopened.list(), []);
  } finally { await second.close(); }
});

test('件名の長さはDBの制約でも守る', async (t) => {
  const store = await memoryStore(t);
  await assert.rejects(store.add(''));
  await assert.rejects(store.add('a'.repeat(201)));
  assert.equal((await store.add('a'.repeat(200))).title.length, 200);
});

test('看板の列を移し、Todoのチェックは完了と未着手の切り替えにする', async (t) => {
  const store = await memoryStore(t);
  const task = await store.add('レビューする');
  assert.equal(task.status, 'todo');
  assert.deepEqual([(await store.setStatus(task.id, 'doing'))?.status, (await store.list())[0]?.done], ['doing', false]);
  assert.deepEqual([(await store.setDone(task.id, true))?.status, (await store.list())[0]?.done], ['done', true]);
  assert.equal((await store.setDone(task.id, false))?.status, 'todo');
  assert.equal(await store.setStatus('00000000-0000-4000-8000-000000000000', 'doing'), undefined);
  await assert.rejects(store.setStatus(task.id, 'closed' as 'done'));
});

test('看板の列がない以前の表は、未完了をTo do・完了をDoneへ移して使い続ける', async (t) => {
  const path = temporaryFile(t);
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE local_tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL, done INTEGER NOT NULL CHECK(done IN (0, 1)), created_at TEXT NOT NULL) STRICT;
    INSERT INTO local_tasks VALUES ('a', '書く', 0, '2026-11-16T00:00:00.000Z'), ('b', '読む', 1, '2026-11-16T00:00:01.000Z');`);
  old.close();
  for (const expected of [['tasks/001-local-tasks'], []]) {
    const db = openLocalDatabase(path);
    try {
      assert.deepEqual(await migrate(db, taskMigrations), expected);
      assert.deepEqual((await new TaskStore(db).list()).map((task) => [task.id, task.status, task.done]),
        [['a', 'todo', false], ['b', 'done', true]]);
    } finally { await db.close(); }
  }
});

test('作成日時が同じタスクも、追加した順に返す', async (t) => {
  const store = await memoryStore(t, { now: () => new Date(Date.UTC(2026, 10, 18)) });
  const titles = Array.from({ length: 12 }, (_, index) => `タスク${index + 1}`);
  for (const title of titles) await store.add(title);
  assert.deepEqual((await store.list()).map((task) => task.title), titles);
});

test('マイグレーションの仕組みより前に作られた看板の列がある表は、変更せずに引き継ぐ', async (t) => {
  const path = temporaryFile(t);
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE local_tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL, done INTEGER NOT NULL CHECK(done IN (0, 1)),
      created_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'todo' CHECK(status IN ('todo', 'doing', 'done'))) STRICT;
    INSERT INTO local_tasks VALUES ('a', '書く', 0, '2026-11-17T00:00:00.000Z', 'doing');`);
  old.close();
  const db = openLocalDatabase(path);
  try {
    assert.deepEqual(await migrate(db, taskMigrations), ['tasks/001-local-tasks']);
    assert.deepEqual((await new TaskStore(db).list()).map((task) => [task.id, task.status]), [['a', 'doing']]);
  } finally { await db.close(); }
});
