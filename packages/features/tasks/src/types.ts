/**
 * 自分のタスクの看板の列。Todo表示のチェックは、完了（done）と未着手（todo）の切り替えになる。
 * GitHubのIssue・PRは看板に載せず、参照だけにする。
 */
export const TASK_STATUSES = ['todo', 'doing', 'done'] as const;
export type TaskStatus = typeof TASK_STATUSES[number];

/** inuiの中で自由に作るタスク。doneはstatusがdoneかどうかを表す（Todo表示用）。 */
export interface LocalTask {
  id: string;
  title: string;
  status: TaskStatus;
  done: boolean;
  createdAt: string;
}

export type GitHubReason = 'assigned' | 'authored' | 'review_requested';

/** GitHubから読み取ったIssue・PR。inuiでは保存・更新しない。 */
export interface ExternalTask {
  id: string;
  source: 'github';
  kind: 'issue' | 'pull_request';
  key: string;
  title: string;
  url: string;
  updatedAt: string;
  reasons?: GitHubReason[];
}

/** GitHubの取得結果。設定がなければ取得せず、未設定であることだけを返す。 */
export type ExternalResult =
  | { configured: false }
  | { configured: true; tasks: ExternalTask[] };

export const MAX_TITLE_LENGTH = 200;
