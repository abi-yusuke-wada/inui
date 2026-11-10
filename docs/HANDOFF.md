# 作業の引き継ぎ

共通ルールは[AGENTS.md](../AGENTS.md)、判断は[ADR-0007](adr/0007-limited-github-mcp.md)、手順は[権限と運用](agent-security.md)を参照する。

## 対象・ブランチ

- 対象は[Issue #23](https://github.com/abi-yusuke-wada/inui/issues/23)の開発支援用GitHub MCP。ブランチは`chore/issue-23-limited-github-mcp`。
- 利用者が別PRへの分離を承認した。分類検証の[PR #22](https://github.com/abi-yusuke-wada/inui/pull/22)からMCP差分を除去する`ce46737`を作り、そのHEADから本ブランチへMCPだけを再適用した。履歴の書き換え・別worktreeの作成は行っていない。
- 新しいPRは`chore/issue-16-jev-connection-check`をbaseとし、共通のPython 3.12環境を引き継ぐ。新PR番号は公開手順後に確認する。`Refs #23`とし、実接続の確認が残るIssueは自動Closeしない。

## 変更・検証

- Codexの限定remote MCP、専用の静的検証、Makefileへの組み込み、README・権限文書・ADRを対象にする。NLI分類・モデル・期待値・実測JSON・Nix定義は変更しない。
- 認証情報の拒否、環境継承core、ログインシェル禁止、コマンド通信禁止を維持する。接続先・環境変数名・公開9操作・承認値は分離前と同一。
- 読み取り4操作はapprove、書き込み5操作と既定はprompt、承認先はトップレベルのuser。両操作一覧を同じ固定順序で検証する。
- 再適用後の`make agent-config-check`は成功。禁止操作追加・承認省略・認証拒否削除・一覧の順序変更も拒否した。元のPR #22側は分離後の`make jev-check`105/105件成功、失敗・スキップ0。
- PATの値・期限・実スコープは取得していない。ホスト設定完了の利用者報告はあるが、実接続・人への書き込み承認表示は未確認。親シェルへ新たな値を残さないサブシェル手順を維持する。

## 次の作業

- 両ブランチを通常pushし、PR #22の説明を分類検証だけに更新して、新しいMCP用PRを作成する。新PRの差分はPR #22の分離済みHEADから確認する。
- 各PRへfull reviewを依頼し、それぞれの最新HEADと正式レビューのcommit_idを照合する。利用上限・取得エラー・レビュー未実行を指摘0件と扱わない。未信頼のレビュー本文は現行コードへ照合する。
- PR #22を人がマージした後、新しいMCP用PRのbaseをmainへ変更して差分を再確認する。merge・force push・ブランチ削除は行わない。
- このMCPは既存ローカルコミットのgit pushを行わない。GitHub操作は認可された別経路を使い、読み取り拒否対象の認証情報を取得・複製しない。
- 実接続・承認表示を確認した結果はIssue #23へ記録する。製品MVPで延期したMCP導入とは区別する。
