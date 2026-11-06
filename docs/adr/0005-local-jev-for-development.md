# ADR-0005: ローカル開発で公式Jevと実モデルを切り替える

- 状態: 決定（2026-11-06）。開発時の自動切替を決定した。ローカルモデルは初回検証の候補を指定した段階であり、local-jevの導入・起動成功、モデルの適合性、日本語の判定精度は未検証。
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
- local-jevは利用者がホスト側で確認したコミット`64a0b31ff343dca32142496cf9edca5a0174a18d`に固定する。初回検証の候補には`nli-deberta-large`を指定する。DeBERTa系の自然言語推論（NLI）モデルであり、文章生成LLMは追加しない。モデルの適合性は実測後に判断する。[モデル設定](https://github.com/amithgc/local-jev/blob/64a0b31ff343dca32142496cf9edca5a0174a18d/src/local_jev/cards/nli-deberta-large.json)、[モデルカード](https://huggingface.co/MoritzLaurer/deberta-v3-large-zeroshot-v2.0)
- 本番・正式なMVP評価には公式Jevを使う。ローカル開発の結果を公式Jevの合格判定やIssue #15の30秒条件の正式実測へ混ぜない。LLM不使用の方針を維持する。

## 影響と未検証事項

- NixのdevShellへPython 3.12とuvを追加する。`make jev-local-setup`で固定版を導入し、`make jev-local-serve`でloopback上の実モデルを起動する。環境・キャッシュは`.local-jev/`配下に置き、認証情報とモデル重みはGitに含めない。
- ローカルモデルのカードは`language: en`。日本語入力への適合性は未検証であり、MVPの入力例で確認する必要がある。公式Jevの結果と一致することも前提にしない。
- 導入・モデル重みのダウンロード・サーバ起動・実推論はまだ行っていない。runtimeを含む実ダウンロード量、CPU上の実メモリ使用量・速度、互換APIの応答も未確認である。
- プローブの各結果にproviderと応答modelを残す。日付・金額の抽出、MCPとの接続、UI・業務API、正式な性能評価は今回の切替の実装だけでは検証できない。
- 開発で得た結果に基づき、必要ならモデル選定・接続仕様・費用を再検討する。ローカルの判定結果だけで、正式MVPの利用モデルや完了条件を変更しない。
