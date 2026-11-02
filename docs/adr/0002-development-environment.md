# ADR-0002: 開発環境をNix Flakesとdirenvで管理する

- 状態: 決定（2026-10-30）
- 更新: 2026-11-02、Codexの機密ファイル拒否を追加。
- 関連: [Issue #3](https://github.com/abi-yusuke-wada/inui/issues/3)、[ADR-0001](0001-mvp-hosting-and-storage.md)

## 背景

ADR-0001で、フロントエンドはReact + TypeScript、APIはTypeScript + Hono / AWS Lambdaを採用した。開発者ごとの差異を減らし、MVPの開発・検証を再現できる環境が必要になった。

また、開発支援CLIのサンドボックスで秘密情報（`.env`・`.env.*`、`.aws` 配下）の読み取りを拒否する必要がある。Codexの従来の `workspace-write` は書き込み範囲の制限であり、機密情報の読み取りを防げないため、読み取り拒否を設定する権限プロファイルへ移行する。Linux・WSLでサンドボックスを動かすには `bubblewrap` と `socat` が必要になる。

## 比較した案

| 案 | 評価 |
| --- | --- |
| Nix Flakes + direnv | ツールとバージョンを `flake.lock` で固定でき、ディレクトリへの移動だけで環境に入れる。Nixとdirenvの導入が必要 |
| Nix Flakesのみ（`nix develop` を手動実行） | 構成は最小だが、環境に入り忘れるとサンドボックスが起動できない |
| 各自でNode.js等を導入（nvm・Volta等） | 導入は手軽だが、バージョンやサンドボックス用ツールの差異を防げない |

いずれもOSSで、ライセンス費用・クラウド費用は発生しない。

## 決定

- Nix Flakes（nixpkgs `nixos-26.05`）でdevShellを定義し、direnvの `use flake` でディレクトリ移動時に自動で読み込む。
- devShellには必要最小限として次を含める。
  - Node.js 24 LTS（`nodejs_24`）
  - pnpm（パッケージマネージャー）
  - `bubblewrap`・`socat`（Linux・WSLのみ。CLIのサンドボックス実行用）
- サンドボックスが利用できない場合は起動を止める設定とし、保護なしで実行しない。
- ビルド・実行・テスト等のコマンドは `Makefile` に集約する。pnpmのscriptsだけに置く案と比べ、Nixの検証やサンドボックスの確認などNode.js以外のコマンドも同じ入口から実行でき、READMEや開発支援CLIへの案内を `make <ターゲット>` に統一できる。GNU MakeはdevShell（`mkShell` の標準環境）に含まれ、追加費用はない。

## 影響

- 開発者はNixとdirenvを導入し、初回に `direnv allow` を実行する。CLIはdevShellに入った状態で起動する。
- Lambdaで使うNode.jsランタイムとのバージョン整合は、Issue #4の構築時に確認する。
- 社内でmacOSを使って開発する人はいないため、macOS（`aarch64-darwin`・`x86_64-darwin`）は `nix flake check --all-systems` で定義を評価できることだけを確認し、実機での動作確認はしない。nixpkgs 26.05は `x86_64-darwin` をサポートする最後のリリースである。
- テスト・Lint等のツールやディレクトリ構成は、Issue #4の実装に合わせて追加する。

## 機密ファイルのアクセス制御（2026-11-02追加）

Codexの [プロジェクト設定](../../.codex/config.toml) に `default_permissions = "inui"` を設定し、`:workspace` を継承する。通常の作業領域の編集と `approval_policy = "on-request"` を維持し、`.git`・`.agents`・`.codex` 等の標準保護を引き継ぐ。作業領域外への書き込み権限は追加しない。

拒否対象は、既存の [共有設定](../../.claude/settings.json) に合わせたプロジェクト内とホーム配下の `.env`・`.env.*`、プロジェクトの `.aws` と `~/.aws`。`.aws` はglobではなくディレクトリそのものを拒否し、起動後に作成されたファイルも保護する。ただし、起動時に存在しないディレクトリは拒否されないため、`flake.nix` の `shellHook` で作業領域の `.aws` と `~/.aws` を事前に作成する（権限700、既存の場合は変更しない）。`shellHook` はdirenvと `nix develop` のどちらで開発環境に入っても実行される。ローカル設定のGit操作の拒否ルールとは分け、ファイルアクセスをOSのサンドボックスで拒否する。AGENTS.mdへの指示や `.gitignore` だけでは読み取りを強制できないため、この方式を選ぶ。追加の依存関係・クラウド資源・利用料は発生せず、CLIごとの設定の保守と検証が必要になる。

旧 `sandbox_mode` はプロジェクト設定から削除する。権限プロファイルと旧 `sandbox_mode`・`sandbox_workspace_write` は併用できず、他の設定階層や起動引数に旧設定があるとプロファイルが適用されない場合がある。グローバル設定は変更しない。信頼済みのプロジェクトでCodexを再起動し、プロファイルを有効にする。[OpenAI公式の権限設定](https://learn.chatgpt.com/docs/permissions)

Linux・WSLの再帰globは `glob_scan_max_depth = 8` とし、各サンドボックスプロセスの起動時に一致するファイルを列挙する。深さ8を超える配置や、起動済みのプロセスの途中で作成された新しい一致ファイルまで保護するとは扱わない（ディレクトリ単位で拒否する `.aws` を除く）。必要な配置には明示的なパスを追加し、新しいプロセスで再確認する。`.env.example` も `.env.*` に一致するため拒否対象となる。

ホーム起点の `~/**/.env`・`~/**/.env.*` は、走査中に読み取れないディレクトリ等でエラーが起きるとサンドボックスを構築できず、コマンドを起動できない。保護範囲を狭めるより、起動できない側（保護なしで実行しない側）に倒れる挙動を受け入れ、ホーム全体の保護を維持する。起動できない場合は、エラーになったディレクトリの権限を確認する。

`:workspace` はファイルシステム全体の読み取りを許可するため、作業領域内に外部ディレクトリを指すシンボリックリンクがあると、リンク先の `.env` はglobの展開対象にならず読み取れる（2026-11-02に `codex sandbox` で確認）。作業領域外の読み取りを禁止するプロファイルは、Nixストア等の開発ツールの読み取りも妨げるため採用しない。代わりに、作業領域外を指すシンボリックリンクを作らないこととし、`make sandbox-check` で検出する（`.git`・`.direnv`・`node_modules` を除く）。

Codex CLI 0.165.0 / LinuxのNix環境で、プロファイルの強制指定をせずに `codex sandbox -- ...` を実行して検証した。プロジェクト内・入れ子・ホーム配下のプロジェクト外のダミー `.env`、プロジェクトとホームの `.aws` 内のダミー、シンボリックリンク経由について、Pythonの読み取り・`cat`・書き込みが拒否された。通常ファイルの読み書きと作業領域外の書き込み拒否も確認した。実際の機密情報は使用せず、作成した一時ファイルは削除済み。macOS・Windowsと、外部MCPツール等の別の実行経路は未検証とする。

## GitHubへの通信（2026-11-02追加）

GitHub CLIとGitが情報取得に失敗し、このCodex実行環境ではIPv4・IPv6のソケット作成が `EPERM`、GitHubの名前解決が失敗することを確認した。`inui` プロファイルには通信許可がなく、ネットワーク無効の既定値を継承していた。

プロジェクト設定で `features.network_proxy = true` と `permissions.inui.network.enabled = true` を併用し、許可リストにはHTTPSのGit操作用の `github.com` とGitHub CLIのAPI用の `api.github.com` を指定する。通信だけを有効化する案は、プロキシがなければドメイン制限が効かず直接通信を許可するため採用しない。プロキシを使って接続先を限定し、既存の機密ファイルdeny・`:workspace` の継承・`on-request` を維持する。追加のサービス・依存関係・クラウド費用はない。[OpenAI公式の通信設定](https://learn.chatgpt.com/docs/permissions#network-permissions)

Codexでの設定読み込みとTOML構文、許可先が上記2ホストだけであること、既存のファイル制御が変更されていないことを確認した。起動済みのセッションの通信制限はファイル編集だけでは変わらないため、信頼済みのプロジェクトでCodexを再起動し、GitHub CLI・Gitの接続と許可リストの動作を確認する。実通信と許可外ホストの拒否は再起動後の検証事項とし、接続成功はまだ確認していない。上位の管理ポリシーによる制限があればそちらに従う。Nix daemonへのUnixソケット接続は、このGitHub用の通信許可とは別に扱う。
