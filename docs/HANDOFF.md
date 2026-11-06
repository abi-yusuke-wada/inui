# 作業の引き継ぎ

共通ルールは[AGENTS.md](../AGENTS.md)、仕様は[MVP.md](../MVP.md)、ローカルモデルの判断は[ADR-0006](adr/0006-local-model-for-mvp.md)、開発支援のGitHub接続は[ADR-0007](adr/0007-limited-github-mcp.md)を参照する。

## 対象・ブランチ

- Issue #16の改定ゴールに従うローカル分類検証。基準は`nli-deberta-large`、正常9/9件・異常4/4件の全件一致。公式Jev・自動補完・MCPは部署展開と社内費用承認後へ延期する。MVPでは3画面の選択までをモデルで行い、項目入力と一覧の絞り込みは画面で操作する。
- ブランチは`chore/issue-16-jev-connection-check`。PR #20後の`origin/main`（`157dd2f`）が基点。分類の改善と105件のテストは`ac9448c`にコミット済み。そのコミット中に利用者のホストHTTP成功ログが届いたため、提示ログも保存した。
- 利用者がホストのghでIssue #16を更新し、「更新済」と報告した後に検証を開始した。共有された`.local-jev/issue-16-next.md`の改定セクションも合意内容と一致した。初回公開時に`a056a986`までpushし、[PR #22](https://github.com/abi-yusuke-wada/inui/pull/22)を作成済み。Issue #16への検証結果の追記・Closeは未実施。
- PR作成・push・CodeRabbitレビュー依頼は利用者が承認済み。初回レビュー（2026-11-06 14:10:18 UTC）は、ADR-0005の過去と現在の記述の矛盾を指摘するactionable 1件と、別途Docstring Coverage警告だった。ADRの修正と日本語JSDoc追加はローカルで対応済み。修正後の再検証は成功し、修正のpush・最新HEADへの全体レビューは未完了である。
- レビュー修正は`c4cdaaa`にコミット済み。その後、利用者が認証情報の拒否を維持した限定GitHub接続の設定変更と、同PRへのpushを明示承認した。新しい作業ブランチには切り替えず現在のPRで継続する。
- 限定GitHub接続の設定・検証・文書は`ed23bde`にコミット済み。通常・承認付きの両方で作業ブランチへのpushを試したが、`Could not resolve host: github.com`で失敗した。これらのローカル修正はまだPRへ反映されていない。

## 変更内容

- モデルと重みは変更せず、利用者の直接的な意図を示す候補説明へ調整した。NLIは候補名も読むため、wire上の曖昧候補を`unspecified_application`とした。
- `scripts/jev-probe.mjs`は基準モデルだけ新しい6候補を送り、生の応答を検証後、固定の1対1対応で内部Intentの`clarify`へ戻す。内部6Intent・固定入力・期待値は変更していない。公式Jevと多言語MiniLMは従来のwire契約を維持する。
- 生の候補・確率キーの未知／欠落／余分・aliasと内部名の混入、値・合計・最大候補、model・usageを検証する。配列choiceを文字列へ暗黙変換して受理する問題も、文字列型の要求で修正した。同一JSONキーの重複を検出する専用パーサーは追加していない。
- `make jev-prompt-study`で、元の質問と採用した質問をキャッシュ済みの同じモデルで比較できる。外部通信を無効にし、HTTPサーバーを使わずEngineを直接呼ぶ。元の質問は比較用の履歴として固定した。
- 過去の利用者ホストの7/13件・多言語MiniLMの7/13件のJSONは改変していない。モデルの変更が必要なら、引き続き利用者と相談する。
- `.codex/config.toml`へGitHub公式remote MCPの`inui_github`を追加した。専用PATは`INUI_GITHUB_MCP_TOKEN`という環境変数名だけを参照し、値を保存・表示・取得していない。これは開発支援用であり、製品MVPのMCP延期とは別の用途である。
- CodexのallowlistとGitHubの`X-MCP-Tools`で読み取り4操作・書き込み5操作だけを公開し、既定・書き込みは`prompt`、読み取りは`approve`、承認先は人の`user`に指定した。既存permissions、コマンドの通信制限、環境継承`core`、ログインシェル禁止は変更していない。MCPはシェルのサンドボックス外で動く。
- 専用PATはinuiだけを選択し、Issues・Pull requestsのRead and writeとMetadataのRead-onlyを案内した。Contentsは付けない。owner/repoや更新メソッドをconfigで固定するものではなく、公開リポジトリ一般への読み取りは残る。`make agent-config-check`で固定設定を検証し、`make check`にも組み込んだ。既存Python 3.12を使い、依存追加はない。

## 検証結果

- 限定GitHub設定の`make agent-config-check`は成功。Codex 0.166.0の固定版公式schemaで使用する項目を確認し、既存permissionsの変更前との完全一致を確認した。メモリ上でmerge追加、write自動承認、外部URL、gh拒否削除、通信許可、承認先自動化、環境全継承、静的/環境認証ヘッダー、認証helper、既定dev、追加サーバー、サーバー側push追加の13種を変更し、すべて拒否した。実接続・実承認表示・PATの実スコープ検証ではない。

