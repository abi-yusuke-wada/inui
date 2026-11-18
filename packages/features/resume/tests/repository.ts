import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { TestContext } from 'node:test';

/** テストの準備に使うgitの環境。利用者のGit設定（insteadOf・fsmonitor等）の影響を受けないようにする。 */
export const SETUP_ENV: Record<string, string | undefined> = {
  ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
};
// 呼出元のリポジトリを操作しないよう、Gitのリポジトリ参照先を変える変数を除く。
for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR', 'GIT_NAMESPACE', 'GIT_CONFIG', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT']) delete SETUP_ENV[name];

export function temporaryDirectory(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), 'inui-resume-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

export interface TestRepository {
  root: string;
  dir: string;
  git: (...args: string[]) => string;
  write: (path: string, content: string) => void;
  /** ファイルを書いてコミットする。日時を指定すると、コミットの日時に使う。 */
  commit: (message: string, files?: Record<string, string>, date?: string) => void;
}

/** 一時ディレクトリの下の repo/ に、ブランチを1つ持つリポジトリを作る。 */
export function createRepository(t: TestContext, branch = 'main'): TestRepository {
  const root = temporaryDirectory(t);
  const dir = join(root, 'repo');
  mkdirSync(dir);
  const run = (cwd: string, args: string[], env = SETUP_ENV) => execFileSync('git', ['-C', cwd, ...args], { env, encoding: 'utf8' });
  const write = (path: string, content: string) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  };
  run(dir, ['init', '-q', '-b', branch]);
  return {
    root, dir, write,
    git: (...args) => run(dir, args),
    commit: (message, files = {}, date) => {
      for (const [path, content] of Object.entries(files)) write(path, content);
      run(dir, ['add', '-A']);
      run(dir, ['commit', '-q', '--allow-empty', '-m', message],
        date ? { ...SETUP_ENV, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : SETUP_ENV);
    },
  };
}

/** 別のworktreeでコミットする。 */
export function commitIn(worktree: string, message: string, files: Record<string, string>, date: string): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(worktree, path)), { recursive: true });
    writeFileSync(join(worktree, path), content);
  }
  const env = { ...SETUP_ENV, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
  execFileSync('git', ['-C', worktree, 'add', '-A'], { env });
  execFileSync('git', ['-C', worktree, 'commit', '-q', '-m', message], { env });
}
