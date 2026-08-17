# bitbank プライベート API エンドポイント棚卸し（税務ツール観点）

> **本書は実口座での検証記録**（[tax-fixtures-plan.md](../tax-fixtures-plan.md)）。
> 生データ（`raw/`）は**本リポジトリには置かない**（`BITBANK_TAX_FIXTURES` が指す別環境）。
> 口座規模が分かる絶対件数・実測金額・実日時は**丸めるか関係式に置換**してある。

- 出典: [bitbankinc/bitbank-api-docs](https://github.com/bitbankinc/bitbank-api-docs) `rest-api_JP.md`（2026-07-25 取得、全 1,807 行を精査）
- 「税務用途」タグ: **主要データ源** / **補助** / **用途なし** / **対象外（書き込み系）**
- 本棚卸しの調査自体は GET のみ実施。POST 系は docs の記載確認のみで一切呼んでいない

## 全エンドポイント一覧（rest-api_JP.md 記載順）

| # | メソッド/パス | docs 節 | 税務用途 | 備考 |
|---|---|---|---|---|
| 1 | GET /user/assets | アセット | **補助** | 現在残高。履歴ではないが**残高突合（再構築検証）の基準**として必須。amount_precision・withdrawal_fee マスタも含む |
| 2 | GET /user/spot/order | 注文情報 | 用途なし | 単一注文の現在状態。約定は trade_history で取れる |
| 3 | POST /user/spot/order | 注文情報 | 対象外（書き込み系） | 新規注文。税務ツールから呼ぶことはない |
| 4 | POST /user/spot/cancel_order | 注文情報 | 対象外（書き込み系） | |
| 5 | POST /user/spot/cancel_orders | 注文情報 | 対象外（書き込み系） | |
| 6 | POST /user/spot/orders_info | 注文情報 | 用途なし | 複数注文の照会（POST だが読み取り）。約定ベースの税務計算には不要 |
| 7 | GET /user/spot/active_orders | 注文情報 | 用途なし | 未約定注文。損益に影響しない |
| 8 | GET /user/margin/status | 信用取引情報 | **補助** | 現在値スナップショット。total_margin_balance は現物残高×掛目の評価合算（BALANCE_RECONCILIATION.md 補足） |
| 9 | GET /user/margin/positions | 信用取引情報 | **補助** | 建玉の未実現 fee/interest（unrealized_fee_amount / unrealized_interest_amount）と payables。**年末時点の未決済建玉の把握**に使用 |
| 10 | GET /user/spot/trade_history | 約定履歴 | **主要データ源** | 現物+信用の全約定。信用行は position_side / profit_loss / interest 付き（FIELDS.md §1） |
| 11 | GET /user/deposit_history | 入金 | **主要データ源** | **asset 省略で crypto のみ・fiat は asset=jpy 明示が必要**（実測）。付与イベント混入あり（txid=null 行・円未満端数行） |
| 12 | GET /user/unconfirmed_deposits | 入金 | 用途なし | 未反映入金の現在値。確定履歴は deposit_history 側 |
| 13 | GET /user/deposit_originators | 入金 | 用途なし | 送付人情報（トラベルルール対応）。損益に影響しない |
| 14 | POST /user/confirm_deposits | 入金 | 対象外（書き込み系） | 入金の確認操作 |
| 15 | POST /user/confirm_deposits_all | 入金 | 対象外（書き込み系） | |
| 16 | GET /user/withdrawal_account | 出金 | 用途なし | 登録済み出金先マスタ。withdrawal_history の account_uuid の解決に使えるが税額計算には不要 |
| 17 | POST /user/request_withdrawal | 出金 | 対象外（書き込み系） | 出金申請 |
| 18 | GET /user/withdrawal_history | 出金 | **主要データ源** | **asset 必須**（全資産巡回が必要、実測）。控除額 = amount + fee（実証済み） |
| 19 | GET /spot/status | 取引所ステータス | 用途なし | 公開系（認証不要）。取引所の稼働状態 |
| 20 | GET /spot/pairs | 銘柄詳細 | **補助** | 公開系。ペアマスタ（amount_digits / price_digits / 手数料率）。`cli/__tests__/__fixtures__/tax/pairs-master.json` として採取済み |
| 21 | GET /user/subscribe | プライベートストリーム | 用途なし | PubNub 接続用チャンネル/トークン取得。**リアルタイム通知のみで履歴取得はできない** |

## レンディング・キャンペーン付与・エアドロップの履歴取得エンドポイント

**存在しない（断定）**。根拠:

1. `rest-api_JP.md` 全 1,807 行に上記 21 エンドポイント以外の記載はない
2. docs リポジトリの全ファイル（README / assets.md / errors.md / networks.md / pairs.md / private-stream / public-api / public-stream / rest-api の各 md）を列挙し、レンディング（貸して増やす）・キャンペーン・エアドロップ・積立に関するエンドポイント文書は存在しない
3. `lend` / `貸` / `レンディング` / `campaign` / `キャンペーン` / `airdrop` / `積立` で docs を全文検索してもヒットなし（唯一の「付与」ヒットは認証ヘッダーの説明文で無関係）

### 税務ツール仕様への含意（これが根拠文書）

- **「貸して増やす」の貸出料・キャンペーン付与・エアドロップには専用の履歴 API が無い**。
  ただし「一切取得できない」わけではなく、一部は下記のとおり `deposit_history` に痕跡として現れる。
  API だけでは**付与の種別を判定できない**ため、種別確定と痕跡に現れない分は手動調整経路が必須
- **【2026-07-25 訂正】販売所（即時売買）の取引も API では取得できない**が、こちらは
  **UI CSV「売買履歴」で取得できる**（BALANCE_RECONCILIATION.md §2-1）。したがって
  「取得不能」ではなく「**API 不可・UI CSV 可**」であり、**UI CSV 取込は必須経路**になる。
  当初ここに「積立買付は取得不能」と書いていたのは誤りで、実体は販売所取引だった。
  **積立機能そのものの履歴取得可否は未確認**（この口座に積立の利用実績がないため検証できていない）
- ただし実測上、**一部の付与は deposit_history に「痕跡」として混入する**（BALANCE_RECONCILIATION.md §2-2, §2-3: 円未満端数の jpy 入金行、txid=null の crypto 入庫行）。混入分は取得可能だが、**種別（何の付与か）は API から判定不能**
- 混入しない付与は**残高突合でしか検出できない**

## 参考: 履歴系エンドポイントの取得上の注意（実測済み事項の索引）

| 事項 | 詳細 |
|---|---|
| trade_history は pair 省略可 | 全ペア横断で返る（ANSWERS.md Q7） |
| deposit_history の fiat | asset=jpy 明示が必須（BALANCE_RECONCILIATION.md 結論 3） |
| withdrawal_history | asset 必須・資産ごと巡回（ANSWERS.md Q7） |
| ページ境界 | タイムスタンプカーソルのため trade_id / uuid で重複排除必須 |
| CANCELED 出金 | 残高に影響しない（除外して残高整合を確認済み） |
