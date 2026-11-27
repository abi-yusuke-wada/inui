import { ApiError, isRecord } from '@inui/feature-kit/web';
import { GITHUB_REASONS, MAX_TITLE_LENGTH, TASK_STATUSES } from './types.ts';
import type { ExternalResult, ExternalTask, LocalTask } from './types.ts';

export type { ExternalResult, ExternalTask, GitHubReason, LocalTask, TaskStatus } from './types.ts';
export { GITHUB_REASONS, MAX_TITLE_LENGTH, TASK_STATUSES } from './types.ts';

const isLocalTask = (value: unknown): value is LocalTask => isRecord(value)
  && typeof value.id === 'string' && value.id.length > 0
  && typeof value.title === 'string' && value.title.length >= 1 && value.title.length <= MAX_TITLE_LENGTH
  && (TASK_STATUSES as readonly unknown[]).includes(value.status)
  && value.done === (value.status === 'done') && typeof value.createdAt === 'string';

export function parseLocalTasks(value: unknown): LocalTask[] {
  if (!isRecord(value) || !Array.isArray(value.tasks) || !value.tasks.every(isLocalTask)) throw new ApiError('invalid');
  return value.tasks;
}

export function parseLocalTask(value: unknown): LocalTask {
  if (!isRecord(value) || !isLocalTask(value.task)) throw new ApiError('invalid');
  return value.task;
}

const GITHUB_URL = /^https:\/\/github\.com\//;

/** GitHubのIssue・PRは、github.com の https のリンクだけを受け付ける。 */
export function parseExternal(value: unknown): ExternalResult {
  if (!isRecord(value)) throw new ApiError('invalid');
  if (value.configured === false) return { configured: false };
  if (value.configured !== true || !Array.isArray(value.tasks)
    || !Number.isSafeInteger(value.omitted) || (value.omitted as number) < 0) throw new ApiError('invalid');
  const tasks = value.tasks;
  if (!tasks.every((task) => isRecord(task) && task.source === 'github' && typeof task.id === 'string'
    && ['issue', 'pull_request'].includes(task.kind as string)
    && typeof task.key === 'string' && typeof task.title === 'string' && typeof task.updatedAt === 'string'
    && typeof task.url === 'string' && GITHUB_URL.test(task.url)
    && (task.reasons === undefined || (Array.isArray(task.reasons) && task.reasons.every((reason) =>
      (GITHUB_REASONS as readonly unknown[]).includes(reason)))))) {
    throw new ApiError('invalid');
  }
  return { configured: true, tasks: tasks as unknown as ExternalTask[], omitted: value.omitted as number };
}
