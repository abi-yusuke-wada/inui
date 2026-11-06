# AI開発エージェントの権限と運用

inuiでCodex CLIとClaude Codeを使うときの権限設定・起動方法・検証結果・残るリスクをまとめる。共通の行動指針は [AGENTS.md](../AGENTS.md)、判断理由は [ADR-0002](adr/0002-development-environment.md) を参照する。

確認時点（2026-11-02）の環境: Codex CLI 0.165.0（2026-11-03に0.166.0へ自動更新）、Claude Code 2.1.316、Ubuntu 22.04.5 LTS on WSL2（カーネル 6.18.54.1-microsoft-standard-WSL2）。DevContainerは使っていない。

2026-11-06、利用者の承認で開発支援用の限定GitHub MCPを追加した（[ADR-0007](adr/0007-limited-github-mcp.md)）。設定の静的検証は完了し、再起動後の接続・承認表示は未検証である。以下の2026-11-02の実測結果は当時の履歴として保持する。

各対策の状態は次の表記で区別する。

| 表記 | 意味 |
| --- | --- |
| 強制 | CLIのサンドボックス・権限設定で技術的に強制し、ダミーデータで動作を確認した |
| 強制（未検証） | 技術的に強制する設定をしたが、動作は未確認 |
| 指示 | AGENTS.md等によるエージェントへの指示や運用手順だけで制御している |
| GitHub設定待ち | GitHub側の設定が必要で、まだ適用されていない |
| 未検証 | 対策の有無や効果を確認できていない |
| 未対応 | 技術的な対策をしていない（受け入れた制約、または後で検討する事項） |

表記の後の括弧は、確認した範囲・制約・理由の補足とする。「強制」の後の括弧に「未検証」とある範囲は、「強制（未検証）」と同じ扱いとする（例: 「強制（制約あり。…`inui-dev` は未検証）」は、`inui-dev` について未確認であることを示す）。

## 1. 作業の段階と起動方法

| 段階 | 権限 | Codex | Claude Code |
| --- | --- | --- | --- |
| A. 調査 | 読み取り専用 | `codex`（既定のプロファイル `inui-readonly`） | `claude --permission-mode plan` |
| B. 実装・テスト | 作業領域への書き込み | `codex` で起動し、`/permissions` で `inui-dev` に切り替える | `claude`（既定）。編集を自動で許可する場合は `claude --permission-mode acceptEdits` |
| C. GitHubへの反映 | 制限付きの書き込み | 限定MCPでIssue・PRを操作し、書き込みは人に承認を求める。ソースのpushは別経路 | `gh`・`git push` を毎回承認して実行する |

どちらのCLIも、devShellに入った状態（direnvまたは `nix develop`）で起動する。Codexは起動後と切り替え後に `/status` で権限が `inui-readonly`・`inui-dev` になっていることを確認してから作業する。起動オプション `-c 'default_permissions="…"'` での指定は、ワークスペースの要件設定の読み込みに失敗して起動できない（2026-11-02確認）。`codex` だけで起動すると `inui-readonly` が適用され、`/permissions` で `inui-dev` を選択できることを確認した。`-s/--sandbox`・`--full-auto` 等の起動オプションやエイリアスがあると、プロジェクトの権限プロファイルより優先される場合がある（2026-11-02、権限プロファイルが適用されず `workspace-write` で起動したセッションでは、GitHubのトークン等を読み取れることを確認した）。調査で整理した作業スコープをユーザーと合意してから、段階Bで起動し直す。

## 2. Codex CLIの実効権限

設定: [.codex/config.toml](../.codex/config.toml)

