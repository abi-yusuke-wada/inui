import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_REPOSITORIES, readResumeSources } from '../src/config.ts';

const TOKEN = 'ghp_' + 'x'.repeat(36);

test('読むリポジトリは、環境変数に絶対パスで並べたものだけにする', () => {
  assert.deepEqual(readResumeSources({}), { repositories: [], invalid: [] });
  assert.deepEqual(readResumeSources({ INUI_REPOSITORIES: ' /root/develop/inui/ , /root/notes,/root/develop/../develop/inui' }), {
    repositories: [{ name: 'inui', path: '/root/develop/inui' }, { name: 'notes', path: '/root/notes' }], invalid: [],
  });
});

test('形式の誤りが1つでもあれば、リポジトリを1つも読まない', () => {
  for (const value of ['relative/repo', '/root/a,,/root/b', '/root/a,', '/root/line\nbreak', '~/repo',
    Array.from({ length: MAX_REPOSITORIES + 1 }, (_, index) => `/root/repo${index}`).join(',')]) {
    assert.deepEqual(readResumeSources({ INUI_REPOSITORIES: value }), { repositories: [], invalid: ['repositories'] }, value);
  }
});

test('GitHubのトークンはタスク画面と同じ変数から読み、値の形式が誤っていれば使わない', () => {
  assert.deepEqual(readResumeSources({ INUI_GITHUB_TOKEN: TOKEN }), { repositories: [], github: { token: TOKEN }, invalid: [] });
  assert.deepEqual(readResumeSources({ INUI_GITHUB_TOKEN: 'short' }), { repositories: [], invalid: ['github'] });
  // GitHubのCLI等の変数は読まない。
  assert.deepEqual(readResumeSources({ GH_TOKEN: TOKEN, GITHUB_TOKEN: TOKEN }), { repositories: [], invalid: [] });
});
