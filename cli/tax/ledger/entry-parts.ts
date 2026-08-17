// from-events.ts の部品（仕訳 1 本の組み立てと手数料の符号分解）。
import { cmp, type Ratio, ZERO } from "../ratio.js";
import { fromDecimalString } from "../ratio-decimal.js";
import type { TaxEvent } from "../schema/event.js";
import type { LedgerEntry, LedgerKind } from "../schema/ledger.js";

type Amounts = {
  qty: string;
  cost_jpy?: string;
  proceeds_jpy?: string;
  amount_jpy?: string;
};

/**
 * 仕訳 1 本を組む。`seq` は同一イベント由来の複数仕訳（約定 + 手数料 + リベート）を
 * 安定順序化するための連番で、`sort_key` は同一ミリ秒の約定を source_ref で
 * 安定ソートするためのキー（決定論性 NFR）。
 */
export function makeEntry(
  e: TaxEvent,
  seq: number,
  kind: LedgerKind,
  amounts: Amounts,
  category: string,
  policyIds: string[],
): LedgerEntry {
  return {
    event_id: e.event_id,
    seq,
    kind,
    currency: e.currency,
    year_jst: e.year_jst,
    ts_utc: e.ts_utc,
    sort_key: `${e.source_ref}:${seq}`,
    category,
    policy_ids: policyIds,
    ...amounts,
  };
}

/**
 * 手数料を正・負に分ける。**負値 = メイカーリベート**（付録E.1）で、正の手数料とは
 * 税務上の扱いが違う（正: 取得価額算入 or 必要経費 ／ 負: 収入計上 P-04）ため、
 * 片方に丸めずに両方を返す。未指定・不正は null（呼び出し側が理由付きで保留する）。
 */
export function feeSplit(fee: string | undefined): { positive: Ratio; negative: Ratio } | null {
  if (fee === undefined) return { positive: ZERO, negative: ZERO };
  const r = fromDecimalString(fee);
  if (r === null) return null;
  return cmp(r, ZERO) >= 0 ? { positive: r, negative: ZERO } : { positive: ZERO, negative: r };
}
