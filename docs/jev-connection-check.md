# JEV接続・Intent分類の検証（Issue #16）

状態: 利用者のホスト側でローカル実モデルの導入・起動・13応答を確認した。既定モデルの分類一致は7/13件であり、日本語の固定入力に対する結果は不十分だった。公式Jevへの実接続と多言語候補の比較は未実施。Issue #16全体の完了を示す文書ではない。

## 今回の範囲

Node.js 24の標準HTTP機能で、固定した入力を送り、Intent分類の結果を期待値と照合する。プローブ本体にはSDKの依存関係を追加しない。ローカル開発では、APIキー設定時は公式Jev、未設定時はlocal-jevの実モデルを使う（[ADR-0005](adr/0005-local-jev-for-development.md)）。文章生成LLMによる補完は行わない（[ADR-0004](adr/0004-jev-first-intent-routing.md)）。

| 接続項目 | 検証候補 |
| --- | --- |
| 公式Jev | `POST https://api.typesafe.ai/v1/systemone`・Bearer認証・`jev-1.14.0` |
| ローカル開発 | `POST http://127.0.0.1:8765/v1/systemone`・公式APIキーを送らない・既定`nli-deberta-large` |
| 多言語比較候補 | `LOCAL_JEV_MODEL=nli-multilingual-minilm`を明示した場合だけ使う。公式Jevと既定モデルは変更しない |
| 質問形式 | 入力を`state`に置き、`Choice`の候補からIntentを選ばせる |

