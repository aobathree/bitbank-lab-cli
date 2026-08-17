# 税務データ整形 P0 設計メモ

> 作成: 2026-07-25。対象は [tax-requirements.md](tax-requirements.md) §10 の **P0 1〜4**。
> 税務ルールの正は [tax-research.md](tax-research.md)（v2.1）。矛盾時は v2 を採る。
> 実装着手前のレビュー用。**要判断**（§4）が解けるまでコードは書かない。
>
> **状況（2026-07-26 更新）**: §4-1（fixtures）・§4-2（decStr と chaos x14）・§4-3（数値表現）・
> §4-5（ロードマップ）は解決済み。**未解決は §4-4（TRADE_EXCHANGE の優先度）の 1 件のみ**で、
> 既定案（P0 = 非JPYクォートを無条件検出してブロック／完全計算は P2）で進行中。
> §4-2 は「`decStr` を `cli/schema-helpers.ts` に追加し、chaos x14 のスコープを `cli/tax/` へ
> 広げる」で決着（規約から外れるのではなく規約側を拡張した）。
>
> **実装状況（P0-1〜4 完了 + 年間取引報告書突合）**: §2 のモジュール分割は
> `import-csv/` の販売所側を除いてすべて実装済み。
> CLI は `bitbank tax events / reconcile / verify-report / pnl` の 4 本。差分は次の 4 点:
> - `import/` に `paginate.ts`（3 エンドポイント共通のページャ）と `fetch-assets.ts`（突合の基準）を追加
> - `to-events.ts` は現物 / 信用 / 入出庫を別ファイルに割り、組み立てたイベントを
>   **TaxEvent スキーマで検証**してから返す（条件付き必須の単一ソースを superRefine に保つため）
> - 移動平均法（非丸め）に**売却 5,000 件の上限**を入れた（ADR-005 の計測。超過は黙って劣化させず
>   violations で明示して総平均法 / 互換モードへ誘導する）
> - `import-csv/` は先に**年間取引報告書（集計 CSV）**側を実装した（`parse-csv.ts` /
>   `parse-report.ts` / `annual-report*.ts` / `margin-report*.ts`）。現物と信用は別様式・
>   別ファイルなので別スキーマで読む。突合本体は `verify/`。販売所の「売買履歴」CSV は
>   取込元が別なので `import-csv/brokerage.ts` として P0-6 に残る
> - 信用の仕訳は `ledger/margin-entries.ts` に分離した。報告書の「年中信用取引損益」は
>   利息だけを控除した値なので、API の `profit_loss`（手数料も控除済み）へ手数料を
>   **足し戻して**差益/差損に置き、手数料は必要経費として別建てにする
>   （[ロードマップ](tax-roadmap.md)「P-06 への含意」参照）
>
> **P0-6 完了（2026-07-26）**: 販売所「売買履歴」CSV を `import-csv/brokerage*.ts` +
> `to-events-brokerage.ts` で取り込む。統合（`merge.ts` 相当）は `import/to-events.ts` に置いた
> — 注文ID の重複と API 約定の `order_id` との交差を弾く処理は、突き合わせる相手（生の約定）を
> 持っている場所でしか書けないため。`--brokerage-csv` は events / reconcile / pnl /
> verify-report の 4 本すべてに付く（どれも `collectEvents` を通るため）。
>
> **残り**: 約定履歴 CSV（`trades-csv.ts`。完全精度の手数料を監査用に保持。P-16 の採用値は
> API のままなので P1）と P1 以降。年間取引報告書との突合（`tax verify-report`）は取込ではなく
> **検証**なので P0-6 とは別物で、販売所ぶんが埋まったかを測る役割を担う。
>
> **【2026-07-26 仕様訂正の反映】販売所（即時売買）は API に一切現れない**（付録E.3 訂正）。
> UI CSV 取込が P1 → **P0 に昇格**したため、本メモに `MarketType` / `SourceSystem` と
> `import-csv/` を追加した。BALANCE_RECONCILIATION の「積立」「ダスト消滅」は誤診で、
> **両者とも販売所取引**だったことが確定している。

