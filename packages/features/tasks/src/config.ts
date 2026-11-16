import type { BacklogConfig } from './backlog.ts';

export interface TaskSources {
  github?: { token: string };
  backlog?: BacklogConfig;
  /** 値の形式が正しくない連携先。値そのものは保持しない。 */
  invalid: ('github' | 'backlog')[];
}

const TOKEN = /^[A-Za-z0-9_]{20,255}$/;
const BACKLOG_SPACE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.backlog\.(?:jp|com)$/;
const BACKLOG_KEY = /^[A-Za-z0-9]{20,128}$/;

/**
 * 連携先の認証情報を環境変数から読む。設定がなければその連携先は使わない。
 * 値はエラーやログへ含めず、形式の誤りだけを記録する。
 */
export function readTaskSources(env: Readonly<Record<string, string | undefined>> = process.env): TaskSources {
  const sources: TaskSources = { invalid: [] };
  const token = env.INUI_GITHUB_TOKEN;
  if (token) {
    if (TOKEN.test(token)) sources.github = { token };
    else sources.invalid.push('github');
  }
  const space = env.INUI_BACKLOG_SPACE?.toLowerCase();
  const apiKey = env.INUI_BACKLOG_API_KEY;
  if (space || apiKey) {
    if (space && apiKey && BACKLOG_SPACE.test(space) && BACKLOG_KEY.test(apiKey)) sources.backlog = { space, apiKey };
    else sources.invalid.push('backlog');
  }
  return sources;
}
