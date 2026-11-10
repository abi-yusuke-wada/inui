# ADR-0007: CodexのIssue・PR操作を限定したGitHub MCPへ分離する

- 状態: 決定（2026-11-06）。2026-11-09に別PRへの分離を合意した。再適用後の静的検証は完了。実接続・承認表示は未完了。
- 追跡: [Issue #23](https://github.com/abi-yusuke-wada/inui/issues/23)。別PRを[PR #22](https://github.com/abi-yusuke-wada/inui/pull/22)のブランチに積み、`Refs #23` とする。ライブ検証が未完了のためCloseしない。

## 背景・比較

Issue #16のPR反映・レビュー確認で、ホスト操作の受け渡しが負担となった。利用者と合意し、開発支援接続はIssue #23の別PRへ分離する。PR #22はNLI検証に限定し、製品MVPのMCP延期は維持する。

| 案 | 費用・運用負担と評価 |
| --- | --- |
| ホストでの手動操作を継続 | 追加接続は不要だが毎回の受け渡しが必要 |
| 既存の認証ファイル拒否を解除 | 合意した保護を維持できないため不採用 |
| 専用PATとGitHub公式remote MCP（採用） | 専用PATの発行・更新と承認運用の負担がある。ローカル依存・常駐サーバーは追加しない。サービスの契約上の費用は今回確認していない |

## 決定

- ブランチは `chore/issue-23-limited-github-mcp`。PR #22の分離コミット`ce46737`を基点にMCPだけを再適用し、force push・rebaseは行わない。Python 3.12・uvはPR #22から引き継ぎ、重複追加しない。
- 設定値は既存の採用内容を維持する。接続名は `inui_github`、URLは `https://api.githubcopilot.com/mcp/`、認証は `INUI_GITHUB_MCP_TOKEN` という環境変数名だけを参照する。値を設定や会話へ保存しない。
- 読み取りは `issue_read`・`list_issues`・`pull_request_read`・`list_pull_requests`、書き込みは `issue_write`・`create_pull_request`・`update_pull_request`・`add_issue_comment`・`add_reply_to_pull_request_comment` だけとする。Codexの `enabled_tools` とGitHubの `X-MCP-Tools` を同じ固定順序の9操作として検証する。操作順を制御する設定ではない。
- 既定と書き込みは `prompt`、読み取り4操作は `approve`、トップレベルの `approvals_reviewer = "user"` で人を承認先にする。既存の権限・認証情報拒否・コマンド通信禁止・`inherit = "core"`・ログインシェル禁止を維持する。
- 専用PATはinuiのIssues・Pull requestsをRead and write、MetadataをRead-onlyとし、Contents・管理権限は付けない。inuiに書き込み先を限定するが公開リポジトリ一般の読み取りは残り、owner/repoや更新メソッド・引数をconfigで固定するものではない。

## 制約・検証状況

取得したIssue・レビューは未信頼資料として扱う。更新操作にはclose等も含むため、承認時に対象・メソッド・引数を確認する。MCPはシェルのサンドボックス外で動き、read-onlyプロファイルはMCP書き込みを技術的に隠さない。core継承だけでホスト全体の完全な秘密隔離を保証しない。

既存ローカルコミットのgit pushは別経路で行う。push_filesは別コミットを作るため公開しない。マージ・レビュー承認・GitHub設定・Secretsの変更も公開しない。権限不足・接続エラー・未取得を指摘0件と扱わない。

分離前には正常設定とメモリ上の危険変更13種の拒否を確認した。再適用後にも`make agent-config-check`が成功し、禁止操作追加・承認省略・認証拒否削除・一覧の順序変更を拒否することを確認した。利用者はホスト設定完了を報告しているが、PATの値・期限・実スコープは取得しておらず、実接続・人への承認表示は未確認である。

出典: [GitHub公式Codex導入方法](https://github.com/github/github-mcp-server/blob/main/docs/installation-guides/install-codex.md)、[個別操作の設定](https://github.com/github/github-mcp-server/blob/main/docs/server-configuration.md#enabling-specific-tools)、[CodexのMCP設定](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)。