## 1. 正規化スキーマ型定義案（v2 §13 準拠）

Zod が型の単一ソース（CLAUDE.md）。`z.infer` で型を導出し、手書き interface は置かない。

```ts
// cli/tax/schema/primitives.ts
/** 十進文字列。float 化しないための表現型（後述 §4-2 の decStr） */
export const decStr = z.string().regex(/^-?\d+(\.\d+)?$/, "decimal string required");

export const Venue = z.enum(["BITBANK", "EXTERNAL_EXCHANGE", "SELF_WALLET", "COUNTERPARTY", "UNKNOWN"]);

/** 約定の場（付録E.3 訂正）。**販売所は API に一切現れない**ため、これは
 *  「どのソースから来たか」ではなく「どこで約定したか」を表す税務上の属性 */
export const MarketType = z.enum(["ORDERBOOK", "BROKERAGE"]); // 取引所（板） / 販売所（即時売買）
/** 取込元。P-16 の優先順位判定と監査に使う（要求仕様 §2.4） */
export const SourceSystem = z.enum(["API", "UI_CSV_TRADES", "UI_CSV_BROKERAGE", "MANUAL"]);
export const RecognitionPolicy = z.enum(["DELIVERY_DATE", "CONTRACT_DATE"]); // P-09
export const TransferReason = z.enum([
  "SELF_TRANSFER", "PURCHASE_EXTERNAL", "GIFT", "INHERITANCE", "REWARD", "PAYMENT", "UNKNOWN",
]);
export const CostbasisProvenance = z.enum([
  "PURCHASE", "EXCHANGE_FMV", "REWARD_FMV", "ZERO_FORK", "CARRYOVER",
  "INHERITED_BOOK", "GIFT_FMV", "LOW_PRICE_SUM", "DEEMED_5PCT", "MANUAL",
]);
export const EventFlag = z.enum([
  "UNRESOLVED_TRANSFER",  // v2 §13.3: 解決まで当該銘柄の参考損益をブロック
  "NO_RATE", "USER_CONFIRMED", "POSSIBLE_ICHIJI_SHOTOKU", // §7 P-08
  // 付録E.3: crypto は txid=null（プレースホルダ address を伴う形が実観測された強いシグナル
  // だが、address 一致まで必須にすると取りこぼす。過検出は手動確認で済むが過少検出は
  // 取得原価の誤りになるため緩い側）。jpy は 円未満端数 & found_at==confirmed_at & 秒以下 00.000
  "GRANT_SUSPECT",
  "FEE_API_ROUNDED",      // 付録E.1: API 手数料は 4 桁丸め値（P-16）
  "NON_JPY_QUOTE",        // 付録E.5: BTC 建てペア検出（TRADE_EXCHANGE 経路 or 明示エラー）
  "UNOBSERVED_SHAPE",     // §9-8: 未観測形状 → 保留リスト
  "BROKERAGE_SPREAD",     // 付録E.3: 販売所は手数料列なし（スプレッド内包）。fee=0 と混同しない
  "API_UNREACHABLE",      // API では取得不能な経路（販売所）由来。CSV 未投入なら欠落する
]);
```

