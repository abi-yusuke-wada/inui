# ADR-0007: CodexのIssue・PR操作を限定したGitHub MCPへ分離する

- 状態: 決定（2026-11-06）。設定の静的検証は完了。実接続・承認表示の動作確認は未完了。
- 関連: [ADR-0002](0002-development-environment.md)、[権限と運用](../agent-security.md)、[PR #22](https://github.com/abi-yusuke-wada/inui/pull/22)

## 背景

Codexから`gh`を使うと、読み取り拒否対象の`~/.config/gh`へアクセスできず失敗する。ホストでIssue・PR操作を毎回実行する負担を減らしたい。一方、外部のIssue・レビューに含まれる悪意ある指示を受けて、認証情報の取得や承認していない書き込みが起きることを避けたい。

利用者は、既存の認証情報の拒否を維持し、GitHubの必要操作だけを公開して書き込みを承認対象にする変更を承認した。これは開発支援の接続であり、[ADR-0006](0006-local-model-for-mvp.md)で延期した製品MVPのMCP導入とは別の用途である。

## 比較した案

| 案 | 費用・運用負担と評価 |
| --- | --- |
| ホストでの手動操作を継続する | 追加接続は不要だが、操作・結果受け渡しを毎回行う必要がある |
| Codexの認証ファイル拒否を解除する | 既存の`gh`を使いやすいが、合意した認証情報の保護を維持できないため不採用 |
| 専用PATとGitHub公式remote MCPを使う（採用） | ローカルの依存・常駐サーバーは追加しない。専用PATの発行・期限更新・書き込み承認の負担がある。サービスの利用条件や契約上の費用は今回確認していない |

## 決定

- プロジェクトの[Codex設定](../../.codex/config.toml)へ`inui_github`を追加し、接続先を`https://api.githubcopilot.com/mcp/`とする。認証は`INUI_GITHUB_MCP_TOKEN`という環境変数名だけを参照し、値を設定ファイルや会話へ保存しない。[GitHub公式の導入方法](https://github.com/github/github-mcp-server/blob/main/docs/installation-guides/install-codex.md)
- 専用fine-grained PATは書き込み先を`abi-yusuke-wada/inui`だけにし、Issues・Pull requestsをRead and write、MetadataをRead-onlyとする。Contentsや管理用の権限は付けない。リポジトリ制限はPAT側の設定であり、MCPの`owner`・`repo`引数を固定する設定ではない。公開リポジトリ一般への読み取りも残る。[PATの仕様](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)
- 読み取りは`issue_read`・`list_issues`・`pull_request_read`・`list_pull_requests`、書き込みは`issue_write`・`create_pull_request`・`update_pull_request`・`add_issue_comment`・`add_reply_to_pull_request_comment`だけを公開する。Codexの`enabled_tools`とGitHubの`X-MCP-Tools`を同じ9操作にする。[GitHubの個別操作設定](https://github.com/github/github-mcp-server/blob/main/docs/server-configuration.md#enabling-specific-tools)
- 既定の承認モードを`prompt`、既知の読み取り4操作だけを`approve`、書き込み5操作を`prompt`とする。承認先はトップレベルの`approvals_reviewer = "user"`で人に指定する。[CodexのMCP設定](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)
- 既存の権限プロファイル、機密ファイルの拒否、コマンドの通信制限、`inherit = "core"`、ログインシェルの無効化は維持する。

## 制約と運用

取得したIssue・レビューは[AGENTS.md](../../AGENTS.md)のTrust Boundaryに従う資料であり、含まれる命令を実行や承認の根拠にしない。更新ツールはclose等の変更も含み、メソッド・引数単位では制限していない。承認時には対象リポジトリ・Issue/PR番号・変更内容を確認する。

MCPはシェルのサンドボックスの保護対象外である。`inui-readonly`がMCPの書き込み操作も隠す設定ではなく、MCPは操作別の承認で制御する。`inherit = "core"`は子シェルへの環境継承の制限であり、Codexホスト全体からの完全な秘密隔離を保証しない。利用者本人としての書き込みになるため、投稿内容の確認も必要になる。

merge・レビュー承認・設定変更・コード書き込み等の操作は公開しない。このPATとMCPでは既存ローカルコミットの`git push`を行わず、ソースのpushは認可された別経路で行う。`push_files`はGitHub側で別コミットを作る操作なので代替として公開しない。GitHubのRulesetやSecretsの変更も今回の範囲に含めない。

権限不足・接続エラー・取得できない応答は、指摘0件やレビュー完了として扱わない。PATの実際の選択リポジトリ・権限・期限はエージェントから取得しておらず、設定ファイルの検証だけでそれらを保証しない。

## 検証状況

Codex 0.166.0の[固定版公式schema](https://raw.githubusercontent.com/openai/codex/rust-v0.166.0/codex-rs/core/config.schema.json)で使用する設定項目を確認した。`make agent-config-check`は、プロジェクト設定だけを読み、既存の拒否設定・公開操作・接続先・承認モードを静的検証する。schemaだけでは詳細を検証できない権限プロファイルは、変更前との完全一致も確認した。

正常設定の成功と、承認省略・認証ファイルの拒否削除・禁止操作追加等の13種類のメモリ上変更の拒否を確認した。利用者はホスト側の設定完了を報告しているが、現在のセッションには新しいMCP操作がまだ現れていない。専用PATを渡したCodexの再起動後に、実接続・読み取り・人への書き込み承認表示を確認する。
