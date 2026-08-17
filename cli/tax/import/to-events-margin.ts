// 信用約定（position_side を持つ行）→ TaxEvent。新規 / 決済の別は margin-tracker が
// 決める（API に区別が無いため。付録E.2）。
//
// `profit_loss` は**手数料・利息控除後のネット値**なので、そのまま realized_net に置く。
// fee / interest は分解明細のために併記するだけで、損益から再減算してはいけない
// （要求仕様 §3.1・§6。再減算は二重計上）。

import { isZero, mul } from "../ratio.js";
import { fromDecimalString, toExactDecimalString } from "../ratio-decimal.js";
import type { TaxEvent } from "../schema/event.js";
import type { EventFlag } from "../schema/primitives.js";
import { baseEvent, ID_PREFIX, type Pending } from "./event-base.js";
import type { MarginRole } from "./margin-tracker.js";
import type { RawTrade } from "./raw-trade.js";
import { isJpyQuote, splitPair } from "./symbol-alias.js";

/**
 * 建玉 open 行に実現損益が乗っていないか。**観測形状では open は `"0"`**
 * （`docs/dev/tax-evidence/FIELDS.md` §1・`ANSWERS.md` Q4 で実機確認済み）。
 * 非ゼロなら新規 / 決済の判定か API の形状が想定と違う。読めない値も同じ扱いにする
 * （「ゼロと確認できない」は「ゼロではない」側に倒す）。
 */
function openWithPnl(role: MarginRole, profitLoss: string | null | undefined): boolean {
  if (role !== "OPEN" || profitLoss == null) return false;
  const pl = fromDecimalString(profitLoss);
  return pl === null || !isZero(pl);
}

export function marginEvent(t: RawTrade, role: MarginRole | undefined): TaxEvent | Pending {
  const sourceRef = String(t.trade_id);
  const fail = (reason: string): Pending => ({ source_ref: sourceRef, reason });

  if (role === undefined) return fail("新規 / 決済を判定できませんでした（margin-tracker）");
  const pair = splitPair(t.pair);
  if (pair === null) return fail(`ペア名を base_quote に分解できません: ${t.pair}`);
  const positionSide = t.position_side;
  if (positionSide !== "long" && positionSide !== "short") {
    return fail(`未知の position_side: ${positionSide}`);
  }

  const amount = fromDecimalString(t.amount);
  const price = fromDecimalString(t.price);
  const feeBase = fromDecimalString(t.fee_amount_base);
  if (amount === null || price === null || feeBase === null) {
    return fail("amount / price / fee_amount_base が十進文字列として読めません");
  }
  const notional = toExactDecimalString(mul(amount, price));
  if (notional === null) return fail("約定代金を厳密な十進で表現できません");

  const jpyQuote = isJpyQuote(pair.quote);
  const flags: EventFlag[] = ["FEE_API_ROUNDED"];
  // `fee_amount_base` は現物 / 信用の共通フィールド。現物側（to-events-spot.ts）と
  // 同じガードを置く — 片方だけ見ていると信用で base 建て手数料が出たとき無言で落ちる。
  //
  // `openWithPnl` も同じ「未観測の形状」。realized_net は CLOSE にしか載せないので
  // （下の三項）、OPEN と判定した行に損益が乗っていること自体が想定外で、そのまま進むと
  // その損益はどこにも計上されない。**この行を落とすのではなく銘柄をブロックする**
  // — 1 行だけ捨てても残りの計算は前提が崩れたままだから
  if (!isZero(feeBase) || openWithPnl(role, t.profit_loss)) flags.push("UNOBSERVED_SHAPE");
  if (!jpyQuote) flags.push("NON_JPY_QUOTE", "NO_RATE");

  const event = baseEvent({
    prefix: ID_PREFIX.margin,
    sourceRef,
    tsUtc: t.executed_at,
    kind: role === "OPEN" ? "MARGIN_OPEN" : "MARGIN_CLOSE",
    currency: pair.base,
    qty: t.amount,
    flags,
  });

  return {
    ...event,
    market_type: "ORDERBOOK",
    pair_raw: t.pair,
    ...(jpyQuote ? { jpy_value: notional } : {}),
    margin: {
      position_side: positionSide,
      role,
      // 新規行にも profit_loss=0 が載ることがある。決済年に帰属させるため
      // realized_net は**決済行だけ**に持たせる（v2 §5）
      ...(role === "CLOSE" && t.profit_loss != null ? { realized_net: t.profit_loss } : {}),
      ...(t.interest != null ? { interest: t.interest } : {}),
      fee_charged: t.fee_amount_quote,
      fee_occurred: t.fee_occurred_amount_quote,
    },
  };
}
