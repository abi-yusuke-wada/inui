import { LocalStore } from './store.ts';

try {
  const store = new LocalStore();
  try { store.reset(); } finally { store.close(); }
  console.log('検証用申請データを初期状態へ戻しました。');
} catch {
  console.error('検証用申請データを初期化できませんでした。');
  process.exitCode = 1;
}
