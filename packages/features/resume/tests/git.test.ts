import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync, closeSync, constants, existsSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync,
  symlinkSync, utimesSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import {
  createGitRunner, GitError, gitEnv, HANDOFF_PATH, MAX_FILES, MAX_HANDOFF_BYTES, MAX_WORKTREES, parseGitHubRemote, parseStatus,
  readRepository,
} from '../src/git.ts';
import type { GitRunner } from '../src/git.ts';
import { commitIn, createRepository, SETUP_ENV, temporaryDirectory } from './repository.ts';

const git = createGitRunner();

/** 偽のgitの rev-parse の応答。本体の確認には本体だけ、worktreeの確認には本体と最上位（cwd）を返す。 */
const revParse = (common: string, cwd: string, args: readonly string[]) =>
  args.includes('--show-toplevel') ? `${common}\n${cwd}\n` : `${common}\n`;

test('worktreeごとのブランチ・変更・最近のコミットを読み、最も新しいコミットの日時を最終作業日時にする', async (t) => {
  const repo = createRepository(t);
  repo.commit('最初のコミット', { 'a.txt': 'a\n' }, '2026-11-16T09:00:00+09:00');
  repo.commit('ADRを書く', { 'b.txt': 'b\n' }, '2026-11-17T09:00:00+09:00');
  repo.git('remote', 'add', 'origin', 'https://github.com/example/inui.git');
  const worktree = join(repo.root, 'wt');
  repo.git('worktree', 'add', '-q', '-b', 'feat/x', worktree);
  commitIn(worktree, '別のworktreeの作業', { 'c.txt': 'c\n' }, '2026-11-18T09:00:00+09:00');
  // 本体のworktreeに、変更・ステージ済み・未追跡のファイルを1つずつ作る。
  repo.write('a.txt', 'changed\n');
  repo.write('staged.txt', 'staged\n');
  repo.git('add', 'staged.txt');
  repo.write('new.txt', 'new\n');

  const status = await readRepository(git, { name: 'repo', path: repo.dir });
  assert.equal(status.error, undefined);
  assert.deepEqual(status.github, { owner: 'example', name: 'inui' });
  assert.equal(status.omittedWorktrees, 0);
  assert.deepEqual(status.worktrees.map((item) => [item.path, item.branch]), [[repo.dir, 'main'], [worktree, 'feat/x']]);
  const [main, feature] = status.worktrees;
  assert.deepEqual(main?.changes, {
    staged: 1, unstaged: 1, untracked: 1, conflicted: 0, omittedFiles: 0,
    files: [{ status: '.M', path: 'a.txt' }, { status: 'A.', path: 'staged.txt' }, { status: '??', path: 'new.txt' }],
  });
  assert.deepEqual(main?.commits.map((commit) => [commit.subject, commit.committedAt]),
    [['ADRを書く', '2026-11-17T09:00:00+09:00'], ['最初のコミット', '2026-11-16T09:00:00+09:00']]);
  // GIT_DEFAULT_HASH=sha256 の環境ではSHA-256のIDになる。
  assert.match(main?.commits[0]?.sha ?? '', /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
  assert.equal(feature?.commits[0]?.subject, '別のworktreeの作業');
  assert.equal(status.lastActivityAt, '2026-11-18T09:00:00+09:00');
});

test('追跡するブランチとの差（先行・遅れ）を読む', async (t) => {
  const repo = createRepository(t);
  repo.commit('最初のコミット', { 'a.txt': 'a\n' });
  const remote = join(repo.root, 'remote.git');
  execFileSync('git', ['init', '-q', '--bare', remote], { env: SETUP_ENV });
  repo.git('remote', 'add', 'up', remote);
  repo.git('push', '-q', 'up', 'main');
  repo.git('branch', '-q', '--set-upstream-to=up/main');
  repo.commit('まだ送っていないコミット', { 'b.txt': 'b\n' });
  const status = await readRepository(git, { name: 'repo', path: repo.dir });
  assert.deepEqual(status.worktrees[0]?.upstream, { name: 'up/main', ahead: 1, behind: 0 });
  // GitHub以外のリモートしかなければ、GitHubのリポジトリとは扱わない。
  assert.equal(status.github, undefined);
});

test('引き継ぎメモは最も新しく更新されたworktreeのものを読み、未コミットの変更があればそれを優先する', async (t) => {
  const repo = createRepository(t);
  repo.commit('メモを書く', { [HANDOFF_PATH]: '# 本体のメモ\n' }, '2020-11-16T09:00:00+09:00');
  const worktree = join(repo.root, 'wt');
  repo.git('worktree', 'add', '-q', '-b', 'feat/x', worktree);
  commitIn(worktree, 'メモを更新する', { [HANDOFF_PATH]: '# 別のworktreeのメモ\n' }, '2020-11-18T09:00:00+09:00');

  const committed = await readRepository(git, { name: 'repo', path: repo.dir });
  assert.deepEqual(committed.handoff, {
    worktreePath: worktree, branch: 'feat/x', path: HANDOFF_PATH, updatedAt: '2020-11-18T09:00:00+09:00', uncommitted: false,
    markdown: '# 別のworktreeのメモ\n', truncated: false,
  });

  // 本体のメモを書き換えて、まだコミットしていない。
  repo.write(HANDOFF_PATH, '# 書きかけのメモ\n');
  const changed = await readRepository(git, { name: 'repo', path: repo.dir });
  assert.equal(changed.handoff?.worktreePath, repo.dir);
  assert.equal(changed.handoff?.uncommitted, true);
  assert.equal(changed.handoff?.markdown, '# 書きかけのメモ\n');
  assert.ok(Date.parse(changed.handoff?.updatedAt ?? '') > Date.parse('2020-11-18T09:00:00+09:00'));
});

test('引き継ぎメモは上限で切り、リンクやworktreeの外を指すものは読まない', async (t) => {
  const repo = createRepository(t);
  // 3バイトの文字を並べ、上限が文字の途中に来るようにする。
  const long = 'あ'.repeat(Math.ceil(MAX_HANDOFF_BYTES / 3) + 10);
  repo.commit('長いメモ', { [HANDOFF_PATH]: long });
  const truncated = await readRepository(git, { name: 'repo', path: repo.dir });
  assert.equal(truncated.handoff?.truncated, true);
  assert.ok(Buffer.byteLength(truncated.handoff?.markdown ?? '') <= MAX_HANDOFF_BYTES);
  assert.ok(long.startsWith(truncated.handoff?.markdown ?? '-'));
  assert.ok(!(truncated.handoff?.markdown ?? '').includes('�'));

  const outside = join(repo.root, 'secret.md');
  writeFileSync(outside, '# worktreeの外のファイル\n');
  rmSync(join(repo.dir, HANDOFF_PATH));
  symlinkSync(outside, join(repo.dir, HANDOFF_PATH));
  assert.equal((await readRepository(git, { name: 'repo', path: repo.dir })).handoff, undefined);

  // docs/ ごとworktreeの外を指している場合も読まない。
  rmSync(join(repo.dir, 'docs'), { recursive: true });
  mkdirSync(join(repo.root, 'elsewhere'));
  writeFileSync(join(repo.root, 'elsewhere', 'HANDOFF.md'), '# 外のメモ\n');
  symlinkSync(join(repo.root, 'elsewhere'), join(repo.dir, 'docs'));
  assert.equal((await readRepository(git, { name: 'repo', path: repo.dir })).handoff, undefined);
});

test('読めないリポジトリ・worktreeは、理由だけを返す', async (t) => {
  const root = temporaryDirectory(t);
  assert.deepEqual(await readRepository(git, { name: 'missing', path: join(root, 'missing') }),
    { name: 'missing', path: join(root, 'missing'), error: 'not_found', worktrees: [], omittedWorktrees: 0 });
  const plain = join(root, 'plain');
  mkdirSync(plain);
  assert.equal((await readRepository(git, { name: 'plain', path: plain })).error, 'not_repository');

  // コミットがまだないリポジトリは、コミットなしとして読む。
  const empty = createRepository(t);
  const initial = await readRepository(git, { name: 'empty', path: empty.dir });
  assert.equal(initial.error, undefined);
  assert.deepEqual(initial.worktrees[0]?.commits, []);
  assert.equal(initial.lastActivityAt, undefined);

  // ディレクトリが消えたworktreeは、そのworktreeだけを読めないものとして返す。
  const repo = createRepository(t);
  repo.commit('最初のコミット', { 'a.txt': 'a\n' });
  const worktree = join(repo.root, 'wt');
  repo.git('worktree', 'add', '-q', '-b', 'feat/x', worktree);
  rmSync(worktree, { recursive: true });
  const pruned = await readRepository(git, { name: 'repo', path: repo.dir });
  assert.deepEqual(pruned.worktrees.map((item) => [item.branch, item.error]), [['main', undefined], ['feat/x', 'not_found']]);
});

test('表示のためだけに外部のプログラムを動かす設定を止め、インデックスも書き換えない', async (t) => {
  const repo = createRepository(t);
  repo.commit('最初のコミット', { 'a.txt': 'a\n' });
  // 署名付きのコミットを作り、表示するときに署名の検証（gpg.program）が呼ばれる状態にする。
  // 準備に使う通常のgitもfsmonitorを呼ぶため、外部のプログラムの設定は準備の後で入れる。
  const tree = repo.git('write-tree').trim();
  const parent = repo.git('rev-parse', 'HEAD').trim();
  const signed = execFileSync('git', ['-C', repo.dir, 'hash-object', '-t', 'commit', '-w', '--stdin'], {
    env: SETUP_ENV, encoding: 'utf8',
    input: `tree ${tree}\nparent ${parent}\nauthor test <test@example.invalid> 1763424000 +0900\ncommitter test <test@example.invalid> 1763424000 +0900\n`
      + 'gpgsig -----BEGIN PGP SIGNATURE-----\n \n iQEzBAABCAAdFiEE\n -----END PGP SIGNATURE-----\n\n署名付きのコミット\n',
  }).trim();
  repo.git('update-ref', 'refs/heads/main', signed);
  const marker = (name: string) => join(repo.root, `${name}-ran`);
  for (const name of ['fsmonitor', 'gpg']) {
    writeFileSync(join(repo.root, `${name}.sh`), `#!/bin/sh\ntouch '${marker(name)}'\nexit 1\n`);
    chmodSync(join(repo.root, `${name}.sh`), 0o755);
  }
  repo.git('config', 'core.fsmonitor', join(repo.root, 'fsmonitor.sh'));
  repo.git('config', 'log.showSignature', 'true');
  repo.git('config', 'gpg.program', join(repo.root, 'gpg.sh'));
  // ファイルの更新日時だけを変え、通常のstatusならインデックスを書き直す状態にする。
  const index = join(repo.dir, '.git', 'index');
  utimesSync(index, new Date('2020-01-01T00:00:00Z'), new Date('2020-01-01T00:00:00Z'));
  utimesSync(join(repo.dir, 'a.txt'), new Date(), new Date());

  const status = await readRepository(git, { name: 'repo', path: repo.dir });
  assert.equal(status.worktrees[0]?.commits[0]?.subject, '署名付きのコミット');
  assert.equal(existsSync(marker('fsmonitor')), false);
  assert.equal(existsSync(marker('gpg')), false);
  assert.equal(statSync(index).mtime.toISOString(), '2020-01-01T00:00:00.000Z');

  // 同じ設定の通常のgitでは、どれも起きることを確かめる（検査が意味を持つことの確認）。
  execFileSync('git', ['-C', repo.dir, 'status', '--porcelain=v2'], { env: SETUP_ENV, stdio: 'ignore' });
  execFileSync('git', ['-C', repo.dir, 'log', '-1', '--format=%s'], { env: SETUP_ENV, stdio: 'ignore' });
  assert.equal(existsSync(marker('fsmonitor')), true);
  assert.equal(existsSync(marker('gpg')), true);
  assert.notEqual(statSync(index).mtime.toISOString(), '2020-01-01T00:00:00.000Z');
});

test('gitへはPATHだけを引き継ぎ、呼び出し元のGitの環境変数や利用者全体の設定を使わない', () => {
  assert.deepEqual(gitEnv('/usr/bin'),
    { PATH: '/usr/bin', LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: '' });
});

test('gitの実行は時間で打ち切り、同時に動かす数を制限する', async (t) => {
  const bin = temporaryDirectory(t);
  const log = join(bin, 'calls.log');
  // 本物のgitの代わりに、開始と終了を記録して少し待つだけのスクリプトを置く。
  writeFileSync(join(bin, 'git'), `#!/bin/sh\necho start >> '${log}'\nsleep 0.2\necho end >> '${log}'\n`);
  chmodSync(join(bin, 'git'), 0o755);
  const limited: GitRunner = createGitRunner({ path: `${bin}:/usr/bin:/bin`, concurrency: 2 });
  await Promise.all(Array.from({ length: 6 }, () => limited(bin, ['status'])));
  let running = 0;
  let peak = 0;
  for (const line of readFileSync(log, 'utf8').trim().split('\n')) {
    running += line === 'start' ? 1 : -1;
    peak = Math.max(peak, running);
  }
  assert.equal(peak, 2);

  // execで置き換え、打ち切ったときに出力の管を持つプロセスが残らないようにする。
  writeFileSync(join(bin, 'git'), '#!/bin/sh\nexec sleep 5\n');
  const slow = createGitRunner({ path: `${bin}:/usr/bin:/bin`, timeoutMs: 100 });
  await assert.rejects(slow(bin, ['status']), (error) => error instanceof GitError && error.code === 'timeout');
});

test('worktreeの数の上限を超えた分は、数だけを返す', async (t) => {
  const root = temporaryDirectory(t);
  const list = Array.from({ length: MAX_WORKTREES + 2 }, (_, index) => `worktree ${root}/wt${index}\nHEAD ${'a'.repeat(40)}\nbranch refs/heads/b${index}\n`).join('\n');
  for (let index = 0; index < MAX_WORKTREES + 2; index++) mkdirSync(join(root, `wt${index}`));
  const fake: GitRunner = async (cwd, args) => {
    // どのworktreeも、同じリポジトリの本体（root）に属する最上位のディレクトリだと答える。
    if (args[0] === 'rev-parse') return revParse(root, cwd, args);
    if (args[0] === 'worktree') return list;
    if (args[0] === 'status') return '# branch.oid (initial)\0# branch.head b0\0';
    throw new GitError('git_failed');
  };
  const status = await readRepository(fake, { name: 'repo', path: root });
  assert.deepEqual(status.worktrees.map((item) => item.error), Array.from({ length: MAX_WORKTREES }, () => undefined));
  assert.equal(status.worktrees.length, MAX_WORKTREES);
  assert.equal(status.omittedWorktrees, 2);
});

test('statusの出力から、名前の変更・衝突・未追跡を数え、ファイルの一覧は上限で切る', () => {
  const fields = [
    '# branch.oid 1111111111111111111111111111111111111111', '# branch.head feat/x', '# branch.upstream origin/feat/x', '# branch.ab +2 -3',
    '2 R. N... 100644 100644 100644 aaaa aaaa R100 新しい名前.md', '古い名前.md',
    'u UU N... 100644 100644 100644 100644 aaaa bbbb cccc 衝突 した.txt',
    ...Array.from({ length: MAX_FILES + 1 }, (_, index) => `? 未追跡${index}.txt`),
  ];
  const status = parseStatus(`${fields.join('\0')}\0`);
  assert.equal(status.branch, 'feat/x');
  assert.deepEqual(status.upstream, { name: 'origin/feat/x', ahead: 2, behind: 3 });
  assert.deepEqual(status.changes.files.slice(0, 2), [{ status: 'R.', path: '新しい名前.md' }, { status: 'UU', path: '衝突 した.txt' }]);
  assert.deepEqual([status.changes.staged, status.changes.unstaged, status.changes.conflicted, status.changes.untracked], [1, 0, 1, MAX_FILES + 1]);
  assert.equal(status.changes.files.length, MAX_FILES);
  assert.equal(status.changes.omittedFiles, 3);
  assert.equal(parseStatus('# branch.oid (initial)\0# branch.head (detached)\0').branch, undefined);
});

test('originのURLからは、GitHubの所有者と名前だけを取り出す', () => {
  for (const url of ['https://github.com/example/inui.git', 'https://github.com/example/inui', 'https://github.com/example/inui/',
    'git@github.com:example/inui.git', 'ssh://git@github.com/example/inui.git', 'https://x-access-token:secret@github.com/example/inui.git']) {
    assert.deepEqual(parseGitHubRemote(url), { owner: 'example', name: 'inui' }, url);
  }
  for (const url of ['https://gitlab.com/example/inui.git', 'https://github.example.com/example/inui.git', 'https://github.com/example',
    'https://github.com/example/inui/extra', 'https://github.com/ex ample/inui', '/root/develop/inui']) {
    assert.equal(parseGitHubRemote(url), undefined, url);
  }
});

test('未追跡のディレクトリの中のファイルも1件ずつ数え、新しく作った引き継ぎメモを未コミットとして読む', async (t) => {
  const repo = createRepository(t);
  repo.commit('最初のコミット', { 'a.txt': 'a\n' });
  // docs/ ごと未追跡（新しく作った引き継ぎメモ）と、ファイルが3つある未追跡のディレクトリ。
  repo.write(HANDOFF_PATH, '# 新しいメモ\n');
  for (const name of ['1', '2', '3']) repo.write(`notes/${name}.md`, name);
  const status = await readRepository(git, { name: 'repo', path: repo.dir });
  const changes = status.worktrees[0]?.changes;
  assert.equal(changes?.untracked, 4);
  assert.deepEqual(changes?.files.map((file) => file.path).sort(), [HANDOFF_PATH, 'notes/1.md', 'notes/2.md', 'notes/3.md']);
  assert.equal(status.handoff?.uncommitted, true);
  assert.equal(status.handoff?.markdown, '# 新しいメモ\n');
});

test('確かめた後に docs がworktreeの外へのリンクに差し替えられても、外の本文は読まない', async (t) => {
  const root = temporaryDirectory(t);
  const worktree = join(root, 'wt');
  mkdirSync(join(worktree, 'docs'), { recursive: true });
  writeFileSync(join(worktree, HANDOFF_PATH), '# worktreeのメモ\n');
  mkdirSync(join(root, 'outside'));
  writeFileSync(join(root, 'outside', 'HANDOFF.md'), '# worktreeの外の本文\n');
  // メモを確かめた後の git log の間に、docs を外へのリンクに差し替える。
  const fake: GitRunner = async (cwd, args) => {
    if (args[0] === 'rev-parse') return revParse(worktree, cwd, args);
    if (args[0] === 'worktree') return `worktree ${worktree}\nHEAD ${'a'.repeat(40)}\nbranch refs/heads/main\n`;
    if (args[0] === 'status') return `# branch.oid ${'a'.repeat(40)}\0# branch.head main\0`;
    if (args[0] === 'log' && args.includes(HANDOFF_PATH)) {
      rmSync(join(worktree, 'docs'), { recursive: true });
      symlinkSync(join(root, 'outside'), join(worktree, 'docs'));
      return '2026-11-19T09:00:00+09:00\n';
    }
    if (args[0] === 'log') return '';
    throw new GitError('git_failed');
  };
  const status = await readRepository(fake, { name: 'wt', path: worktree });
  // リポジトリとworktreeは読めていて、メモだけを読まない。
  assert.deepEqual(status.worktrees.map((item) => [item.path, item.error]), [[worktree, undefined]]);
  assert.equal(status.handoff, undefined);
});

test('iノードが同じでも、worktreeの外を指すリンクを経て開いたファイルは読まない（Linux）', { skip: process.platform !== 'linux' }, async (t) => {
  const root = temporaryDirectory(t);
  const worktree = join(root, 'wt');
  mkdirSync(join(worktree, 'docs'), { recursive: true });
  writeFileSync(join(worktree, HANDOFF_PATH), '# worktreeのメモ\n');
  // 外にも同じファイル（同じiノード）を置き、確かめた後に docs を外へのリンクに差し替える。
  // 開くファイルのiノードは確かめたものと同じになるため、iノードの比較だけでは外の場所から開いたことが分からない。
  mkdirSync(join(root, 'outside'));
  linkSync(join(worktree, HANDOFF_PATH), join(root, 'outside', 'HANDOFF.md'));
  const fake: GitRunner = async (cwd, args) => {
    if (args[0] === 'rev-parse') return revParse(worktree, cwd, args);
    if (args[0] === 'worktree') return `worktree ${worktree}\nHEAD ${'a'.repeat(40)}\nbranch refs/heads/main\n`;
    if (args[0] === 'status') return `# branch.oid ${'a'.repeat(40)}\0# branch.head main\0`;
    if (args[0] === 'log' && args.includes(HANDOFF_PATH)) {
      rmSync(join(worktree, 'docs'), { recursive: true });
      symlinkSync(join(root, 'outside'), join(worktree, 'docs'));
      return '2026-11-19T09:00:00+09:00\n';
    }
    if (args[0] === 'log') return '';
    throw new GitError('git_failed');
  };
  const status = await readRepository(fake, { name: 'wt', path: worktree });
  assert.deepEqual(status.worktrees.map((item) => [item.path, item.error]), [[worktree, undefined]]);
  assert.equal(status.handoff, undefined);
});

test('確かめた後にメモがFIFOへ差し替えられても、開くところで止まらず、メモを読まない', { skip: process.platform === 'win32' }, async (t) => {
  const root = temporaryDirectory(t);
  const worktree = join(root, 'wt');
  const fifo = join(worktree, HANDOFF_PATH);
  mkdirSync(join(worktree, 'docs'), { recursive: true });
  writeFileSync(fifo, '# worktreeのメモ\n');
  const fake: GitRunner = async (cwd, args) => {
    if (args[0] === 'rev-parse') return revParse(worktree, cwd, args);
    if (args[0] === 'worktree') return `worktree ${worktree}\nHEAD ${'a'.repeat(40)}\nbranch refs/heads/main\n`;
    if (args[0] === 'status') return `# branch.oid ${'a'.repeat(40)}\0# branch.head main\0`;
    if (args[0] === 'log' && args.includes(HANDOFF_PATH)) {
      rmSync(fifo);
      execFileSync('mkfifo', [fifo]);
      return '2026-11-19T09:00:00+09:00\n';
    }
    if (args[0] === 'log') return '';
    throw new GitError('git_failed');
  };
  // 書き手が現れるまで開くところで止まった場合は、書き手として開いて止まりを解き、テストを終わらせる。
  let blocked = false;
  const timer = setTimeout(() => {
    blocked = true;
    try {
      closeSync(openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK));
    } catch {
      // 読み手がいなければ開けない。止まっていないため、そのままでよい。
    }
  }, 5_000);
  try {
    const status = await readRepository(fake, { name: 'wt', path: worktree });
    assert.equal(blocked, false);
    assert.deepEqual(status.worktrees.map((item) => [item.path, item.error]), [[worktree, undefined]]);
    assert.equal(status.handoff, undefined);
  } finally {
    clearTimeout(timer);
  }
});

