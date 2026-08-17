// TaxEvent の構成要素（種別 enum と入れ子オブジェクト）。event.ts を 100 行に
// 収めるための分割で、責務は「イベントの部品定義」。判定ロジックは持たない。
import { z } from "zod";
import { decStr, TransferReason, Venue } from "./primitives.js";

export const EventKind = z.enum([
  "TRADE_SPOT_BUY",
  "TRADE_SPOT_SELL",
  "TRADE_EXCHANGE",
  "MARGIN_OPEN",
  "MARGIN_CLOSE",
  "FEE",
  "REBATE",
  "LENDING_REWARD",
  "CAMPAIGN_REWARD",
  "AIRDROP",
  "FORK_RECEIPT",
  "DEPOSIT",
  "WITHDRAWAL",
  "PAYMENT",
  "GIFT_OUT",
  "GIFT_IN",
  "BEQUEST_OUT",
  "INHERITANCE_IN",
  "LOW_PRICE_TRANSFER",
  "DONATION",
  "ADJUSTMENT",
]);
export type EventKind = z.infer<typeof EventKind>;

/** 取得（簿価が立つ）イベント。costbasis_provenance が必須になる。 */
export const ACQUIRE_KINDS: readonly EventKind[] = [
  "TRADE_SPOT_BUY",
  "TRADE_EXCHANGE",
  "LENDING_REWARD",
  "CAMPAIGN_REWARD",
  "AIRDROP",
  "FORK_RECEIPT",
  "GIFT_IN",
  "INHERITANCE_IN",
];

/** 約定イベント。market_type が必須（販売所か板かで手数料の扱いが変わる）。 */
export const TRADE_KINDS: readonly EventKind[] = [
  "TRADE_SPOT_BUY",
  "TRADE_SPOT_SELL",
  "TRADE_EXCHANGE",
];

/** 円換算の監査情報（v2 §6 P-07） */
export const RateSource = z.object({
  pair: z.string(),
  venue: Venue,
  method: z.enum(["LAST_TRADE", "VIA_PAIR", "EXTERNAL", "MANUAL"]),
  ts_utc: z.number().int(),
  path: z.array(z.string()),
});

export const Transfer = z.object({
  counter_account_id: z.string().optional(),
  transfer_group_id: z.string().optional(),
  reason: TransferReason,
  fee_qty: decStr.optional(), // 付録E.3: 出庫の資産減少 = amount + fee
});

export const Margin = z.object({
  position_side: z.enum(["long", "short"]),
  role: z.enum(["OPEN", "CLOSE"]), // API に無いのでトラッカーが決定
  realized_net: decStr.optional(), // profit_loss（ネット値。fee/interest を再控除しない）
  interest: decStr.optional(),
  fee_charged: decStr.optional(), // fee_amount_quote（決済時は建て分込みの累計）
  fee_occurred: decStr.optional(), // fee_occurred_amount_quote
});

/** 現物の手数料内訳（v2 §4）。販売所（BROKERAGE）は列自体が無いので付けない。 */
export const Fee = z.object({
  quote_charged: decStr,
  quote_occurred: decStr,
  base: decStr,
});
