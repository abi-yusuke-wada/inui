# 作業の引き継ぎ

CLIを切り替えるときに、最新の引き継ぎ1件へ更新する。共通ルールは [AGENTS.md](../AGENTS.md)、仕様は [MVP.md](../MVP.md)、設計判断は既存のADRを参照する。

## 対象・状態

- 対象: Issue #16のJEV接続仕様・接続検証の準備。利用者は着手を了承済み。
- 現在のブランチ: `chore/issue-16-jev-connection-check`。利用者が最新mainを取得し、PR #20マージ後の`origin/main`（`157dd2f`）から作成した。切り替え前に指示・設定ファイルの差分がないことを確認した。
- 変更: SDKや依存関係を追加せず、Node.js標準機能を使う接続・Intent分類プローブ、オフラインテスト、Makefileの入口、READMEと[検証手順](jev-connection-check.md)を追加。設定・MVPの完了条件は変更していない。実接続は未実施で、Issue #16全体は未完了。
- 役割分担: PoC実装はIssue #4、JEVを含む1回の応答が30秒以内かの正式な実測はIssue #15で扱う（[ADR-0001](adr/0001-mvp-hosting-and-storage.md)）。MVPではLLMを使わない（[ADR-0004](adr/0004-jev-first-intent-routing.md)）。

## 調査結果

- 既存資料のJEV / Choiceに合致する候補として、TypeSafeのJevを確認した。接続先は`POST https://api.typesafe.ai/v1/systemone`で、APIキーによるBearer認証を使う。製品・接続方式の採用決定と実接続検証は未了。[公式導入ガイド](https://docs.typesafe.ai/introduction/quickstart)、[API仕様](https://docs.typesafe.ai/api/system-one)
- Choiceは提示した候補を選ぶ方式で、選択肢・確率・confidenceを返す。任意の引数JSONを自由生成する前提にはしない。[Choice](https://docs.typesafe.ai/primitives/choice)
- 日付は部品をChoiceで選んでコードで暦計算する例、金額は原文から候補を抽出してChoiceで選びコードで正規化する例がある。日本語の表記、昨日・明日、年省略時の2026年固定など、MVPの規則への適用は未検証。[日付の公式例](https://docs.typesafe.ai/cookbooks/date_extraction_cookbook)、[値抽出の公式例](https://docs.typesafe.ai/cookbooks/pre_parsed_value_extraction_cookbook)
- CJKを含む他言語も扱うが、公式は英語と同等の精度を保証していない。MVPの日本語入力で確認する。[言語対応](https://docs.typesafe.ai/models#language-support)
- 検証範囲の案: MVPの正常9入力、対象外・曖昧な4入力、通信失敗・タイムアウト時の扱い。MCPはinuiがServer側となる方針を維持し、公開Tool・利用側・入出力・通信方式・SDK対応版・配置は未確定として確認する。

## 検証結果

- `make jev-check`が成功。単一プロセスで39件を検出し、成功39・失敗0・スキップ0を確認した。通信はモックで、実APIの分類精度を確認した結果ではない。
- 通常のNodeテスト実行ではファイル単位1件だけが報告されたため、今回の単一テストファイルは`--test-isolation=none`で実行する。個々のテスト名と39件の集計を独立に再確認した。元の検出問題の原因は未確定。
- `make jev-probe`が成功し、13件のリクエストを通信なしで表示できた。全件`not_run`であり、実接続の成功を示すものではない。差分の空白検査も成功した。
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
- [検証手順](jev-connection-check.md)に従い、リクエストを`make jev-probe`で確認したうえで、利用者のホスト側で`make jev-probe-live`を実行する。最大13回の外部API呼び出しと料金を確認してから行う。結果を確認するまで実接続や日本語の分類を成功扱いしない。
- 日付・金額の抽出とMCPの接続条件は引き続きIssue #16で検証する。今回のプローブは接続とIntent分類だけを扱い、業務APIや保存は実行しない。
- 接続検証の結果と採用判断はMVP・ADRへ反映し、提案と決定済みを区別する。30秒条件の正式な判定は引き続きIssue #15に残す。
- CLIを切り替える際は、このメモに加えて現在のブランチ・`git status`・差分を確認する。GitHubへの反映とレビューはAGENTS.mdの手順に従う。
