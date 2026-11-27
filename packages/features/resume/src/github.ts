import { isRecord } from '@inui/feature-kit/server';
import { isText, isTimestamp, requestJson, UpstreamError } from '@inui/feature-kit/upstream';
import type { UpstreamOptions } from '@inui/feature-kit/upstream';
import type { PullRequestStatus } from './types.ts';

export { UpstreamError } from '@inui/feature-kit/upstream';
export type { UpstreamOptions } from '@inui/feature-kit/upstream';

const ENDPOINT = 'https://api.github.com/graphql';
/** 1つのリポジトリで読む、自分が作った未完了のPRの数。 */
const MAX_PULLS = 20;
const NAME = /^[A-Za-z0-9_.-]{1,100}$/;
const REVIEW = { APPROVED: 'approved', CHANGES_REQUESTED: 'changes_requested', REVIEW_REQUIRED: 'review_required' } as const;
const CHECKS = { SUCCESS: 'success', FAILURE: 'failure', ERROR: 'failure', PENDING: 'pending', EXPECTED: 'pending' } as const;

export interface GitHubRepository {
  owner: string;
  name: string;
}

/** 照合に使うキー。GitHubの所有者・リポジトリ名は大文字と小文字を区別しない。 */
export const repositoryKey = ({ owner, name }: GitHubRepository): string => `${owner}/${name}`.toLowerCase();

/**
 * 検索結果の1件を検証し、表示に必要な項目だけを取り出す。
 * checksUnknown は、そのPRのCIの状態が読めなかった可能性がある（エラーがあった、またはCIの状態を読まなかった）ことを表す。
 */
function toPullRequest(node: unknown, repository: GitHubRepository, checksUnknown: boolean): PullRequestStatus {
  if (!isRecord(node) || !Number.isSafeInteger(node.number) || (node.number as number) < 1 || !isText(node.title, 500)
      || typeof node.url !== 'string' || !isText(node.headRefName, 255) || typeof node.isDraft !== 'boolean'
      || !isTimestamp(node.updatedAt)
      || (node.reviewDecision !== null && !Object.hasOwn(REVIEW, node.reviewDecision as string))) {
    throw new UpstreamError('upstream_invalid');
  }
  // 別のリポジトリや別のサイトへのリンクは表示しない。
  const expected = `https://github.com/${repository.owner}/${repository.name}/pull/${node.number as number}`;
  if (node.url.toLowerCase() !== expected.toLowerCase()) throw new UpstreamError('upstream_invalid');
  const commits = isRecord(node.commits) && Array.isArray(node.commits.nodes) ? node.commits.nodes : undefined;
  const commit = commits?.[0];
  const rollup = isRecord(commit) && isRecord(commit.commit) ? commit.commit.statusCheckRollup : undefined;
  let checks: PullRequestStatus['checks'];
  if (isRecord(rollup)) {
    if (!Object.hasOwn(CHECKS, rollup.state as string)) throw new UpstreamError('upstream_invalid');
    checks = CHECKS[rollup.state as keyof typeof CHECKS];
  } else {
    // チェックがないPRはnullになる。トークンの権限が足りない場合もnullとエラーが返るため、区別できないものはunknownにする。
    checks = checksUnknown ? 'unknown' : 'none';
  }
  return {
    number: node.number as number, title: node.title, url: node.url, branch: node.headRefName, draft: node.isDraft,
    review: node.reviewDecision === null ? 'none' : REVIEW[node.reviewDecision as keyof typeof REVIEW],
    checks, updatedAt: node.updatedAt,
  };
}

/** GraphQLの要求を1回だけ送る。 */
function postGraphQL(token: string, query: string, variables: Record<string, string>, options: UpstreamOptions): Promise<unknown> {
  return requestJson(ENDPOINT, {
    method: 'POST', body: JSON.stringify({ query, variables }),
    headers: {
      Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
      'User-Agent': 'inui-local-poc',
    },
  }, options);
}

/**
 * GraphQLのエラーの場所（path）から、読めなかった欄を含むPRを `r0/3`（検索の別名/何件目か）の形で求める。
 * 場所がPRの中を指さないエラーが1つでもあれば、どのPRかを決められないため all にする。
 */
