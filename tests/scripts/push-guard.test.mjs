import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// 検査スクリプトはエージェントが書き換えられない .claude/hooks/ に置く。
const HOOK = process.env.INUI_PUSH_GUARD ?? fileURLToPath(new URL('../../.claude/hooks/push-guard.py', import.meta.url));
const ORIGIN = 'https://github.com/abi-yusuke-wada/inui.git';
// 利用者のGit設定（insteadOf等）の影響を受けないよう、グローバル・システム設定を読まない。
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
// 呼出元のリポジトリを操作しないよう、Gitのリポジトリ参照先を変える変数を除く。
for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR', 'GIT_NAMESPACE', 'GIT_CONFIG', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT']) delete GIT_ENV[name];

/** 作業ブランチを1コミットだけ持つ一時リポジトリを作る。 */
function repository(branch = 'feat/sample') {
  const dir = mkdtempSync(join(tmpdir(), 'push-guard-'));
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { env: GIT_ENV, stdio: 'pipe' });
  git('init', '-q', '-b', branch);
  git('-c', 'user.name=test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'init');
  git('remote', 'add', 'origin', ORIGIN);
  return { dir, git, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** フックへコマンドを渡し、出力した判定を返す。何も出力しなければnull。 */
function decide(command, cwd, toolName = 'Bash', env = GIT_ENV) {
  const result = spawnSync('python3', ['-I', HOOK], {
    input: JSON.stringify({ tool_name: toolName, tool_input: { command }, cwd }), env, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  if (!result.stdout.trim()) return null;
  return JSON.parse(result.stdout).hookSpecificOutput.permissionDecision;
}

test('現在の作業ブランチへの通常のpushだけを承認なしにする', () => {
  const repo = repository();
  try {
    assert.equal(decide('git push origin feat/sample', repo.dir), 'allow');
    assert.equal(decide('  git push origin feat/sample  ', repo.dir), 'allow');
  } finally { repo.cleanup(); }
});

test('refspec・強制更新・余分な引数・連結したコマンドは承認を求める', () => {
  const repo = repository();
  try {
    for (const command of [
      'git push origin feat/sample:release', 'git push origin feat/sample:main', 'git push origin :feat/sample',
      'git push origin +feat/sample', 'git push origin feat/sample --force', 'git push origin feat/sample -f',
      'git push origin feat/sample refs/heads/main', 'git push origin feat/sample --dry-run',
      'git push -u origin feat/sample', 'git push origin feat/sample; rm -rf .', 'git push origin feat/sample && true',
      'git push upstream feat/sample', 'git push', 'git push origin',
    ]) {
      assert.equal(decide(command, repo.dir), 'ask', command);
    }
  } finally { repo.cleanup(); }
});

test('作業ブランチ以外や、現在のブランチと異なるブランチへのpushは承認を求める', () => {
  const repo = repository();
  try {
    for (const command of ['git push origin main', 'git push origin release/x', 'git push origin feat/other',
      'git push origin feat/../main', 'git push origin feat/x.lock']) {
      assert.equal(decide(command, repo.dir), 'ask', command);
    }
  } finally { repo.cleanup(); }
  const onMain = repository('main');
  try {
    assert.equal(decide('git push origin main', onMain.dir), 'ask');
  } finally { onMain.cleanup(); }
});

test('push先やURLを書き換えるGitの設定があれば承認を求める', () => {
  for (const [key, value] of [
    ['remote.origin.push', 'refs/heads/feat/sample:refs/heads/main'],
    ['remote.origin.pushurl', 'https://example.invalid/other.git'],
    ['remote.origin.mirror', 'true'],
    ['push.followTags', 'true'],
    ['url.https://example.invalid/.insteadOf', 'https://github.com/'],
    ['url.https://example.invalid/.pushInsteadOf', 'https://github.com/'],
  ]) {
    const repo = repository();
    try {
      repo.git('config', key, value);
      assert.equal(decide('git push origin feat/sample', repo.dir), 'ask', key);
    } finally { repo.cleanup(); }
  }
  const repo = repository();
  try {
    repo.git('remote', 'set-url', 'origin', 'https://example.invalid/other.git');
    assert.equal(decide('git push origin feat/sample', repo.dir), 'ask');
  } finally { repo.cleanup(); }
  // urlが複数あるとgitはすべてへpushするため、許可URLが最後でも承認を求める。
  const multi = repository();
  try {
    multi.git('config', '--replace-all', 'remote.origin.url', 'https://example.invalid/other.git');
    multi.git('config', '--add', 'remote.origin.url', ORIGIN);
    assert.equal(decide('git push origin feat/sample', multi.dir), 'ask');
  } finally { multi.cleanup(); }
});

test('GIT_CONFIGでgit configの参照先だけが切り替わる場合は承認を求める', () => {
  const repo = repository();
  try {
    // 実際のoriginは別リポジトリでも、GIT_CONFIGが期待URLだけを書いたファイルを指すと検査が通ってしまう。
    repo.git('remote', 'set-url', 'origin', 'https://example.invalid/other.git');
    const fake = join(repo.dir, 'fake-config');
    execFileSync('git', ['config', '--file', fake, 'remote.origin.url', ORIGIN], { env: GIT_ENV });
    assert.equal(decide('git push origin feat/sample', repo.dir, 'Bash', { ...GIT_ENV, GIT_CONFIG: fake }), 'ask');
  } finally { repo.cleanup(); }
});

test('git push以外のコマンドや判定できない入力では何も出力しない', () => {
  const repo = repository();
  try {
    assert.equal(decide('git status', repo.dir), null);
    assert.equal(decide('echo git push origin feat/sample', repo.dir), null);
    assert.equal(decide('git push origin feat/sample', repo.dir, 'Read'), null);
  } finally { repo.cleanup(); }
  const broken = spawnSync('python3', ['-I', HOOK], { input: 'not json', env: GIT_ENV, encoding: 'utf8' });
  assert.equal(broken.status, 0);
  assert.equal(broken.stdout, '');
});
