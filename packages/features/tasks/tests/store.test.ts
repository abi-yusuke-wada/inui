import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { TaskStore } from '../src/store.ts';

test('実ファイルを再openしても追加・完了を保持し、resetで空に戻す', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'inui-tasks-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'app.sqlite');
  let tick = 0;
  const now = () => new Date(Date.UTC(2026, 10, 16, 0, 0, tick++));
  const first = new TaskStore(path, { now });
  assert.deepEqual(first.list(), []);
  const write = first.add('ADRを書く');
  const review = first.add('PRを確認する');
  assert.equal(first.setDone(write.id, true)?.done, true);
  assert.equal(first.setDone('00000000-0000-4000-8000-000000000000', true), undefined);
  first.close();
  const second = new TaskStore(path, { now });
  try {
    // 未完了を先に、作成順で並べる。
    assert.deepEqual(second.list().map((task) => [task.title, task.done]), [['PRを確認する', false], ['ADRを書く', true]]);
    assert.equal(second.list()[0]?.createdAt, review.createdAt);
    assert.equal(second.remove(review.id), true);
    assert.equal(second.remove(review.id), false);
    second.reset();
    assert.deepEqual(second.list(), []);
  } finally { second.close(); }
});

test('件名の長さはDBの制約でも守る', (t) => {
  const store = new TaskStore(':memory:');
  t.after(() => store.close());
  assert.throws(() => store.add(''));
  assert.throws(() => store.add('a'.repeat(201)));
  assert.equal(store.add('a'.repeat(200)).title.length, 200);
});

test('看板の列を移し、Todoのチェックは完了と未着手の切り替えにする', (t) => {
  const store = new TaskStore(':memory:');
  t.after(() => store.close());
  const task = store.add('レビューする');
  assert.equal(task.status, 'todo');
  assert.deepEqual([store.setStatus(task.id, 'doing')?.status, store.list()[0]?.done], ['doing', false]);
  assert.deepEqual([store.setDone(task.id, true)?.status, store.list()[0]?.done], ['done', true]);
  assert.equal(store.setDone(task.id, false)?.status, 'todo');
  assert.equal(store.setStatus('00000000-0000-4000-8000-000000000000', 'doing'), undefined);
  assert.throws(() => store.setStatus(task.id, 'closed' as 'done'));
});

test('看板の列がない以前の表は、未完了をTo do・完了をDoneへ移して使い続ける', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'inui-tasks-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'app.sqlite');
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE local_tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL, done INTEGER NOT NULL CHECK(done IN (0, 1)), created_at TEXT NOT NULL) STRICT;
    INSERT INTO local_tasks VALUES ('a', '書く', 0, '2026-11-16T00:00:00.000Z'), ('b', '読む', 1, '2026-11-16T00:00:01.000Z');`);
  old.close();
  for (let open = 0; open < 2; open++) {
    const store = new TaskStore(path);
    try {
      assert.deepEqual(store.list().map((task) => [task.id, task.status, task.done]), [['a', 'todo', false], ['b', 'done', true]]);
    } finally { store.close(); }
  }
});