- `approval_policy = "on-request"`。危険な操作や権限外の操作は、モデルが承認を求める。
- `approvals_reviewer = "user"`。承認要求の提示先を人に指定する。実際のMCP承認表示は再起動後に確認する。
- 既定のプロファイルは `inui-readonly`（組み込みの `:read-only` を継承）。実装時だけ、セッション内の `/permissions` で `inui-dev`（`:workspace` を継承）に切り替える。
- 依頼文にあった `sandbox_mode = "read-only"` と `[sandbox_workspace_write] network_access = false` は使わない。Codex 0.165.0では、旧 `sandbox_mode`・`sandbox_workspace_write` を権限プロファイルと併用できないため、機密ファイルの拒否ができるプロファイル方式を採る。CLIの `-s/--sandbox` も旧方式の指定なので使わない。
- どちらのプロファイルもネットワークの許可を持たない（既定で無効）。
- 両プロファイルで、`.env`・`.env.*`、`.aws`・`~/.aws`、`~/.ssh`、`~/.gnupg`、`~/.netrc`、`~/.git-credentials`、`~/.npmrc`、`~/.config/pnpm`、`~/.docker/config.json`、`~/.config/gh`（GitHubのトークン）、`~/.claude/.credentials.json`、`~/.codex/auth.json` の読み取りを拒否する。
- グローバル設定（`~/.codex/config.toml`）にはモデルと信頼済みプロジェクトの設定だけがあり、権限・サンドボックスの設定はない。プロジェクト設定が適用されるのは、信頼済みのプロジェクトとして開いた場合に限られる。
- `--dangerously-bypass-approvals-and-sandbox`、`-s danger-full-access`、`-a never` は使わない（設定で禁止はできないため、指示による制御）。
- 開発支援用の`inui_github`を設定する。MCPはシェルのサンドボックスでは保護されないため、下記の公開操作と承認で別に制御する。

### Codexの限定GitHub接続

GitHub公式remote MCPの接続先・公開する9操作・操作別承認をプロジェクト設定で管理する。公開操作は次のとおりで、Codexの`enabled_tools`とサーバーの`X-MCP-Tools`を一致させる。

| 用途 | 公開操作 | 承認設定 |
| --- | --- | --- |
| 読み取り | `issue_read`、`list_issues`、`pull_request_read`、`list_pull_requests` | `approve` |
| 書き込み | `issue_write`、`create_pull_request`、`update_pull_request`、`add_issue_comment`、`add_reply_to_pull_request_comment` | `prompt` |

既定は`prompt`とし、merge・レビュー承認・コード書き込み・管理用操作は公開しない。更新操作はclose等も含むため、承認時にはメソッド・対象・本文等の引数を確認する。取得内容の扱いは[AGENTS.md](../AGENTS.md)のTrust Boundaryに従う。

`inui-readonly`はMCPの書き込み操作を技術的に隠す設定ではない。MCPの承認はファイルシステムの制限とは別である。調査段階の合意外の書き込みは行わず、承認時にも作業スコープを確認する。環境変数の継承制限だけで、ホスト全体の完全な秘密隔離を保証したとは扱わない。

#### 初回設定（人がホストで行う）

1. GitHubのSettings → Developer settings → Personal access tokens → Fine-grained tokensから専用PATを発行する。Resource ownerを`abi-yusuke-wada`、Only select repositoriesを`inui`にする。
2. Issues・Pull requestsをRead and write、MetadataをRead-onlyにする。Contentsや管理権限は追加せず、有効期限を指定する。書き込み先の制限はPAT側で行う。公開リポジトリ一般への読み取りは残る。
3. ホストのdevShellで、次のように非表示入力しCodexを起動する。値はチャット・ファイル・シェル履歴へ保存しない。既に起動中のCodexにはこの環境変数は後から反映されない。

```bash
read -rsp 'GitHub MCP用PAT: ' INUI_GITHUB_MCP_TOKEN
printf '\n'
export INUI_GITHUB_MCP_TOKEN
codex
```

設定にはトークン値を保存せず、`bearer_token_env_var`に環境変数名だけを書く。`shell_environment_policy.inherit = "core"`を維持してシェルへ明示継承しない。既存の`~/.config/gh`の認証情報も取得・複製しない。

