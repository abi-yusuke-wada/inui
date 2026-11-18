import { TaskStore } from '@inui/feature-tasks/store';
import { BoardStore } from '@inui/feature-whiteboard/store';
import { openAppDatabase } from './db.ts';
import { DEFAULT_DB_PATH } from './local-config.ts';
import { createLogger, logLevel } from './logger.ts';

const logger = createLogger({ level: logLevel(process.env.LOG_LEVEL) });

try {
  // 未適用のマイグレーションがあれば適用してから空にする（初めてなら表もここで作る）。
  const { db } = await openAppDatabase(DEFAULT_DB_PATH);
  try {
    await new TaskStore(db).reset();
    await new BoardStore(db).reset();
  } finally { await db.close(); }
  logger.info('data_reset');
} catch {
  logger.error('data_reset_failed', { error_code: 'reset_failed' });
  process.exitCode = 1;
}
