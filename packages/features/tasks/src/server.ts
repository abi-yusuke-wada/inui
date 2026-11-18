import { Hono } from 'hono';
import { checkQuery, invalidInput, isRecord, keysAre, readJson, RequestError } from '@inui/feature-kit/server';
import { fetchGitHubTasks } from './github.ts';
import type { TaskStore } from './store.ts';
import type { TaskSources } from './config.ts';
import { MAX_TITLE_LENGTH, TASK_STATUSES } from './types.ts';
import type { ExternalResult, ExternalTask, LocalTask } from './types.ts';
import { UpstreamError } from './upstream.ts';
import type { UpstreamOptions } from './upstream.ts';

export { readTaskSources } from './config.ts';
export type { TaskSources } from './config.ts';
export { TaskStore } from './store.ts';

const TASK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UPSTREAM_ERRORS = {
  upstream_auth: [502, '連携先の認証に失敗しました。トークンと権限を確認してください。'],
  upstream_unavailable: [502, '連携先から取得できませんでした。時間をおいてお試しください。'],
  upstream_invalid: [502, '連携先の応答を確認できませんでした。'],
  upstream_timeout: [504, '連携先からの取得に時間がかかりすぎました。'],
} as const;

interface TaskRoutesOptions {
  store: Pick<TaskStore, 'list' | 'add' | 'setDone' | 'setStatus' | 'remove'>;
  sources: TaskSources;
  upstream?: UpstreamOptions;
}

function taskId(value: string): string {
  if (!TASK_ID.test(value)) invalidInput();
  return value;
}

function notFound(): never {
  throw new RequestError(404, 'task_not_found', '指定したタスクは見つかりませんでした。');
}

/** 連携先の失敗を固定のコードと案内文へ置き換え、元の例外は返さない。 */
async function external(source: 'github', sources: TaskSources,
  load: () => Promise<ExternalTask[]>): Promise<ExternalResult> {
  if (sources.invalid.includes(source)) {
    throw new RequestError(503, 'invalid_config', '連携の設定値の形式を確認してください。');
  }
  try {
    return { configured: true, tasks: await load() };
  } catch (error) {
    const code = error instanceof UpstreamError ? error.code : 'upstream_unavailable';
    const [status, message] = UPSTREAM_ERRORS[code];
    throw new RequestError(status, code, message);
  }
}

/** 自由に作るタスクの保存と、GitHubのIssue・PRの読み取りを提供する。 */
export function createTaskRoutes({ store, sources, upstream = {} }: TaskRoutesOptions): Hono {
  const routes = new Hono();

  routes.get('/tasks/local', (c) => {
    checkQuery(c, []);
    return c.json({ tasks: store.list() });
  });

  routes.post('/tasks/local', async (c) => {
    const body = await readJson(c);
    if (!isRecord(body) || !keysAre(body, ['title']) || typeof body.title !== 'string') invalidInput();
    const title = body.title.trim();
    if (title.length < 1 || title.length > MAX_TITLE_LENGTH) invalidInput();
    return c.json({ task: store.add(title) }, 201);
  });

  routes.patch('/tasks/local/:id', async (c) => {
    const id = taskId(c.req.param('id'));
    const body = await readJson(c);
    // Todo表示は完了のチェック（done）、看板は列（status）を、どちらか1つだけ送る。
    if (!isRecord(body) || Object.keys(body).length !== 1) invalidInput();
    let task: LocalTask | undefined;
    if (typeof body.done === 'boolean') task = store.setDone(id, body.done);
    else if (typeof body.status === 'string' && (TASK_STATUSES as readonly string[]).includes(body.status)) {
      task = store.setStatus(id, body.status as typeof TASK_STATUSES[number]);
    } else invalidInput();
    if (!task) notFound();
    return c.json({ task });
  });

  routes.delete('/tasks/local/:id', (c) => {
    if (!store.remove(taskId(c.req.param('id')))) notFound();
    return c.json({ deleted: true });
  });

  routes.get('/tasks/github', async (c) => {
    checkQuery(c, []);
    const github = sources.github;
    if (!github && !sources.invalid.includes('github')) return c.json({ configured: false });
    return c.json(await external('github', sources, () => fetchGitHubTasks(github?.token ?? '', upstream)));
  });

  return routes;
}