```ts
// cli/tax/schema/event.ts — v2 §13.2 の Event
export const EventKind = z.enum([
  "TRADE_SPOT_BUY", "TRADE_SPOT_SELL", "TRADE_EXCHANGE",
  "MARGIN_OPEN", "MARGIN_CLOSE", "FEE", "REBATE",
  "LENDING_REWARD", "CAMPAIGN_REWARD", "AIRDROP", "FORK_RECEIPT",
  "DEPOSIT", "WITHDRAWAL", "PAYMENT",
  "GIFT_OUT", "GIFT_IN", "BEQUEST_OUT", "INHERITANCE_IN", "LOW_PRICE_TRANSFER", "DONATION",
  "ADJUSTMENT",
]);

export const TaxEvent = z.object({
  event_id: z.string(),                 // 決定論的に生成（下記）
  source_ref: z.string(),               // trade_id / uuid（監査・重複排除）
  ts_utc: z.number().int(),             // API の Unix ms をそのまま
  ts_jst: z.string(),                   // jstIso() の +09:00 付き ISO
  year_jst: z.number().int(),           // jstYear()。年分判定はこれだけを使う
  account_id: z.string(),               // 既定 "bitbank:default"（サブアカウントは P2）
  kind: EventKind,
  market_type: MarketType.optional(),   // 約定系のみ。BROKERAGE は CSV 経由でしか入らない
  source_system: SourceSystem,          // §2.4 の優先順位判定・監査ログ用
  currency: z.string(),                 // 名寄せ後の資産キー（matic→pol, rndr→render のみ）
  qty: decStr,
  jpy_value: decStr.optional(),
  rate_source: z.object({               // §6 P-07 の監査情報
    pair: z.string(), venue: Venue, method: z.enum(["LAST_TRADE", "VIA_PAIR", "EXTERNAL", "MANUAL"]),
    ts_utc: z.number().int(), path: z.array(z.string()),
  }).optional(),
  transfer: z.object({
    counter_account_id: z.string().optional(),
    transfer_group_id: z.string().optional(),
    reason: TransferReason,
    fee_qty: decStr.optional(),         // 付録E.3: 出庫の資産減少 = amount + fee
  }).optional(),
  margin: z.object({                    // §5・付録E.2
    position_side: z.enum(["long", "short"]),
    role: z.enum(["OPEN", "CLOSE"]),    // API に無いのでトラッカーが決定（§2 margin-tracker）
    realized_net: decStr.optional(),    // profit_loss（ネット。再控除禁止）
    interest: decStr.optional(),
    fee_charged: decStr.optional(),     // fee_amount_quote（決済時は建て分込みの累計）
    fee_occurred: decStr.optional(),    // fee_occurred_amount_quote
  }).optional(),
  fee: z.object({                       // 現物の手数料内訳（§4）
    quote_charged: decStr, quote_occurred: decStr, base: decStr,
  }).optional(),
  costbasis_provenance: CostbasisProvenance.optional(), // 取得系イベントに必須（検証で強制）
  recognition_policy: RecognitionPolicy,
  flags: z.array(EventFlag),
  pair_raw: z.string().optional(),      // 付録E.5: ペア名は生値保持（名寄せしない）
});
export type TaxEvent = z.infer<typeof TaxEvent>;
```

- `event_id` は `<kind>:<source_ref>`（取引所約定は `trade:<trade_id>`、**販売所は `brk:<注文ID>`**、
  入出庫は `dep:<uuid>`/`wd:<uuid>`）で決定論的に生成する。再取得で同一 → 冪等性（NFR）と
  重複排除を同じキーで満たす
- **販売所（`BROKERAGE`）の扱い**（付録E.3 訂正・要求仕様 §2.4）:
  - `/user/spot/trade_history` には**1 件も現れない**。取込経路は UI CSV「売買履歴」のみ
  - 取引所約定の `trade_id` と販売所の注文 ID は**ID 空間が交差しない**ことを実データで確認済みだが、
    **防御的に「両者の source_ref 集合が交差しないこと」を取込時にチェック**し、交差したら
    重複排除の前提が崩れたとして明示エラーにする（黙って片方を落とさない）
  - 販売所は**手数料列を持たない**（スプレッド内包）。`fee` を省略し `BROKERAGE_SPREAD` を立てる。
    「手数料 0 円」として記帳すると、後段で fee 集計の欠落と区別できなくなる
  - CSV が未投入の口座では販売所分が丸ごと欠落する。**ガード(d) の残高突合がこれを検出する**
    （実際にこの経路で検出された。BALANCE_RECONCILIATION.md §2-1）
- **仕訳（ledger）は Event から派生させる別型**にする。v2 §13.3 のパイプライン
  `Event列 → ACQUIRE/DISPOSE/INCOME/EXPENSE → 平均法 → レポート`。変換規則は v2 付録A の表が単一ソース

