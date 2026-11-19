export interface TaskSources {
  github?: { token: string };
  /** 値の形式が正しくない連携先。値そのものは保持しない。 */
  invalid: 'github'[];
}

const TOKEN = /^[A-Za-z0-9_]{20,255}$/;

/**
 * GitHubのトークンを環境変数から読む。設定がなければGitHubとは連携しない。
 * 値はエラーやログへ含めず、形式の誤りだけを記録する。
 */
export function readTaskSources(env: Readonly<Record<string, string | undefined>> = process.env): TaskSources {
  const sources: TaskSources = { invalid: [] };
  const token = env.INUI_GITHUB_TOKEN;
  if (token) {
    if (TOKEN.test(token)) sources.github = { token };
    else sources.invalid.push('github');
  }
  return sources;
}
