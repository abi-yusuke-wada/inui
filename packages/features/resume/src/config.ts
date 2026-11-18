import { basename, isAbsolute, resolve } from 'node:path';

export interface Repository {
  name: string;
  path: string;
}

export interface ResumeSources {
  repositories: Repository[];
  github?: { token: string };
  /** 値の形式が正しくない設定。値そのものは保持しない。 */
  invalid: ('repositories' | 'github')[];
}

/** 登録できるリポジトリの数の上限。1回の表示で、この数のリポジトリをgitで読む。 */
export const MAX_REPOSITORIES = 10;
const TOKEN = /^[A-Za-z0-9_]{20,255}$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: 環境変数に含まれる制御文字を拒否するため。
const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * 作業の再開画面で読むリポジトリ（INUI_REPOSITORIES。絶対パスのカンマ区切り）と、GitHubのトークン
 * （INUI_GITHUB_TOKEN。タスク画面と同じもの）を環境変数から読む。読めるのは、利用者が明示したリポジトリだけにする。
 * 1つでも形式が正しくなければ、リポジトリは1つも読まない。値はエラーやログへ含めない。
 */
export function readResumeSources(env: Readonly<Record<string, string | undefined>> = process.env): ResumeSources {
  const sources: ResumeSources = { repositories: [], invalid: [] };
  const list = env.INUI_REPOSITORIES;
  if (list) {
    const items = list.split(',').map((item) => item.trim());
    const valid = items.length <= MAX_REPOSITORIES
      && items.every((item) => item.length > 0 && item.length <= 4096 && isAbsolute(item) && !CONTROL.test(item));
    if (valid) {
      // 末尾の「/」や「..」を整え、同じ場所を重ねて読まない。
      const paths = [...new Set(items.map((item) => resolve(item)))];
      sources.repositories = paths.map((path) => ({ name: basename(path) || path, path }));
    } else {
      sources.invalid.push('repositories');
    }
  }
  const token = env.INUI_GITHUB_TOKEN;
  if (token) {
    if (TOKEN.test(token)) sources.github = { token };
    else sources.invalid.push('github');
  }
  return sources;
}
