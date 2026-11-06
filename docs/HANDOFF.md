# 作業の引き継ぎ

CLIを切り替えるときに、最新の引き継ぎ1件へ更新する。共通ルールは [AGENTS.md](../AGENTS.md)、仕様は [MVP.md](../MVP.md)、設計判断は既存のADRを参照する。

## 対象・状態

- 対象: Issue #16の接続検証と、ローカル開発時の公式Jev・実モデルの自動切替。利用者はキー設定時に公式Jev、未設定時に実ローカルモデルを使う方針を了承済み。
- 現在のブランチ: `chore/issue-16-jev-connection-check`。利用者が最新mainを取得し、PR #20マージ後の`origin/main`（`157dd2f`）から作成した。切り替え前に指示・設定ファイルの差分がないことを確認した。
- 変更: APIキーによる公式Jev・ローカル実モデルの自動切替を実装済み。利用者のホストで既定NLIが起動し、実推論の13応答を確認したが分類一致は7件だった。結果を保存し、既定を維持したまま多言語NLI候補を明示選択できる比較手順を追加した。公式Jevと正式MVPの条件は維持し、Issue #16全体は未完了。
- 役割分担: PoC実装はIssue #4、JEVを含む1回の応答が30秒以内かの正式な実測はIssue #15で扱う（[ADR-0001](adr/0001-mvp-hosting-and-storage.md)）。MVPではLLMを使わない（[ADR-0004](adr/0004-jev-first-intent-routing.md)）。

## 調査結果

