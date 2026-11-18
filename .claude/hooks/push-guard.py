#!/usr/bin/env python3
"""作業ブランチへの通常のgit pushだけを承認なしにするPreToolUseフック。

Claude Codeの許可ルールは文字列の一致でしか判定できず、`feat/x:release` のような
refspecや、Gitの設定による送信先の書き換えを見分けられない。このフックはコマンドと
Gitの設定を確認し、次の条件をすべて満たす場合だけ承認なしで実行させる。

- コマンドが `git push origin <ブランチ>` だけで、記号や余分な引数を含まない
- ブランチが作業ブランチ（feat/・docs/・fix/・chore/）で、現在のブランチと同じ
- originの接続先がこのリポジトリで、push先やURLを書き換える設定がない
- ブランチ以外の参照（タグ）も送る設定（push.followTags）が有効でない
- 環境変数 GIT_CONFIG が設定されていない（git configだけに効き、実際のpushとは別の設定を検査してしまうため）
- リポジトリ（local・worktree）の設定が許可リストの項目だけで、コマンドで与えた設定もない
  （git はpushの途中で認証ヘルパー等の設定されたプログラムをサンドボックス外で実行しうるため、
  危険な項目を個別に探すのではなく、許可した項目以外があれば承認を求める）
- 実行されうるgitフックがない（core.hooksPathが未設定で、フックのディレクトリに.sample以外がない）
- サブモジュールも送る設定（push.recurseSubmodules・submodule.recurse）が有効でない

条件を満たさないgit pushは、このフックが承認を求める（ask）。settings.jsonのaskルールは
フックのallowより優先されるため、git pushをaskルールには入れない。拒否はdenyで行う。
git push以外のコマンドや、判定できない入力では何も出力せず、通常の権限確認に任せる。
このファイルはエージェントが書き換えられない .claude/hooks/ に置く。
"""
import json
import os
import re
import subprocess
import sys

WORK_BRANCH = re.compile(r'^(?:feat|docs|fix|chore)/[A-Za-z0-9._-]+(?:/[A-Za-z0-9._-]+)*$')
ALLOWED_CHARS = re.compile(r'^[A-Za-z0-9 ._/-]+$')
ORIGIN_URL = 'https://github.com/abi-yusuke-wada/inui.git'
# リポジトリの設定（local・worktree）で許可する項目。gitが既定で作る項目と、
# ブランチの追跡設定・VS Codeが付ける項目・利用者名だけに限る。
LOCAL_KEYS = {
    'core.repositoryformatversion', 'core.filemode', 'core.bare', 'core.logallrefupdates',
    'core.ignorecase', 'core.precomposeunicode', 'core.symlinks',
    'remote.origin.url', 'remote.origin.fetch', 'user.name', 'user.email',
}
LOCAL_BRANCH_KEY = re.compile(r'^branch\.[^\s]+\.(remote|merge|vscode-merge-base|github-pr-owner-number)$')


def decide(decision, reason):
    print(json.dumps({'hookSpecificOutput': {
        'hookEventName': 'PreToolUse',
        'permissionDecision': decision,
        'permissionDecisionReason': reason,
    }}, ensure_ascii=False))
    sys.exit(0)


def git(cwd, *args):
    result = subprocess.run(['git', '-C', cwd, *args], capture_output=True, text=True, timeout=10, check=False)
    return result.returncode, result.stdout.strip()


def problem(command, cwd):
    """承認なしにできない理由を返す。問題がなければNoneを返す。"""
    if os.environ.get('GIT_CONFIG') is not None:
        return '環境変数GIT_CONFIGが設定されており、pushと同じ設定を検査できません。'
    if not ALLOWED_CHARS.match(command):
        return 'pushのコマンドに許可していない記号（: + ; 等）が含まれます。'
    tokens = command.split()
    if len(tokens) != 4 or tokens[:3] != ['git', 'push', 'origin']:
        return '「git push origin <ブランチ>」以外の形式のpushです。'
    branch = tokens[3]
    if not WORK_BRANCH.match(branch) or '..' in branch or branch.endswith('.lock'):
        return '作業ブランチ（feat/・docs/・fix/・chore/）へのpushではありません。'
    code, head = git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD')
    if code != 0 or head != branch:
        return '現在のブランチと異なるブランチへのpushです。'
    # urlが複数あるとgitはすべてへpushするため、許可した1件だけのときに限る。
    code, urls = git(cwd, 'config', '--get-all', 'remote.origin.url')
    if code != 0 or urls.splitlines() != [ORIGIN_URL]:
        return 'originの接続先が想定のリポジトリ1件だけではありません。'
    _, rewrite = git(cwd, 'config', '--get-regexp', r'^remote\.origin\.(push|pushurl|mirror)$')
    if rewrite:
        return 'originのpush先を変更する設定（remote.origin.push等）があります。'
    _, rewrite = git(cwd, 'config', '--get-regexp', r'^url\..*\.(insteadof|pushinsteadof)$')
    if rewrite:
        return 'URLを書き換える設定（insteadOf等）があります。'
    _, follow_tags = git(cwd, 'config', '--type=bool', '--get', 'push.followTags')
    if follow_tags == 'true':
        return 'ブランチと一緒にタグも送る設定（push.followTags）が有効です。'
    code, entries = git(cwd, 'config', '--list', '--show-scope', '--name-only')
    if code != 0:
        return 'Gitの設定を確認できませんでした。'
    for line in entries.splitlines():
        scope, _, key = line.partition('\t')
        if scope == 'command':
            return 'コマンドで与えたGitの設定があります。'
        if scope in ('local', 'worktree') and key not in LOCAL_KEYS and not LOCAL_BRANCH_KEY.match(key):
            return 'リポジトリのGit設定に、許可していない項目があります。'
    code, _ = git(cwd, 'config', '--get', 'core.hooksPath')
    if code == 0:
        return 'gitフックの場所を変える設定（core.hooksPath）があります。'
    code, hooks = git(cwd, 'rev-parse', '--git-path', 'hooks')
    if code != 0:
        return 'gitフックの場所を確認できませんでした。'
    hooks_dir = hooks if os.path.isabs(hooks) else os.path.join(cwd, hooks)
    if os.path.isdir(hooks_dir) and any(not name.endswith('.sample') for name in os.listdir(hooks_dir)):
        return 'push中に実行されうるgitフックがあります。'
    _, recurse = git(cwd, 'config', '--get', 'push.recurseSubmodules')
    if recurse not in ('', 'no', 'check'):
        return 'サブモジュールも送る設定（push.recurseSubmodules）が有効です。'
    _, recurse = git(cwd, 'config', '--type=bool', '--get', 'submodule.recurse')
    if recurse == 'true':
        return 'サブモジュールを再帰的に扱う設定（submodule.recurse）が有効です。'
    return None


def main():
    try:
        data = json.load(sys.stdin)
    except (ValueError, OSError):
        return
    if not isinstance(data, dict) or data.get('tool_name') != 'Bash':
        return
    tool_input = data.get('tool_input')
    command = tool_input.get('command') if isinstance(tool_input, dict) else None
    if not isinstance(command, str) or not re.match(r'^\s*git\s+push(?:\s|$)', command):
        return
    cwd = data.get('cwd') if isinstance(data.get('cwd'), str) else '.'
    try:
        reason = problem(command.strip(), cwd)
    except (OSError, subprocess.SubprocessError):
        reason = 'Gitの状態を確認できませんでした。'
    if reason:
        decide('ask', reason)
    decide('allow', '作業ブランチへの通常のpushであることを確認しました。')


if __name__ == '__main__':
    main()