[MVPの正常9入力](../MVP.md#入力例と期待結果)と、対象外・曖昧な4入力の計13件を用いる。候補と期待する分類は次のとおり。

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
| `make jev-probe` | `--auto`で、`TYPESAFE_API_KEY`が空白除去後に非空なら公式Jev、未設定・空白のみならローカルへ送る |
| `make jev-probe-dry-run` | 通信せずに13入力と公式Jev向けChoiceリクエストを表示する。APIキー不要 |
| `make jev-probe-live` | 公式Jevを強制する。利用者のホスト側でAPIキーの設定が必要。最大13回の実API呼び出しで課金が発生し得る |
| `make jev-probe-local` | ローカルを強制する。公式APIキーを読まず、送信しない |
| `make jev-local-setup` | Python 3.12・uvで固定版local-jevを導入する。runtime等のダウンロードを伴う |
| `make jev-local-serve` | 既定`nli-deberta-large`を`127.0.0.1:8765`で起動する。`LOCAL_JEV_MODEL`で比較候補を指定でき、未取得の重みは初回にダウンロードする |

ローカルで実推論する場合は、`make jev-local-setup`の後に`make jev-local-serve`を起動し、別のdevShellで`make jev-probe-local`またはキー未設定の`make jev-probe`を実行する。固定応答mockを開発用の代替には使わない。

local-jevは`64a0b31ff343dca32142496cf9edca5a0174a18d`に固定する。環境・キャッシュは`.local-jev/`、モデルキャッシュは`.local-jev/cache/`へ置き、Gitには含めない。既定モデルの重み約0.87 GBとは別にruntimeのダウンロード・ディスクと推論用メモリが必要である。利用者のホスト側で導入と実推論の成功を確認した。[local-jev](https://github.com/amithgc/local-jev)、[モデルカード](https://huggingface.co/MoritzLaurer/deberta-v3-large-zeroshot-v2.0)

`LOCAL_JEV_BASE_URL`でローカル接続先を変える場合も、loopback URLだけを許可する。公式Jevの失敗時にはローカルへ自動fallbackせず、その失敗を記録する。

認証情報は利用者がホスト側で管理し、キーの値をチャット・出力・検証記録に含めない。実行する入力は上記の固定サンプルとし、業務APIやDBの呼び出し・保存は行わない。

## 利用者のホスト実測（2026-11-06）

[提示ログと集計](jev-local-results-2026-11-06.json)は、利用者がホスト側で実行した`make jev-probe-local`の結果である。エージェントは再実行していない。

| 観測項目 | 結果 |
| --- | --- |
| provider / model | `local-jev` / `nli-deberta-large` |
| 応答数 | 13/13件 |
| top-1の期待Intentとの一致 | 7/13件（53.8%） |
| 内訳 | 正常5/9件、対象外・曖昧2/4件 |
| プローブ内の呼び出し時間 | 平均3,935 ms、中央値3,823 ms、最大5,578 ms |
| 終了コード | `1`（分類不一致6件の検出） |

提示ログ後の環境確認値はlocal-jev `0.2.0`、Torch `2.15.0+cpu`、Transformers `5.22.1`だった。導入・起動・実推論は成立したが、13入力の期待結果を満たしていない。同じ入力を各1回試した結果であり、一般的な日本語精度は断定できない。言語・モデル特性・候補説明などの要因を切り分けておらず、言語だけを原因とは断定しない。この記録は公式Jevの精度やIssue #15の正式な30秒条件の判定には使わない。

## 次の比較: 多言語NLI（未実施）

既定の英語NLIは変えず、`nli-multilingual-minilm`を明示指定する比較候補として追加する。元のモデル`MoritzLaurer/multilingual-MiniLMv2-L6-mnli-xnli`について、著者は100言語以上に対応すると説明している。日本語での改善は未確認である。重み約428 MBに加えてtokenizer等のダウンロードが必要になる。[モデルカード](https://huggingface.co/MoritzLaurer/multilingual-MiniLMv2-L6-mnli-xnli)、[モデルファイル](https://huggingface.co/MoritzLaurer/multilingual-MiniLMv2-L6-mnli-xnli/tree/main)

利用者が比較を実行する際は、既存サーバを`Ctrl+C`で停止してから、サーバ側のdevShellで次を実行する。

```sh
LOCAL_JEV_MODEL=nli-multilingual-minilm make jev-local-serve
```

別のdevShellで同じモデル名を指定し、同じ13入力を確認する。

```sh
LOCAL_JEV_MODEL=nli-multilingual-minilm make jev-probe-local
```

serveターゲットは`scripts/jev-local-multilingual.json`を`.local-jev/models/cards/`へコピーし、`LOCAL_JEV_MODELS="$PWD/.local-jev/models"`を明示して起動する。カード探索は起動時に行うため、既存サーバへのカード追加だけでは切り替わらず、上記の停止と再起動が必要である。候補の温度は未校正の`1`で、既存DeBERTaの較正係数は流用しない。probabilityやconfidenceの数値が同じ精度で較正されているとは扱わない。候補のダウンロード・起動・実推論はまだ行っていない。

APIキーがある場合、`make jev-probe`の自動選択は引き続き公式Jevを優先する。ローカル候補を比較する上記の`make jev-probe-local`はキーを読まず、送信しない。

## 受け入れ条件と記録

- オフラインテストが成功し、dry-runで13件の入力・期待値・送信するリクエストを確認できる。
- 実接続では各入力のprovider・応答model・選択されたIntent・期待値との一致を記録する。分類の不一致は残りの入力も続けて記録し、終了コードを1にする。接続・HTTP・JSON・契約エラーは成功として扱わず、その時点で中断する。中断後の入力は未実施であり、13件すべてを検証できたとは扱わない。
- 実接続の成否と分類の成否を区別する。13件が一致しても、日付・金額を含むMVP全体の成功とは扱わない。未検証項目と、実行環境・手順を記録する。
- 対象外機能・対象外操作・曖昧入力を区別できなければ、[MVPの失敗時の案内](../MVP.md#未対応失敗時の挙動)を再検討する。LLMによる補完は追加しない。
- ローカルの結果は開発用の記録として扱い、公式Jevの接続成功・分類精度・MVPの合格を示す結果にはしない。本番と正式なMVP評価には公式Jevを使う。

## 未検証事項・次の段階

日付・金額などの引数抽出、コアへの組み込み、MCPのTool・通信方式・SDKと接続、UI・認証・業務APIは今回のプローブの対象外であり、未検証である。JEVを含む応答30秒以内の正式な実測はIssue #15で、ブラウザ送信から成功の最終結果受信までを測る。プローブのAPI呼び出しだけでは判定できない（[ADR-0001](adr/0001-mvp-hosting-and-storage.md)、[MVPの完了条件](../MVP.md#pocの完了条件と記録)）。

公式Jevは英語が主な訓練言語であり、CJKを含む他言語は精度が同等ではない。ローカルの既定モデルカードも`language: en`で、上記13入力では期待結果を満たさなかった。公式Jevの日本語精度と、多言語候補による改善は引き続き未検証であり、ローカルの結果を公式Jevへ一般化しない。[Models / Language support](https://docs.typesafe.ai/models#language-support)、[既定モデルカード](https://huggingface.co/MoritzLaurer/deberta-v3-large-zeroshot-v2.0)

Choiceは提示した候補を選ぶ形式で、任意の文字列を生成するものではない。日付は部品をChoiceで読み取りコードで日付にする例、金額は正規表現で候補を抽出しChoiceで選びコードで数値化する例が公式にある。日本語・円表記・MVPの固定基準日時への適用は別途検証し、実装方針を確定する。[Choice](https://docs.typesafe.ai/primitives/choice)、[Date extraction](https://docs.typesafe.ai/cookbooks/date_extraction_cookbook)、[Pre-parsed value extraction](https://docs.typesafe.ai/cookbooks/pre_parsed_value_extraction_cookbook)

接続・認証・リクエスト形式の出典: [TypeSafe Quick start](https://docs.typesafe.ai/introduction/quickstart)。モデルIDの出典: [Models](https://docs.typesafe.ai/models)。