再起動後に`/mcp`で`inui_github`を確認し、inuiのIssue・PRの読み取りと、合意済みの書き込みに対する人への承認表示を確認する。権限不足や取得エラーを指摘0件と扱わない。この接続ではローカルコミットの`git push`はできず、認可された別経路を使う。製品MVPのMCP延期とは別の接続である。

`make agent-config-check`は、認証情報や環境変数の値を読まずにプロジェクトの権限・公開操作・承認設定を静的検証する。2026-11-06に正常設定の成功、既存permissionsの完全一致、危険な変更13種の拒否を確認した。実接続・人への承認表示・PATの実スコープはまだ検証していない。

## 3. Claude Codeの実効権限

設定: [.claude/settings.json](../.claude/settings.json)（共有）、`.claude/settings.local.json`（個人、Git管理外）

- `permissions.defaultMode = "default"`。ファイル編集は承認を求める。自動編集は段階Bで明示的に指定したときだけ使う。Bashは、`sandbox.autoAllowBashIfSandboxed` の既定値（`true`）により、サンドボックス内で実行できるコマンドは承認なしで実行される。承認を求めるのは、`ask` に一致するコマンド（`gh`・`git push` 等）、サンドボックス外での実行が必要なコマンド、拒否されていないサンドボックス外の通信先への接続である。
- `sandbox.enabled`・`failIfUnavailable`・`allowUnsandboxedCommands: false`。Bashはサンドボックス内で実行し、サンドボックスが使えなければ起動しない。サンドボックスを外した再実行はできない。例外は `excludedCommands` に指定した `gh`・`git push` で、承認後にホスト上（サンドボックス外）で実行される。
- `permissions.blockWritesOutsideWorkingDirectories`。ファイル操作ツール（Write・Edit等）による作業領域外への書き込みと、CLIの設定ファイルへの書き込みを拒否する。
- `Read`・`Edit` の拒否ルールで、Codexと同じ機密ファイル・認証情報を対象にする。拒否ルールはサンドボックスの読み取り拒否にも反映される。
- `gh` と `git push` はGitHubのトークンを使うため、サンドボックスの対象外（`excludedCommands`）とし、`ask` で毎回承認を求める。パイプ等で他のコマンドと組み合わせた場合はサンドボックス内で実行され、トークンを読めないため失敗する。`git -C <dir> push` のように `git push` で始まらない書き方や、引数にバッククォート・リダイレクト記号を含む `gh` もサンドボックス内で実行されるため、コマンドは単独で書き、本文は `-F body=@<ファイル>` で渡す。
- マージ・Auto-mergeの有効化・承認（`gh pr review --approve`）・`gh auth`・リポジトリ設定・Secrets・Variables・Rulesetの変更、force push、`main` へのpush、ブランチの削除を `deny` で拒否する。`gh api` 経由のRuleset・ブランチ保護・Secrets・Variables・Actionsの権限の操作、`DELETE`、リポジトリ設定の `PATCH` も拒否する（Rulesetの確認・登録は人間が行う）。コマンドの書き方を変えれば回避できるパターン照合のため、マージ禁止の主な手段はGitHub側の保護設定とする。
- サンドボックス外で動く `gh` がローカルの機密ファイルを読んで送信しないよう、`.env` を含む引数、`@` で始まる作業領域外・ドットファイルへのファイル参照、`--body-file`・`--input` を拒否する。本文はスクラッチパッド（`/tmp` 配下）のファイルを `-F body=@<ファイル>` で渡す。これもパターン照合のため、承認時にコマンド全体を確認する。
- `git -C <dir> push` 等の別の書き方も承認の対象にする。これらはサンドボックス内で実行されトークンを読めないため、現状でも認証付きのpushはできない（2026-11-02、`git -C` 形式のpushがサンドボックスの通信制限で失敗することを確認）。
- `sandbox.credentials.envVars` で、`GH_TOKEN`・`GITHUB_TOKEN`・AWSの認証情報・レジストリのトークン・LLMのAPIキー等の環境変数を、サンドボックス内のコマンドから見えなくする。`Read` の拒否やファイルシステムの制限は環境変数を保護しないため。サンドボックス外で動く `gh` は対象外で、トークンを使える（承認で制御）。
- `WebFetch` は毎回承認を求める。
- `disableClaudeAiConnectors`。claude.aiのコネクタ（Gmail・Slack等のMCP）を、このプロジェクトでは読み込まない。
- `bypassPermissions` は使わない。

