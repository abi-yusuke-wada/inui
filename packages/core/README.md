# @inui/core

PoCアプリに依存しない、サーバー側のIntent判定コア。`nli-deberta-large`へ7候補のChoiceリクエストを送り、検証した結果だけを返す。公式APIやAPIキーは参照しない。

`createIntentRouter({ baseUrl?, timeoutMs?, fetchImpl? })`が返す関数へ、前後の空白を除いて1〜2000文字の入力を渡す。接続先はloopback URLだけを許し、既定は`http://127.0.0.1:8765`。リダイレクトを拒否し、既定25秒でJSON本文の読み取りまでを制限する。

結果は`RoutingDecision`で、`kind: 'screen'`なら`intent`と`ui`が同じ固定画面名（`leave_request`、`expense_request`、`application_status`、`schedule_compare`）、`kind: 'notice'`なら対象外・未対応操作・曖昧入力への固定案内となる。人名解決や業務APIの実行、日付・金額の抽出は行わない。

`buildLocalRequest(text)`と`parseLocalResponse(body)`も公開する。モデル・7候補・確率の合計と最大値・トークン使用量を検証し、未知の候補やTool・UI・args等の混入を拒否する。wireの`unspecified_application`は検証後にだけ`clarify`へ対応付ける。7候補の説明は既存13入力で採用した説明を基に予定比較を追加したもので、既存プローブの履歴は変更しない。

失敗は`new DecisionError(code)`で返し、`code`は`invalid_input`、`invalid_response`、`unavailable`、`timeout`のいずれか。日本語メッセージは固定し、上流の本文・例外詳細を含めない。

テストは`make core-check`、アプリを含む型検査・ビルド・テストは`make app-check`から実行する。注入した通信によるテストは契約と失敗処理の確認であり、実NLIの分類精度やブラウザからの正式30秒条件の実測ではない。予定比較を加えた7候補の実モデル検証は別途行う。
