import { execFile } from 'node:child_process';
import type { ExecFileException } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, realpath, stat } from 'node:fs/promises';
import { join, sep } from 'node:path';
import type { Repository } from './config.ts';
import type { ChangeSummary, CommitSummary, GitErrorCode, Handoff, RepositoryStatus, WorktreeStatus } from './types.ts';

/** 1回のgitの実行の上限時間・出力量と、同時に動かす数。 */
const TIMEOUT_MS = 5000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const CONCURRENCY = 8;
/** 1つのリポジトリ・worktreeで表示する数の上限。 */
export const MAX_WORKTREES = 8;
export const MAX_FILES = 30;
const MAX_COMMITS = 5;
const MAX_SUBJECT_LENGTH = 200;
/** 引き継ぎメモの場所（AGENTS.mdの決まり）と、読む大きさの上限。 */
export const HANDOFF_PATH = 'docs/HANDOFF.md';
export const MAX_HANDOFF_BYTES = 64 * 1024;
const SHA = /^[0-9a-f]{40,64}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
// originのURLからGitHubの所有者と名前だけを取り出す。URLに認証情報が含まれていても、それは使わない。
const GITHUB_REMOTE = /^(?:https:\/\/(?:[^@/\s]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100}?)(?:\.git)?\/?$/;

/** gitで読めなかった理由。パスや標準エラーの本文は保持しない。 */
export class GitError extends Error {
  readonly code: GitErrorCode;
  constructor(code: GitErrorCode) {
    super(code);
    this.name = 'GitError';
    this.code = code;
  }
}

/** 読み取り専用のgitのコマンドを、決まった引数で実行して標準出力を返す。 */
export type GitRunner = (cwd: string, args: readonly string[]) => Promise<string>;

/**
 * gitへ渡す環境変数。呼び出し元の変数（GIT_DIR・GIT_CONFIG_*・HOME等）でリポジトリや設定を
 * 差し替えられないよう、PATHだけを引き継ぐ。HOMEも渡さないため、利用者全体の設定（~/.gitconfig）は読まない。
 */
export function gitEnv(path: string): Record<string, string> {
  return { PATH: path, LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' };
}

function errorCode(error: ExecFileException, stderr: string): GitErrorCode {
  if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return 'git_failed';
  if (error.killed) return 'timeout';
  if (/not a git repository/i.test(stderr)) return 'not_repository';
  if (/dubious ownership/i.test(stderr)) return 'unsafe_repository';
  if (/cannot change to/i.test(stderr)) return 'not_found';
  return 'git_failed';
}

/**
 * gitを読み取り専用で動かす。
 * - シェルを使わず、引数を配列で渡す。
 * - 表示のためだけに外部のプログラムが動く設定（fsmonitor、署名の検証）を止め、インデックスも書き換えない。
 * - 1回の実行の時間・出力量と、同時に動かす数に上限を設ける。
 */
export function createGitRunner({ path = process.env.PATH ?? '', timeoutMs = TIMEOUT_MS, concurrency = CONCURRENCY }: {
  path?: string;
  timeoutMs?: number;
  concurrency?: number;
} = {}): GitRunner {
  const env = gitEnv(path);
  let running = 0;
  const waiting: (() => void)[] = [];
  // 空きを待っていた実行には、終わった実行の枠をそのまま渡す。
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else running--;
  };
  return async (cwd, args) => {
    if (running < concurrency) running++;
    else await new Promise<void>((resolve) => { waiting.push(resolve); });
    try {
      return await new Promise<string>((resolve, reject) => {
        execFile('git', ['--no-pager', '-C', cwd, '-c', 'core.fsmonitor=false', '-c', 'log.showSignature=false', ...args],
          { env, timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES, encoding: 'utf8', windowsHide: true },
          (error, stdout, stderr) => {
            if (error) reject(new GitError(errorCode(error, stderr)));
            else resolve(stdout);
          });
      });
    } finally {
      release();
    }
  };
}

const codeOf = (error: unknown): GitErrorCode => error instanceof GitError ? error.code : 'git_failed';
const emptyChanges = (): ChangeSummary => ({ staged: 0, unstaged: 0, untracked: 0, conflicted: 0, files: [], omittedFiles: 0 });

interface WorktreeEntry {
  path: string;
  branch?: string;
  bare: boolean;
  prunable: boolean;
}

