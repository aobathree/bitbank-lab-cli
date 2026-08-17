# 確認事項への回答（実レスポンス根拠付き）

> **本書は実口座での検証記録**（[tax-fixtures-plan.md](../tax-fixtures-plan.md)）。
> 生データ（`raw/`）は**本リポジトリには置かない**（`BITBANK_TAX_FIXTURES` が指す別環境）。
> 口座規模が分かる絶対件数・実測金額・実日時は**丸めるか関係式に置換**してある。
> JSON の実例は**形状を示すための合成値**で、実測値ではない（`address` のプレースホルダー定数を除く）。

採取日 2026-07-25。根拠 JSON は別環境の `raw/` 配下（識別子はマスク済み）。

## 1. 現物約定の手数料フィールド

**フィールドは 3 つ**: `fee_amount_base`（base 建て）/ `fee_amount_quote`（quote 建て）/
`fee_occurred_amount_quote`（quote 建て「発生」額）。

- base 建てと quote 建ての**両方のフィールドが常に併存**する。ただしこの口座では
  `fee_amount_base` が**全行で数値ゼロ**だった（手数料はすべて quote=JPY 建てで発生）。
  ゼロ表記の小数桁はペア精度依存（btc_jpy は `"0.00000000"`、xrp_jpy は `"0.000000"`）
- **メイカー約定は別フィールドではなく、同じ `fee_amount_quote` が負値になる**（負 = リベート受取）。
  maker 行のほぼ全てが負値で、1 行だけ `"0.0000"`（リベートなし期と推定）
- 現物では `fee_occurred_amount_quote` は `fee_amount_quote` と**全行一致**
  （現物全行で機械検証。docs も「現物取引では fee_amount_quote と同値」）
- 建て通貨: quote 通貨。観測ペアはすべて `*_jpy` のため実質 JPY

メイカー行（負値）の形状（**値は合成例**）:

```json
{
  "trade_id": 1000000001,
  "pair": "btc_jpy",
  "side": "sell",
  "type": "limit",
  "amount": "0.1000",
  "price": "2000000",
  "maker_taker": "maker",
  "fee_amount_base": "0.00000000",
  "fee_amount_quote": "-40.0000",
  "fee_occurred_amount_quote": "-40.0000",
  "executed_at": 1600000000000
}
```

テイカー行（正値）の形状:

```json
{
  "pair": "btc_jpy", "maker_taker": "taker",
  "fee_amount_base": "0.00000000",
  "fee_amount_quote": "1.2346",
  "fee_occurred_amount_quote": "1.2346"
}
```

## 2. 出庫レスポンスの手数料フィールド

**ある**。フィールド名は `fee`。建て通貨は**出庫資産と同一**（jpy 出金なら JPY、eth 出金なら ETH）。

- レスポンス上は `amount` と別掲の独立フィールド
- **「引落総額 = amount + fee」か「amount に fee 込み」かは、レスポンスからも公式 docs からも判定不可**
  → 残高突合で**仮説1（amount + fee）に確定**（BALANCE_RECONCILIATION.md 結論 1）
- fee はネットワーク・資産ごとに異なる固定額（同一資産でもネットワークで変わる例あり: eth の
  Arbitrum と Ethereum mainnet）

実例の形状（**値は合成例**）:

```json
{
  "uuid": "MASKED_UUID_38",
  "network": "arbitrum",
  "asset": "eth",
  "amount": "0.1000000",
  "fee": "0.00042",
  "status": "DONE",
  "requested_at": 1700000000000
}
```

## 3. 入庫レスポンスの txid / アドレス

**両方含まれる**。`txid` と `address`（自分の入金アドレス）のキーが crypto 全行に存在。`network` も付く。

> **訂正（第2バッチで判明）**: キーは全行に存在するが、**btc の 1 行は `txid` が `null`、`address` が
> bitbank 側のプレースホルダー文字列 `"xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"`** だった
> （チェーン外付与とみられる）。txid は「crypto なら常に文字列」ではなく **nullable**。
> 詳細は BALANCE_RECONCILIATION.md §2-3。
> また、**asset 省略時のレスポンスには fiat（jpy）行が含まれない**ことが判明（`asset=jpy` 明示で取得）。
> 同 §結論 3 参照。

- 注意: この口座の入庫は crypto 経路が中心。**fiat（jpy）入庫行は asset 省略では未観測**。
  docs では txid は「暗号資産の時のみ」であり、fiat 行では network / address / txid がキーごと欠落する
- XRP 入庫行にも destination_tag / memo 相当のキーは**無い**

実例の形状（**値は合成例**・マスク済み）:

```json
{
  "uuid": "MASKED_UUID_1",
  "asset": "arb",
  "amount": "100.00000000",
  "network": "arbitrum",
  "address": "MASKED_ADDRESS_1",
  "txid": "MASKED_TXID_1",
  "found_at": 1700000000000,
  "confirmed_at": 1700000389014,
  "status": "DONE"
}
```

## 4. 信用決済のフィールドと符号・突合

**専用の金利・貸付返済履歴エンドポイントは公式 docs に存在しない**。信用の実現損益・利息・手数料は
すべて `GET /user/spot/trade_history` の**行内フィールド**として返る（現物と同一エンドポイント・同一配列）:

- `position_side`（"long"/"short"）— このキーが**ある行が信用**。現物行にはキー自体が無い（null ではなく欠落）
- `profit_loss` — 実現損益（JPY）。**正=益 / 負=損**。建玉 open 行は `"0"`、決済行に入る
- `interest` — 利息（JPY）。観測は**正=支払**（open 行 `"0"`、決済行に計上）。
  ショート時に受取側で負になるかは未観測 = 不明
