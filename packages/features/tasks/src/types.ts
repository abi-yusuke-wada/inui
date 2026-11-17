/**
 * 自分のタスクの看板の列。Todo表示のチェックは、完了（done）と未着手（todo）の切り替えになる。
 * 連携先（GitHub・Backlog）のチケットは看板に載せず、参照だけにする。
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

export type ExternalSource = 'github' | 'backlog';
export type GitHubReason = 'assigned' | 'authored' | 'review_requested';

/** GitHub・Backlogから読み取ったチケット。inuiでは保存・更新しない。 */
export interface ExternalTask {
  id: string;
  source: ExternalSource;
  kind: 'issue' | 'pull_request' | 'backlog_issue';
  key: string;
  title: string;
  url: string;
  updatedAt: string;
  status?: string;
  dueDate?: string;
  reasons?: GitHubReason[];
}

/** 連携先ごとの取得結果。設定がなければ取得せず、未設定であることだけを返す。 */
export type ExternalResult =
  | { configured: false }
  | { configured: true; tasks: ExternalTask[] };

export const MAX_TITLE_LENGTH = 200;