```ts
// cli/tax/schema/ledger.ts
export const LedgerKind = z.enum(["ACQUIRE", "DISPOSE", "INCOME", "EXPENSE"]);
export const LedgerEntry = z.object({
  event_id: z.string(), seq: z.number().int(),   // 同一 event 由来の複数仕訳を安定順序化
  kind: LedgerKind, currency: z.string(), year_jst: z.number().int(),
  ts_utc: z.number().int(), sort_key: z.string(),  // (ts_utc, source_ref) の安定ソート用
  qty: decStr,                                    // ACQUIRE/DISPOSE のみ
  cost_jpy: decStr.optional(),                    // ACQUIRE: 取得価額（購入手数料込み）
  proceeds_jpy: decStr.optional(),                // DISPOSE: 譲渡価額
  amount_jpy: decStr.optional(),                  // INCOME/EXPENSE
  category: z.string(),                           // "rebate_income" / "expense_fee" / "margin_net" 等
  policy_ids: z.array(z.string()),                // 適用した【方針】ID（P-04 等）をレポートに露出
});
```

## 2. モジュール分割案

1 ファイル 100 行が目安（chaos x04）なので、責務ごとに小さく割る。依存は上から下の一方向。

```
cli/tax/
  ratio.ts            # 【実装済】厳密有理数（BigInt 分子/分母）: 四則・gcd 約分・比較・述語
  ratio-decimal.ts    # 【実装済】十進文字列 ⇄ 有理数 + **丸めが起きる唯一の場所**（ADR-005）
  schema/
    primitives.ts     # decStr / enum 群（§1）
    event.ts          # TaxEvent
    ledger.ts         # LedgerEntry
    report.ts         # レポート出力型
  import/
    raw-trade.ts      # trade_history の「文字列保持」スキーマ（既存 numStr 経路とは別。§4-2）
    raw-transfer.ts   # deposit/withdrawal の文字列保持スキーマ
    fetch-trades.ts   # 全ペア横断取得（既存 tradeHistoryAllPairs を再利用）+ trade_id dedup
    fetch-deposits.ts # ★2系統取得（asset 省略=crypto / asset=jpy=fiat）+ uuid dedup
    fetch-withdrawals.ts # 全 asset 巡回 + uuid dedup + CANCELED 除外
    margin-tracker.ts # position_side + 数量積み上げで OPEN/CLOSE 判定（付録E.2。profit_loss では判定しない）
    to-events.ts      # 生レコード → TaxEvent（現物/信用の振り分け・非JPY quote 検出）
    grant-suspect.ts  # 付録E.3 の付与痕跡判定（txid=null ／ 円未満端数 & found_at==confirmed_at & 秒以下 00.000）
    symbol-alias.ts   # {matic→pol, rndr→render} のみ。mkr→sky は名寄せ禁止（手動マスタ）
  import-csv/         # ★P0 に昇格（販売所が API 非対応のため。要求仕様 §2.2 / §2.4）
    parse-csv.ts      # CSV パーサ（JST ミリ秒・8 桁ゼロ詰め・列名の小文字混じりに対応）
    brokerage.ts      # 「売買履歴」→ TaxEvent（market_type=BROKERAGE・手数料列なし）
    trades-csv.ts     # 「約定履歴」→ 完全精度の手数料を監査用に保持（採用値は API。P-16）
    merge.ts          # §2.4 の優先順位で API 由来と統合。ID 空間の交差チェックと差分ログ
  ledger/
    from-events.ts    # 付録A の対応表に従い LedgerEntry へ
  reconcile/          # 原型は scripts/dev/tax/reconcile.ts（検証済みオラクル。恒久保全）
    rebuild.ts        # Event 列 → 資産別理論残高（出庫は amount+fee で減算）
    compare.ts        # /user/assets と突合・ダスト閾値・残差の符号診断（ガード(d) / P-17）
                      # **判定ではなく検出**: 閾値外は fail ではなく残差の量と符号を報告
  engine/
    total-average.ts  # 総平均法（v2 §3）
    moving-average.ts # 移動平均法（v2 §3・時系列安定ソート）
    invariants.ts     # I1〜I4 の機械検証
    nta-compat.ts     # NTA_SHEET_2025_12（P1。P0 では型と分岐点だけ用意）
  guard/
    reference-pnl.ts  # ガード(a)〜(d) + 履歴打ち切り判定 → 表示可否とブロック理由
                      # 打ち切りは (a)〜(d) の外。欠けたイベントが偶然ネットゼロだと
                      # 突合(d) が MATCH のまま通るので、独立条件として全銘柄を止める
  report/
    build.ts          # 取引集計 + （ガード成立時のみ）参考損益
    disclaimers.ts    # 免責文言（v2 §1.3/§9/§10/§12 から転記。文言は仕様書が単一ソース）
cli/commands/tax/     # CLI 表層（Result パターン・--format=json|table|csv）
  events.ts           # bitbank tax events --year=2026 [--brokerage-csv=...]
  reconcile.ts        # bitbank tax reconcile --year=2026
  verify-report.ts    # bitbank tax verify-report --year=2026 --csv=... [--margin-csv=...]
  pnl.ts              # bitbank tax pnl --year=2026 --method=total-average
```

