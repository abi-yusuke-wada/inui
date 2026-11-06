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

申請・ワークフロー（申請を出す側）を題材に、休暇申請・経費精算（交通費）・申請状況の確認の3つを対象として小さく実装し、E2Eの動作と旧形式との比較を確認します。
自然言語はこの3画面へのIntent振り分けに使い、日付・金額・区分・状態は利用者が画面上で明示的に操作します。公式Jev、自然言語からの引数自動補完、MCPは、MVPの部署展開と費用に関する社内承認後へ延期します（[ADR-0006](docs/adr/0006-local-model-for-mvp.md)）。
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
| `make jev-check` | JEV接続プローブのオフラインテストを実行する |
| `make jev-probe` | 従来の自動選択。APIキーありは公式Jev（従量課金）、なしはローカルNLIへ接続する。MVP評価には`make jev-probe-local`を使う |
| `make jev-probe-dry-run` | 将来検証用の公式Jevリクエストを固定13入力で表示する（通信なし） |
| `make jev-probe-live` | 将来の公式Jev検証用。最大13回接続する（APIキー・通信許可・利用料金の確認が必要） |
| `make jev-probe-local` | 正式MVPの基準としてローカルNLIで固定13入力を検証する（公式APIキーを使わない） |
| `make jev-prompt-study` | キャッシュ済み重みで元の質問と採用した質問を比較する（外部通信・HTTPなし） |
| `make jev-local-setup` | 固定版local-jevとCPU用Python依存を取得する |
| `make jev-local-serve` | ローカルNLIを起動する（初回はモデル重み約0.87GBを取得） |

ローカルNLIの範囲・手順・未検証事項は [接続検証の説明](docs/jev-connection-check.md) を参照してください。MVP基準の検証では、サーバーとプローブの両方で`LOCAL_JEV_MODEL=nli-deberta-large`を明示し、`make jev-local-serve`と`make jev-probe-local`を使います。

プローブの従来の自動選択はコードに残っており、`make jev-probe`は`TYPESAFE_API_KEY`があれば公式Jevを呼びます。公式モードは将来の検証用として残し、現在のMVP基準には使いません。ローカル開発用だった位置づけ（[ADR-0005](docs/adr/0005-local-jev-for-development.md)）は、[ADR-0006](docs/adr/0006-local-model-for-mvp.md)で正式MVPの基準に変更しました。

Issue #16の分類条件は、固定13入力で正常9/9件・対象外と曖昧入力4/4件の全件一致です。同じモデルの候補説明と曖昧候補名を調整し、実Engine呼び出しと[利用者ホストのHTTP実測](docs/jev-local-http-results-2026-11-06.json)で13/13件を確認しました。質問・結果・重みの版は[比較記録](docs/jev-prompt-study-2026-11-06.json)に保存しています。以前の各1件以上という基準は導入確認の履歴です。Issue #4・#15での本実装・正式評価は残っています。

過去の多言語NLI比較は正常7/9件・異常0/4件でした。今回の改善ではモデルを変更していません。固定13入力を見ながら調整した結果であり、日本語全般の精度を保証するものではありません。質問・応答契約と再現手順は [接続検証の説明](docs/jev-connection-check.md) を参照してください。

アプリのビルド・起動等のターゲットは、Issue #4の実装に合わせて追加します。

### Linuxでのサンドボックスの前提条件

CLIのサンドボックスには、devShellが提供する `bubblewrap`（`bwrap`）と `socat` の両方が必要です。`bwrap` はユーザー名前空間を使います。Ubuntu 24.04以降ではAppArmorが非特権のユーザー名前空間を制限している場合があり、`bwrap` があってもサンドボックス内のコマンドが失敗します。CLIのサンドボックスの外にあるホスト側のシェルでdevShellに入り、`make sandbox-check` を実行して次を確認してください。CLIのサンドボックス内では、`bwrap` を入れ子で起動するためのユーザー名前空間が許可されず、ホスト側の設定が正しくても失敗することがあります。

- `bwrap`・`socat` がNixストア（`/nix/store/...`）のパスで表示される
- `kernel.apparmor_restrict_unprivileged_userns` が `1` なら、AppArmorによる制限あり
- 作業領域の `.aws` と `~/.aws` が存在する（開発環境に入るときに `flake.nix` の `shellHook` が作成する）
- 作業領域外を指すシンボリックリンクがない（`.git`・`.direnv`・`node_modules` 配下は検査しない）
- 最後に「サンドボックスの前提条件を満たしています」と表示される

`bwrap` の起動で失敗する場合は、ホスト側でユーザー名前空間を許可する必要があります。設定方法（`bwrap` 用のAppArmorプロファイル追加や上記sysctlの変更）は組織のセキュリティ方針に従って判断してください。WSL2では通常この制限はありません。

## 現在のステータス

MVPの範囲と完了条件、技術構成（[ADR-0001](docs/adr/0001-mvp-hosting-and-storage.md)）と開発環境（[ADR-0002](docs/adr/0002-development-environment.md)）、コアとPoCアプリの分離方針（[ADR-0003](docs/adr/0003-separate-core-from-poc-app.md)）を基に、[ADR-0006](docs/adr/0006-local-model-for-mvp.md)でローカルモデルを正式MVPの基準にしました。Issue #16の固定13入力は実Engine比較と利用者ホストのHTTP実測で全件一致を確認し、結果と分類の変更を[PR #22](https://github.com/abi-yusuke-wada/inui/pull/22)にまとめました。Issue #4でアプリ本体とローカル推論の配置・呼び出し経路を具体化します。Issue #15では、ローカルモデルを含むブラウザ送信からの応答が30秒以内かを実測します。アプリケーションは未実装です。