## 4. 動作確認の結果

ダミーデータだけを使い、秘密情報の内容は出力していない。

### Claude Code（2026-11-02、本設定で確認）

| 項目 | 結果 | 状態 |
| --- | --- | --- |
| サンドボックスが起動する（WSL2、bubblewrap 0.12.0） | 起動した | 強制 |
| サンドボックス外での再実行 | 設定で無効（`dangerouslyDisableSandbox` が使えない） | 強制 |
| 作業領域内への書き込み | 成功 | 強制 |
| ホームへの書き込み | 拒否（Read-only file system） | 強制 |
| `.claude/settings.json` への書き込み | 拒否 | 強制 |
| `~/.config/gh`・`~/.codex/auth.json`・`~/.claude/.credentials.json` の読み取り | 拒否（Permission denied） | 強制 |
| `~/.gnupg` | 中身が0件に見える（元から空かは確認していない） | 強制（一部未検証） |
| 実行前から存在するダミー `.env` | 読み取り・削除ともにできない | 強制 |
| `example.com` への通信 | 拒否 | 強制 |
| トークンの読み取りを含む `cat ~/.config/gh/...` | 実行前に権限チェックで拒否 | 強制 |
| `gh` 単体の実行 | サンドボックス外で実行され、毎回、利用者の画面に承認の確認が表示された | 強制 |
| `gh` を他のコマンドと組み合わせた実行 | サンドボックス内でトークンを読めず失敗 | 強制 |
| Readツールによる機密ファイルの読み取り | 以前の検証で `.env` の拒否を確認。認証情報の拒否は実ファイルで試していない | 強制（一部未検証） |
| 同じコマンドの中で新しく作った `.env` | 読み取れた | 未対応（制約） |
| 認証情報の環境変数（`sandbox.credentials.envVars`）を隠す | 現在の環境では対象の変数が設定されておらず、起動時に継承された変数が隠れることは確認していない | 強制（未検証） |

### Codex（一部実施、2026-11-02）

`codex sandbox` はClaude Codeのサンドボックス内では入れ子のユーザー名前空間を作れず起動できないため、利用者のシェルで起動したCodexのセッションで確認する。

| 項目 | 結果 | 状態 |
| --- | --- | --- |
| `codex` だけで起動したときのプロファイル | `/status` で `Profile inui-readonly (read-only, Ask for approval)` | 強制 |
| `/permissions` での `inui-dev` への切り替え | 選択できる | 強制 |
| `-c 'default_permissions="…"'` での起動 | ワークスペースの要件設定の読み込みに失敗して起動できない | — |
| プロファイルが適用されていない（`workspace-write`）セッション | GitHubのトークン等を読み取れた | 指示（起動手順で回避） |
| `inui-readonly`: 作業領域への書き込み | 拒否（Read-only file system） | 強制 |
| `inui-readonly`: `~/.config/gh`・`~/.codex/auth.json`・`~/.gnupg` の読み取り | 拒否（Permission denied） | 強制 |
| `inui-readonly`: `example.com` への通信 | 失敗（名前解決不可） | 強制 |
| `inui-readonly`: ダミー `.env` の読み取り | ファイルの存在は確認でき、`cat` は拒否された（Permission denied、rc=1） | 強制 |
| `inui-readonly`: `GH_TOKEN` の除外 | `GH_TOKEN=dummy-inui codex` で起動し、コマンド内では未設定と表示された | 強制 |
| `inui-dev` の各項目 | 未実施 | 強制（未検証） |

