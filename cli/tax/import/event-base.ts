// 正規化イベントの共通部分と、取り込めなかった行の保留リスト型。
// `event_id` を決定論的に組むことで、再取得しても同じ ID になる（冪等性 NFR）。
import { jstIso, jstYear } from "../../date-utils.js";
import type { TaxEvent } from "../schema/event.js";
import type { EventKind } from "../schema/event-parts.js";
import type { EventFlag, SourceSystem } from "../schema/primitives.js";

/** サブアカウント対応（P1）まではこの 1 値。スキーマ側は口座別を既に許容している。 */
export const DEFAULT_ACCOUNT_ID = "bitbank:default";

/** event_id の prefix。`<prefix>:<source_ref>` が ID 空間そのものになる。 */
export const ID_PREFIX = {
  trade: "trade",
  margin: "margin",
  deposit: "dep",
  withdrawal: "wd",
  /** 販売所は注文ID が単位（取引所約定の trade_id とは別の ID 空間） */
  brokerage: "brk",
} as const;

/** 取り込めなかった行。**黙って捨てない**（NFR 堅牢性: 未知は警告して保留リストへ）。 */
export type Pending = { source_ref: string; reason: string };

export type Normalized = { events: TaxEvent[]; pending: Pending[] };

/** Pending か TaxEvent かの判別（`kind` の有無で足りる）。 */
export function isPending(v: TaxEvent | Pending): v is Pending {
  return !("kind" in v);
}

export type BaseEventArgs = {
  prefix: string;
  sourceRef: string;
  tsUtc: number;
  kind: EventKind;
  currency: string;
  qty: string;
  flags?: EventFlag[];
  sourceSystem?: SourceSystem;
};

/** 全イベント共通の必須項目を組む。年分は JST だけで判定する（要求仕様 §4）。 */
export function baseEvent(a: BaseEventArgs): TaxEvent {
  return {
    event_id: `${a.prefix}:${a.sourceRef}`,
    source_ref: a.sourceRef,
    ts_utc: a.tsUtc,
    ts_jst: jstIso(a.tsUtc),
    year_jst: jstYear(a.tsUtc),
    account_id: DEFAULT_ACCOUNT_ID,
    kind: a.kind,
    source_system: a.sourceSystem ?? "API",
    currency: a.currency,
    qty: a.qty,
    // P-09: 既定は DELIVERY_DATE・年度固定。切替は設定側の 1 本で行う
    recognition_policy: "DELIVERY_DATE",
    flags: a.flags ?? [],
  };
}
