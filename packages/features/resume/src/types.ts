/** 作業の再開画面に出す、登録したリポジトリの状況。リポジトリが未登録なら、未登録であることだけを返す。 */
export type ResumeResult =
  | { configured: false }
  | { configured: true; github: GitHubState; repositories: RepositoryStatus[] };

export type UpstreamErrorCode = 'upstream_auth' | 'upstream_unavailable' | 'upstream_timeout' | 'upstream_invalid';

/** GitHubから自分のPRを読めたか。失敗しても、手元のgitの状況は返す。 */
export type GitHubState =
  | { status: 'not_configured' }
  | { status: 'ok' }
  | { status: 'error'; code: 'invalid_config' | UpstreamErrorCode };

/** gitで読めなかった理由。パスや例外の本文は返さない。 */
export type GitErrorCode = 'not_found' | 'not_repository' | 'unsafe_repository' | 'git_failed' | 'timeout';

export interface RepositoryStatus {
  /** 表示名（登録したパスの最後の部分）。 */
  name: string;
  path: string;
  error?: GitErrorCode;
  /** 各worktreeのHEADのコミット日時のうち、最も新しいもの。並び順に使う。 */
  lastActivityAt?: string;
  /** originがGitHubのリポジトリなら、その所有者と名前。 */
  github?: { owner: string; name: string };
  worktrees: WorktreeStatus[];
  /** 上限を超えて表示しなかったworktreeの数。 */
  omittedWorktrees: number;
  /** worktreeのうち、最も新しく更新された引き継ぎメモ。 */
  handoff?: Handoff;
  /** 自分が作った未完了のPR（20件まで）。GitHubから読めた場合だけ入る。 */
  pullRequests?: PullRequestStatus[];
  /** 上限を超えて表示しなかったPRの数。pullRequestsと一緒に入る。 */
  omittedPullRequests?: number;
}

export interface WorktreeStatus {
  path: string;
  /** ブランチ名。detached HEADのときはない。 */
  branch?: string;
  error?: GitErrorCode;
  upstream?: { name: string; ahead: number; behind: number };
  changes: ChangeSummary;
  /** 新しい順に、最大5件。 */
  commits: CommitSummary[];
}

export interface ChangeSummary {
  staged: number;
  unstaged: number;
  untracked: number;
  conflicted: number;
  /** 変更のあるファイル（git status の2文字の状態と、リポジトリからの相対パス）。 */
  files: { status: string; path: string }[];
  /** 上限を超えて表示しなかったファイルの数。 */
  omittedFiles: number;
}

export interface CommitSummary {
  sha: string;
  committedAt: string;
  subject: string;
}

export interface Handoff {
  /** メモを読んだworktree。 */
  worktreePath: string;
  branch?: string;
  /** リポジトリの中の場所（docs/HANDOFF.md）。 */
  path: string;
  /** 未コミットの変更があればファイルの更新日時、なければ最後にコミットした日時。 */
  updatedAt: string;
  uncommitted: boolean;
  markdown: string;
  /** 上限を超えた分を省いたか。 */
  truncated: boolean;
}

export interface PullRequestStatus {
  number: number;
  title: string;
  url: string;
  branch: string;
  draft: boolean;
  review: 'approved' | 'changes_requested' | 'review_required' | 'none';
  /** 最新のコミットのチェック（CI）の結果。トークンの権限が足りずに読めない場合はunknown。 */
  checks: 'success' | 'failure' | 'pending' | 'none' | 'unknown';
  updatedAt: string;
}