## 5. 認証情報

| 認証情報 | 配置 | 対策 | 状態 |
| --- | --- | --- | --- |
| GitHubのトークン（`gho_`、`repo`・`workflow`・`gist`・`read:org`） | `~/.config/gh` | 両CLIで読み取り拒否。Claudeの `gh` は毎回承認 | 強制（Claude・Codexの `inui-readonly` で確認済み、`inui-dev` は未検証） |
| 限定GitHub MCP専用fine-grained PAT | Codex起動時の`INUI_GITHUB_MCP_TOKEN` | 値をファイルに保存しない。inuiのIssues・PRだけを書き込み対象にし、MCP操作を制限・書き込みを人の承認対象にする | 設定の静的検証済み。実接続・実スコープ・承認表示は未検証 |
| AWS | `~/.aws`（空のディレクトリ） | 両CLIで拒否 | 強制（Codexは未検証） |
| GnuPG | `~/.gnupg` | 両CLIで拒否 | 強制（Claude・Codexの `inui-readonly` で確認済み、`inui-dev` は未検証） |
| CLI自身の認証 | `~/.claude/.credentials.json`・`~/.codex/auth.json` | 両CLIのサンドボックスで拒否 | 強制（Claudeは両方、Codexの `inui-readonly` は `~/.codex/auth.json` で確認済み。`inui-dev` は未検証） |
| `.env` 内の値 | 作業領域・ホーム配下 | 両CLIで拒否。深さ8を超える配置と、実行中に新しく作るファイルは対象外 | 強制（制約あり。Claude・Codexの `inui-readonly` でダミーの拒否を確認済み、`inui-dev` は未検証） |
| SSH鍵・npm・pnpm・Docker | 現在は存在しない | 作成された場合に備えて拒否対象に含める | 強制（未検証） |
| VS CodeのGit認証連携（`GIT_ASKPASS`） | 環境変数 | VS Code経由で起動した場合、Git操作で認証情報を取得できる可能性がある | 未対応（未検証） |

`.gitignore` で `.env`・`.env.*`・`.aws/`・個人設定を追跡対象外にしている。ただし、`.gitignore` は読み取りを防がない。

## 6. GitHub側で必要な設定

確認時点の状態: 個人アカウントの公開リポジトリ。Ruleset・Branch Protectionはなく、`main` は保護されていない。Auto-mergeは無効。両CLIが使うトークンは利用者本人のもので、利用者と同じ権限を持つ。

### 認証主体の分離（推奨）

AIが利用者本人のトークンを使う限り、GitHubからは人間の操作と区別できず、レビュー必須やマージ制限を技術的に強制できない。次のように分ける。

| 用途 | 認証主体 | 権限 |
| --- | --- | --- |
| 調査 | 認証なし（公開リポジトリ）、または読み取り専用のfine-grained PAT | Metadata・Contents・Issues・Pull requests: Read |
| GitHubへの反映 | inuiだけにインストールしたGitHub App、または専用のBotアカウント | Contents・Issues・Pull requests: Read/Write、Metadata: Read |
| 管理・マージ | 利用者本人（人間） | 管理者 |

ContentsのWrite権限があればブランチの更新（マージを含む）が可能なため、権限設定だけでマージを禁止できない。マージの禁止はRulesetで行う。

### Ruleset案（`main`）

GitHubの「Settings → Rules → Rulesets → New branch ruleset」で作成するか、内容を確認したうえで、Rulesetごとに `gh api -X POST repos/abi-yusuke-wada/inui/rulesets --input <ファイル>` で登録する（AIは実行しない）。

レビュー必須のルールにバイパスが及ばないよう、2つのRulesetに分ける。