test('パスの途中に改行や空行があるworktreeは、切れたパスや別の場所を読まない', async (t) => {
  const root = temporaryDirectory(t);
  mkdirSync(join(root, 'main'));
  const statusCalls: string[] = [];
  // git 2.34 には -z がなく、改行を含むパスの続きは別の行に、空行を含むパスの続きは別のworktreeに見える。
  const list = `worktree ${root}/main\nHEAD ${'a'.repeat(40)}\nbranch refs/heads/main\n\n`
    + `worktree ${root}/wt\nnext\nHEAD ${'b'.repeat(40)}\nbranch refs/heads/feat/x\n\n`
    + `worktree ${root}/a\n\nworktree ${root}/elsewhere\nHEAD ${'c'.repeat(40)}\nbranch refs/heads/feat/y\n`;
  const fake: GitRunner = async (cwd, args) => {
    // 本体だけがこのリポジトリに属し、切れたパスや別の場所は別のリポジトリ（または存在しない）と答える。
    if (args[0] === 'rev-parse') {
      if (cwd === root || cwd === `${root}/main`) return revParse(`${root}/main`, cwd, args);
      throw new GitError('not_repository');
    }
    if (args[0] === 'worktree') return list;
    if (args[0] === 'status') { statusCalls.push(cwd); return '# branch.oid (initial)\0# branch.head main\0'; }
    throw new GitError('git_failed');
  };
  const status = await readRepository(fake, { name: 'repo', path: root });
  assert.deepEqual(status.worktrees.map((item) => [item.path, item.error]), [
    [`${root}/main`, undefined], [`${root}/wt`, 'git_failed'], [`${root}/a`, 'not_repository'], [`${root}/elsewhere`, 'not_repository'],
  ]);
  assert.deepEqual(statusCalls, [`${root}/main`]);
});

