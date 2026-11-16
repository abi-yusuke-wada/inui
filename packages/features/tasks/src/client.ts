import { ApiError, isRecord } from '@inui/feature-kit/web';
import { MAX_TITLE_LENGTH } from './types.ts';
import type { ExternalResult, ExternalTask, LocalTask } from './types.ts';

export type { ExternalResult, ExternalTask, LocalTask } from './types.ts';
export { MAX_TITLE_LENGTH } from './types.ts';

const isLocalTask = (value: unknown): value is LocalTask => isRecord(value)
  && typeof value.id === 'string' && value.id.length > 0
  && typeof value.title === 'string' && value.title.length >= 1 && value.title.length <= MAX_TITLE_LENGTH
  && typeof value.done === 'boolean' && typeof value.createdAt === 'string';

export function parseLocalTasks(value: unknown): LocalTask[] {
  if (!isRecord(value) || !Array.isArray(value.tasks) || !value.tasks.every(isLocalTask)) throw new ApiError('invalid');
  return value.tasks;
}

export function parseLocalTask(value: unknown): LocalTask {
  if (!isRecord(value) || !isLocalTask(value.task)) throw new ApiError('invalid');
  return value.task;
}

const SAFE_URL: Record<ExternalTask['source'], RegExp> = {
  github: /^https:\/\/github\.com\//,
  backlog: /^https:\/\/[a-z0-9-]+\.backlog\.(?:jp|com)\/view\//,
};

/** 連携先のチケットは、取得元に応じた https のリンクだけを受け付ける。 */
export function parseExternal(value: unknown, source: ExternalTask['source']): ExternalResult {
  if (!isRecord(value)) throw new ApiError('invalid');
  if (value.configured === false) return { configured: false };
  if (value.configured !== true || !Array.isArray(value.tasks)) throw new ApiError('invalid');
  const tasks = value.tasks;
  if (!tasks.every((task) => isRecord(task) && task.source === source && typeof task.id === 'string'
    && ['issue', 'pull_request', 'backlog_issue'].includes(task.kind as string)
    && typeof task.key === 'string' && typeof task.title === 'string' && typeof task.updatedAt === 'string'
    && typeof task.url === 'string' && SAFE_URL[source].test(task.url)
    && (task.status === undefined || typeof task.status === 'string')
    && (task.dueDate === undefined || typeof task.dueDate === 'string')
    && (task.reasons === undefined || (Array.isArray(task.reasons) && task.reasons.every((reason) =>
      ['assigned', 'authored', 'review_requested'].includes(reason as string)))))) {
    throw new ApiError('invalid');
  }
  return { configured: true, tasks: tasks as unknown as ExternalTask[] };
}