1つ目（`main-review`）はPRとコードオーナーによる承認を必須にする。バイパスする主体は設定しない。

```json
{
  "name": "main-review",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "bypass_actors": [],
  "rules": [
    {
      "type": "pull_request",
      "parameters": {
        "required_approving_review_count": 1,
        "dismiss_stale_reviews_on_push": true,
        "require_code_owner_review": true,
        "require_last_push_approval": true,
        "required_review_thread_resolution": true
      }
    }
  ]
}
```

2つ目（`main-update`）は `main` の削除・force push・更新を制限し、管理者ロールだけがPR経由で更新（マージ）できるようにする。

```json
{
  "name": "main-update",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "bypass_actors": [
    { "actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "pull_request" }
  ],
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "update" }
  ]
}
```

- `main-review`: PR経由の変更と、コードオーナーによる承認を必須にする。バイパスを設定しないため、管理者でも承認なしではマージできない。
- `main-update` の `deletion`・`non_fast_forward`: `main` の削除とforce pushを禁止する。
- `main-update` の `update` と `bypass_actors`: `main` を更新（マージを含む）できるのを、管理者ロール（`actor_id: 5`）がPR経由で行う場合に限る。バイパスはこのRulesetのルールにだけ及び、`main-review` の承認必須には及ばない。AIの認証主体には管理者権限もバイパス権限も与えない。
- 必須のCIチェック（`required_status_checks`）は、CIを作成した後に追加する。
- 制約: 利用者本人のトークンをAIが使い続ける場合、AIは管理者として扱われ、上記の制限をバイパスできる。また、PRの作成者は自分のPRを承認できないため、AIが利用者のアカウントでPRを作るとレビュー必須の条件を満たせなくなる。いずれも、反映用の認証主体を分離してから適用する。個人アカウントのリポジトリでのロール指定は、適用時に画面で確認する。

### CODEOWNERS案

セキュリティ上重要な設定の変更に、利用者の承認を必須にする。`.github/CODEOWNERS` として追加する（今回は作成していない）。指示ファイルとCLIの設定は、7.で確認する範囲と同じく階層を問わず一致させる。`**/` で始まる行は、ルートと任意の階層の両方に一致する。

```text
**/AGENTS.md            @abi-yusuke-wada
**/AGENTS.override.md   @abi-yusuke-wada
**/CLAUDE.md            @abi-yusuke-wada
**/CLAUDE.local.md      @abi-yusuke-wada
**/.claude/             @abi-yusuke-wada
**/.codex/              @abi-yusuke-wada
**/.mcp.json            @abi-yusuke-wada
**/.envrc               @abi-yusuke-wada
/.github/               @abi-yusuke-wada
/flake.nix              @abi-yusuke-wada
/flake.lock             @abi-yusuke-wada
/Makefile               @abi-yusuke-wada
/docs/agent-security.md @abi-yusuke-wada
```

## 7. 信頼できないブランチでエージェントを起動する場合のリスク

CLIは、起動したブランチにあるプロジェクト設定と指示ファイルをそのまま読み込む。外部からのPRのブランチで起動すると、次のような変更がそのまま適用される。

- `.claude/settings.json`・`.codex/config.toml` の権限の緩和や、起動時に実行されるフック
- `AGENTS.md`・`CLAUDE.md` の指示の書き換え
- `flake.nix` の `shellHook`。direnvの `use flake` は `flake.nix`・`flake.lock` を監視しており、承認済みの `.envrc` がある作業ディレクトリでブランチを切り替えると、次のプロンプトで変更後の `flake.nix` が再評価され、`shellHook` がホスト上で実行される。direnvが再承認を求めるのは `.envrc` の変更だけで、`flake.nix` の変更では求めない
- `Makefile` やテストコードの変更。テストやビルドは任意のコード実行を伴う