- 既存資料のJEV / Choiceに合致する候補として、TypeSafeのJevを確認した。接続先は`POST https://api.typesafe.ai/v1/systemone`で、APIキーによるBearer認証を使う。製品・接続方式の採用決定と実接続検証は未了。[公式導入ガイド](https://docs.typesafe.ai/introduction/quickstart)、[API仕様](https://docs.typesafe.ai/api/system-one)
- Choiceは提示した候補を選ぶ方式で、選択肢・確率・confidenceを返す。任意の引数JSONを自由生成する前提にはしない。[Choice](https://docs.typesafe.ai/primitives/choice)
- 日付は部品をChoiceで選んでコードで暦計算する例、金額は原文から候補を抽出してChoiceで選びコードで正規化する例がある。日本語の表記、昨日・明日、年省略時の2026年固定など、MVPの規則への適用は未検証。[日付の公式例](https://docs.typesafe.ai/cookbooks/date_extraction_cookbook)、[値抽出の公式例](https://docs.typesafe.ai/cookbooks/pre_parsed_value_extraction_cookbook)
- CJKを含む他言語も扱うが、公式は英語と同等の精度を保証していない。MVPの日本語入力で確認する。[言語対応](https://docs.typesafe.ai/models#language-support)
- 検証範囲の案: MVPの正常9入力、対象外・曖昧な4入力、通信失敗・タイムアウト時の扱い。MCPはinuiがServer側となる方針を維持し、公開Tool・利用側・入出力・通信方式・SDK対応版・配置は未確定として確認する。
- ローカルの既定はlocal-jevの`nli-deberta-large`。上流は`64a0b31ff343dca32142496cf9edca5a0174a18d`に固定。英語向けモデルで今回の日本語分類は不十分だったが、言語・モデル・候補説明の原因は切り分けていない。
- 比較候補は`nli-multilingual-minilm`（`MoritzLaurer/multilingual-MiniLMv2-L6-mnli-xnli`）。CPUで使い、既存モデルの校正係数は流用しない。重みファイル428MBに加えてtokenizer等の取得が必要で、日本語精度・速度の改善は未確認。

## 検証結果

- `make jev-check`が成功。単一プロセスで79件を検出し、成功79・失敗0・スキップ0を確認した。自動選択、強制モード、キー非送信、接続先を変えない失敗処理、丸め誤差に加え、候補を指定した場合だけモデルが変わることと応答モデルの一致を検証した。通信はテスト用の差し替えであり、分類精度の結果ではない。
- 利用者の`make jev-probe-local`の提示ログでは、13応答・分類一致7/13（正常5/9、対象外・曖昧2/4）。平均3935ms、中央値3823ms、最大5578ms。6件の分類不一致により終了1となった。ログを[結果JSON](jev-local-results-2026-11-06.json)に保存した。公式Jevとブラウザを含む正式な30秒条件の結果ではない。
- 提示ログ後にインストール済みmetadataを確認し、local-jev 0.2.0、torch 2.15.0+cpu、transformers 5.22.1を記録した。候補カードはインストール済みlocal-jevの読み取り処理で受理できることを確認したが、候補の重み取得・推論は実行していない。
- 通常のNodeテスト実行ではファイル単位1件だけが報告されたため、今回の単一テストファイルは`--test-isolation=none`で実行する。個々のテスト名と件数を確認した。元の検出問題の原因は未確定。
- `make jev-probe-dry-run`が成功し、13件の公式Jev向けリクエストを通信なしで表示できた。全件`not_run`であり、実接続の成功を示すものではない。`make jev-probe`は現在、自動切替で実際に接続する入口である。
- `nix-instantiate --parse flake.nix`は成功。Python 3.12.15とuvの実体も使用可能になった。一方、こちらからの`nix develop --command make check jev-local-setup`は、承認付きでもNixストアの所有権処理で失敗した。
- エージェント側の導入試行はCPU用PyTorch取得の名前解決で失敗したが、その後、利用者がホスト側で導入・既定モデルの起動・実推論に成功した。
- セッションの権限は作業領域への書き込みを許可する状態へ切り替わった。利用者はホスト側で`nix develop`後にCodex本体を起動し直したと回答した。
- `.direnv/flake-profile`には生成済みdevShellがあり、記録されたPATHではNode.js・pnpm・Makeの実体が見つかる。一方、こちらのコマンド実行環境のPATHでは3つとも見つからない。
- 2026-11-06、利用者がホスト側devShellのPATHを提示。対応するNixストア内の実体を直接呼ぶと、Node.js `v24.22.1`、pnpm `11.27.0`、GNU Make `4.4.1`の起動を確認できた。ツールの実体は使用可能で、コマンドへそのパスを明示できる。devShell全体の環境が自動で継承されない原因は未確定。
- プロジェクト設定は`inherit = "core"`、`allow_login_shell = false`で、PATHの明示的な上書きはない。環境が反映されない原因は未確定。設定の変更や権限の緩和は行っていない。
- 通常の`nix develop`・direnv再読み込みは、作業領域外のNixキャッシュのロック作成が`Read-only file system`で失敗。承認付き実行も、`/nix/store`の所有権処理で`Invalid argument`となった。
- 生成済みprofileをNixデーモン経由で読む方法も試したが、通常・承認付き実行ともにデーモンソケットへの接続が`Operation not permitted`で拒否された。
- 最新mainを公開リポジトリから取得する操作も試した。通常実行は`.git/FETCH_HEAD`への書き込みが拒否され、承認付き実行は`Could not resolve host: github.com`で失敗した。認証ヘルパーは無効にして実行し、認証情報は使っていない。
- 利用者のホスト側での取得は成功し、`origin/main`は`157dd2f`へ更新された。作業ブランチはこのコミットを基点としている。
- Issue #16本文はWeb経由で取得できていない。上記の範囲は手元のMVP・ADRに基づく。APIキーの取得・読み取り、公式Jevへの実リクエスト、アプリのビルド・テストは未実施。
- 既存のセキュリティ設定と過去の検証結果は、[ADR-0002](adr/0002-development-environment.md) と [AI開発エージェントの権限と運用](agent-security.md) を参照する。

## 未完了事項・次の作業

- コマンド実行時はdevShellが供給するツールのパスを明示できる。環境が自動で継承されない原因は引き続き未確定で、設定ファイルの不具合と断定しない。
- TypeSafeのアカウント・APIキー準備と利用条件を確認する。キーの実値をチャットや文書へ保存しない。
- [比較手順](jev-connection-check.md)に従い、既存サーバーを停止してから`LOCAL_JEV_MODEL=nli-multilingual-minilm make jev-local-serve`で候補を起動し、別devShellで同じ変数を指定して`make jev-probe-local`を実行する。カード探索先は`.local-jev/models/cards`。初回に追加の重みを取得する。候補の結果が来るまでは開発時の既定モデルを変更したり、改善したと断定したりしない。
- `make jev-probe`はキーありなら公式Jev（課金）、キーなしならローカルを使う。通信なしの確認には`make jev-probe-dry-run`を使う。公式API用のキーをローカルへ送らず、公式Jevの失敗時もローカルへ自動で切り替えない。
- 日付・金額の抽出とMCPの接続条件は引き続きIssue #16で検証する。今回のプローブは接続とIntent分類だけを扱い、業務APIや保存は実行しない。
- 接続検証の結果と採用判断はMVP・ADRへ反映し、提案と決定済みを区別する。30秒条件の正式な判定は引き続きIssue #15に残す。
- CLIを切り替える際は、このメモに加えて現在のブランチ・`git status`・差分を確認する。GitHubへの反映とレビューはAGENTS.mdの手順に従う。
