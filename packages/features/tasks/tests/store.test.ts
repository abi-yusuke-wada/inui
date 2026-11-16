import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
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
