# bitbank プライベート API 生レスポンス フィールド一覧

> **本書は実口座での検証記録**（[tax-fixtures-plan.md](../tax-fixtures-plan.md)）。
> 生データ（`raw/`）は**本リポジトリには置かない**（`BITBANK_TAX_FIXTURES` が指す別環境）。
> **「実例値」列は形状を示すための合成値**で実測値ではない（`address` のプレースホルダー定数を除く）。
> 口座規模が分かる絶対件数・実日時も丸めるか省いてある。

- 採取日: 2026-07-25（UTC）。別環境の `raw/` の各 JSON が根拠（レスポンス envelope `{success, data}` ごと保存、pretty-print のみ）
- マスキング: `uuid` / `account_uuid` / `txid` / `address` / `label` / `destination_tag` / 銀行口座 4 項目のみ `MASKED_<FIELD>_<n>` に置換（同一値は同一トークン）。数量・金額・日時・フィールド名は無変換
- 「型」は JSON 上の型。bitbank は数値をほぼすべて **文字列** で返す（数値型は ID とタイムスタンプのみ）
- 表に載せたフィールドはすべて実レスポンスに存在したもの。実在しないものは載せていない

## 1. GET /user/spot/trade_history（約定履歴: 現物・信用共通）

配列パス: `data.trades[]`。採取: 全ペア横断（pair 省略）・口座の全期間（maker 行と信用行を含む）

| フィールド名（生） | 型 | 実例値 | 単位/建て通貨 | 符号の意味 | UI CSVの対応カラム（分かる範囲） | 備考 |
|---|---|---|---|---|---|---|
| trade_id | number | 1000000001 | - | - | 取引ID | 一意性が保証されるのは**ペア内**。全ペア横断の重複排除キーは **`pair:trade_id`**（実装もこの複合キー） |
| order_id | number | 2000000001 | - | - | 注文ID | |
| pair | string | "btc_jpy" | - | - | 通貨ペア | 観測は全て `*_jpy`（§ANSWERS Q6） |
| side | string | "buy" / "sell" | - | - | 売/買 | 2 値のみ観測 |
| type | string | "limit" / "market" / "stop" | - | - | タイプ | 3 値を観測 |
| amount | string | "0.1000" | base 通貨数量 | 常に正 | 数量 | 小数桁はペアの base 精度依存 |
| price | string | "2000000" | quote/base | 常に正 | 価格 | |
| maker_taker | string | "maker" / "taker" | - | - | M/T | |
| fee_amount_base | string | "0.00000000" / "0.000000" | base 通貨 | 不明（非ゼロ実例なし） | 手数料（base 建て時） | **全行で数値ゼロ**。桁数だけペア精度で異なる（btc=8 桁, xrp=6 桁）点に注意 |
| fee_amount_quote | string | "1.2346" / "-40.0000" | quote 通貨（JPY） | 正=支払、**負=受取（メイカーリベート）** | 手数料 | 信用では「請求」額: 建玉 open 行は "0.0000"、決済行にポジション累計が入る（ANSWERS.md Q4 の例） |
| fee_occurred_amount_quote | string | "3.0000" | quote 通貨（JPY） | 正=発生、負=受取 | 不明 | 「発生」手数料。**現物では fee_amount_quote と全行一致**（現物全行で検証、docs にも同旨）。信用では約定ごとの発生分で fee_amount_quote と異なる |
| executed_at | number | 1700000000000 | Unix epoch ミリ秒 | - | 取引日時（UI は JST 表記） | |
| position_side | string | "long" | - | - | 不明 | **信用行のみキー存在**（現物行には無い）。観測は "long" のみ |
| profit_loss | string | "3.3900" | quote 通貨（JPY） | 正=益 / 負=損 | 不明 | 信用行のみ。open 行は "0"、決済行に実現損益（Q4 で検算） |
| interest | string | "0.6000" | quote 通貨（JPY） | 正=支払利息（観測は正と "0" のみ） | 不明 | 信用行のみ。決済行に計上 |

## 2. GET /user/deposit_history（暗号資産入庫履歴）

