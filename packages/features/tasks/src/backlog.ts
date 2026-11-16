import { getJson, isRecord, isText, isTimestamp, UpstreamError } from './upstream.ts';
import type { UpstreamOptions } from './upstream.ts';
import type { ExternalTask } from './types.ts';

const MAX_ISSUES = 100;
// Backlogの既定の状態のうち、完了（4）以外の未対応・処理中・処理済みを対象にする。
const OPEN_STATUS_IDS = ['1', '2', '3'];
const ISSUE_KEY = /^[A-Z][A-Z0-9_]{0,24}-\d{1,10}$/;
const DUE_DATE = /^\d{4}-\d{2}-\d{2}(?:T00:00:00Z)?$/;

export interface BacklogConfig {
  space: string;
  apiKey: string;
}

/** BacklogのAPIキーはクエリで渡す仕様のため、URLをログ・エラーへ含めない。 */
function url(config: BacklogConfig, path: string, params: [string, string][]): string {
  const search = new URLSearchParams([['apiKey', config.apiKey], ...params]);
  return `https://${config.space}${path}?${search.toString()}`;
}

function toTask(item: unknown, space: string): ExternalTask {
  if (!isRecord(item) || !Number.isSafeInteger(item.id) || typeof item.issueKey !== 'string'
      || !ISSUE_KEY.test(item.issueKey) || !isText(item.summary) || !isTimestamp(item.updated)
      || !isRecord(item.status) || !isText(item.status.name, 50)
      || !(item.dueDate === null || item.dueDate === undefined || (typeof item.dueDate === 'string' && DUE_DATE.test(item.dueDate)))) {
    throw new UpstreamError('upstream_invalid');
  }
  return {
    id: `backlog-${item.id as number}`,
    source: 'backlog',
    kind: 'backlog_issue',
    key: item.issueKey,
    title: item.summary,
    url: `https://${space}/view/${item.issueKey}`,
    updatedAt: item.updated,
    status: item.status.name,
    ...(typeof item.dueDate === 'string' ? { dueDate: item.dueDate.slice(0, 10) } : {}),
  };
}

/**
 * 自分が担当の未完了の課題を読み取る。顧客の情報を含み得るため、結果は保存・記録しない。
 */
export async function fetchBacklogTasks(config: BacklogConfig, options: UpstreamOptions = {}): Promise<ExternalTask[]> {
  const headers = { Accept: 'application/json', 'User-Agent': 'inui-local-poc' };
  const myself = await getJson(url(config, '/api/v2/users/myself', []), headers, options);
  if (!isRecord(myself) || !Number.isSafeInteger(myself.id)) throw new UpstreamError('upstream_invalid');
  const body = await getJson(url(config, '/api/v2/issues', [
    ['assigneeId[]', String(myself.id)],
    ...OPEN_STATUS_IDS.map((id): [string, string] => ['statusId[]', id]),
    ['count', String(MAX_ISSUES)], ['sort', 'updated'], ['order', 'desc'],
  ]), headers, options);
  if (!Array.isArray(body) || body.length > MAX_ISSUES) throw new UpstreamError('upstream_invalid');
  return body.map((item) => toTask(item, config.space));
}
