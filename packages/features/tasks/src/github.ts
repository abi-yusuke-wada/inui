import { getJson, isRecord, isText, isTimestamp, UpstreamError } from './upstream.ts';
import type { UpstreamOptions } from './upstream.ts';
import type { ExternalTask, GitHubReason } from './types.ts';

const API = 'https://api.github.com';
// 1回の検索で取得する件数（GitHubの上限）。超えた分は件数だけを返し、画面でGitHubを確認するよう案内する。
const PER_QUERY = 100;
// 自分に関係する未完了のIssue・PRを、リポジトリをまたいで検索する。
const QUERIES: readonly (readonly [GitHubReason, string])[] = [
  ['assigned', 'is:open is:issue assignee:@me archived:false'],
  ['authored', 'is:open is:pr author:@me archived:false'],
  // 最新のコミットのCIが失敗している自分のPR。PRごとにCIの状態を読み直さず、検索の条件で絞る。
  ['ci_failed', 'is:open is:pr author:@me status:failure archived:false'],
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
 * 担当のIssue・自分が作ったPR（CIが失敗したものには印を付ける）・レビューを依頼されたPR・自分へのメンションを読み取る。
 * トークンはヘッダーにだけ使い、結果は保存しない。各条件の件数が上限を超えた分は、omittedとして件数だけを返す。
 */
export async function fetchGitHubTasks(token: string, options: UpstreamOptions = {}): Promise<{ tasks: ExternalTask[]; omitted: number }> {
  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'inui-local-poc',
  };
  // GitHub Appのユーザーアクセストークンでは、IssueとPRをまとめて検索すると422になる。
  const mentionQueries = token.startsWith('ghu_')
    ? [
      'is:open is:issue mentions:@me archived:false',
      'is:open is:pull-request mentions:@me archived:false',
    ]
    : ['is:open mentions:@me archived:false'];
  const queries = [...QUERIES, ...mentionQueries.map((query) => ['mentioned', query] as const)];

  const results = await Promise.all(queries.map(async ([reason, query]) => {
    const params = new URLSearchParams({ q: query, sort: 'updated', order: 'desc', per_page: String(PER_QUERY) });
    const body = await getJson(`${API}/search/issues?${params.toString()}`, headers, options);
    if (!isRecord(body) || !Array.isArray(body.items) || body.items.length > PER_QUERY
        || typeof body.incomplete_results !== 'boolean'
        || !Number.isSafeInteger(body.total_count) || (body.total_count as number) < body.items.length) {
      throw new UpstreamError('upstream_invalid');
    }
    // 検索が時間内に終わらなかった結果は一部が欠けるため、使わずに再試行を案内する。
    if (body.incomplete_results) throw new UpstreamError('upstream_unavailable');
    return { tasks: body.items.map((item) => toTask(item, reason)), omitted: (body.total_count as number) - body.items.length };
  }));
  // 同じIssue・PRが複数の条件に当てはまる場合は1件にまとめ、理由を併記する。
  const merged = new Map<string, ExternalTask>();
  for (const task of results.flatMap((result) => result.tasks)) {
    const existing = merged.get(task.id);
    if (existing) existing.reasons = [...new Set([...(existing.reasons ?? []), ...(task.reasons ?? [])])];
    else merged.set(task.id, task);
  }
  return {
    tasks: [...merged.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    omitted: results.reduce((sum, result) => sum + result.omitted, 0),
  };
}