- `fee_amount_quote` — 信用では「請求」額: open 行は `"0.0000"`（未徴収）、
  **決済行にポジション累計手数料**が入る。`fee_occurred_amount_quote` は各約定の発生分

同一ポジションの open → close の形状（**値は合成例**）:

```json
{
  "trade_id": 1000000002, "pair": "eth_jpy", "side": "buy",  "type": "market",
  "amount": "0.0100", "price": "300000", "maker_taker": "taker",
  "position_side": "long",
  "fee_amount_quote": "0.0000", "fee_occurred_amount_quote": "3.0000",
  "profit_loss": "0", "interest": "0", "executed_at": 1700000000000
}
{
  "trade_id": 1000000003, "pair": "eth_jpy", "side": "sell", "type": "market",
  "amount": "0.0100", "price": "301000", "maker_taker": "taker",
  "position_side": "long",
  "fee_amount_quote": "6.0100", "fee_occurred_amount_quote": "3.0100",
  "profit_loss": "3.3900", "interest": "0.6000", "executed_at": 1700086400000
}
```

検算（**実測値は関係式に置換**。丸めた値を並べると恒等式が成立せず証拠価値が失われるため）:

- 価格差損益 = (決済価格 − 建て価格) × 数量
- 決済行の `fee_amount_quote` = open 行の `fee_occurred_amount_quote` + close 行の同フィールド（= 累計請求）
- **`profit_loss` = 価格差損益 − 決済行 `fee_amount_quote` − `interest`** が**原精度で完全一致**することを実測で確認
  （手数料の丸め値を使うと見かけの差が出るが、完全精度で計算すれば誤差ゼロ。FIELDS.md 参照）
- → `profit_loss` は**手数料・利息控除後のネット実現損益**。インポータで fee / interest を別途減算すると
  **二重計上**になる

重複・突合:

- 別エンドポイントとの重複計上は**構造上発生しない**（金利履歴 API が無いため）。
  突合キーは信用行も `trade_id` / `order_id` を持つ
- 未実現分は `GET /user/margin/positions` の `positions[].unrealized_fee_amount` /
  `unrealized_interest_amount`、確定済み未徴収は `payables.amount`（いずれも現在値スナップショットで履歴なし）

## 5. 日時フィールドの形式

**すべて Unix epoch ミリ秒の JSON number（13 桁）**。ISO 文字列・タイムゾーン表現は一切登場しない
（epoch なので TZ 非依存。JST 表示は変換側の責務）。

| エンドポイント | フィールド |
|---|---|
| trade_history | `executed_at` |
| deposit_history | `found_at`（検知）, `confirmed_at`（承認。docs「承認後のみ存在」） |
| withdrawal_history | `requested_at`（申請。**完了時刻フィールドは無い**） |

UI の CSV は JST 表記のため、UI CSV と突合する場合は +9h 変換が必要。

## 6. 約定履歴に登場する通貨ペア

全期間で登場したのは以下の**十数ペア、すべて JPY 建て**。**BTC 建てペアは過去分にも含まれない**
（件数は口座規模の情報になるため記載しない）:

```text
eth_jpy / btc_jpy / matic_jpy / xrp_jpy / link_jpy / imx_jpy / mkr_jpy / arb_jpy /
doge_jpy / bcc_jpy / enj_jpy / oas_jpy / mona_jpy / atom_jpy / flr_jpy / rndr_jpy / ltc_jpy
```

- rename 系の注意: `matic_jpy`（現 pol）と `rndr_jpy`（現 render）が**旧シンボルのまま**履歴に残る。
  assets 側には matic/pol、rndr/render が両方存在するため、インポータはシンボル対応表が必要
- delist 済みペアも履歴にはそのまま残る（bcc_jpy 等）

## 7. ページネーション方式と遡及期間の実測

| エンドポイント | 方式 | 実測 |
|---|---|---|
| /user/spot/trade_history | `count`（最大 1000）+ `since`/`end`（executed_at ミリ秒）+ `order`（asc/desc、既定 desc）。**pair は省略可能で全ペア横断が返る**（実測で確認） | asc + since 前方走査で完走。**口座開設時（5 年以上前）まで到達**（API 側の遡及上限は未到達のため不明） |
| /user/deposit_history | `count` + `since`/`end`（found_at ミリ秒）。既定 desc。`asset` 省略可能（実測で確認） | 1 ページで全量。**口座開設直後まで到達** |
| /user/withdrawal_history | `count` + `since`/`end`（requested_at ミリ秒）。**`asset` 必須**（省略時の全資産横断は不可。資産ごとに巡回が必要） | 全資産巡回で非空は少数資産。**口座開設直後まで到達**。1000 件上限に達した資産なし |
| /user/margin/status, /user/margin/positions | ページングなし（現在値スナップショット） | - |

- ページ境界: `since`/`end` はタイムスタンプカーソルのため、同一ミリ秒に複数レコードがあると境界で
  重複が返り得る。`trade_id` / `uuid` での重複排除が**必須**（実測でも境界重複を確認）
- レート制限: 逐次 400ms 間隔・計 60 リクエスト弱で 429 なし
- 遡及上限: この口座の開設以前のデータが存在しないため、「API が何年前まで返すか」の上限は
  **この口座では測定不能**（少なくとも 5 年超は返ることを確認）