function affectedPullRequests(errors: readonly unknown[]): { all: boolean; pulls: Set<string> } {
  const affected = { all: false, pulls: new Set<string>() };
  for (const error of errors) {
    const path = isRecord(error) ? error.path : undefined;
    if (Array.isArray(path) && typeof path[0] === 'string' && /^r\d+$/.test(path[0]) && path[1] === 'nodes'
        && Number.isSafeInteger(path[2])) {
      affected.pulls.add(`${path[0]}/${path[2] as number}`);
    } else {
      affected.all = true;
    }
  }
  return affected;
}

/** 1つのリポジトリで読めたPRと、上限を超えて表示しなかった件数。 */
export interface PullRequestList {
  pullRequests: PullRequestStatus[];
  omitted: number;
}

/**
 * 自分が作った未完了のPRを、リポジトリごとに読む（キーはrepositoryKey）。トークンはヘッダーにだけ使い、結果は保存しない。
 * リポジトリごとの検索を、別名を付けて1回の要求にまとめる。上限を超えた分は、件数だけを返す。
 * CIの状態を読む最新のコミット（commits）は省略できない欄のため、権限が足りずに読めないと、エラーでPRごとnullになる。
 * その場合は、CIの状態を読まずにもう1回だけ要求し、PRの一覧を残してCIの状態をunknownにする。
 */
export async function fetchPullRequests(token: string, repositories: readonly GitHubRepository[],
  options: UpstreamOptions = {}): Promise<Map<string, PullRequestList>> {
  // 同じリポジトリ（大文字と小文字だけが違うものを含む）は、最初に出てきたものだけを検索する。
  const targets: GitHubRepository[] = [];
  const seen = new Set<string>();
  for (const repository of repositories) {
    if (seen.has(repositoryKey(repository))) continue;
    seen.add(repositoryKey(repository));
    targets.push(repository);
  }
  const result = new Map<string, PullRequestList>();
  if (targets.length === 0) return result;
  // 検索の条件に余分な語を入れられないよう、所有者と名前は使える文字だけに限る。
  if (!targets.every((repository) => NAME.test(repository.owner) && NAME.test(repository.name))) {
    throw new UpstreamError('upstream_invalid');
  }
  const variables: Record<string, string> = {};
  for (const [index, repository] of targets.entries()) {
    variables[`q${index}`] = `repo:${repository.owner}/${repository.name} is:pr is:open author:@me archived:false`;
  }
  const request = async (withChecks: boolean) => {
    const fields = targets.map((_, index) => `r${index}: search(query: $q${index}, type: ISSUE, first: ${MAX_PULLS}) { issueCount nodes { ... on PullRequest {
      number title url headRefName isDraft reviewDecision updatedAt
      ${withChecks ? 'commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }' : ''} } } }`);
    const query = `query(${targets.map((_, index) => `$q${index}: String!`).join(', ')}) { ${fields.join('\n')} }`;
    const body = await postGraphQL(token, query, variables, options);
    if (!isRecord(body) || !isRecord(body.data)) {
      throw new UpstreamError('upstream_invalid');
    }
    return { data: body.data, errors: Array.isArray(body.errors) ? body.errors as unknown[] : [] };
  };
  let response = await request(true);
  let withChecks = true;
  const lostPullRequest = (search: unknown) => isRecord(search) && Array.isArray(search.nodes) && search.nodes.some((node) => !isRecord(node));
  if (response.errors.length > 0 && targets.some((_, index) => lostPullRequest(response.data[`r${index}`]))) {
    response = await request(false);
    withChecks = false;
  }
  const { data, errors } = response;
  const affected = affectedPullRequests(errors);
  for (const [index, repository] of targets.entries()) {
    const search = data[`r${index}`];
    // issueCountは条件に合う全件数で、nodesは上限までの分。件数が矛盾する応答は受け付けない。
    if (!isRecord(search) || !Array.isArray(search.nodes) || search.nodes.length > MAX_PULLS
        || !Number.isSafeInteger(search.issueCount) || (search.issueCount as number) < search.nodes.length) {
      throw new UpstreamError('upstream_invalid');
    }
    result.set(repositoryKey(repository), {
      pullRequests: search.nodes.map((node, position) =>
        toPullRequest(node, repository, !withChecks || affected.all || affected.pulls.has(`r${index}/${position}`)))
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)),
      omitted: (search.issueCount as number) - search.nodes.length,
    });
  }
  return result;
}