/** `git worktree list --porcelain` の出力を読む。最初が本体のworktree。 */
export function parseWorktrees(output: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  for (const block of output.split('\n\n')) {
    const [first, ...rest] = block.split('\n').filter((line) => line.length > 0);
    if (!first?.startsWith('worktree ')) continue;
    const entry: WorktreeEntry = { path: first.slice('worktree '.length), bare: false, prunable: false };
    for (const line of rest) {
      if (line.startsWith('branch refs/heads/')) entry.branch = line.slice('branch refs/heads/'.length);
      else if (line === 'bare') entry.bare = true;
      else if (line === 'prunable' || line.startsWith('prunable ')) entry.prunable = true;
    }
    entries.push(entry);
  }
  return entries;
}

interface StatusResult {
  /** まだコミットがない。 */
  initial: boolean;
  branch?: string;
  upstream?: { name: string; ahead: number; behind: number };
  changes: ChangeSummary;
  /** 引き継ぎメモに未コミットの変更がある。 */
  handoffChanged: boolean;
}

/** `git status --porcelain=v2 --branch -z` の出力を読む。 */
export function parseStatus(output: string): StatusResult {
  const changes = emptyChanges();
  const result: StatusResult = { initial: false, changes, handoffChanged: false };
  let upstream: string | undefined;
  let aheadBehind: [number, number] | undefined;
  const add = (status: string, path: string) => {
    if (path === HANDOFF_PATH) result.handoffChanged = true;
    if (changes.files.length < MAX_FILES) changes.files.push({ status, path });
    else changes.omittedFiles++;
  };
  const fields = output.split('\0');
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index] ?? '';
    if (field.startsWith('# branch.oid ')) {
      result.initial = field === '# branch.oid (initial)';
    } else if (field.startsWith('# branch.head ')) {
      const head = field.slice('# branch.head '.length);
      if (head !== '(detached)') result.branch = head;
    } else if (field.startsWith('# branch.upstream ')) {
      upstream = field.slice('# branch.upstream '.length);
    } else if (field.startsWith('# branch.ab ')) {
      const match = /^# branch\.ab \+(\d+) -(\d+)$/.exec(field);
      if (match) aheadBehind = [Number(match[1]), Number(match[2])];
    } else if (field.startsWith('1 ') || field.startsWith('2 ')) {
      const parts = field.split(' ');
      const xy = parts[1] ?? '..';
      if (xy[0] !== '.') changes.staged++;
      if (xy[1] !== '.') changes.unstaged++;
      add(xy, parts.slice(field.startsWith('1 ') ? 8 : 9).join(' '));
      // 名前を変えたファイルは、元の名前が次の欄に続く。
      if (field.startsWith('2 ')) index++;
    } else if (field.startsWith('u ')) {
      const parts = field.split(' ');
      changes.conflicted++;
      add(parts[1] ?? 'UU', parts.slice(10).join(' '));
    } else if (field.startsWith('? ')) {
      changes.untracked++;
      add('??', field.slice(2));
    }
  }
  if (upstream !== undefined) result.upstream = { name: upstream, ahead: aheadBehind?.[0] ?? 0, behind: aheadBehind?.[1] ?? 0 };
  return result;
}

/** `git log --format=%H%x1f%cI%x1f%s -z` の出力を読む。形の合わない記録は捨てる。 */
export function parseLog(output: string): CommitSummary[] {
  const commits: CommitSummary[] = [];
  for (const record of output.split('\0')) {
    const [sha = '', committedAt = '', subject = ''] = record.replace(/^\n/, '').split('\x1f');
    if (!SHA.test(sha) || !TIMESTAMP.test(committedAt)) continue;
    commits.push({ sha, committedAt, subject: subject.slice(0, MAX_SUBJECT_LENGTH) });
  }
  return commits;
}

/** originのURLが github.com のリポジトリなら、その所有者と名前を返す。 */
export function parseGitHubRemote(url: string): { owner: string; name: string } | undefined {
  const match = GITHUB_REMOTE.exec(url.trim());
  if (!match?.[1] || !match[2]) return undefined;
  return { owner: match[1], name: match[2] };
}

interface WorktreeResult {
  status: WorktreeStatus;
  handoffChanged: boolean;
}

async function readWorktree(git: GitRunner, entry: WorktreeEntry): Promise<WorktreeResult> {
  const failed = (error: GitErrorCode): WorktreeResult => ({
    status: { path: entry.path, ...(entry.branch ? { branch: entry.branch } : {}), error, changes: emptyChanges(), commits: [] },
    handoffChanged: false,
  });
  // worktreeのディレクトリが消えている。
  if (entry.prunable) return failed('not_found');
  try {
    const status = parseStatus(await git(entry.path, ['status', '--porcelain=v2', '--branch', '-z', '--ignore-submodules=all']));
    const commits = status.initial ? [] : parseLog(await git(entry.path, ['log', `-n${MAX_COMMITS}`, '--format=%H%x1f%cI%x1f%s', '-z']));
    return {
      status: {
        path: entry.path, ...(status.branch ? { branch: status.branch } : {}), ...(status.upstream ? { upstream: status.upstream } : {}),
        changes: status.changes, commits,
      },
      handoffChanged: status.handoffChanged,
    };
  } catch (error) {
    return failed(codeOf(error));
  }
}