- 登録は `registry.ts` に `TAX_COMMANDS`（`bitbank tax <cmd>`）を追加。`paper`/`profile` と同じ
  サブコマンド形式。**private GET のみ・POST は呼ばない**
- ADR-004 が「CLAUDE.md の例外条項と commands.md のカテゴリ表への追記は実装着手時に行う」と
  規定しているので、この P0 で両方に `tax` を追記する
- 計算は CLI 内（ADR-004 の例外）。Skill 側には計算を置かない

## 3. §9 未確定事項のうち実装に影響するもの（暫定扱い）

実装の分岐に直接効く 5 件だけ挙げる。いずれも**【方針】の判断は変えず**、切替点をコードに残す。

| # | 事項 | 暫定実装 | 切替の残し方 |
|---|---|---|---|
| 1 | ⑩支払手数料が丸め前/後どちらの合計か | **API 値（4 桁丸め）を正**（P-16）。`FEE_API_ROUNDED` フラグを付与 | UI CSV 取込（P1）で完全精度値を併記し突合ログに差分を出す |
| 2 | リベートの扱い | 負 fee → **収入計上**（P-04）。ただし P-04 の簡素化は **JPY ペア限定**（付録E.5）。BTC 建てペアの負 fee は P-11（厳密処理）へ | `policy_ids` に P-04/P-11 を記録。月次キャッシュバックは `ADJUSTMENT`（P1） |
| 3 | 出庫手数料（P-13/P-14） | **必要経費に算入しない**。ただし crypto 出庫手数料は**数量減少として必ず記帳**（残高突合が壊れるため） | 経費算入は engine の入力段でフラグ 1 本。既定 off |
| 4 | MKR→SKY（P-18） | **継続（簿価引継ぎ・課税イベントなし）**。名寄せはせず手動マスタ | 転換を `ADJUSTMENT` 2 本（DISPOSE+ACQUIRE）へ切替可能な形にする |
| 5 | 付与イベント（`GRANT_SUSPECT`）の区分 | 雑所得ラベル + `POSSIBLE_ICHIJI_SHOTOKU`。**取得価額が未解決なので当該銘柄はガード(b)でブロック**し参考損益を出さない | 手動入力（P1）で由来を解決すればガードが通る |

`#6`（P-01〜P-19 全般）は **`policy_ids` を全仕訳に持たせ、レポート末尾に「適用した処理方針」として
一覧出力**する形で吸収する。監修で方針が変わったとき、差し替え箇所が機械的に辿れる。

## 4. 要判断（コード着手前に決めたい）

### 4-1. `fixtures/` の扱い → **解決済み（2026-07-25）**

コードとデータを切り分けて決着した（[tax-fixtures-plan.md](tax-fixtures-plan.md) §2.5）:
`tools/` は `scripts/dev/tax/` へ（原型を恒久保全）、回帰テストは
`cli/__tests__/tax/fixtures-regression/` に **skip ゲート付き**で実装済み、`raw/` は repo に置かず
SHA-256 のみ manifest に記録、MD レポートは値を丸めて `docs/dev/tax-evidence/` へ。
**P0 の実装は合成データで進められる**（実データ回帰は fixtures がある環境でのみ走る）。

