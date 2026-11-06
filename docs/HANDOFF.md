# 作業の引き継ぎ

CLIを切り替えるときに、最新の引き継ぎ1件へ更新する。共通ルールは [AGENTS.md](../AGENTS.md)、仕様は [MVP.md](../MVP.md)、設計判断は既存のADRを参照する。

## 対象・状態

- 対象: Issue #16の接続検証と、ローカル開発時の公式Jev・実モデルの自動切替。利用者はキー設定時に公式Jev、未設定時に実ローカルモデルを使う方針を了承済み。
- 現在のブランチ: `chore/issue-16-jev-connection-check`。利用者が最新mainを取得し、PR #20マージ後の`origin/main`（`157dd2f`）から作成した。切り替え前に指示・設定ファイルの差分がないことを確認した。
- 変更: Node.js標準機能のプローブへAPIキーの有無による自動切替と明示モードを実装。ローカル用にPython 3.12・uv、固定版local-jevの導入・起動ターゲットを追加し、[ADR-0005](adr/0005-local-jev-for-development.md)とMVPへ開発時の例外を記録した。正式なMVP評価のモデル・完了条件は維持する。実推論は未確認で、Issue #16全体は未完了。
- 役割分担: PoC実装はIssue #4、JEVを含む1回の応答が30秒以内かの正式な実測はIssue #15で扱う（[ADR-0001](adr/0001-mvp-hosting-and-storage.md)）。MVPではLLMを使わない（[ADR-0004](adr/0004-jev-first-intent-routing.md)）。

## 調査結果

