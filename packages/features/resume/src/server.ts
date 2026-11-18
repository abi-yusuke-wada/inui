import { Hono } from 'hono';
import { checkQuery, RequestError } from '@inui/feature-kit/server';
import type { ResumeSources } from './config.ts';
import { createGitRunner, readRepository } from './git.ts';
import type { GitRunner } from './git.ts';
import { fetchPullRequests, repositoryKey, UpstreamError } from './github.ts';
import type { UpstreamOptions } from './github.ts';
import type { GitHubState, RepositoryStatus, ResumeResult } from './types.ts';

export { readResumeSources } from './config.ts';
export type { ResumeSources } from './config.ts';
export { createGitRunner } from './git.ts';
export type { GitRunner } from './git.ts';

interface ResumeRoutesOptions {
  sources: ResumeSources;
  git?: GitRunner;
  upstream?: UpstreamOptions;
}

/** 自分が作った未完了のPRを、GitHubのリポジトリを持つものへ加える。失敗しても、手元のgitの状況は返す。 */
async function attachPullRequests(repositories: RepositoryStatus[], sources: ResumeSources,
  upstream: UpstreamOptions): Promise<GitHubState> {
  if (sources.invalid.includes('github')) return { status: 'error', code: 'invalid_config' };
  if (!sources.github) return { status: 'not_configured' };
  const targets = repositories.flatMap((repository) => repository.github ? [{ repository, github: repository.github }] : []);
  try {
    const pulls = await fetchPullRequests(sources.github.token, targets.map((target) => target.github), upstream);
    for (const { repository, github } of targets) {
      const list = pulls.get(repositoryKey(github));
      repository.pullRequests = list?.pullRequests ?? [];
      repository.omittedPullRequests = list?.omitted ?? 0;
    }
    return { status: 'ok' };
  } catch (error) {
    return { status: 'error', code: error instanceof UpstreamError ? error.code : 'upstream_unavailable' };
  }
}

/** 最近作業したリポジトリを先にする。読めなかったものは、登録した順で後ろにまとめる。 */
function byActivity(a: RepositoryStatus, b: RepositoryStatus): number {
  const time = (repository: RepositoryStatus) => repository.lastActivityAt === undefined ? -Infinity : Date.parse(repository.lastActivityAt);
  return time(b) - time(a) || 0;
}

/**
 * 作業の再開画面のために、登録したリポジトリの状況（worktreeごとのブランチ・変更・最近のコミット、
 * 引き継ぎメモ、自分のPR）を読み取って返す。リポジトリにもGitHubにも書き込まない。
 */
export function createResumeRoutes({ sources, git = createGitRunner(), upstream = {} }: ResumeRoutesOptions): Hono {
  const routes = new Hono();

  routes.get('/resume', async (c) => {
    checkQuery(c, []);
    if (sources.invalid.includes('repositories')) {
      throw new RequestError(503, 'invalid_config', '連携の設定値の形式を確認してください。');
    }
    if (sources.repositories.length === 0) return c.json({ configured: false } satisfies ResumeResult);
    const repositories = await Promise.all(sources.repositories.map((repository) => readRepository(git, repository)));
    const github = await attachPullRequests(repositories, sources, upstream);
    repositories.sort(byActivity);
    return c.json({ configured: true, github, repositories } satisfies ResumeResult);
  });

  return routes;
}
