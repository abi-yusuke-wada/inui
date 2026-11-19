import { migrate, openLocalDatabase } from '@inui/feature-kit/db';
import type { Database, Migration } from '@inui/feature-kit/db';
import { taskMigrations } from '@inui/feature-tasks/store';
import { boardMigrations } from '@inui/feature-whiteboard/store';

/**
 * 業務機能の表のマイグレーション。機能の中の順序は保ち、機能の間で表を参照し合わない。
 * 機能を外すときは、ここから外す（作られた表とデータは残る）。
 */
export const MIGRATIONS: readonly Migration[] = [...taskMigrations, ...boardMigrations];

/** ローカルのSQLiteを開き、未適用のマイグレーションを適用する。適用したidもあわせて返す。 */
export async function openAppDatabase(path: string): Promise<{ db: Database; applied: string[] }> {
  const db = openLocalDatabase(path);
  try {
    return { db, applied: await migrate(db, MIGRATIONS) };
  } catch (error) {
    await db.close();
    throw error;
  }
}
