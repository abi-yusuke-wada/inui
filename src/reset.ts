import { TaskStore } from '@inui/feature-tasks/store';
import { DEFAULT_DB_PATH } from './local-config.ts';
import { createLogger, logLevel } from './logger.ts';

const logger = createLogger({ level: logLevel(process.env.LOG_LEVEL) });

try {
  const store = new TaskStore(DEFAULT_DB_PATH);
  try { store.reset(); } finally { store.close(); }
  logger.info('data_reset');
} catch {
  logger.error('data_reset_failed', { error_code: 'reset_failed' });
  process.exitCode = 1;
}
