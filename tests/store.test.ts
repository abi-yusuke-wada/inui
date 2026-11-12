import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { LocalStore } from '../src/store.ts';

test('実ファイルを再openして保存を確認し、seedを重複させない', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'inui-poc-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'app.sqlite');
  const first = new LocalStore(path);
  assert.equal(first.list().length, 2);
  assert.equal(first.list('pending').length, 1);
  assert.equal(first.list('approved').length, 1);
  assert.equal(first.list('returned').length, 0);
  const leave = first.addLeave({ date: '2026-11-03', period: 'full_day', reason: '私用' });
  const expense = first.addExpense({ date: '2026-11-01', amount: 1200, description: '交通費' });
  first.close();
  const second = new LocalStore(path);
  try {
    assert.equal(second.list().length, 4);
    assert.deepEqual(second.list().find((row) => row.id === leave.id), leave);
    assert.deepEqual(second.list().find((row) => row.id === expense.id), expense);
    assert.equal(leave.submittedOn, '2026-11-02');
    second.reset();
    assert.equal(second.list().length, 2);
  } finally { second.close(); }
  const third = new LocalStore(path);
  try { assert.equal(third.list().length, 2); } finally { third.close(); }
});
