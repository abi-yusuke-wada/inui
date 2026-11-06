# ローカルNLI接続・Intent分類の検証（Issue #16）

状態: 基準モデル`nli-deberta-large`を維持し、実Engine比較と利用者ホストでのHTTP再実測の両方で正常9/9件・異常4/4件を確認した。保存応答のスキーマとNodeの検証・正規化も13件で通過し、Issue #16のローカル分類・HTTP応答検証条件は達成済み。GitHubへの進捗反映・Close・PR反映は未実施である。以前の7/13件の記録と導入確認の履歴は保持する（[ADR-0006](adr/0006-local-model-for-mvp.md)）。

## 今回の範囲

Node.js 24の標準HTTP機能で、固定した入力をlocal-jevへ送り、Intent分類の結果を期待値と照合する。正式MVPでは`nli-deberta-large`を基準とし、モデル変更が必要な場合は事前に相談する。プローブ本体にはSDKの依存関係を追加せず、LLMによる補完も行わない。ローカル開発用だった位置づけ（[ADR-0005](adr/0005-local-jev-for-development.md)）は、[ADR-0006](adr/0006-local-model-for-mvp.md)で変更した。

MVPは、自然言語のIntentから休暇申請・経費精算（交通費）・申請状況の3画面へ振り分ける。日付・金額・区分・状態は利用者が画面上で明示的に操作し、自然言語から自動補完しない。公式Jev・引数自動補完・MCPは、MVPの部署展開と費用に関する社内承認後へ延期する。

| 接続項目 | 開発用プローブの仕様 |
| --- | --- |
| 正式MVPの基準 | `POST http://127.0.0.1:8765/v1/systemone`・公式APIキーを送らない・`nli-deberta-large` |
| 公式Jev（延期） | `POST https://api.typesafe.ai/v1/systemone`・Bearer認証・`jev-1.14.0`。将来の検証用コードは残っている |
| 過去の多言語比較候補 | `nli-multilingual-minilm`。現在の基準モデルには採用せず、変更や追加比較は事前相談とする |
| 質問形式 | 入力を`state`に置き、`Choice`の候補からIntentを選ばせる |

上記の接続先は開発用プローブの経路であり、正式MVPの推論配置・呼び出し経路はIssue #4で具体化する。

