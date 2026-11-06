# JEV接続・Intent分類の検証（Issue #16）

状態: 検証準備。TypeSafeのJev / Choiceを検証候補とし、実APIへの接続成功や日本語での判定精度はまだ確認していない。Issue #16全体の完了を示す文書ではない。

## 今回の範囲

Node.js 24の標準HTTP機能で、固定した入力をTypeSafe APIへ送り、Intent分類の結果を期待値と照合する。SDKや追加の依存関係は導入しない。JEVだけで判定し、LLMへは回さない（[ADR-0004](adr/0004-jev-first-intent-routing.md)）。

| 接続項目 | 検証候補 |
| --- | --- |
| 接続先 | `https://api.typesafe.ai/v1/systemone` |
| メソッド・認証 | `POST`・Bearer認証 |
| モデル | `jev-1.14.0`（再現のため固定） |
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

既存のdevShell内で実行する。

| コマンド | 内容・外部通信 |
| --- | --- |
| `make jev-check` | オフラインテスト。実APIへ接続しない |
| `make jev-probe` | `--dry-run`で13入力とChoiceリクエストを表示する。APIキー不要・外部通信なし |
| `make jev-probe-live` | 利用者のホスト側で`TYPESAFE_API_KEY`を設定して実行する。最大13回の実API呼び出しを行い、課金が発生し得る |

認証情報は利用者がホスト側で管理し、キーの値をチャット・出力・検証記録に含めない。実行する入力は上記の固定サンプルとし、業務APIやDBの呼び出し・保存は行わない。

## 受け入れ条件と記録

- オフラインテストが成功し、dry-runで13件の入力・期待値・送信するリクエストを確認できる。
- 実接続では各入力の応答モデル・選択されたIntent・期待値との一致を記録する。分類の不一致は残りの入力も続けて記録し、終了コードを1にする。接続・HTTP・JSON・契約エラーは成功として扱わず、その時点で中断する。中断後の入力は未実施であり、13件すべてを検証できたとは扱わない。
- 実接続の成否と分類の成否を区別する。13件が一致しても、日付・金額を含むMVP全体の成功とは扱わない。未検証項目と、実行環境・手順を記録する。
- 対象外機能・対象外操作・曖昧入力を区別できなければ、[MVPの失敗時の案内](../MVP.md#未対応失敗時の挙動)を再検討する。LLMによる補完は追加しない。

## 未検証事項・次の段階

日付・金額などの引数抽出、コアへの組み込み、MCPのTool・通信方式・SDKと接続、UI・認証・業務APIは今回のプローブの対象外であり、未検証である。JEVを含む応答30秒以内の正式な実測はIssue #15で、ブラウザ送信から成功の最終結果受信までを測る。プローブのAPI呼び出しだけでは判定できない（[ADR-0001](adr/0001-mvp-hosting-and-storage.md)、[MVPの完了条件](../MVP.md#pocの完了条件と記録)）。

公式資料では、英語が主な訓練言語であり、CJKを含む他言語は精度が同等ではない。日本語の13入力での実測を必要とする。[Models / Language support](https://docs.typesafe.ai/models#language-support)

Choiceは提示した候補を選ぶ形式で、任意の文字列を生成するものではない。日付は部品をChoiceで読み取りコードで日付にする例、金額は正規表現で候補を抽出しChoiceで選びコードで数値化する例が公式にある。日本語・円表記・MVPの固定基準日時への適用は別途検証し、実装方針を確定する。[Choice](https://docs.typesafe.ai/primitives/choice)、[Date extraction](https://docs.typesafe.ai/cookbooks/date_extraction_cookbook)、[Pre-parsed value extraction](https://docs.typesafe.ai/cookbooks/pre_parsed_value_extraction_cookbook)

接続・認証・リクエスト形式の出典: [TypeSafe Quick start](https://docs.typesafe.ai/introduction/quickstart)。モデルIDの出典: [Models](https://docs.typesafe.ai/models)。
