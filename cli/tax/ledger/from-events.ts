// イベント → 税務仕訳（v2 §13.3 のパイプライン中段）。変換規則の単一ソースは付録A。
//
// ここで**仕訳を作らない**イベントがあることに注意:
// - DEPOSIT / WITHDRAWAL は課税イベントではない（付録A）。§13.3 のとおり簿価も数量も
//   動かさない（自己移転前提）。**残高再構築（reconcile）は別の帳簿**で、そちらは
//   出庫を amount+fee で減らす。両者が食い違って見えるのは仕様
// - MARGIN_OPEN は決済年に帰属させるため（v2 §5）決済側でだけ計上する（margin-entries.ts）
// - TRADE_EXCHANGE は P0 では計算しない（設計メモ §4-4）。deferred に積んでガードが止める
import { add, cmp, neg, ZERO } from "../ratio.js";
import { fromDecimalString, toExactDecimalString } from "../ratio-decimal.js";
import type { TaxEvent } from "../schema/event.js";
import type { LedgerEntry } from "../schema/ledger.js";
import { byLedgerOrder } from "../sort-order.js";
import { feeSplit, makeEntry } from "./entry-parts.js";
import { marginEntries } from "./margin-entries.js";

export type Deferred = { event_id: string; currency: string; reason: string };
export type LedgerResult = { entries: LedgerEntry[]; deferred: Deferred[] };

function spotEntries(e: TaxEvent): LedgerEntry[] | string {
  const notional = e.jpy_value === undefined ? null : fromDecimalString(e.jpy_value);
  if (notional === null) return "円換算額（jpy_value）がありません";
  const fee = feeSplit(e.fee?.quote_charged);
  if (fee === null) return "手数料を十進文字列として読めません";

  const entries: LedgerEntry[] = [];
  if (e.kind === "TRADE_SPOT_BUY") {
    // §4-1: 購入時手数料は取得価額に算入する（必要経費へ再掲しない）
    const cost = toExactDecimalString(add(notional, fee.positive));
    if (cost === null) return "取得価額を厳密な十進で表現できません";
    entries.push(makeEntry(e, 0, "ACQUIRE", { qty: e.qty, cost_jpy: cost }, "purchase", ["P-16"]));
  } else {
    const proceeds = toExactDecimalString(notional);
    if (proceeds === null) return "譲渡価額を厳密な十進で表現できません";
    entries.push(makeEntry(e, 0, "DISPOSE", { qty: e.qty, proceeds_jpy: proceeds }, "sale", []));
    // §4-2: 売却時手数料は必要経費
    if (cmp(fee.positive, ZERO) > 0) {
      const amount = toExactDecimalString(fee.positive);
      if (amount === null) return "手数料を厳密な十進で表現できません";
      entries.push(
        makeEntry(e, 1, "EXPENSE", { qty: "0", amount_jpy: amount }, "expense_fee", ["P-16"]),
      );
    }
  }
  // P-04: 負手数料（メイカーリベート）は受取時に収入計上する（簿価中立・切替不可）
  if (cmp(fee.negative, ZERO) < 0) {
    const amount = toExactDecimalString(neg(fee.negative));
    if (amount === null) return "リベート額を厳密な十進で表現できません";
    entries.push(
      makeEntry(e, 2, "INCOME", { qty: "0", amount_jpy: amount }, "rebate_income", ["P-04"]),
    );
  }
  return entries;
}

/** 付録A の対応表に従って仕訳へ落とす。落とせないものは deferred に理由付きで残す。 */
export function ledgerFromEvents(events: readonly TaxEvent[]): LedgerResult {
  const entries: LedgerEntry[] = [];
  const deferred: Deferred[] = [];
  for (const e of events) {
    if (e.kind === "DEPOSIT" || e.kind === "WITHDRAWAL" || e.kind === "MARGIN_OPEN") continue;
    const built =
      e.kind === "TRADE_SPOT_BUY" || e.kind === "TRADE_SPOT_SELL"
        ? spotEntries(e)
        : e.kind === "MARGIN_CLOSE"
          ? marginEntries(e)
          : `${e.kind} は P0 では仕訳化しません（設計メモ §4-4 / 手動調整は P1）`;
    if (typeof built === "string")
      deferred.push({ event_id: e.event_id, currency: e.currency, reason: built });
    else entries.push(...built);
  }
  entries.sort(byLedgerOrder);
  return { entries, deferred };
}