/**
 * worktreeの中の引き継ぎメモを返す。シンボリックリンクや、リンクでworktreeの外を指す場所にあるものは読まない。
 */
async function handoffFile(worktree: string): Promise<{ path: string; mtime: Date } | undefined> {
  const path = join(worktree, HANDOFF_PATH);
  try {
    const info = await lstat(path);
    if (!info.isFile()) return undefined;
    const [root, real] = await Promise.all([realpath(worktree), realpath(path)]);
    if (!real.startsWith(root + sep)) return undefined;
    return { path, mtime: info.mtime };
  } catch {
    return undefined;
  }
}

/** 上限までを読み、上限で切った位置が文字の途中なら壊れた末尾を除く。 */
async function readLimited(path: string): Promise<{ markdown: string; truncated: boolean }> {
  // 確かめた後にリンクへ差し替えられても、たどらない。
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const buffer = Buffer.alloc(MAX_HANDOFF_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const truncated = bytesRead > MAX_HANDOFF_BYTES;
    const text = new TextDecoder().decode(buffer.subarray(0, Math.min(bytesRead, MAX_HANDOFF_BYTES)));
    return { markdown: truncated ? text.replace(/�+$/, '') : text, truncated };
  } finally {
    await handle.close();
  }
}

/**
 * worktreeのうち、最も新しく更新された引き継ぎメモを読む。未コミットの変更があればファイルの更新日時、
 * なければ最後にコミットした日時で比べ、同じなら本体のworktreeを優先する。
 */
async function readHandoff(git: GitRunner, worktrees: readonly WorktreeResult[]): Promise<Handoff | undefined> {
  const candidates: { status: WorktreeStatus; path: string; updatedAt: string; uncommitted: boolean }[] = [];
  for (const { status, handoffChanged } of worktrees) {
    if (status.error) continue;
    const file = await handoffFile(status.path);
    if (!file) continue;
    let updatedAt = file.mtime.toISOString();
    if (!handoffChanged) {
      const committed = (await git(status.path, ['log', '-1', '--format=%cI', '--', HANDOFF_PATH]).catch(() => '')).trim();
      if (TIMESTAMP.test(committed)) updatedAt = committed;
    }
    candidates.push({ status, path: file.path, updatedAt, uncommitted: handoffChanged });
  }
  const latest = candidates.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
  if (!latest) return undefined;
  try {
    const { markdown, truncated } = await readLimited(latest.path);
    return {
      worktreePath: latest.status.path, ...(latest.status.branch ? { branch: latest.status.branch } : {}), path: HANDOFF_PATH,
      updatedAt: latest.updatedAt, uncommitted: latest.uncommitted, markdown, truncated,
    };
  } catch {
    return undefined;
  }
}

/** 登録したリポジトリの、worktreeごとの状況と引き継ぎメモを読む。読めない場合は理由だけを返す。 */
export async function readRepository(git: GitRunner, repository: Repository): Promise<RepositoryStatus> {
  const base: RepositoryStatus = { name: repository.name, path: repository.path, worktrees: [], omittedWorktrees: 0 };
  try {
    if (!(await stat(repository.path)).isDirectory()) return { ...base, error: 'not_found' };
  } catch {
    return { ...base, error: 'not_found' };
  }
  let entries: WorktreeEntry[];
  try {
    entries = parseWorktrees(await git(repository.path, ['worktree', 'list', '--porcelain']));
  } catch (error) {
    return { ...base, error: codeOf(error) };
  }
  // 作業ディレクトリのない本体（bare）は表示しない。
  const usable = entries.filter((entry) => !entry.bare);
  const results = await Promise.all(usable.slice(0, MAX_WORKTREES).map((entry) => readWorktree(git, entry)));
  const worktrees = results.map((result) => result.status);
  const github = await git(repository.path, ['config', '--get', 'remote.origin.url']).then(parseGitHubRemote, () => undefined);
  const lastActivityAt = worktrees.map((worktree) => worktree.commits[0]?.committedAt).filter((value) => value !== undefined)
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0];
  const handoff = await readHandoff(git, results);
  return {
    ...base, worktrees, omittedWorktrees: usable.length - results.length,
    ...(lastActivityAt ? { lastActivityAt } : {}), ...(github ? { github } : {}), ...(handoff ? { handoff } : {}),
  };
}
