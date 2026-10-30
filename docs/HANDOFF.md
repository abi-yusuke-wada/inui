# 作業の引き継ぎ

CLIを切り替えるときに、最新の引き継ぎ1件へ更新する。共通ルールは [AGENTS.md](../AGENTS.md)、仕様は [MVP.md](../MVP.md)、設計判断は既存のADRを参照する。

## 対象・状態

- 対象: Codex CLIとClaude Code CLIで開発ルールと作業状態を共有する。
- ブランチ: `chore/shared-cli-context`。最新の `origin/main` から作成した別worktreeで作業している。
- 変更: `AGENTS.md` に共有・引き継ぎのルールを追加。`CLAUDE.md` は `@AGENTS.md` を読み込む。Claude Codeのプロジェクト設定と個人設定のGit除外を整備した。
- 状態: 共有ルールと設定の整備は完了。push・PR作成は未実施。元の `docs/issue-2-technical-plan` の未コミット変更は元の作業ディレクトリに保持している。

## 検証結果

- `git diff --check`、JSON構文、Markdownの相対リンク・文字コード・改行、個人設定のGit除外、`@AGENTS.md` の参照先を確認し、すべて成功した。
- AGENTS.mdに開発ツール名の指定がないこと、既存のCodex設定を変更していないことを確認した。CLIの実起動・会社側設定との組み合わせは未検証。

## 未完了事項・次の作業

- CLIを切り替える際は、このメモに加えて現在のブランチ・`git status`・差分を確認する。各CLIの会話履歴は自動同期しない。
- Issue #2の技術構成の検討は `docs/issue-2-technical-plan` で継続する。HTTP入口の採用は未確定で、比較内容はそのブランチのADRと [Issue #2](https://github.com/abi-yusuke-wada/inui/issues/2) を確認する。
- CLIの導入・会社側設定を含む実環境での起動確認は未実施。アプリや基盤の構築は今回の対象外。
