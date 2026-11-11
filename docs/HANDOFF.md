# 作業の引き継ぎ

共通ルールは[AGENTS.md](../AGENTS.md)、仕様は[MVP.md](../MVP.md)、構成は[ADR-0008](adr/0008-local-poc-workflows.md)、起動は[ローカル実行手順](poc-local.md)を参照する。

## 対象・現在の状態

- 対象は[Issue #4](https://github.com/abi-yusuke-wada/inui/issues/4)。取得したmainの`f5f7c83`（PR #22のマージ）から`feat/issue-4-poc`を作成し、現在も同じリポジトリで作業している。別worktreeは作成していない。今回の実装はまだGitHubへ反映していない。
- 利用者と休暇申請・交通費精算・申請状況の確認・複数人の予定比較を合意し、研究用アプリ・API・画面・サンプルデータを自前で実装した。自然言語UIと旧形式は同じ業務API・画面部品・データを使う。
- 予定比較は文章中の人名から対象者を選択済みにする。全名・一意な姓を辞書へ照合し、同姓・未知名は勝手に補完せず画面で確認する。予定日は基準日2026-11-02から手動変更する。
- 既存の常駐推論サーバーはないという回答を受け、まず開発機でのローカルPoCとした。Turso・GitHub認証・AWSへの配置は未実装であり、部署展開の完了とは扱わない。

## 変更内容

- `packages/core`は実NLIの7候補・モデル・確率・使用量を検証し、4画面か3種類の案内へ対応付ける。LLMと公式APIキーは使わず、loopback接続と本文受信を含む25秒の期限を設けた。
- `apps/poc`はHono・Reactの画面とAPI、Node標準SQLiteによる実ファイル保存・初期データ・再取得を実装した。保存はフォーム確定POSTのみ。画面操作の失敗時は入力を保持し、保存成否不明時の再POSTを止める。
- 申請日・予定日の基準は2026-11-02。申請の初期データ2件、サンプル社員4名、11月2日・3日の予定を用意した。自然言語から日付・金額・区分・状態は補完しない。
- Node・pnpmはNix、プロジェクト依存は直接バージョンとlockfileで固定する。公開依存の取得はホストで実行済み。設定・環境を分離し、利用者の認証設定とインストールscriptは使わない。Makeへbuild/run/check/model/probe/diagnose/resetを集約した。
- `make app-dev`と`make app-smoke`でアプリと実NLIの起動をまとめた。既存の正常なサービスは再利用し、接続拒否の場合だけ不足分を起動する。認証用変数は子へ渡さず、自分で起動したプロセス群だけを終了する。
- 構成・比較案・費用負担・未実装範囲をADR-0008へ、実行手順とMVPの追加要件を関連文書へ反映した。元のIssue #23の引き継ぎはstashと`.local-jev/issue4-handoff-before.md`へ保全済み。

## 検証結果

- `make app-check`成功。ビルド・型検査・単体123件、JSDOMでの4操作ケース（Node集計5件）・保存した実NLI応答の19件再照合が成功した。失敗・スキップ0。起動管理の7件も実プロセス起動・通信なしの注入テストであり、実ブラウザの操作確認とは区別する。
- `make jev-check`は既存105件成功。旧13入力・期待値・過去の6候補プローブは変更していない。
- 実NLIの新7候補は最初18/19件だった。未対応操作の説明へ会議登録を明示し、同じモデル・重み・入力・期待値で19/19件（正常13/13・対象外と曖昧6/6、人名4/4）の一致を確認した。[保存応答](poc-nli-responses-2026-11-10.jsonl)を`make app-replay-check`で再検証できる。
- 実測はEngine直接呼び出しでHTTPを使わない。CPU・float32・4threads、重みrevisionは`cf44676c28ba7312e5c5f8f8d2c22b3e0c9cdae2`。モデル読込13.9秒、分類平均13.0秒・最大22.0秒、PythonプロセスのピークRSS3,039,952KiB。Lambdaや正式30秒条件の実測ではない。
- エージェントからのTCP待受・接続は通常・権限付き再試行ともEPERMで拒否された。ホストの初回HTTPはサービス未起動で失敗したため、起動管理を1コマンドへまとめた。利用者ホストの`nix develop --command make app-smoke`でHTTP19/19件・人名4/4件を確認し、現行入力・期待値・質問digestと照合した。[HTTP結果](poc-http-results-2026-11-11.json)の平均は約8267ms、最大12713ms。ブラウザ・画面表示・保存・正式なIssue #15の測定は含まない。
- ホストの起動ログではモデル読込とwarm-upに37.8秒かかった。HTTP応答から重みrevision・runtimeは観測していないため、Engine直接実測の値とは区別する。
- 文書の相対リンク・差分空白、flakeの構文解析は成功。`nix flake check --no-build --offline`はキャッシュ／Nixストアの制限で未完了（権限付き再試行も失敗）。

## 残作業・次の作業

- 画面を使うときは`make app-dev`を実行し、`http://127.0.0.1:3000/`と`/legacy`を開く。起動したターミナルは開いたままにする。実ブラウザの見た目・OS音声入力・旧形式との操作数比較は別途確認する。
- [Issue #12](https://github.com/abi-yusuke-wada/inui/issues/12)の認証、[Issue #13](https://github.com/abi-yusuke-wada/inui/issues/13)のTurso、[Issue #14](https://github.com/abi-yusuke-wada/inui/issues/14)の配置・CIを具体化する。部署向けモデルの配置・起動・費用は未確定。ローカルSQLiteをTurso・新Lambda環境の永続化確認として扱わない。
- 基盤は[ADR-0001](adr/0001-mvp-hosting-and-storage.md)を参照し、正式な30秒条件の実測は[Issue #15](https://github.com/abi-yusuke-wada/inui/issues/15)で行う。Issue #4全体は未完了。

## Issue #23に残す確認

- [ ] 専用PATを渡した新しいCodexセッションで、限定GitHub MCPからinuiのIssue・PRを実際に読み取れることを確認する。
- [ ] 合意したIssue・PRへの書き込みで、対象・操作内容が人への承認要求として表示され、承認後に実行されることを確認する。

利用者からPR #22・#24のマージ報告を受けたが、取得したmainにはMCP設定が含まれていない。PR #24のマージ先とIssue #23の現在の状態は別途確認する。認証情報の値は取得・表示・記録しない。
