import { LocalStore } from './store.ts';
import { createLogger, logLevel } from './logger.ts';

const logger = createLogger({ level: logLevel(process.env.LOG_LEVEL) });

try {
  const store = new LocalStore();
  try { store.reset(); } finally { store.close(); }
  logger.info('data_reset');
} catch {
  logger.error('data_reset_failed', { error_code: 'reset_failed' });
  process.exitCode = 1;
}