#### （以下、判断前の記述）`fixtures/` がこのリポジトリに存在しない

`tax-requirements.md` は `fixtures/`（実口座の API 生レスポンス・`FIELDS.md`・`ENDPOINTS.md`・
`BALANCE_RECONCILIATION.md`・`SYMBOL_ALIASES.md`・`PAIRS_MASTER.json`・`tests/`・`tools/reconcile.ts`）を
エビデンス兼回帰テスト資産として前提にしているが、**この repo には無い**（別環境で作られたもの）。

影響の切り分け:

- P0-1〜4 の**実装自体は可能**（仕様が v2 付録D/E に十分に落ちている）。テストは合成フィクスチャ
  + 既存 `cli/__tests__/__fixtures__/private/` で書ける
- **できないのは**「実データでの回帰（手数料 4 桁丸めの全行検証・`profit_loss` の誤差ゼロ再現・
  重複排除後の件数一致）」と「`reconcile.ts` の"昇格"」（昇格元が無いので E.3/E.4 から新規実装になる）

判断が必要な点: 実口座データを**この公開フォークに置くか**（機密性の判断はユーザー側）。
置かない場合は、値を匿名化した最小フィクスチャを作るか、回帰テストは別環境に残す。

### 4-2. `float 禁止` が既存の chaos 規約 x14 と正面衝突する ★要方針決定

- v2 P-02 / NFR: 全金額・数量は**文字列 → Decimal 直パース。float 禁止**
  （この「Decimal」は**有限桁の十進型という指定ではなく「float を経由しない十進の直パース」の意**。
  本リポジトリでの実体は ADR-005 の厳密有理数 `Ratio` で、`fromDecimalString` が `Number()` を
  経由せずに読む。以下の §4-2 の論点は表現形式が Ratio でも変わらない）
- chaos **x14** は逆に「`price`/`amount`/`fee`/`rate`/`pnl`/`vol` を含むフィールドを `z.string()` の
  ままにするのを禁止」し、`numStr`（= **JS number へ変換**）への統一を強制している
- つまり既存 `Trade` スキーマ（`cli/commands/private/trade-history.ts`）は `amount`/`price`/
  `fee_amount_quote` すべて **number 化済み**で、**税務経路からはそのまま使えない**

提案（CLAUDE.md「違反したら無視・回避せず修正する」に従い、回避ではなく規約側を明示的に拡張）:

1. `cli/schema-helpers.ts` に **`decStr`**（十進文字列を検証し文字列のまま保持）を追加
2. x14 の許可リストを `numStr | nullableNumStr | decStr` に拡張し、
   「税務経路（`cli/tax/`）は精度保持のため `decStr` を使う」を規約として明記
3. 税務インポータは既存 private コマンドの戻り値を使わず、**生レスポンスを `decStr` スキーマで
   別途 parse する**（`import/raw-*.ts`）。既存コマンドの出力互換は壊さない

**未解決。既定の進め方**: 反対がなければ上記 1〜3 で進める（float 禁止は P-02 の【方針】であり、
x14 の `numStr`（= JS number）と両立しないため、規約側の明示的拡張が唯一の整合解）。
x14 のテスト本体も同時に更新し、「税務経路は `decStr`」を機械検証に含める。

### 4-3. 数値表現 → **決定済み。[ADR-005](../adr/005-tax-exact-rational-arithmetic.md) を参照**

以下は判断前の記述で、2 点誤りがあったため訂正した上で残す（経緯として有用なため）。

- **訂正 1**: 本質は「有理数か十進か」ではなく **「丸めは厳密値に対して 1 回だけ適用し、
  丸め済みの中間値に再度丸めない」** という原則。有理数はその手段
- **訂正 2**: 下表の (c)「差引方式」を*変更*と書いたのは誤り。差引方式は
  [tax-research.md](tax-research.md) §3 の擬似コードが**既に採用済みの現行仕様**
  （付録D.2 の `G = E×F` は国税庁 Excel シート側の数式＝互換モードで再現する対象）。
  I1 は成立させるが互換モードの `ROUNDUP` 境界問題は解決しないため単独の解にはならず、
  有理数と併用する

