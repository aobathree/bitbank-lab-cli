// 仕訳の単純集計。total-average / moving-average の双方が使う。
// 金額欄が読めない仕訳は**黙って 0 として飲み込まず** violations に残す
// （0 円の取得として計上すると譲渡原価が静かに狂うため）。
import { add, type Ratio, ZERO } from "../ratio.js";
import { fromDecimalString } from "../ratio-decimal.js";
import type { LedgerEntry } from "../schema/ledger.js";

export type EntrySums = {
  acquired: { qty: Ratio; cost: Ratio };
  disposed: { qty: Ratio; proceeds: Ratio };
  income: Ratio;
  expense: Ratio;
  violations: string[];
};

/** 十進文字列を読む。読めなければ violations に積んで ZERO を返す。 */
export function readAmount(
  value: string | undefined,
  label: string,
  entry: LedgerEntry,
  violations: string[],
): Ratio {
  if (value === undefined) {
    violations.push(`${entry.event_id}#${entry.seq}: ${label} がありません`);
    return ZERO;
  }
  const r = fromDecimalString(value);
  if (r === null) {
    violations.push(`${entry.event_id}#${entry.seq}: ${label} を十進文字列として読めません`);
    return ZERO;
  }
  return r;
}

export function sumEntries(entries: readonly LedgerEntry[]): EntrySums {
  const violations: string[] = [];
  const s: EntrySums = {
    acquired: { qty: ZERO, cost: ZERO },
    disposed: { qty: ZERO, proceeds: ZERO },
    income: ZERO,
    expense: ZERO,
    violations,
  };
  for (const e of entries) {
    const qty = readAmount(e.qty, "qty", e, violations);
    if (e.kind === "ACQUIRE") {
      s.acquired.qty = add(s.acquired.qty, qty);
      s.acquired.cost = add(s.acquired.cost, readAmount(e.cost_jpy, "cost_jpy", e, violations));
    } else if (e.kind === "DISPOSE") {
      s.disposed.qty = add(s.disposed.qty, qty);
      s.disposed.proceeds = add(
        s.disposed.proceeds,
        readAmount(e.proceeds_jpy, "proceeds_jpy", e, violations),
      );
    } else if (e.kind === "INCOME") {
      s.income = add(s.income, readAmount(e.amount_jpy, "amount_jpy", e, violations));
    } else {
      s.expense = add(s.expense, readAmount(e.amount_jpy, "amount_jpy", e, violations));
    }
  }
  return s;
}
