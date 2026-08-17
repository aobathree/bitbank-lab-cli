// 国税庁「暗号資産の計算書」互換モード（`NTA_SHEET_2025_12`。v2 付録D）。
// 既定の計算（ADR-005: 内部非丸め）は**変えない**。「計算書に手で書き込んだらこうなる」
// 値を併記するための層で、用途はレポートの互換欄と回帰テストだけ（付録D.6）。
//
// **丸めの位置が方式で違う**（実ファイルの数式解析・付録D.2 / D.3）。ここが本体:
// - 総平均法: 単価・原価・残高は**非丸め**。最終の
//   **収入金額計を切捨て（AV52）・必要経費計を切上げ（AV53）**。所得は丸めた両者の差
// - 移動平均法: **売却の都度、残高価額を切上げ**。譲渡原価はそこからの差引で、
//   集計段階の**追加の丸めは無い**（丸めは既に売却時に入っているため）
import type { AverageOutcome } from "../engine/types.js";
import { add, type Ratio, sub } from "../ratio.js";
import { toDecimalString, toYen } from "../ratio-decimal.js";
import type { LedgerEntry } from "../schema/ledger.js";
import { NTA_SHEET_MODE, type NtaCompat } from "../schema/nta.js";
import { i1Delta } from "./delta.js";
import { movingAverageBook } from "./moving-average-sheet.js";

const yen = (r: Ratio, mode: "ROUNDDOWN" | "ROUNDUP" | "HALF_UP"): string =>
  toYen(r, mode).toString();

export function ntaCompat(outcome: AverageOutcome, entries: readonly LedgerEntry[]): NtaCompat {
  const revenue = add(outcome.disposed.proceeds, outcome.income);
  const compat = sheetValues(outcome, entries, revenue);
  // I4: 丸め起因の乖離を**違反ではなく開示**として併記する（delta.ts）
  return { ...compat, delta: i1Delta(outcome, revenue, compat) };
}

function sheetValues(
  outcome: AverageOutcome,
  entries: readonly LedgerEntry[],
  revenue: Ratio,
): Omit<NtaCompat, "delta"> {
  if (outcome.method === "moving-average") {
    const { closing, inputCost } = movingAverageBook(entries, outcome.opening);
    // cogs は差引（D.5）。売却時の切上げぶんが原価側から抜けて残高へ寄る
    const cogs = sub(inputCost, closing.cost);
    const expense = add(cogs, outcome.expense);
    // 移動平均法は集計段階の追加丸めが無い。表示のため切捨てるだけ
    return {
      mode: NTA_SHEET_MODE,
      cogs_jpy: yen(cogs, "ROUNDDOWN"),
      closing_cost_jpy: yen(closing.cost, "ROUNDDOWN"),
      income_total_jpy: yen(revenue, "ROUNDDOWN"),
      expense_total_jpy: yen(expense, "ROUNDDOWN"),
      income_jpy: toDecimalString(sub(revenue, expense), 0, "ROUNDDOWN"),
      carryover_cost_jpy: yen(closing.cost, "HALF_UP"),
    };
  }
  // 総平均法: 丸めるのは最終 2 セルだけ。**所得は丸めた両者の差**（丸め前の差ではない）
  const expense = add(outcome.cogs, outcome.expense);
  const incomeTotal = toYen(revenue, "ROUNDDOWN");
  const expenseTotal = toYen(expense, "ROUNDUP");
  return {
    mode: NTA_SHEET_MODE,
    cogs_jpy: yen(outcome.cogs, "ROUNDDOWN"),
    closing_cost_jpy: yen(outcome.closing.cost, "ROUNDDOWN"),
    income_total_jpy: incomeTotal.toString(),
    expense_total_jpy: expenseTotal.toString(),
    income_jpy: (incomeTotal - expenseTotal).toString(),
    carryover_cost_jpy: yen(outcome.closing.cost, "HALF_UP"),
  };
}