[MVPの正常9入力](../MVP.md#入力例と期待結果)と、対象外・曖昧な4入力の計13件を用いる。日付・金額などを含む入力も、ここではIntentだけを照合する。候補と期待する分類は次のとおり。

| 入力の種類 | 件数 | 期待するIntent |
| --- | --- | --- |
| 休暇申請 | 3 | `leave_request` |
| 経費精算（交通費） | 3 | `expense_request` |
| 申請状況の確認 | 3 | `application_status` |
| 「出張を申請したい」「会議室を予約したい」 | 2 | `unsupported_feature` |
| 「申請を取り下げたい」 | 1 | `unsupported_operation` |
| 「申請したい」 | 1 | `clarify` |

## 実行方法

変更後のdevShell内で実行する。ローカル用に追加したPython 3.12とuvを反映するため、`nix develop`に入り直してから導入する。

| コマンド | 内容・外部通信 |
| --- | --- |
| `make jev-check` | オフラインテスト。実APIへ接続しない |
| `make jev-probe` | 従来の`--auto`動作が残る。APIキーがあれば公式Jevを呼ぶため、MVP基準の検証には使わない |
| `make jev-probe-dry-run` | 通信せずに13入力と公式Jev向けChoiceリクエストを表示する。APIキー不要 |
| `make jev-probe-live` | 将来の公式Jev検証用。公式APIを強制し、最大13回の呼び出しで課金が発生し得る。APIキーが必要 |
| `make jev-probe-local` | 正式MVP基準の検証用。ローカルを強制し、公式APIキーを読まず、送信しない |
| `make jev-local-setup` | Python 3.12・uvで固定版local-jevを導入する。runtime等のダウンロードを伴う |
| `make jev-local-serve` | 基準の`nli-deberta-large`を`127.0.0.1:8765`で起動する。未取得の重みは初回にダウンロードする |

MVP基準の実推論では、導入済みの環境で次を実行する。未導入の場合のみ、事前に`make jev-local-setup`で導入する。固定応答mockを開発用の代替には使わない。

```sh
LOCAL_JEV_MODEL=nli-deberta-large make jev-local-serve
```

別のdevShellで同じ基準モデルを指定し、公式APIキーの有無によらずローカルの13入力を検証する。

```sh
LOCAL_JEV_MODEL=nli-deberta-large make jev-probe-local
```

HTTP経由の再現には、利用者のホスト側で上記のサーバ起動と別devShellからのプローブを実行する。この手順による全13件一致の提示ログを受領済みである。再現時は13件の分類と応答契約を確認し、数値の終了コードも記録する。実Engine分類比較や保存応答の検証は、HTTPの提示ログとは分けて扱う。

local-jevは`64a0b31ff343dca32142496cf9edca5a0174a18d`に固定する。環境・キャッシュは`.local-jev/`、モデルキャッシュは`.local-jev/cache/`へ置き、Gitには含めない。既定モデルの重み約0.87 GBとは別にruntimeのダウンロード・ディスクと推論用メモリが必要である。利用者のホスト側で導入と実推論の成功を確認した。[local-jev](https://github.com/amithgc/local-jev)、[モデルカード](https://huggingface.co/MoritzLaurer/deberta-v3-large-zeroshot-v2.0)

`LOCAL_JEV_BASE_URL`でローカル接続先を変える場合も、loopback URLだけを許可する。公式Jevの失敗時にはローカルへ自動fallbackせず、その失敗を記録する。

認証情報は利用者がホスト側で管理し、キーの値をチャット・出力・検証記録に含めない。実行する入力は上記の固定サンプルとし、業務APIやDBの呼び出し・保存は行わない。

## 利用者のホスト実測（2026-11-06）

[調整前の既定NLI](jev-local-results-2026-11-06.json)、[多言語MiniLM](jev-local-multilingual-results-2026-11-06.json)、[採用説明でのHTTP再実測](jev-local-http-results-2026-11-06.json)は、利用者がホスト側で実行した`make jev-probe-local`の提示ログと集計である。エージェントからのTCP実行結果ではない。

| 観測項目 | 既定NLI（調整前） | 多言語MiniLM | 基準NLI（採用説明・HTTP） |
| --- | --- | --- | --- |
| provider / model | `local-jev` / `nli-deberta-large` | `local-jev` / `nli-multilingual-minilm` | `local-jev` / `nli-deberta-large` |
| 応答数 | 13/13件 | 13/13件 | 13/13件 |
| top-1の期待Intentとの一致 | 7/13件（53.8%） | 7/13件（53.8%） | 13/13件（100%） |
| 正常入力 | 5/9件 | 7/9件 | 9/9件 |
| 対象外・曖昧入力 | 2/4件 | 0/4件 | 4/4件 |
| プローブ内の呼び出し時間 | 平均3,935 ms、中央値3,823 ms、最大5,578 ms | 平均108.615 ms、中央値87 ms、最大276 ms | 平均4,674.615 ms、中央値4,591 ms、最大5,502 ms |
| 終了コード | `1`（分類不一致6件の検出） | `1`（分類不一致6件の検出） | 数値未提示（`0`と推定） |

調整前の既定NLIの提示ログ後の環境確認値はlocal-jev `0.2.0`、Torch `2.15.0+cpu`、Transformers `5.22.1`だった。多言語MiniLMの実行時メタデータと、今回のHTTPサーバ側のruntime・重みrevision・スレッド数は提示ログに含まれない。後述の実Engine比較の観測値を、HTTP実行へ流用しない。

今回のHTTPログは全13件が`matched=true`で、makeエラーなくプロンプトへ戻った。数値の終了コードは未提示のため、`0`は現在の実装の終了条件からの推定であり、直接観測した値ではない。呼び出し時間はブラウザを含まないプローブ内の記録で、Issue #15の正式な30秒条件の合格を示さない。

調整前の既定NLIと多言語MiniLMの保存ログでは、両モデルで13応答は成立したが、正常入力と対象外・曖昧入力で成績が変わり、合計の一致数は増えなかった。この以前の質問では、どちらも正常9/9件・異常4/4件という基準を満たしていない。各実測は同じ入力を各1回試した結果であり、一般的な日本語精度は断定できない。言語・モデル特性・候補説明などの要因を切り分けておらず、言語だけを原因とは断定しない。実行条件・負荷・キャッシュ・ウォームアップ等も統制していないため、記録した時間差を一般的な速度差とは扱わない。公式Jevの精度やIssue #15の正式な30秒条件の判定には使わない。

## 候補説明の比較と採用条件（2026-11-06）

基準モデルを固定して5バッチの候補説明比較を行い、`feature-outside-supported`で正常9/9件・対象外と曖昧入力4/4件、合計13/13件が一致した。[採用した質問・aliasと比較結果](jev-prompt-study-2026-11-06.json)に、各条件の質問、設定、13入力の実結果を残す。これは外部通信やHTTPを使わず、実際の`local_jev.Engine`を直接呼んだ分類だけの比較である。

| 実行条件 | 記録値 |
| --- | --- |
| モデル / 重みrevision | `nli-deberta-large`（435M） / `cf44676c28ba7312e5c5f8f8d2c22b3e0c9cdae2` |
| デバイス / dtype / threads | CPU / `torch.float32` / 4 |
| 明示的warmup | `False` |
| runtime | local-jev `0.2.0`、Torch `2.15.0+cpu`、Transformers `5.22.1` |
| Choiceの較正温度 | 既存の`1.395`を維持 |

採用する質問は次のとおり。候補説明で業務の境界を明示し、曖昧な申請を示すwire候補名を`unspecified_application`にした。内部Intentは従来の`clarify`を維持する。

```json
{
  "type": "choice",
  "instructions": "入力の利用者が何を求めているかを、候補の説明に従って分類してください。",
  "criteria": {
    "leave_request": "利用者は有給休暇や半日休暇などの休暇を申請したい。",
    "expense_request": "利用者は電車代などの交通費を経費として申請・精算したい。",
    "application_status": "利用者は提出済み申請の承認待ち・承認済み・差し戻しなどの状態を確認したい。",
    "unsupported_feature": "利用者は出張申請や会議室予約など、休暇申請・交通費精算・申請状況の確認以外のサービスを利用したい。",
    "unsupported_operation": "利用者は申請を取り下げる、内容を変更する、または承認者の作業を実行したい。",
    "unspecified_application": "利用者は申請手続きを始めたいとだけ述べており、具体的な申請の用件は示していない。"
  }
}
```

aliasは`{"unspecified_application": "clarify"}`という固定1対1の正規化だけである。入力文字列による正解の決め打ちや期待値の変更は行わず、同じCASESと内部Intentで比較した。モデル・重み・較正係数は変更せず、LLMも追加していない。

この条件をローカルの`nli-deberta-large`向けプローブに採用し、現在の`buildRequest`との質問の完全一致を確認した。固定13入力で候補説明を調整した結果であり、未使用の入力や一般的な日本語精度の保証ではない。

## 応答データの検証とHTTP経路の確認状況

[保存した比較結果](jev-prompt-study-2026-11-06.json)の`contract_validation`には、実Engineの13件の入出力を既存APIのPydanticスキーマで検証・JSON化し、Nodeの`validateResponse`と固定Intent正規化も13件通過したことを記録した。これは保存されたデータの契約検証であり、APIルートの実行やHTTP通信ではない。

先行したエージェント環境での確認では、TCPソケットが`EPERM`で拒否され、ASGI TestClientも`from_thread`のportal待機から完了しなかった。この別環境での制約を成功へ読み替えず、HTTP成功の根拠には[利用者ホストでの提示ログ](jev-local-http-results-2026-11-06.json)を使う。

実Engine比較、保存入出力13件の契約検証、Nodeの105テストに加え、利用者ホストのHTTP再実測でも13件全一致を確認した。Issue #16のローカル分類・HTTP応答検証条件は達成済みであり、HTTP未確認は現在の未完了事項から外す。GitHubへの進捗反映・Close・PR反映は未実施で、Issue #4のアプリ実装と推論配置、Issue #15のブラウザを含む正式30秒測定も未完了である。

## 導入確認の履歴（以前の終了基準）

以前は、正常系9件と異常系（対象外・曖昧入力）4件で、それぞれ1件以上が期待するIntentと一致することを、ローカルの導入確認の終了基準とした。既定NLIの保存結果は正常5/9件・異常2/4件で、この限定した確認は達成している。

- 正常例: 「交通費を精算したい」→`expense_request`。
- 異常例: 「申請を取り下げたい」→`unsupported_operation`。

MiniLMは正常7/9件・異常0/4件で、以前の最小基準も未達だった。この履歴を、現在のIssue #16の完了条件とは扱わない。

13件プローブは全件一致を終了コード`0`の基準として維持する。以前の既定NLIとMiniLMの6件不一致による終了コード`1`と、保存済み結果JSONは変更しない。

## 過去の多言語NLI比較の再現手順

以下は保存済み比較結果の再現手順であり、基準モデルの変更や追加比較を進める場合は事前に相談する。`nli-multilingual-minilm`は正式MVPの基準には採用していない。元のモデル`MoritzLaurer/multilingual-MiniLMv2-L6-mnli-xnli`について、著者は100言語以上に対応すると説明している。保存済みの13入力では合計の一致数は変わらず、日本語全般での改善は確定していない。重み約428 MBに加えてtokenizer等のダウンロードが必要になる。[モデルカード](https://huggingface.co/MoritzLaurer/multilingual-MiniLMv2-L6-mnli-xnli)、[モデルファイル](https://huggingface.co/MoritzLaurer/multilingual-MiniLMv2-L6-mnli-xnli/tree/main)

利用者が比較を再現する際は、既存サーバを`Ctrl+C`で停止してから、サーバ側のdevShellで次を実行する。

```sh
LOCAL_JEV_MODEL=nli-multilingual-minilm make jev-local-serve
```

別のdevShellで同じモデル名を指定し、同じ13入力を確認する。

```sh
LOCAL_JEV_MODEL=nli-multilingual-minilm make jev-probe-local
```

serveターゲットは`scripts/jev-local-multilingual.json`を`.local-jev/models/cards/`へコピーし、`LOCAL_JEV_MODELS="$PWD/.local-jev/models"`を明示して起動する。カード探索は起動時に行うため、既存サーバへのカード追加だけでは切り替わらず、上記の停止と再起動が必要である。候補の温度は未校正の`1`で、既存DeBERTaの較正係数は流用しない。probabilityやconfidenceの数値が同じ精度で較正されているとは扱わない。

APIキーがある場合、`make jev-probe`の自動選択は引き続き公式Jevを優先する。ローカル候補を比較する上記の`make jev-probe-local`はキーを読まず、送信しない。

## Issue #16の完了条件と記録

- 基準モデルを維持して候補説明を整え、応答契約・失敗時の扱い・再現手順を記録する。モデル変更が必要になった場合は事前に相談する。
- 固定13入力を基準モデルで実測し、正常入力9/9件・対象外と曖昧入力4/4件が、すべて期待するIntentと一致する。接続成功や13件の応答だけで完了とはしない。
- オフラインテストが成功し、固定13件の入力・期待値と送信するChoiceリクエストを確認できる。既存のdry-run表示は公式Jev向けであり、MVP基準の実測は`make jev-probe-local`で行う。
- 実接続では各入力のprovider・応答model・選択されたIntent・期待値との一致を記録する。分類の不一致は残りの入力も続けて記録し、終了コードを1にする。接続・HTTP・JSON・契約エラーは成功として扱わず、その時点で中断する。中断後の入力は未実施であり、13件すべてを検証できたとは扱わない。
- 実接続の成否と分類の成否を区別する。13件が一致しても、3画面の描画・画面上の明示操作・保存を含むMVP全体の成功とは扱わない。モデル・実行環境・候補説明・入力と期待値・実結果・手順・未検証項目を記録する。
- 対象外機能・対象外操作・曖昧入力の期待分類も固定し、区別できない結果は不一致として記録する。基準やモデルの変更が必要な場合は事前に相談し、LLMによる補完は追加しない。
- ローカルモデルの結果を正式MVPのIntent振り分けの評価材料とする。公式Jevの接続成功・分類精度を示す結果にはしない。公式Jevの延期は、現在のIssue #16を未完了にする理由には含めない。

## 未検証事項・次の段階

コアへの組み込み、3画面のUI・認証・業務APIは今回のプローブの対象外であり、未実装・未検証である。Issue #4で本体を実装し、ローカル推論の配置・呼び出し経路も具体化する。ローカルモデルを含む応答が30秒以内かの正式な実測はIssue #15で、ブラウザ送信から成功の最終結果受信までを測る。プローブ単体の呼び出し時間だけでは判定できない（[ADR-0006](adr/0006-local-model-for-mvp.md)、[MVPの完了条件](../MVP.md#pocの完了条件と記録)）。

公式Jevは英語が主な訓練言語であり、CJKを含む他言語は精度が同等ではない。ローカルの基準モデルカードも`language: en`で、以前の質問では7/13件だった。今回、同じモデルの候補説明とwire候補名を調整して実Engineで13/13件を得たが、言語だけが原因だったとは判断しない。公式Jevの日本語精度は引き続き未検証であり、ローカルの結果を公式Jevへ一般化しない。[Models / Language support](https://docs.typesafe.ai/models#language-support)、[基準モデルカード](https://huggingface.co/MoritzLaurer/deberta-v3-large-zeroshot-v2.0)

採用した質問と固定aliasを反映したHTTPプローブで、利用者の提示ログから正常9/9件・異常4/4件の一致を確認した。HTTPの追加再確認を現在の必須次作業にはしない。confidenceの較正と未使用の言い換え入力は引き続き追加検証事項で、固定13入力だけで一般的な精度を断定しない。

Issue #16の改定ゴールの本文更新は、利用者がホスト側で実施済みと報告し、ローカルの更新内容との一致を確認した。今回の達成を受けた進捗反映・Close・PR反映はまだ行っていない。リモート本文の再取得はできておらず、GitHub上の最新状態を独立に確認したとは扱わない。

公式Jev・引数自動補完・MCPは、部署展開と費用に関する社内承認後に再検討する。Choiceや日付・金額の公式例は、その将来検証の参考資料として残す。現在のMVPでは日付・金額・区分・状態を画面上で明示的に操作する。[Choice](https://docs.typesafe.ai/primitives/choice)、[Date extraction](https://docs.typesafe.ai/cookbooks/date_extraction_cookbook)、[Pre-parsed value extraction](https://docs.typesafe.ai/cookbooks/pre_parsed_value_extraction_cookbook)

将来検証用の公式モードの接続・認証・リクエスト形式の出典: [TypeSafe Quick start](https://docs.typesafe.ai/introduction/quickstart)。公式モデルIDの出典: [Models](https://docs.typesafe.ai/models)。
