// 現物約定（position_side を持たない行）→ TaxEvent。
// 非 JPY クォートは**ペアのフラグにも対象年にも依存せず**、取り込んだ行の quote 通貨
// だけで検出する（設計メモ §4-4）。P0 は完全計算をせず TRADE_EXCHANGE として隔離し、
// NON_JPY_QUOTE でガードがブロックする。黙って JPY 建て前提で誤計算しないための経路。

import { isZero, mul } from "../ratio.js";
import { fromDecimalString, toExactDecimalString } from "../ratio-decimal.js";
import type { TaxEvent } from "../schema/event.js";
import type { EventFlag } from "../schema/primitives.js";
import { baseEvent, ID_PREFIX, type Pending } from "./event-base.js";
import type { RawTrade } from "./raw-trade.js";
import { isJpyQuote, splitPair } from "./symbol-alias.js";

export function spotEvent(t: RawTrade): TaxEvent | Pending {
  const sourceRef = String(t.trade_id);
  const fail = (reason: string): Pending => ({ source_ref: sourceRef, reason });

  const pair = splitPair(t.pair);
  if (pair === null) return fail(`ペア名を base_quote に分解できません: ${t.pair}`);
  if (t.side !== "buy" && t.side !== "sell") return fail(`未知の side: ${t.side}`);

  const amount = fromDecimalString(t.amount);
  const price = fromDecimalString(t.price);
  const feeBase = fromDecimalString(t.fee_amount_base);
  if (amount === null || price === null || feeBase === null) {
    return fail("amount / price / fee_amount_base が十進文字列として読めません");
  }
  // 有限小数同士の積なので必ず厳密な十進表現になる（ここでは丸めない。ADR-005）
  const notional = toExactDecimalString(mul(amount, price));
  if (notional === null) return fail("約定代金を厳密な十進で表現できません");

  // P-16: API の手数料は小数第 4 位丸め値。完全精度は UI CSV 側（P0-6）に持つ
  const flags: EventFlag[] = ["FEE_API_ROUNDED"];
  // 実口座では全行ゼロ。非ゼロなら P-11（暗号資産建て手数料の厳密処理）が要るが
  // P0 は未実装なので保留扱いにして当該銘柄をブロックする
  if (!isZero(feeBase)) flags.push("UNOBSERVED_SHAPE");

  const jpyQuote = isJpyQuote(pair.quote);
  if (!jpyQuote) flags.push("NON_JPY_QUOTE", "NO_RATE");

  const kind = jpyQuote
    ? t.side === "buy"
      ? "TRADE_SPOT_BUY"
      : "TRADE_SPOT_SELL"
    : "TRADE_EXCHANGE";
  const event = baseEvent({
    prefix: ID_PREFIX.trade,
    sourceRef,
    tsUtc: t.executed_at,
    kind,
    currency: pair.base,
    qty: t.amount,
    flags,
  });

  return {
    ...event,
    market_type: "ORDERBOOK",
    pair_raw: t.pair, // 付録E.5: ペア名は生値保持（名寄せしない）
    // 非 JPY クォートでは円換算額が未確定なので jpy_value を**付けない**（NO_RATE）
    ...(jpyQuote ? { jpy_value: notional } : {}),
    fee: {
      quote_charged: t.fee_amount_quote,
      quote_occurred: t.fee_occurred_amount_quote,
      base: t.fee_amount_base,
    },
    ...(kind === "TRADE_SPOT_SELL"
      ? {}
      : { costbasis_provenance: jpyQuote ? ("PURCHASE" as const) : ("EXCHANGE_FMV" as const) }),
  };
}