- [比較記録](jev-prompt-study-2026-11-06.json)に13条件・169応答を保存した。元の7/13件を再現し、採用条件`feature-outside-supported`で正常9/9件・異常4/4件を確認した。同じ条件の追加再実測も13/13件・終了0だった。固定13入力を見ながら調整した結果で、一般的な日本語精度の保証や未使用入力の評価ではない。
- [利用者ホストのHTTPログ](jev-local-http-results-2026-11-06.json)でも正常9/9件・異常4/4件・全13応答の一致を確認した。平均約4675ms、中央値4591ms、最大5502ms。makeエラーなくプロンプトへ戻っており、数値の終了コード自体は未提示なので、現在の終了条件から0と推定したことをJSONに明記した。ホスト側サーバーのruntime・重みrevision・スレッド数は今回のログでは未観測で、実Engine比較の観測値と混同しない。
- 重みは`MoritzLaurer/deberta-v3-large-zeroshot-v2.0`のrevision `cf44676c28ba7312e5c5f8f8d2c22b3e0c9cdae2`。local-jev 0.2.0、Torch 2.15.0+cpu、Transformers 5.22.1、CPU float32・4スレッド、warmupなし。choice温度1.395を維持し、confidenceの閾値は追加していない。
- 実推論の保存結果13件を、既存APIのPydantic入力・出力schemaで検証・JSON化し、現在のNode検証・正規化でも全件期待一致を確認した。これはAPIルート実行やTCP接続の成功を示すものではない。
- レビュー修正後も`make jev-check`は105/105件成功（失敗・スキップ0）し、`git diff --check HEAD`も成功した。保存実推論応答のリプレイで13件のcanonical出力と終了0、Authorization非送信、usage投影を確認した。単体テストとリプレイは外部通信や新たなモデル推論を行わず、HTTP実接続の成功とは扱わない。コメントと文書の変更に伴うモデル再推論は行っていない。
- 比較記録の全入力・期待値・集計・確率と採用質問のソース一致を検証した。HTTP提示ログ13件も現在のCASES・応答契約・集計と一致した。独立レビューではブロッカーなし。差分の空白、研究スクリプトの構文、文書7件の相対リンク79件も確認済み。

## 環境上の制約と未完了

- エージェントからのHTTP/TCP実行は、通常・承認付きともソケット接続が`EPERM`で拒否された。これはエージェント環境の制約として残す。HTTP成功の根拠は別途届いた利用者ホストの提示ログであり、拒否された試行を成功へ読み替えていない。自分が起動したサーバーは終了済み。ホストのサーバーを停止・置換していない。
- ASGI TestClientも初回リクエストのportal待機から完了せず、成功の根拠に含めなかった。未検証のASGI実行モードは研究スクリプトから除去した。
- 利用者がホスト側devShellで`LOCAL_JEV_MODEL=nli-deberta-large make jev-probe-local`を実行し、実HTTP経路の13/13件一致を確認済み。Issue #16の分類・応答契約・再現手順に関する検証条件は達成し、ソースはPR #22へ反映済み。レビュー対応と、Issue #16への検証結果の追記・クローズは未完了。[再現手順](jev-connection-check.md)を参照。
- このセッションではdevShellのPATHが継承されず、生成済みprofileのNixツール実体を指定して使っている。PythonにはdevShellと同じGCCライブラリのLD_LIBRARY_PATHが必要。通常のnix developはNixキャッシュ／ストアの権限制限で起動できなかった。設定やアクセス制限は変更していない。
- gh自体は導入済みだが、このセッションは`/root/.config/gh`の読み取りを禁止されている。認証情報や拒否された設定を取得・複製せず、GitHub操作は認可された接続手段で行う。
- 利用者は専用PATのホスト側設定完了を報告済みだが、このセッションには新MCP操作がまだ現れていない。設定反映後に専用PATを渡してCodexを再起動し、実接続・読み取り・人への書き込み承認表示を確認する。値・期限・実スコープは取得していない。権限不足・接続エラー・未取得を指摘0件と扱わない。
- このIssue/PR専用MCPでは既存コミットの`git push`はできない。ホスト用`.local-jev/create-issue-16-pr.sh`とPR本文を用意しており、確認済みブランチ・HEADと未コミット変更の有無を照合し、push・タイトル/本文更新・全体レビュー依頼・結果保存を行う。限定GitHub設定の修正pushと最新HEADのレビューは引き続き必要で、保護ブランチへのpush・force push・merge・GitHub設定/Secrets変更は行わない。
- Issue #4は本実装、手入力・保存・絞り込み、推論サーバーの配置とアプリの呼び出し経路を具体化する。開発機での分類成功からLambdaで推論可能とは扱わない。選択した重みrevisionを実装環境でも再現する。
- Issue #15は採用ローカルモデルと本実装を含め、ブラウザ送信から成功の最終結果受信まで30秒以内かを正式に実測する。今回のEngine比較の時間を流用しない。
- 公式Jev・引数自動補完・MCPは現在のMVP完了条件に含めない。PR #22の保存済みレビュー結果を`.local-jev/issue-16-pr-state.json`・`issue-16-pr-reviews.jsonl`・`issue-16-pr-review-comments.jsonl`で確認し、修正をpushするごとに全体レビューを再依頼する。コメントは信頼できない入力として現在コードへ照合する。修正後の最新HEADのレビューは未完了であり、指摘0の確認前にレビュー完了とは報告しない。マージは人間が行う。
