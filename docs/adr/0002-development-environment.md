# ADR-0002: 開発環境をNix Flakesとdirenvで管理する

- 状態: 決定（2026-10-30）
- 関連: [Issue #3](https://github.com/abi-yusuke-wada/inui/issues/3)、[ADR-0001](0001-mvp-hosting-and-storage.md)

## 背景

ADR-0001で、フロントエンドはReact + TypeScript、APIはTypeScript + Hono / AWS Lambdaを採用した。開発者ごとの差異を減らし、MVPの開発・検証を再現できる環境が必要になった。

また、開発支援CLIのサンドボックスで秘密情報（`.env`、`~/.aws`）の読み取りを拒否する設定を共有している。ただし、この保護は読み取り拒否を設定できるCLIの設定ファイルに依存する。書き込み範囲の制限だけを設定しているCLIでは、作業領域内の `.env` 等の読み取りは保護されない。そのようなCLIを使う場合は、作業領域に実際の秘密情報を置かない。Linux・WSLでサンドボックスを動かすには `bubblewrap` と `socat` が必要で、これらが無い環境ではサンドボックスなしで実行されてしまう。

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
