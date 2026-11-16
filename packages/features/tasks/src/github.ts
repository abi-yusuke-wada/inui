import { getJson, isRecord, isText, isTimestamp, UpstreamError } from './upstream.ts';
import type { UpstreamOptions } from './upstream.ts';
import type { ExternalTask, GitHubReason } from './types.ts';

const API = 'https://api.github.com';
const PER_QUERY = 50;
// 自分に関係する未完了のIssue・PRを、リポジトリをまたいで検索する。
const QUERIES: readonly (readonly [GitHubReason, string])[] = [
  ['assigned', 'is:open is:issue assignee:@me archived:false'],
  ['authored', 'is:open is:pr author:@me archived:false'],
  ['review_requested', 'is:open is:pr review-requested:@me archived:false'],
];
const REPOSITORY_URL = /^https:\/\/api\.github\.com\/repos\/([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})$/;
const HTML_URL = /^https:\/\/github\.com\/[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}\/(?:issues|pull)\/\d{1,10}$/;

/** 検索結果の1件を検証し、表示に必要な項目だけを取り出す。 */
function toTask(item: unknown, reason: GitHubReason): ExternalTask {
  if (!isRecord(item) || !Number.isSafeInteger(item.id) || !Number.isSafeInteger(item.number)
      || !isText(item.title) || typeof item.html_url !== 'string' || !HTML_URL.test(item.html_url)
      || typeof item.repository_url !== 'string' || !isTimestamp(item.updated_at)) {
    throw new UpstreamError('upstream_invalid');
  }
  const repository = REPOSITORY_URL.exec(item.repository_url);
  if (!repository) throw new UpstreamError('upstream_invalid');
  const pullRequest = isRecord(item.pull_request);
  return {
    id: `github-${item.id as number}`,
    source: 'github',
    kind: pullRequest ? 'pull_request' : 'issue',
    key: `${repository[1]}/${repository[2]}#${item.number as number}`,
    title: item.title,
    url: item.html_url,
    updatedAt: item.updated_at,
    reasons: [reason],
  };
}

/**
 * 担当のIssue・自分が作ったPR・レビューを依頼されたPRを読み取る。
 * トークンはヘッダーにだけ使い、結果は保存しない。
 */
export async function fetchGitHubTasks(token: string, options: UpstreamOptions = {}): Promise<ExternalTask[]> {
  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'inui-local-poc',
  };
  const results = await Promise.all(QUERIES.map(async ([reason, query]) => {
    const params = new URLSearchParams({ q: query, sort: 'updated', order: 'desc', per_page: String(PER_QUERY) });
    const body = await getJson(`${API}/search/issues?${params.toString()}`, headers, options);
    if (!isRecord(body) || !Array.isArray(body.items) || body.items.length > PER_QUERY) {
      throw new UpstreamError('upstream_invalid');
    }
    return body.items.map((item) => toTask(item, reason));
  }));
  // 同じIssue・PRが複数の条件に当てはまる場合は1件にまとめ、理由を併記する。
  const merged = new Map<string, ExternalTask>();
  for (const task of results.flat()) {
    const existing = merged.get(task.id);
    if (existing) existing.reasons = [...new Set([...(existing.reasons ?? []), ...(task.reasons ?? [])])];
    else merged.set(task.id, task);
  }
  return [...merged.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
