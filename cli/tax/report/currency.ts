// 銘柄 1 件分のレポート組み立て。
// 参考損益（`reference`）が付くのはガード(a)〜(d) がすべて成立したときだけで、
// 不成立なら**欄そのものを出さない**（0 や null にすると「損益ゼロ」と読めてしまう）。
import { ntaCompat } from "../compat/nta-sheet.js";
import type { CurrencyResult } from "../engine/run.js";
import { evaluateGuard, type GuardInput } from "../guard/reference-pnl.js";
import type { LedgerResult } from "../ledger/from-events.js";
import { add, sub } from "../ratio.js";
import type { CurrencyReport } from "../schema/report.js";
import { qty, unitPrice, yen } from "./format.js";

/** 当該銘柄に適用された【方針】ID を集める（監修で方針が変わったとき辿れるように）。 */
export function policyIds(ledger: LedgerResult, currency: string): string[] {
  const ids = new Set<string>();
  for (const e of ledger.entries) {
    if (e.currency === currency) for (const id of e.policy_ids) ids.add(id);
  }
  return [...ids].sort();
}

export function currencyReport(
  currency: string,
  result: CurrencyResult,
  ledger: LedgerResult,
  guardInput: GuardInput,
): CurrencyReport {
  const o = result.outcome;
  const verdict = evaluateGuard(guardInput, currency);
  const revenue = add(o.disposed.proceeds, o.income);
  const expense = add(o.cogs, o.expense);
  return {
    currency,
    method: o.method,
    // 取引集計はガードの成否に関係なく常に出す（年間取引報告書相当のデータ）
    summary: {
      acquired_qty: qty(o.acquired.qty),
      acquired_cost_jpy: yen(o.acquired.cost),
      disposed_qty: qty(o.disposed.qty),
      proceeds_jpy: yen(o.disposed.proceeds),
      income_jpy: yen(o.income),
      expense_jpy: yen(o.expense),
    },
    ...(verdict.allowed
      ? {
          reference: {
            unit_price_jpy: unitPrice(o.unit),
            cogs_jpy: yen(o.cogs),
            closing_qty: qty(o.closing.qty),
            closing_cost_jpy: yen(o.closing.cost),
            revenue_total_jpy: yen(revenue),
            expense_total_jpy: yen(expense),
            // 負値のまま出す（v2 §9: max(0,·) に丸めると内部通算の余地が消える）
            reference_pnl_jpy: yen(sub(revenue, expense)),
          },
          // 計算書と同値の欄。既定（非丸め）と丸め位置が違うので値がずれ得る
          nta_compat: ntaCompat(
            o,
            ledger.entries.filter((e) => e.currency === currency),
          ),
        }
      : {}),
    blocked_by: verdict.blockedBy,
    warnings: verdict.warnings,
    policy_ids: policyIds(ledger, currency),
  };
}
