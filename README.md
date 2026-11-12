# inui

inui（Intent + UI）は、Intent-driven Web UIを小さく検証する研究用MVP / PoCです。

## 背景と目的

従来のWebアプリでは、ユーザーがメニューや画面遷移を通じて機能へアクセスします。
inuiでは、自然言語からユーザーのIntentを判定し、必要な業務UIを直接表示する方式を検証します。
大規模なプロダクトや汎用プラットフォームの開発は目指しません。

### 研究の問い

inuiの問題提起は「LLMにどんなUIを生成させるか」ではありません。LLMは応答が遅く、費用もかさみます。JEVのように安く速く使えるルーターで入力を適切な画面へ振り分けるだけで、アプリケーションのこれまでのUI/UXを最適化できるのではないか、という点にあります。

そこで、安く速いルーターによる振り分けで、これまでのUI/UXを最適化できるかを検証します。正式なMVPはlocal-jevのNLIモデル`nli-deberta-large`を基準とし、LLMを使いません。モデル変更が必要になった場合は事前に相談します（[ADR-0006](docs/adr/0006-local-model-for-mvp.md)）。旧形式（メニューや画面遷移で目的の画面を開くUI）と同じ作業で比較し、inuiが有利な例だけでなく不利な例も示します。

## 中核思想

- **Intent-driven UI**：ユーザーのIntentを起点に、必要な業務UIを表示する。
- **安く速い振り分け**：Intent判定は、local-jevのNLIモデルを基準に小さく検証する。
- **Thin Client**：ブラウザにLLMや自律的なAIエージェントを常駐させず、入力受付と事前実装済みUIの描画を中心に担わせる。
- **Server-side Intent Orchestration**：Intent判定の制御、業務処理、UI選択をホスト側に置く。AIの判断結果は許可リストや検証処理で制御する。
- **既存資産の再利用**：HTMLやJavaScriptをAIで自由生成せず、既存の業務APIと事前実装済みUIコンポーネントを再利用する。
- **小さく検証する**：性能、クライアント負荷、セキュリティ上の特性を、推測ではなく検証結果に基づいて評価する。

## MVPの方向性

休暇申請・経費精算（交通費）・申請状況の確認・複数人の予定比較を対象として小さく実装し、E2Eの動作と旧形式との比較を確認します。
自然言語から4画面へ振り分け、予定比較では文章中の人名をサンプル社員辞書へ照合して対象者を選択済みにします。日付・金額・区分・状態は画面上で明示的に操作します。公式Jev、これらの申請項目の自動補完、製品MCPは、部署展開と費用に関する社内承認後へ延期します（[ADR-0006](docs/adr/0006-local-model-for-mvp.md)、[ADR-0008](docs/adr/0008-local-poc-workflows.md)）。
範囲と完了条件は [MVP.md](MVP.md) にまとめます。

## 開発環境