配列パス: `data.deposits[]`。採取: asset 省略・口座の全期間（全行 crypto・全行 DONE）。
**第2バッチ（batch2）で追加判明**: asset **省略時は fiat（jpy）行が返らない**。`asset=jpy` 明示で日本円入金を取得（`raw/<batch>/user_deposit_history_jpy_*.json`）。fiat 行のキーは uuid / asset / amount / found_at / confirmed_at / status のみ（network / address / txid は**キーごと欠落**）

| フィールド名（生） | 型 | 実例値 | 単位/建て通貨 | 符号の意味 | UI CSVの対応カラム（分かる範囲） | 備考 |
|---|---|---|---|---|---|---|
| uuid | string | "MASKED_UUID_1"（生: UUID v1 形式） | - | - | 不明 | ページング重複排除キー |
| asset | string | "arb" | - | - | 不明 | |
| amount | string | "100.00000000" | 当該資産 | 常に正 | 数量 | **手数料フィールドは存在しない**（入庫は無手数料） |
| network | string | "arbitrum" | - | - | 不明 | 観測値: arbitrum, bitcoin, cosmos, ethereum, flare, litecoin, oasys, ripple |
| address | string | "MASKED_ADDRESS_1"（生: 0x... / r... 等） | - | - | 不明 | 自分の入金アドレス |
| txid | string / **null** | "MASKED_TXID_1"（生: チェーン上の txid） | - | - | 不明 | キーは crypto 全行に存在するが **null の行あり**（btc の 1 行。address もプレースホルダー "xxxxxxxx-…"。チェーン外付与とみられる。BALANCE_RECONCILIATION.md §2-3）。docs では「暗号資産の時のみ」 |
| status | string | "DONE" | - | - | ステータス | 観測は DONE のみ |
| found_at | number | 1700000000000 | Unix epoch ミリ秒 | - | 日時 | 検知時刻 |
| confirmed_at | number | 1700000389014 | Unix epoch ミリ秒 | - | 不明 | docs「承認後のみ存在」。観測は全行あり（全行 DONE のため） |

- fiat（jpy）行は `asset=jpy` 明示時のみ返る（上記）。円未満端数の付与様レコードを含む（BALANCE_RECONCILIATION.md §2-2）
- XRP 入庫行にも destination_tag / memo に相当するキーは**存在しない**（deposit の生レスポンス参照）

## 3. GET /user/withdrawal_history（出庫履歴: 暗号資産・日本円共通）

配列パス: `data.withdrawals[]`。採取: asset **必須**のため全資産を巡回（非空は少数資産）。空レスポンス例: `raw/<batch>/user_withdrawal_history_<asset>_empty_*.json`

共通フィールド（crypto / jpy 両方に存在）:

| フィールド名（生） | 型 | 実例値 | 単位/建て通貨 | 符号の意味 | UI CSVの対応カラム（分かる範囲） | 備考 |
|---|---|---|---|---|---|---|
| uuid | string | "MASKED_UUID_123" | - | - | 不明 | |
| asset | string | "eth" / "jpy" | - | - | 不明 | |
| account_uuid | string | "MASKED_ACCOUNT_UUID_1" | - | - | 不明 | 出金先アカウント（登録済み宛先）の ID |
| amount | string | "0.1000000" / "10000" | 当該資産 | 常に正 | 数量 | **fee を含まない**（残高突合で確定。資産の減少 = `amount` + `fee`。BALANCE_RECONCILIATION 結論1） |
| fee | string | "0.00042" / "550" | **当該資産と同一建て** | 常に正（ゼロ含む可能性は未観測） | 手数料 | 資産・ネットワークごとの固定額（同一資産でもネットワークで変わる。値は `/user/assets` の `withdrawal_fee` マスタ参照） |
| status | string | "DONE" / "CANCELED" | - | - | ステータス | 2 値を観測。税務では CANCELED 除外が必要 |
| requested_at | number | 1700000000000 | Unix epoch ミリ秒 | - | 日時 | 申請時刻。完了時刻のフィールドは**存在しない** |

crypto 出庫のみ存在:

| フィールド名（生） | 型 | 実例値 | 備考 |
|---|---|---|---|
| network | string | "arbitrum" | 観測値: arbitrum, bitcoin, ethereum, oasys, polygon, ripple |
| label | string | "MASKED_LABEL_1"（生: ユーザー命名の宛先ラベル） | |
| address | string | "MASKED_ADDRESS_5"（生: 送付先アドレス） | |
| txid | string | "MASKED_TXID_100" | |
| destination_tag | **number** | 生: 9 桁程度の数値（マスク後は文字列トークン） | XRP 行のみ観測。**生の型は number**（マスキングで文字列化した点に注意） |

jpy（法定通貨）出庫のみ存在（jpy 行には network/address/txid/label が**キーごと欠落**）:

| フィールド名（生） | 型 | 実例値 | 備考 |
|---|---|---|---|
| bank_name | string | "MASKED_BANK_NAME_1"（生: 銀行名の日本語文字列） | |
| branch_name | string | "MASKED_BRANCH_NAME_1"（生: 支店名の日本語文字列） | |
| account_type | string | "NORMAL" | 普通口座。他の値は未観測 |
| account_number | string | "MASKED_ACCOUNT_NUMBER_1"（生: 数字文字列） | |
| account_owner | string | "MASKED_ACCOUNT_OWNER_1"（生: カタカナ名義） | |

## 4. GET /user/margin/status（信用ステータス: 現在値スナップショット、履歴ではない）

オブジェクトパス: `data`。ポジション未保有時の採取のため大半が "0.0000" / null

| フィールド名（生） | 型 | 実例値 | 備考 |
|---|---|---|---|
| status | string | "NORMAL" | |
| total_margin_balance_percentage | null | null | ポジション無し時は null |
| total_margin_balance | string | "10000.0000" | JPY（**合成例**） |
| margin_position_profit_loss | string | "0.0000" | JPY。評価損益 |
| unrealized_cost | string | "0.0000" | |
| total_margin_position_product / open_margin_position_product / open_margin_order_product | string | "0.0000" | |
| total_position_maintenance_margin ほか maintenance_margin 系 6 種 | string | "0.0000" | total/long/short × position/open_order |
| margin_call_percentage / losscut_percentage | null | null | |
| buy_credit / sell_credit | string | "500000" / "30000000" | JPY（口座区分ごとの与信枠） |
| available_balances[] | array | `{pair, long, short}` | pair ごとの発注可能額（JPY 文字列） |

## 5. GET /user/margin/positions（信用建玉: 現在値スナップショット、履歴ではない）

オブジェクトパス: `data`

| フィールド名（生） | 型 | 実例値 | 備考 |
|---|---|---|---|
| notice | object | `{what: null, occurred_at: null, amount: null, due_date_at: null}` | 追証等の通知。無し時は全 null |
| payables.amount | string | "0.0000" | 未払い額（JPY）。確定済み未徴収分 |
| positions[].pair | string | "btc_jpy" | 信用対応 5 ペア × long/short の 10 要素が建玉ゼロでも返る |
| positions[].position_side | string | "long" / "short" | |
| positions[].open_amount | string | "0.0000" | base 数量 |
| positions[].product | string | "0.0000" | 建玉金額（JPY） |
| positions[].average_price | string | "0" | |
| positions[].unrealized_fee_amount | string | "0.0000" | **未実現（未徴収）手数料**。決済時に trade_history 側 fee_amount_quote へ確定 |
| positions[].unrealized_interest_amount | string | "0.0000" | **未実現（未徴収）金利**。決済時に trade_history 側 interest へ確定 |
| losscut_threshold | object | `{individual: "0.5", company: "0.5"}` | |

## カバレッジと未観測領域

- 約定: 全期間・全ペア取得済み。maker 約定を含む。信用は long 建て→決済の 1 往復のみ（short・複数部分決済・ロールオーバー金利の日次挙動は未観測）
- 入庫: 全期間取得済み。**asset 省略経路では fiat（jpy）入庫・DONE 以外の status は未観測**
- 出庫: 全期間取得済み（1000 件/資産の上限に達した資産なし）。crypto の CANCELED は未観測（CANCELED は jpy のみ）
- 信用の金利・貸付返済の**専用履歴エンドポイントは公式 docs に存在しない**（ANSWERS Q4）
