# ADR-0005: ローカル開発で公式Jevと実モデルを切り替える

- 状態: 決定（2026-11-06）。開発時の自動切替とローカル検証の終了基準を決定した。既定NLIの保存結果で「正常系・異常系それぞれ1件以上の期待値との一致」を達成済み。13件全体の精度合格を意味せず、既定モデルは変更しない。
- 関連: [Issue #16](https://github.com/abi-yusuke-wada/inui/issues/16)、[ADR-0003](0003-separate-core-from-poc-app.md)、[ADR-0004](0004-jev-first-intent-routing.md)、[MVP](../../MVP.md)、[接続検証](../jev-connection-check.md)

## 背景

公式JevのAPIキーがなくても、入力に対して実際に推論する環境でローカル開発を進めたい。利用者は、APIキー設定時にはローカル開発でも公式Jevを使い、キー未設定時にはlocal-jev等の実モデルを使うことを希望した。固定応答を返すmockを開発時の代替にはしない。

公式JevはTypeSafeのサービスであり、local-jevは別のモデルをTypeSafe互換APIから使うための実装である。local-jevを動かしても、公式Jevの判定能力や応答時間を確認したことにはならない。[local-jev](https://github.com/amithgc/local-jev)、[公式Jevの概要](https://docs.typesafe.ai/introduction)

## 比較した案

| 案 | 費用・負担 | 評価 |
| --- | --- | --- |
| A. 常に公式Jevを使う | APIキーと利用量に応じた料金が必要。ローカルの重み・推論runtimeは不要 | 正式評価と同じサービスを使えるが、キーがない状態では実推論を伴う開発が進まない |
| B. キー未設定時は固定応答mockにする | モデルのダウンロード・推論負荷は不要 | 入力に応じた推論を確認できず、利用者の希望を満たさないため不採用。通信処理等の単体テスト用の差し替えとは区別する |
| C. キー設定時は公式Jev、未設定時はlocal-jevの実モデルを使う（採用） | ローカル時の公式API利用料は不要。モデル重み約0.87 GBに加え、Python・Torch等のruntimeのダウンロード、ディスク、推論時間・メモリが必要 | キーがなくても実推論を使って開発できる。公式Jevとの差は残るため、結果にproviderとmodelを記録し、正式評価から分ける |

## 決定

- `make jev-probe`を自動切替の入口にする。`TYPESAFE_API_KEY`が空白除去後に非空なら公式Jevを呼ぶ。未設定・空白のみならローカルモデルを呼ぶ。
- 公式Jevの接続先は`https://api.typesafe.ai/v1/systemone`、検証モデルは`jev-1.14.0`。公式Jevが失敗した場合にローカルへ自動で切り替えず、失敗として扱う。
- ローカルの既定接続先は`http://127.0.0.1:8765/v1/systemone`。`LOCAL_JEV_BASE_URL`で変更できるのはloopback URLだけとする。ローカルへのリクエストに公式APIキーを送らない。`make jev-probe-local`ではキー自体を読まない。
- local-jevは利用者がホスト側で確認したコミット`64a0b31ff343dca32142496cf9edca5a0174a18d`に固定する。既定の開発モデルは引き続き`nli-deberta-large`とする。DeBERTa系の自然言語推論（NLI）モデルであり、文章生成LLMは追加しない。このモデルを日本語MVPに適合済みとは扱わない。[モデル設定](https://github.com/amithgc/local-jev/blob/64a0b31ff343dca32142496cf9edca5a0174a18d/src/local_jev/cards/nli-deberta-large.json)、[モデルカード](https://huggingface.co/MoritzLaurer/deberta-v3-large-zeroshot-v2.0)
- `nli-multilingual-minilm`を比較候補として追加し、`LOCAL_JEV_MODEL`で明示した場合だけ使う。元のモデルは`MoritzLaurer/multilingual-MiniLMv2-L6-mnli-xnli`で、著者は100言語以上への対応を説明している。今回の固定13入力では正常入力の一致数が増えた一方、対象外・曖昧入力の一致数が減り、合計は変わらなかった。重み約428 MBに加えてtokenizer等の取得が必要になる。[モデルカード](https://huggingface.co/MoritzLaurer/multilingual-MiniLMv2-L6-mnli-xnli)、[モデルファイル](https://huggingface.co/MoritzLaurer/multilingual-MiniLMv2-L6-mnli-xnli/tree/main)
- 比較候補の温度は未校正の`1`とし、既存DeBERTa用の較正係数を流用しない。候補のprobability・confidenceが同じ精度で較正されているとは扱わない。
- ローカル検証は、正常系9件と異常系（対象外・曖昧入力）4件でそれぞれ1件以上、期待するIntentと一致すれば終了とする。これは開発用の限定した終了基準であり、13件全体の精度や正式MVPの合格基準を変更しない。13件プローブは全件一致を終了コード`0`の基準として維持し、不一致のある保存ログの終了コード`1`は変更しない。
- 本番・正式なMVP評価には公式Jevを使う。ローカル開発の結果を公式Jevの合格判定やIssue #15の30秒条件の正式実測へ混ぜない。LLM不使用の方針を維持する。

## 利用者のホスト実測（2026-11-06）

`nli-deberta-large`で13入力すべての応答を受け取った。[提示ログと集計](../jev-local-results-2026-11-06.json)は利用者がホスト側で実行した結果であり、エージェントによる再実行結果ではない。

- top-1の期待Intentとの一致は7/13件（53.8%）。正常入力は5/9件、対象外・曖昧入力は2/4件だった。
- プローブ内の呼び出し時間は平均3,935 ms、中央値3,823 ms、最大5,578 ms。終了コード`1`は6件の分類不一致を検出した結果で、13件の接続が失敗したことを示さない。
- 提示ログ後の環境確認値はlocal-jev `0.2.0`、Torch `2.15.0+cpu`、Transformers `5.22.1`。
- 導入・起動・実推論の経路は確認できたが、この13入力の期待結果を満たしていない。モデルカードは`language: en`であるものの、不一致の原因が言語だけとは断定できない。モデルの特性や候補説明などの要因は未切り分けである。

続いて、利用者のホスト側で`nli-multilingual-minilm`の13応答を得た。[多言語MiniLMの提示ログと集計](../jev-local-multilingual-results-2026-11-06.json)では、正常入力が7/9件（既定5/9件）、対象外・曖昧入力が0/4件（既定2/4件）、合計は同じ7/13件だった。平均108.615 ms、中央値87 ms、最大276 msで、終了コード`1`は分類不一致6件を検出した結果である。この実行のruntimeバージョンやリソース使用量は提示ログに含まれない。

合意したローカル検証の終了基準は、既定NLIの正常5/9件・異常2/4件で既に達成している。正常例は「交通費を精算したい」→`expense_request`、異常例は「申請を取り下げたい」→`unsupported_operation`。MiniLMは正常7/9件・異常0/4件で、この最小基準は未達である。今回はソース・モデル・閾値の追加変更を必要としない。

両方とも同じ13入力を各1回試した結果であり、一般的な日本語精度を示さない。実行条件・負荷・キャッシュ・ウォームアップ等を統制しておらず、観測した時間差を一般的な速度差とは扱わない。公式Jevの精度や、ブラウザを含むIssue #15の30秒条件の正式実測にも使わない。confidenceの較正は未検証であり、閾値の変更だけで誤分類を解消できる根拠も得られていない。

候補説明のA/B比較はローカル検証を終えるための必須作業から外し、必要になった場合の任意の将来検証とする。説明の変更・比較実行はまだ行っていない。実施する場合はモデルを固定し、調整後は未使用の言い換え入力でも確認して、固定13入力への過適合と区別する。言語やNLIという方式だけを原因と断定しない。

## 影響と未検証事項

- NixのdevShellへPython 3.12とuvを追加する。`make jev-local-setup`で固定版を導入し、`make jev-local-serve`でloopback上の実モデルを起動する。環境・キャッシュは`.local-jev/`配下に置き、認証情報とモデル重みはGitに含めない。
- 多言語候補のカードは`scripts/jev-local-multilingual.json`で管理し、serve時に`.local-jev/models/cards/`へコピーする。起動時には`LOCAL_JEV_MODELS="$PWD/.local-jev/models"`を明示する。カード探索は起動時に行うため、既存サーバを停止してから比較候補を指定して起動し直す。
- `nli-multilingual-minilm`の起動と13応答は利用者のホスト側で確認した。今回の結果だけで日本語への適合性や速度の優位性は確定しない。runtimeを含む総ダウンロード量やCPU上の実メモリ使用量も未測定である。
- プローブの各結果にproviderと応答modelを残す。日付・金額の抽出、MCPとの接続、UI・業務API、正式な性能評価は今回の切替の実装だけでは検証できない。
- 開発で得た結果に基づき、必要ならモデル選定・接続仕様・費用を再検討する。ローカルの判定結果だけで、正式MVPの利用モデルや完了条件を変更しない。
