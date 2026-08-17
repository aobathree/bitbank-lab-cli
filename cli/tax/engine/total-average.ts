// 総平均法（v2 §3・付録D.2）。個人の法定評価方法（届出がない場合）。
//
//   E(単価) = (年始金額B + 購入金額計D) / (年始数量A + 購入数量計C)   ← 丸めない
//   G(譲渡原価) = E × F(売却数量計)                                    ← 直接乗算
//   H(年末数量) = A + C − F,  I(年末金額) = E × H
//
// E を厳密値のまま持つ限り `G + I == B + D` が恒等的に成立する（不変条件 I1）。
// 有限桁の十進で E を先に確定させるとこの等式が壊れるため、Ratio で持ち回る。
import { add, cmp, div, isZero, mul, sub, ZERO } from "../ratio.js";
import { fromDecimalString } from "../ratio-decimal.js";
import type { LedgerEntry } from "../schema/ledger.js";
import { sumEntries } from "./sum-entries.js";
import type { AverageOutcome, Book } from "./types.js";

export function totalAverage(
  currency: string,
  entries: readonly LedgerEntry[],
  opening: Book,
): AverageOutcome {
  const s = sumEntries(entries);
  const violations = [...s.violations];

  const totalQty = add(opening.qty, s.acquired.qty);
  const totalCost = add(opening.cost, s.acquired.cost);
  const unit = isZero(totalQty) ? null : div(totalCost, totalQty);

  const closingQty = sub(totalQty, s.disposed.qty);
  // 単価が引けない（数量ゼロ）ときは簿価を**期末に残す**。ここで簿価を譲渡原価へ
  // 流すと、実際には処分していない簿価がまるごと参考損失になり、しかも I1 は
  // 成立してしまうので検知できない（繰越の入力ミスが静かに損失を生む）
  const closingCost = unit === null ? totalCost : mul(unit, closingQty);
  const cogs = unit === null ? ZERO : sub(totalCost, closingCost);

  if (isZero(totalQty) && !isZero(totalCost)) {
    violations.push(
      `${currency}: 数量ゼロなのに取得価額が残っています（前年繰越の入力を確認してください）`,
    );
  }
  if (cmp(closingQty, ZERO) < 0) {
    violations.push(
      `${currency}: 年末残高数量が負です（処分が取得を超過。取込漏れか前年繰越の未入力）`,
    );
  }
  if (unit === null && !isZero(s.disposed.qty)) {
    violations.push(`${currency}: 取得が 1 件も無いのに処分があります（取得価額を決められません）`);
  }

  return {
    currency,
    method: "total-average",
    opening,
    acquired: s.acquired,
    disposed: s.disposed,
    unit,
    cogs,
    closing: { qty: closingQty, cost: closingCost },
    income: s.income,
    expense: s.expense,
    violations,
  };
}

/** 前年繰越（decStr）→ Book。片方でも読めなければ null（ガード(c) で止める）。 */
export function bookFromDecimal(qty: string, cost: string): Book | null {
  const q = fromDecimalString(qty);
  const c = fromDecimalString(cost);
  return q === null || c === null ? null : { qty: q, cost: c };
}

export const ZERO_BOOK: Book = { qty: ZERO, cost: ZERO };
