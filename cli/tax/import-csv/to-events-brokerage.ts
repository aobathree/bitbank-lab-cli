// 販売所の売買履歴行 → TaxEvent。
//
// 取引所（板）の約定と決定的に違う点を型と flag で表す:
// - `market_type: "BROKERAGE"` / `source_system: "UI_CSV_BROKERAGE"`
// - **fee を付けない**。販売所は手数料列を持たず、コストはスプレッドに内包される。
//   `fee: {quote_charged: "0", ...}` と書くと「手数料ゼロで約定した」と読めてしまうため、
//   欄そのものを作らず `BROKERAGE_SPREAD` で表現する（schema/event.ts の superRefine が強制）
// - `API_UNREACHABLE`: この経路は API では取得できない。CSV 未投入なら丸ごと欠落する
//
// クォートは **JPY 固定**として読む。CSV にペア列が無く、販売所は JPY 建てのみのため。
// 約定代金は数量 × 価格（P-15）。CSV に代金列が無く、数量は 8 桁で丸められているので、
// 実際の約定代金と厳密には一致しない可能性がある（差は verify-report が測る）。
import { jstDateTimeToMs } from "../../date-utils.js";
import { baseEvent, ID_PREFIX, type Pending } from "../import/event-base.js";
import { canonicalAsset } from "../import/symbol-alias.js";
import { mul } from "../ratio.js";
import { fromDecimalString, toExactDecimalString } from "../ratio-decimal.js";
import type { TaxEvent } from "../schema/event.js";
import { type BrokerageRow, SIDE_BUY, SIDE_SELL } from "./brokerage-columns.js";

export function brokerageEvent(r: BrokerageRow): TaxEvent | Pending {
  const sourceRef = r.order_id;
  const fail = (reason: string): Pending => ({ source_ref: sourceRef, reason });

  if (r.side !== SIDE_BUY && r.side !== SIDE_SELL) return fail(`未知の 売/買: ${r.side}`);
  const tsUtc = jstDateTimeToMs(r.executed_at);
  if (tsUtc === null) return fail(`売買日時を JST の日時として読めません: ${r.executed_at}`);

  const qty = fromDecimalString(r.qty);
  const price = fromDecimalString(r.price);
  if (qty === null || price === null) return fail("数量 / 指値価格が十進文字列として読めません");
  // 有限小数同士の積なので厳密な十進表現になる（ここでは丸めない。ADR-005）
  const notional = toExactDecimalString(mul(qty, price));
  if (notional === null) return fail("約定代金を厳密な十進で表現できません");

  const buy = r.side === SIDE_BUY;
  const event = baseEvent({
    prefix: ID_PREFIX.brokerage,
    sourceRef,
    tsUtc,
    kind: buy ? "TRADE_SPOT_BUY" : "TRADE_SPOT_SELL",
    currency: canonicalAsset(r.currency),
    qty: r.qty,
    flags: ["BROKERAGE_SPREAD", "API_UNREACHABLE"],
    sourceSystem: "UI_CSV_BROKERAGE",
  });

  return {
    ...event,
    market_type: "BROKERAGE",
    jpy_value: notional,
    ...(buy ? { costbasis_provenance: "PURCHASE" as const } : {}),
  };
}