#### （以下、判断前の記述）I1「Decimal で厳密一致」は有限桁 Decimal では成立しない

総平均法は `E = (B+D)/(A+C)` が割り切れないことがあり（v2 D.2 は非丸め）、
`G = E×F`・`I = E×H` の**直接乗算**を採る。I1 は

```
(B+D) == G + I == E×F + E×H == E×((A+C)) == (B+D)
```

で、**E が厳密なら恒等的に成立**する。しかし decimal.js 等の有限有効桁では E に丸めが入り、
`G + I ≠ B+D`（誤差が残る）ため **I1 の「厳密一致」テストが原理的に通らない**。
互換モードの `ROUNDUP`/`ROUNDDOWN` も、境界値が `66.99999…` と表現されると 1 円ずれる。

選択肢:

| 案 | I1 厳密一致 | 外部依存 | 実装量 | 備考 |
|---|---|---|---|---|
| **(a) BigInt 有理数を自作**（推奨） | ○（恒等的に成立） | **なし** | `ratio.ts` 約 120 行 | CLAUDE.md「外部依存最小」と整合。gcd 約約で分母膨張を抑える。除算は単価計算のみ |
| (b) decimal.js を追加 | ×（許容誤差が必要） | 追加 1 本 | 小 | 依存クールダウン 7 日（`dependency-cooldown.md`）。I1 をトレランス比較に緩める必要 |
| (c) cogs を差引方式に変更 | ○（定義上成立） | なし | 小 | v2 D.2 の `G=E×F` と式が変わる（値は一致するが仕様との対応が薄れる） |

**推奨は (a)**。10^5 件の性能は要計測（NFR）だが、除算が必要なのは単価と移動平均法の処分時のみ。
これは ADR 化する（ロードマップも「Week 6 冒頭に ADR 化」と規定済み）。

### 4-4. `TRADE_EXCHANGE` の優先度が v2 と要求仕様で食い違う ★報告

- v2 付録E.5: 「`TRADE_EXCHANGE` は『予約』ではなく**過年度取込で必須**に格上げ」
- `tax-requirements.md` §10: `TRADE_EXCHANGE`（過年度BTC建てペア）は **P2**
- 同 §3.1 では「非JPYクォートは `TRADE_EXCHANGE` へ振り分け **or 明示エラー**」（P0 の防御要件）

まず**検出は年に依存させない**。`stop_order=true` は「新規注文の停止」であって
**当年に約定履歴が存在しない根拠にはならない**（停止時期は API から判定できず、
年の途中で停止された可能性を排除できない）。よって非JPY quote の検出は
**ペアのフラグにも対象年にも依存せず、取り込んだ約定行の quote 通貨だけを見て**行う。

そのうえで、交換の**完全計算**をいつ実装するかは別問題。v2 を正とすると当年（2026 年分）に
BTC 建ての新規約定が発生する可能性は低く、実際に必要になるのは主として
**過年度から簿価を再構築するケース**である。よって P0 では
「非JPY quote を検出したら `NON_JPY_QUOTE` フラグ + 当該銘柄をガードでブロック（明示エラー）」
までを実装し、交換の完全計算は P2 のまま——という整理を提案する。
検出が無条件なので、当年に BTC 建て約定が実在しても**黙って誤計算されることはない**。

**未解決。既定の進め方**: 反対がなければこの整理で進める（当年分の計算に交換ロジックは不要で、
必要になるのは過年度からの簿価再構築のみ。黙って誤計算するより明示エラーで止める方が安全）。

### 4-5. ロードマップの記述が付録E.5 と不整合 → **解決済み（修正コミット済み）**

`tax-roadmap.md` 実機確認 #4 は「BTC 建てペアは全て **delist 済み**（社内確認）／フラグ実値の確認が残」
と書いているが、付録E.5 で **`is_enabled=true` かつ `stop_order=true`**（新規注文停止だが定義は有効）と
確定した。実装済みの `trade-history --all-pairs` は `is_enabled` に依存しない設計なので**挙動は正しいまま**。
ロードマップ側の記述を付録E.5 に合わせて更新する。
