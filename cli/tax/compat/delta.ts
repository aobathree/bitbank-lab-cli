// 不変条件 I4（要求仕様 §3）:「Excel互換モード有効時のみ、丸め起因の I1 乖離を許容し、
// **乖離額をレポートに明示**」。I1〜I3 は `engine/invariants.ts` が違反として検出するが、
// I4 は違反ではなく**開示**なので、検出側ではなく互換欄の一部として出す。
//
// 向きは **既定 − 互換**（正なら既定の方が大きい）。既定は `report/format.ts` の `yen()`
// と同じ「厳密値を円未満切捨てで 1 回だけ丸めた値」で、互換は方式ごとに丸め位置が違う。
//
// **4 欄すべて出す。** 実口座の検証（tax-roadmap.md）では総平均法で
// 「所得は一致・必要経費計だけ互換が 1 円大きい」という出方をしており、所得の差だけを
// 出すと「差なし」に見えてしまう。逆に移動平均法では譲渡原価に差が出る。どちらの方式でも
// ゼロの欄が並ぶが、**差が無いこと自体が情報**なので欄を落とさない。
import type { AverageOutcome } from "../engine/types.js";
import { add, type Ratio, sub } from "../ratio.js";
import { toYen } from "../ratio-decimal.js";
import type { NtaCompat } from "../schema/nta.js";

/** 互換欄の金額は全部が整数円の十進文字列（`toYen` 由来）なので BigInt で厳密に戻せる。 */
const asYen = (s: string): bigint => BigInt(s);

/**
 * 既定（ADR-005: 非丸め計算 → 表示で円未満切捨て 1 回）の表示値。
 * `report/currency.ts` が `reference` に出す 4 欄と**同じ式**である必要がある
 * （ずれると乖離額が「表示の差」ではなくなる）。対応は
 * `cogs_jpy` / `revenue_total_jpy` / `expense_total_jpy` / `reference_pnl_jpy`。
 */
function defaultYen(outcome: AverageOutcome, revenue: Ratio) {
  const expense = add(outcome.cogs, outcome.expense);
  return {
    cogs: toYen(outcome.cogs),
    incomeTotal: toYen(revenue),
    expenseTotal: toYen(expense),
    income: toYen(sub(revenue, expense)),
  };
}

export function i1Delta(
  outcome: AverageOutcome,
  revenue: Ratio,
  compat: Omit<NtaCompat, "delta">,
): NtaCompat["delta"] {
  const d = defaultYen(outcome, revenue);
  return {
    cogs_jpy: (d.cogs - asYen(compat.cogs_jpy)).toString(),
    income_total_jpy: (d.incomeTotal - asYen(compat.income_total_jpy)).toString(),
    expense_total_jpy: (d.expenseTotal - asYen(compat.expense_total_jpy)).toString(),
    income_jpy: (d.income - asYen(compat.income_jpy)).toString(),
  };
}