[Nix](https://nixos.org/)（Flakes有効）と [direnv](https://direnv.net/) を利用します。構成と判断理由は [ADR-0002](docs/adr/0002-development-environment.md) にまとめます。

`.envrc` の `use flake` を使うため、`use flake` に対応したdirenvが必要です。Ubuntu 22.04の標準パッケージ（direnv 2.25.2）など古い版は対応していないため、`nix profile install nixpkgs#direnv` でNixから導入してください（direnv 2.37.1で動作確認済み）。導入済みの版は `direnv version` で確認できます。

初回は、使用するシェルにdirenvのフックを設定してから `direnv allow` を実行します。フック設定後は、ディレクトリ移動時に開発環境が現在のシェルへ自動で反映されます。他のシェルの設定は [direnvのドキュメント](https://direnv.net/docs/hook.html) を参照してください。

```sh
# bashの例（初回のみ。設定後にシェルを開き直す）
echo 'eval "$(direnv hook bash)"' >> ~/.bashrc

cd inui
direnv allow   # 初回のみ
node --version # devShellのNode.js 24が表示されることを確認
```

direnvを使わない場合は `nix develop` で開発環境に入ります。

### コマンド

ビルド・実行・テスト等のコマンドは `Makefile` に集約します。devShell内で `make` を実行するとターゲット一覧を表示します。

| コマンド | 内容 |
| --- | --- |
| `make check` | 開発環境の定義（`nix flake check`）と差分の空白を検証する |
| `make sandbox-check` | CLIのサンドボックスの前提条件を確認する |
| `make app-setup` | 固定lockfileの公開npm依存を取得する。利用者の認証設定を参照せず、インストールscriptを実行しない |
| `make app-setup-offline` | 取得済み依存だけでworkspaceのリンクを更新する（通信なし） |
| `make app-dev` | アプリ（`127.0.0.1:8766`）と実NLI（`127.0.0.1:8765`）をまとめて起動する |
| `make app-smoke` | 不足しているサーバーを起動し、実NLIを含む19入力のHTTP検証を行う |
| `make app-run` | アプリだけを起動する。実NLIを別に管理する場合に使う |
| `make app-check` | コア・API・SQLite・Webの単体テスト、DOM操作テスト、型検査・ビルドを実行する |
| `make lint` | BiomeでTypeScript・React・CSSを、actionlintでGitHub Actionsの定義を検査する |
| `make ci` | lint・型検査・ビルド・テストをまとめて実行する。実NLIやAPIキーは不要 |
| `make core-check` | 独立コアの単体テストだけを通信なしで実行する |
| `make app-model-check` | キャッシュ済み実NLIで7候補・19入力を検証する（HTTP・外部通信なし） |
| `make app-probe` | 起動中のPoCを19入力でHTTP検証する。申請の保存はしない |
| `make app-diagnose` | アプリとlocal-jevへの接続を個別に確認する。応答本文や秘密情報は表示しない |
| `make app-reset` | アプリ停止後、ローカルの申請データを初期2件へ戻す |
| `make jev-check` | JEV接続プローブのオフラインテストを実行する |
| `make jev-probe` | 旧検証用の自動選択。APIキーありは公式Jev（従量課金）、なしはローカルNLIへ接続する。現PoCの評価は`make app-probe`を使う |
| `make jev-probe-dry-run` | 将来検証用の公式Jevリクエストを固定13入力で表示する（通信なし） |
| `make jev-probe-live` | 将来の公式Jev検証用。最大13回接続する（APIキー・通信許可・利用料金の確認が必要） |
| `make jev-probe-local` | Issue #16時点の6候補・固定13入力をローカルNLIで再現する（公式APIキーを使わない） |
| `make jev-prompt-study` | キャッシュ済み重みで元の質問と採用した質問を比較する（外部通信・HTTPなし） |
| `make jev-local-setup` | ソースSHAを固定したlocal-jevと、バージョン未固定のCPU用runtimeを取得する |
| `make jev-local-versions` | 導入済みruntimeの実バージョンを表示する（通信なし） |
| `make jev-local-pin-model` | 実測revisionの重み・tokenizerを取得し、同名モデルのローカルカードへ固定する |
| `make jev-local-serve` | ローカルNLIを起動する（初回はモデル重み約0.87GBを取得） |

Issue #16時点のローカルNLI検証の範囲・手順は[接続検証の説明](docs/jev-connection-check.md)を参照してください。旧13入力を再現する場合は、サーバーとプローブの両方で`LOCAL_JEV_MODEL=nli-deberta-large`を明示します。予定比較を含む現PoCの7候補・19入力は、`make app-model-check`と、起動後の`make app-probe`で確認します。

プローブの従来の自動選択はコードに残っており、`make jev-probe`は`TYPESAFE_API_KEY`があれば公式Jevを呼びます。公式モードは将来の検証用として残し、現在のMVP基準には使いません。ローカル開発用だった位置づけ（[ADR-0005](docs/adr/0005-local-jev-for-development.md)）は、[ADR-0006](docs/adr/0006-local-model-for-mvp.md)で正式MVPの基準に変更しました。

Issue #16の分類条件は、固定13入力で正常9/9件・対象外と曖昧入力4/4件の全件一致です。同じモデルの候補説明と曖昧候補名を調整し、実Engine呼び出しと[利用者ホストのHTTP実測](docs/jev-local-http-results-2026-11-06.json)で13/13件を確認しました。質問・結果・重みの版は[比較記録](docs/jev-prompt-study-2026-11-06.json)に保存しています。以前の各1件以上という基準は導入確認の履歴です。Issue #4・#15での本実装・正式評価は残っています。

過去の多言語NLI比較は正常7/9件・異常0/4件でした。今回の改善ではモデルを変更していません。固定13入力を見ながら調整した結果であり、日本語全般の精度を保証するものではありません。質問・応答契約と再現手順は [接続検証の説明](docs/jev-connection-check.md) を参照してください。

ローカルPoCの起動・予定比較・保存・旧形式での操作は[実行手順](docs/poc-local.md)を参照してください。自然言語UIと`/legacy`は同じ業務UI・API・データを使います。ローカルSQLiteによる保存であり、Turso・GitHub認証・AWSへの配置は未実装です。

アプリのコードはルートの`src/`、ブラウザの画面とCSSは`src/web/`、独立したIntent判定は`packages/core/`に置きます。アプリ・画面・実行スクリプトのテストは`tests/`へまとめ、コアのテストは`packages/core/tests/`に置きます。ビルド結果は`dist/`、申請DB・診断結果・依存キャッシュは`.local-poc/`に作られ、どちらもGitの管理対象外です。

GitHub Actionsの[CI](.github/workflows/ci.yml)はPRとmainへのpushで`make ci`を実行します。Nixの固定環境とpnpmの固定lockfileを使い、モデルやクラウド環境は起動しません。lintツールを追加した環境へは`nix develop`で入り直してください。

バックエンドのログは`src/logger.ts`で共通化し、時刻・レベル・イベント・リクエストID・処理時間などを1行JSONで出力します。既定は`info`で、`LOG_LEVEL=debug make app-dev`などで切り替えられます。出力内容と確認方法は[実行手順](docs/poc-local.md#バックエンドのログ)を参照してください。

### Linuxでのサンドボックスの前提条件

CLIのサンドボックスには、devShellが提供する `bubblewrap`（`bwrap`）と `socat` の両方が必要です。`bwrap` はユーザー名前空間を使います。Ubuntu 24.04以降ではAppArmorが非特権のユーザー名前空間を制限している場合があり、`bwrap` があってもサンドボックス内のコマンドが失敗します。CLIのサンドボックスの外にあるホスト側のシェルでdevShellに入り、`make sandbox-check` を実行して次を確認してください。CLIのサンドボックス内では、`bwrap` を入れ子で起動するためのユーザー名前空間が許可されず、ホスト側の設定が正しくても失敗することがあります。

- `bwrap`・`socat` がNixストア（`/nix/store/...`）のパスで表示される
- `kernel.apparmor_restrict_unprivileged_userns` が `1` なら、AppArmorによる制限あり
- 作業領域の `.aws` と `~/.aws` が存在する（開発環境に入るときに `flake.nix` の `shellHook` が作成する）
- 作業領域外を指すシンボリックリンクがない（`.git`・`.direnv`・`node_modules` 配下は検査しない）
- 最後に「サンドボックスの前提条件を満たしています」と表示される

`bwrap` の起動で失敗する場合は、ホスト側でユーザー名前空間を許可する必要があります。設定方法（`bwrap` 用のAppArmorプロファイル追加や上記sysctlの変更）は組織のセキュリティ方針に従って判断してください。WSL2では通常この制限はありません。

## 現在のステータス

[ADR-0006](docs/adr/0006-local-model-for-mvp.md)でローカルモデルを正式MVPの基準とし、既存13入力の分類・HTTP検証を[PR #22](https://github.com/abi-yusuke-wada/inui/pull/22)へまとめました。現在はIssue #4で4つの業務を扱うローカルPoCを実装しています。構成と部署展開との境界は[ADR-0008](docs/adr/0008-local-poc-workflows.md)を参照してください。予定比較を加えた7候補の実NLI検証は従来の6候補とは別に記録します。部署向けの推論配置・認証・Turso接続は残っており、正式な30秒条件はIssue #15で実測します。