test('パスに改行と属性の名前を含むworktreeがあっても、切れたパスにある別のリポジトリは読まない', async (t) => {
  const repo = createRepository(t);
  repo.commit('最初のコミット', { 'a.txt': 'a\n' });
  // 一覧では「worktree …/wt」と「locked」の2行に見える。
  const tricky = join(repo.root, 'wt\nlocked');
  repo.git('worktree', 'add', '-q', '-b', 'feat/x', tricky);
  // 切れたパス（…/wt）には、別のリポジトリを置く。
  const other = join(repo.root, 'wt');
  mkdirSync(other);
  execFileSync('git', ['-C', other, 'init', '-q', '-b', 'main'], { env: SETUP_ENV });
  execFileSync('git', ['-C', other, 'commit', '-q', '--allow-empty', '-m', '別のリポジトリ'], { env: SETUP_ENV });
  const status = await readRepository(git, { name: 'repo', path: repo.dir });
  assert.deepEqual(status.worktrees.map((item) => [item.path, item.error]), [[repo.dir, undefined], [other, 'not_repository']]);
  assert.ok(!JSON.stringify(status).includes('別のリポジトリ'));
});

test('パスに改行を含むworktreeが切れて同じリポジトリのサブディレクトリを指しても、そこを読まない', async (t) => {
  const repo = createRepository(t);
  repo.commit('最初のコミット', { 'sub/a.txt': 'a\n' });
  // 一覧では「worktree …/repo/sub」と「locked」の2行に見え、切れたパスは本体のworktreeの中のディレクトリになる。
  repo.git('worktree', 'add', '-q', '-b', 'feat/x', join(repo.dir, 'sub\nlocked'));
  repo.write('b.txt', 'b\n');
  const status = await readRepository(git, { name: 'repo', path: repo.dir });
  const sub = join(repo.dir, 'sub');
  assert.deepEqual(status.worktrees.map((item) => [item.path, item.error]), [[repo.dir, undefined], [sub, 'not_repository']]);
  // 本体の変更を、切れたパスの変更として返さない。
  assert.deepEqual(status.worktrees[1]?.changes.files, []);
});

