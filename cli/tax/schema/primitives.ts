// 税務正規化スキーマの原子型（v2 §13 / 設計メモ tax-p0-design.md §1）。
// 金額・数量は **decStr（十進文字列のまま）**。number 化すると有効桁が落ち、
// 「厳密値を保持し丸めは境界で 1 回だけ」（v2 付録F・ADR-005）が成立しない。
import { z } from "zod";

export { decStr } from "../../schema-helpers.js";

/** 移転の相手方の種別（v2 §13.2） */
export const Venue = z.enum([
  "BITBANK",
  "EXTERNAL_EXCHANGE",
  "SELF_WALLET",
  "COUNTERPARTY",
  "UNKNOWN",
]);
export type Venue = z.infer<typeof Venue>;

/** 約定の場。**販売所は API に一切現れない**（v2 付録E.3 訂正）ため、
 *  「どのソースから来たか」ではなく「どこで約定したか」を表す税務上の属性。 */
export const MarketType = z.enum(["ORDERBOOK", "BROKERAGE"]);
export type MarketType = z.infer<typeof MarketType>;

/** 取込元。統合優先順位（要求仕様 §2.4）の判定と監査ログに使う。 */
export const SourceSystem = z.enum(["API", "UI_CSV_TRADES", "UI_CSV_BROKERAGE", "MANUAL"]);
export type SourceSystem = z.infer<typeof SourceSystem>;

/** 収入認識時点（P-09） */
export const RecognitionPolicy = z.enum(["DELIVERY_DATE", "CONTRACT_DATE"]);
export type RecognitionPolicy = z.infer<typeof RecognitionPolicy>;

export const TransferReason = z.enum([
  "SELF_TRANSFER",
  "PURCHASE_EXTERNAL",
  "GIFT",
  "INHERITANCE",
  "REWARD",
  "PAYMENT",
  "UNKNOWN",
]);
export type TransferReason = z.infer<typeof TransferReason>;

/** 取得価額の由来（v2 §13.2）。取得系イベントでは必須（event.ts の superRefine で強制）。 */
export const CostbasisProvenance = z.enum([
  "PURCHASE",
  "EXCHANGE_FMV",
  "REWARD_FMV",
  "ZERO_FORK",
  "CARRYOVER",
  "INHERITED_BOOK",
  "GIFT_FMV",
  "LOW_PRICE_SUM",
  "DEEMED_5PCT",
  "MANUAL",
]);
export type CostbasisProvenance = z.infer<typeof CostbasisProvenance>;

export const EventFlag = z.enum([
  "UNRESOLVED_TRANSFER", // v2 §13.3: 解決まで当該銘柄の参考損益をブロック
  "NO_RATE",
  "USER_CONFIRMED",
  "POSSIBLE_ICHIJI_SHOTOKU", // §7 P-08
  // 付録E.3。crypto は txid=null で立てる（プレースホルダ address を伴う形が実観測された
  // 強いシグナルだが、address 一致まで必須にすると付与の取りこぼしが起きる。過検出は
  // 手動確認に回るだけなのに対し、過少検出は取得原価の誤りに直結するので緩い側に倒す）。
  // jpy は「円未満端数 & found_at==confirmed_at & 秒以下 00.000」の 3 条件すべて
  "GRANT_SUSPECT",
  "FEE_API_ROUNDED", // 付録E.1: API 手数料は 4 桁丸め値（P-16）
  "NON_JPY_QUOTE", // 付録E.5: 非 JPY クォート検出 → TRADE_EXCHANGE か明示エラー
  "UNOBSERVED_SHAPE", // §9-8: 未観測形状 → 保留リスト
  "BROKERAGE_SPREAD", // 付録E.3: 販売所は手数料列なし（スプレッド内包）。fee=0 と混同しない
  "API_UNREACHABLE", // API では取得不能な経路（販売所）由来
]);
export type EventFlag = z.infer<typeof EventFlag>;