- 既存資料のJEV / Choiceに合致する候補として、TypeSafeのJevを確認した。接続先は`POST https://api.typesafe.ai/v1/systemone`で、APIキーによるBearer認証を使う。製品・接続方式の採用決定と実接続検証は未了。[公式導入ガイド](https://docs.typesafe.ai/introduction/quickstart)、[API仕様](https://docs.typesafe.ai/api/system-one)
- Choiceは提示した候補を選ぶ方式で、選択肢・確率・confidenceを返す。任意の引数JSONを自由生成する前提にはしない。[Choice](https://docs.typesafe.ai/primitives/choice)
- 日付は部品をChoiceで選んでコードで暦計算する例、金額は原文から候補を抽出してChoiceで選びコードで正規化する例がある。日本語の表記、昨日・明日、年省略時の2026年固定など、MVPの規則への適用は未検証。[日付の公式例](https://docs.typesafe.ai/cookbooks/date_extraction_cookbook)、[値抽出の公式例](https://docs.typesafe.ai/cookbooks/pre_parsed_value_extraction_cookbook)
- CJKを含む他言語も扱うが、公式は英語と同等の精度を保証していない。MVPの日本語入力で確認する。[言語対応](https://docs.typesafe.ai/models#language-support)
- 検証範囲の案: MVPの正常9入力、対象外・曖昧な4入力、通信失敗・タイムアウト時の扱い。MCPはinuiがServer側となる方針を維持し、公開Tool・利用側・入出力・通信方式・SDK対応版・配置は未確定として確認する。
- ローカル開発の候補はlocal-jevのNLIモデル`nli-deberta-large`。上流は利用者がホスト側で確認した`64a0b31ff343dca32142496cf9edca5a0174a18d`に固定した。モデル重み約0.87GBとは別にruntimeの取得と推論メモリが必要。モデルカードは英語向けで、日本語への適合は実測後に判断する。

## 検証結果

- `make jev-check`が成功。単一プロセスで70件を検出し、成功70・失敗0・スキップ0を確認した。キー有無による自動選択、強制モード、ローカルへのキー非送信、失敗時に接続先を変えないこと、確率丸めを検証した。通信はテスト用の差し替えであり、実モデルの精度を確認した結果ではない。
- 通常のNodeテスト実行ではファイル単位1件だけが報告されたため、今回の単一テストファイルは`--test-isolation=none`で実行する。個々のテスト名と件数を確認した。元の検出問題の原因は未確定。
- `make jev-probe-dry-run`が成功し、13件の公式Jev向けリクエストを通信なしで表示できた。全件`not_run`であり、実接続の成功を示すものではない。`make jev-probe`は現在、自動切替で実際に接続する入口である。
- `nix-instantiate --parse flake.nix`は成功。Python 3.12.15とuvの実体も使用可能になった。一方、こちらからの`nix develop --command make check jev-local-setup`は、承認付きでもNixストアの所有権処理で失敗した。
- Nix版Pythonとuvを明示して`.local-jev/venv`の作成には成功した。その後のCPU用PyTorch取得は、通常・承認付き実行ともに`download.pytorch.org`の名前解決で失敗した。local-jevの導入・モデル取得・実推論は未実施。
- セッションの権限は作業領域への書き込みを許可する状態へ切り替わった。利用者はホスト側で`nix develop`後にCodex本体を起動し直したと回答した。
- `.direnv/flake-profile`には生成済みdevShellがあり、記録されたPATHではNode.js・pnpm・Makeの実体が見つかる。一方、こちらのコマンド実行環境のPATHでは3つとも見つからない。
- 2026-11-06、利用者がホスト側devShellのPATHを提示。対応するNixストア内の実体を直接呼ぶと、Node.js `v24.22.1`、pnpm `11.27.0`、GNU Make `4.4.1`の起動を確認できた。ツールの実体は使用可能で、コマンドへそのパスを明示できる。devShell全体の環境が自動で継承されない原因は未確定。
- プロジェクト設定は`inherit = "core"`、`allow_login_shell = false`で、PATHの明示的な上書きはない。環境が反映されない原因は未確定。設定の変更や権限の緩和は行っていない。
- 通常の`nix develop`・direnv再読み込みは、作業領域外のNixキャッシュのロック作成が`Read-only file system`で失敗。承認付き実行も、`/nix/store`の所有権処理で`Invalid argument`となった。
- 生成済みprofileをNixデーモン経由で読む方法も試したが、通常・承認付き実行ともにデーモンソケットへの接続が`Operation not permitted`で拒否された。
- 最新mainを公開リポジトリから取得する操作も試した。通常実行は`.git/FETCH_HEAD`への書き込みが拒否され、承認付き実行は`Could not resolve host: github.com`で失敗した。認証ヘルパーは無効にして実行し、認証情報は使っていない。
- 利用者のホスト側での取得は成功し、`origin/main`は`157dd2f`へ更新された。作業ブランチはこのコミットを基点としている。
- Issue #16本文はWeb経由で取得できていない。上記の範囲は手元のMVP・ADRに基づく。APIキーの取得・読み取り、Jevへの実リクエスト、アプリのビルド・テストは未実施。
- 既存のセキュリティ設定と過去の検証結果は、[ADR-0002](adr/0002-development-environment.md) と [AI開発エージェントの権限と運用](agent-security.md) を参照する。

## 未完了事項・次の作業

- コマンド実行時はdevShellが供給するツールのパスを明示できる。環境が自動で継承されない原因は引き続き未確定で、設定ファイルの不具合と断定しない。
- TypeSafeのアカウント・APIキー準備と利用条件を確認する。キーの実値をチャットや文書へ保存しない。
- ホスト側の変更後devShellで`make check jev-local-setup`を実行する。成功後は`make jev-local-serve`でNLIモデルを起動し、別のdevShellで`make jev-probe-local`を実行する。初回起動時にモデル重みを取得する。結果を確認するまで導入や日本語分類を成功扱いしない。
- `make jev-probe`はキーありなら公式Jev（課金）、キーなしならローカルを使う。通信なしの確認には`make jev-probe-dry-run`を使う。公式API用のキーをローカルへ送らず、公式Jevの失敗時もローカルへ自動で切り替えない。
- 日付・金額の抽出とMCPの接続条件は引き続きIssue #16で検証する。今回のプローブは接続とIntent分類だけを扱い、業務APIや保存は実行しない。
- 接続検証の結果と採用判断はMVP・ADRへ反映し、提案と決定済みを区別する。30秒条件の正式な判定は引き続きIssue #15に残す。
- CLIを切り替える際は、このメモに加えて現在のブランチ・`git status`・差分を確認する。GitHubへの反映とレビューはAGENTS.mdの手順に従う。