test('切れたパスにある別のリポジトリの本体のパスに改行があっても、出力の行のずれで登録したリポジトリと取り違えない', async (t) => {
  const repo = createRepository(t);
  repo.commit('最初のコミット', { 'a.txt': 'a\n' });
  // 一覧では「worktree …/wt」と「locked」の2行に見える。
  repo.git('worktree', 'add', '-q', '-b', 'feat/x', join(repo.root, 'wt\nlocked'));
  // 切れたパス（…/wt）に、本体のパスが「…/link」と「…/wt」の2行に見える別のリポジトリを置く。
  // …/link は登録したリポジトリの .git へのリンクにし、rev-parse の出力の先頭2行だけを比べると一致する形にする。
  const other = join(repo.root, 'wt');
  const link = join(repo.root, 'link');
  symlinkSync(join(repo.dir, '.git'), link);
  const otherGitDir = `${link}\n${other}`;
  mkdirSync(dirname(otherGitDir), { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', '--separate-git-dir', otherGitDir, other], { env: SETUP_ENV });
  execFileSync('git', ['-C', other, 'commit', '-q', '--allow-empty', '-m', '別のリポジトリ'], { env: SETUP_ENV });
  const status = await readRepository(git, { name: 'repo', path: repo.dir });
  assert.deepEqual(status.worktrees.map((item) => [item.path, item.error]), [[repo.dir, undefined], [other, 'not_repository']]);
  assert.ok(!JSON.stringify(status).includes('別のリポジトリ'));
});

test('リポジトリの設定に関わらず、コミットの件名をUTF-8で読む', async (t) => {
  const repo = createRepository(t);
  // Latin-1で表せる文字だけにする（表せない文字があると、gitは変換をあきらめてUTF-8のまま出す）。
  repo.commit('café crème', { 'a.txt': 'a\n' });
  repo.git('config', 'i18n.logOutputEncoding', 'ISO-8859-1');
  const status = await readRepository(git, { name: 'repo', path: repo.dir });
  assert.equal(status.worktrees[0]?.commits[0]?.subject, 'café crème');
});

test('ignore対象で status に出ない新しい引き継ぎメモも、未コミットとして読む', async (t) => {
  const repo = createRepository(t);
  repo.commit('メモをignoreする', { '.gitignore': `${HANDOFF_PATH}\n` });
  repo.write(HANDOFF_PATH, '# ignoreされたメモ\n');
  const status = await readRepository(git, { name: 'repo', path: repo.dir });
  assert.deepEqual(status.worktrees[0]?.changes.files, []);
  assert.equal(status.handoff?.uncommitted, true);
  assert.equal(status.handoff?.markdown, '# ignoreされたメモ\n');
});

test('引き継ぎメモの履歴を読めなかったworktreeは、未コミットとして扱わず、メモの候補にしない', async (t) => {
  const root = temporaryDirectory(t);
  for (const [name, memo] of [['main', '# 本体のメモ\n'], ['wt', '# 古いメモ\n']] as const) {
    mkdirSync(join(root, name, 'docs'), { recursive: true });
    writeFileSync(join(root, name, HANDOFF_PATH), memo);
  }
  const sha = 'a'.repeat(40);
  const fake: GitRunner = async (cwd, args) => {
    if (args[0] === 'rev-parse') return revParse(`${root}/main`, cwd, args);
    if (args[0] === 'worktree') {
      return `worktree ${root}/main\nHEAD ${sha}\nbranch refs/heads/main\n\nworktree ${root}/wt\nHEAD ${sha}\nbranch refs/heads/feat/x\n`;
    }
    if (args[0] === 'status') return `# branch.oid ${sha}\0# branch.head main\0`;
    if (args[0] === 'log' && args.includes(HANDOFF_PATH)) {
      // 本体のメモは過去にコミットしたもの。worktreeのメモ（今日checkoutした古いもの）は、履歴の読み取りが時間切れになる。
      if (cwd === `${root}/main`) return '2026-11-01T09:00:00+09:00\n';
      throw new GitError('timeout');
    }
    if (args[0] === 'log') return '';
    throw new GitError('git_failed');
  };
  const status = await readRepository(fake, { name: 'repo', path: `${root}/main` });
  assert.equal(status.handoff?.worktreePath, `${root}/main`);
  assert.equal(status.handoff?.uncommitted, false);
  assert.equal(status.handoff?.markdown, '# 本体のメモ\n');
});

test('部分クローンで足りないオブジェクトがあっても取りに行かず（通信せず）、リポジトリに書き込まない', async (t) => {
  const source = createRepository(t);
  source.commit('メモを書く', { [HANDOFF_PATH]: '# 最初のメモ\n' });
  source.commit('別のファイルを足す', { 'a.txt': 'a\n' });
  source.git('config', 'uploadpack.allowFilter', 'true');
  // treeを持たない部分クローン。最新のコミットのtreeだけはcheckoutで取得し、メモの履歴をたどるのに要る古いtreeは持たない。
  const clone = join(source.root, 'clone');
  execFileSync('git', ['clone', '-q', '--filter=tree:0', `file://${source.dir}`, clone], { env: SETUP_ENV });
  // リポジトリの設定でプロトコルごとに許可していても（protocol.allow より優先される）、通信しない。
  execFileSync('git', ['-C', clone, 'config', 'protocol.file.allow', 'always'], { env: SETUP_ENV });
  const packs = () => readdirSync(join(clone, '.git', 'objects', 'pack')).sort();
  const before = packs();
  const status = await readRepository(git, { name: 'clone', path: clone });
  assert.deepEqual(packs(), before);
  assert.equal(status.worktrees[0]?.error, undefined);
  // 履歴を読めないメモは選ばない。
  assert.equal(status.handoff, undefined);
});
