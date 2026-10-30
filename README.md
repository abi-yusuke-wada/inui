# inui

inui（Intent + UI）は、Intent-driven Web UIを小さく検証する研究用MVP / PoCです。

## 背景と目的

従来のWebアプリでは、ユーザーがメニューや画面遷移を通じて機能へアクセスします。
inuiでは、自然言語からユーザーのIntentを判定し、必要な業務UIを直接表示する方式を検証します。
大規模なプロダクトや汎用プラットフォームの開発は目指しません。

## 中核思想

- **Intent-driven UI**：ユーザーのIntentを起点に、必要な業務UIを表示する。
- **Thin Client**：ブラウザにLLMや自律的なAIエージェントを常駐させず、入力受付と事前実装済みUIの描画を中心に担わせる。
- **Server-side Intent Orchestration**：Intent判定の制御、業務処理、Tool選択、UI選択をホスト側に置く。AIの判断結果は許可リストや検証処理で制御する。
- **既存資産の再利用**：HTMLやJavaScriptをAIで自由生成せず、既存の業務APIと事前実装済みUIコンポーネントを再利用する。
- **小さく検証する**：性能、クライアント負荷、セキュリティ上の特性を、推測ではなく検証結果に基づいて評価する。

## MVPの方向性

アンケート回答・指定日の予定参照・個人の表示設定変更の3つを対象に、小さく実装してE2E動作を確認します。
範囲と完了条件は [MVP.md](MVP.md) にまとめます。

## 開発環境

[Nix](https://nixos.org/)（Flakes有効）と [direnv](https://direnv.net/) を利用します。構成と判断理由は [ADR-0002](docs/adr/0002-development-environment.md) にまとめます。

初回は、使用するシェルにdirenvのフックを設定してから `direnv allow` を実行します。フック設定後は、ディレクトリ移動時に開発環境が現在のシェルへ自動で反映されます。他のシェルの設定は [direnvのドキュメント](https://direnv.net/docs/hook.html) を参照してください。

```sh
# bashの例（初回のみ。設定後にシェルを開き直す）
echo 'eval "$(direnv hook bash)"' >> ~/.bashrc

cd inui
direnv allow   # 初回のみ
node --version # devShellのNode.js 24が表示されることを確認
```

direnvを使わない場合は `nix develop` で開発環境に入ります。

### Linuxでのサンドボックスの前提条件

CLIのサンドボックスには、devShellが提供する `bubblewrap`（`bwrap`）と `socat` の両方が必要です。`bwrap` はユーザー名前空間を使います。Ubuntu 24.04以降ではAppArmorが非特権のユーザー名前空間を制限している場合があり、`bwrap` があってもサンドボックス内のコマンドが失敗します。devShell内で次を確認してください。

```sh
command -v bwrap   # /nix/store/...-bubblewrap-.../bin/bwrap が表示される
command -v socat   # /nix/store/...-socat-.../bin/socat が表示される
sysctl kernel.apparmor_restrict_unprivileged_userns   # 1 なら制限あり
bwrap --ro-bind / / --dev /dev --proc /proc --unshare-all true && echo ok
```

最後のコマンドが失敗する場合は、ホスト側でユーザー名前空間を許可する必要があります。設定方法（`bwrap` 用のAppArmorプロファイル追加や上記sysctlの変更）は組織のセキュリティ方針に従って判断してください。WSL2では通常この制限はありません。

## 現在のステータス

MVPの範囲と完了条件は整理済みです。現在は [ADR](docs/adr/0001-mvp-hosting-and-storage.md) で技術構成と接続・運用方式を整理しています。アプリケーションは未実装です。