対策として、外部からのPRは、作業ディレクトリでチェックアウトする前に、人間が設定ファイルの差分を確認する。`git fetch` と `git diff` はブランチを切り替えないため、`shellHook` は実行されない。

```sh
git fetch origin pull/<番号>/head:pr-<番号>
git diff main...pr-<番号> -- \
  ':(glob)**/AGENTS.md' ':(glob)**/AGENTS.override.md' \
  ':(glob)**/CLAUDE.md' ':(glob)**/CLAUDE.local.md' \
  ':(glob)**/.claude/**' ':(glob)**/.codex/**' ':(glob)**/.mcp.json' \
  ':(glob)**/.envrc' flake.nix flake.lock Makefile .github
```

各CLIは作業するディレクトリの階層にある指示ファイル（`AGENTS.md`・`AGENTS.override.md`・`CLAUDE.md` 等）も読み込むため、ルートだけでなく階層を問わず確認する。`':(glob)**/<名前>'` はルートと任意の階層の両方に一致する。

- 差分がある場合は、承認済みの `.envrc` がある作業ディレクトリでそのブランチをチェックアウトしない。direnvの読み込みを止めてから切り替えても、作業ディレクトリに戻った時点で再評価されるため、チェックアウト自体を避ける。
- 差分の内容を確認して問題がないと判断した場合も、チェックアウトの前に `direnv deny` で作業ディレクトリの承認を取り消し、変更後の `flake.nix` を確認し終えてから `direnv allow` で戻す。
- 外部のコードを実行する検証は、作業用の環境とは別の隔離環境で行う。

## 8. 人間による操作が必要な項目

1. Codexの検証スクリプトを利用者のシェルで実行し、結果を確認する。
2. 反映用の認証主体（GitHub AppまたはBot）を作成し、inuiだけに必要最小限の権限で導入する。現在のトークン（`repo`・`workflow` 等）を開発環境から外す。
3. 認証主体の分離後に、Rulesetを適用し、CODEOWNERSを追加する。
4. Claude Codeのサンドボックスは、設定ファイル（`.bashrc`・`.gitconfig`・`.mcp.json`・`.vscode` 等）が存在しない場所に `/dev/null` を重ねて、書き込みを防ぐ。その土台として、サンドボックスのコマンドの実行中は、ホスト側の作業ディレクトリにも空のファイルが作られ、未追跡のファイルとして見える。Claude Code（2.1.318）には、コマンドの終了後に空のファイルと空のディレクトリだけを削除する処理がある。ただし、ほかのサンドボックスのコマンドが動いている間は削除を後回しにするため、その間は残る。Claude Codeが途中で終了した場合も残る可能性がある。コミットに含めないよう、ファイルを個別に指定してコミットする。

## 9. 未解決のリスク

| リスク | 状態 |
| --- | --- |
| AIが利用者本人のトークンでGitHubを操作するため、マージ・保護設定の変更を技術的に防げない（Claudeは承認と拒否ルールで抑制） | GitHub設定待ち |
| `main` が保護されていない | GitHub設定待ち |
| 承認した `gh`・`git push` はサンドボックス外で動き、トークンを使える。承認時にコマンドを確認する必要がある | 指示 |
| Bashの拒否ルールは書き方を変えると回避できる | 指示（GitHub設定で補う） |
| Codexの各プロファイルの動作 | 未検証 |
| 実行中に新しく作られた `.env`、深さ8を超える `.env` は拒否されない | 未対応（受容済みの制約） |
| 作業領域外を指すシンボリックリンク経由の読み取り（Codex） | `make sandbox-check` で検出（指示） |
| VS CodeのGit認証連携（`GIT_ASKPASS`）経由の認証情報の取得 | 未対応（未検証） |
| 依存関係の取得など、ネットワークが必要な作業の経路 | 未対応（技術スタック決定後に検討） |
| 信頼できないブランチでの起動による設定の差し替え | 指示（起動前の差分確認） |
