import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { Hono } from 'hono';
import { RequestError } from '@inui/feature-kit/server';
import { createResumeRoutes } from '../src/server.ts';
import type { GitRunner, ResumeSources } from '../src/server.ts';
import { createRepository, temporaryDirectory } from './repository.ts';

const TOKEN = 'ghp_' + 'x'.repeat(36);

function app(sources: ResumeSources, fetchImpl?: typeof fetch, git?: GitRunner) {
  const root = new Hono();
  root.route('/api', createResumeRoutes({ sources, ...(git ? { git } : {}), upstream: fetchImpl ? { fetchImpl } : {} }));
  root.onError((error, c) => error instanceof RequestError
    ? c.json({ error: { code: error.code } }, error.status)
    : c.json({ error: { code: 'internal_error' } }, 500));
  return (path = '/api/resume') => root.request('http://127.0.0.1' + path);
}

function countingFetch(handler: () => Response) {
  let calls = 0;
  return { fetchImpl: (async () => { calls++; return handler(); }) as typeof fetch, calls: () => calls };
}

const pullsResponse = () => Response.json({ data: { r0: { issueCount: 1, nodes: [{
  number: 37, title: 'DBの土台', url: 'https://github.com/example/inui/pull/37', headRefName: 'feat/db', isDraft: false,
  reviewDecision: 'REVIEW_REQUIRED', updatedAt: '2026-11-18T06:00:00Z', commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] },
}] } } });

test('リポジトリが未登録なら未登録であることだけを返し、gitもGitHubも呼ばない', async () => {
  const git: GitRunner = async () => { throw new Error('gitを呼んではいけない'); };
  const { fetchImpl, calls } = countingFetch(() => Response.json({}));
  const response = await app({ repositories: [], github: { token: TOKEN }, invalid: [] }, fetchImpl, git)();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { configured: false });
  assert.equal(calls(), 0);
});

test('登録の形式が誤っていれば503で案内し、クエリは受け付けない', async () => {
  const invalid = await app({ repositories: [], invalid: ['repositories'] })();
  assert.equal(invalid.status, 503);
  assert.deepEqual(await invalid.json(), { error: { code: 'invalid_config' } });
  assert.equal((await app({ repositories: [], invalid: [] })('/api/resume?repository=inui')).status, 400);
});

test('最近作業したリポジトリを先に並べ、GitHubから読めた自分のPRを加える', async (t) => {
  const old = createRepository(t);
  old.commit('前の作業', { 'a.txt': 'a\n' }, '2026-11-10T09:00:00+09:00');
  const recent = createRepository(t);
  recent.commit('今日の作業', { 'a.txt': 'a\n' }, '2026-11-18T09:00:00+09:00');
  recent.git('remote', 'add', 'origin', 'git@github.com:example/inui.git');
  const missing = join(temporaryDirectory(t), 'missing');
  const { fetchImpl, calls } = countingFetch(pullsResponse);
  const sources: ResumeSources = {
    repositories: [{ name: 'missing', path: missing }, { name: 'old', path: old.dir }, { name: 'recent', path: recent.dir }],
    github: { token: TOKEN }, invalid: [],
  };
  const body = await (await app(sources, fetchImpl)()).json();
  assert.deepEqual(body.github, { status: 'ok' });
  assert.deepEqual(body.repositories.map((repository: { name: string; error?: string }) => [repository.name, repository.error]),
    [['recent', undefined], ['old', undefined], ['missing', 'not_found']]);
  assert.deepEqual(body.repositories[0].pullRequests.map((item: { number: number; checks: string }) => [item.number, item.checks]), [[37, 'success']]);
  assert.equal(body.repositories[0].omittedPullRequests, 0);
  // GitHubのリポジトリでないものには、PRの欄を付けない。
  assert.equal(Object.hasOwn(body.repositories[1], 'pullRequests'), false);
  assert.equal(calls(), 1);
});

test('GitHubが未設定・設定の誤り・失敗でも、手元のgitの状況は返す', async (t) => {
  const repo = createRepository(t);
  repo.commit('作業', { 'a.txt': 'a\n' });
  repo.git('remote', 'add', 'origin', 'https://github.com/example/inui.git');
  const repositories = [{ name: 'repo', path: repo.dir }];
  const unused = countingFetch(pullsResponse);
  const cases: [ResumeSources, unknown][] = [
    [{ repositories, invalid: [] }, { status: 'not_configured' }],
    [{ repositories, invalid: ['github'] }, { status: 'error', code: 'invalid_config' }],
  ];
  for (const [sources, github] of cases) {
    const body = await (await app(sources, unused.fetchImpl)()).json();
    assert.deepEqual(body.github, github);
    assert.equal(body.repositories[0].worktrees[0].commits[0].subject, '作業');
  }
  assert.equal(unused.calls(), 0);
  const failing = countingFetch(() => new Response('test-only-secret', { status: 500 }));
  const body = await (await app({ repositories, github: { token: TOKEN }, invalid: [] }, failing.fetchImpl)()).json();
  assert.deepEqual(body.github, { status: 'error', code: 'upstream_unavailable' });
  assert.equal(body.repositories[0].worktrees[0].commits[0].subject, '作業');
  assert.equal(Object.hasOwn(body.repositories[0], 'pullRequests'), false);
  assert.equal(JSON.stringify(body).includes('test-only-secret'), false);
});
