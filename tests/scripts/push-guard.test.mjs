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
function decide(command, cwd, toolName = 'Bash') {
  const result = spawnSync('python3', ['-I', HOOK], {
    input: JSON.stringify({ tool_name: toolName, tool_input: { command }, cwd }), env: GIT_ENV, encoding: 'utf8',
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
