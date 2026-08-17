// 国税庁計算書（移動平均法用シート）の漸化式。`nta-sheet.ts` から分けたのは、
// ここだけ**丸めの規則が 2 つ**あって説明の量が多いため（入力の円確定と売却時の切上げ）。
//
// 既定エンジン（`engine/moving-average.ts`）は `cost -= cogs` で簿価を減らすが、
// 計算書は**売却のたびに残高を `ceil(単価 × 残数量)` へ置き直す**（付録D.3 の ASn）。
// 譲渡原価は最後に差引で出す（`(繰越 + Σ購入) − 年末残高`。D.3 の U47）。
import type { Book } from "../engine/types.js";
import { add, cmp, div, eq, isZero, mul, type Ratio, sub, ZERO } from "../ratio.js";
import { fromDecimalString, toYen } from "../ratio-decimal.js";
import type { LedgerEntry } from "../schema/ledger.js";
import { byLedgerOrder } from "../sort-order.js";

const num = (s: string | undefined): Ratio => (s ? (fromDecimalString(s) ?? ZERO) : ZERO);
const fromYen = (v: bigint): Ratio => ({ n: v, d: 1n });

/**
 * シートへ「入力する」金額を円に確定する。付録D.5 の前提「繰越価額・購入価額は整数円入力
 * （円未満を含む場合は事前に確定させる）」の実装で、丸めは翌年 B 欄への転記
 * （D.5 carryover DISPLAY = `round_half_up`）と同じ HALF_UP に揃える。
 *
 * 販売所（即時売買）は約定代金の列が無く `数量 × 指値価格` で出すため小数円になる
 * （例: `0.00009542 × 10479030 = 999.9090426`）。これをそのまま漸化式へ入れると
 * D.3 の「繰越価額・購入価額が整数円入力である限り残高価額 (AS) は常に整数に保たれる」が
 * 崩れ、`nta_compat` が「計算書に書いたらこうなる」値ではなくなる。
 *
 * **既定エンジンはこの確定を行わない**（ADR-005: 内部非丸め）。ここは互換欄専用。
 */
const toSheetYen = (r: Ratio): Ratio => fromYen(toYen(r, "HALF_UP"));

/** 漸化式の結果。`cogs` の差引に使う入力側も**円確定後**の合計で返す。 */
export type SheetBook = { closing: Book; inputCost: Ratio };

/**
 * 計算書の漸化式で残高を回し直す。
 *
 * **差引の左辺も円確定後の合計を使う**（`inputCost`）。非丸めの繰越・購入から
 * 丸めた残高を引くと、どちらでもない third の値になって「シートに書いた値」から外れる。
 */
export function movingAverageBook(entries: readonly LedgerEntry[], opening: Book): SheetBook {
  // 既定エンジンと**同じ順序**で回す（違う順序で回すと差が丸め由来かどうか判別できない）
  const ordered = [...entries].sort(byLedgerOrder);
  let inputCost = toSheetYen(opening.cost);
  let book: Book = { qty: opening.qty, cost: inputCost };
  let unit: Ratio | null = isZero(book.qty) ? null : div(book.cost, book.qty);
  for (const e of ordered) {
    const qty = num(e.qty);
    if (e.kind === "ACQUIRE") {
      const cost = toSheetYen(num(e.cost_jpy));
      inputCost = add(inputCost, cost);
      book = { qty: add(book.qty, qty), cost: add(book.cost, cost) };
      if (!isZero(book.qty)) unit = div(book.cost, book.qty);
      continue;
    }
    if (e.kind !== "DISPOSE" || isZero(qty) || cmp(qty, book.qty) > 0) continue;
    const left = sub(book.qty, qty);
    // 全量処分は残高ゼロ（切上げても 0）。単価が無い異常時は簿価を動かさない
    const cost =
      eq(qty, book.qty) || unit === null ? ZERO : fromYen(toYen(mul(unit, left), "ROUNDUP"));
    book = { qty: left, cost };
  }
  return { closing: book, inputCost };
}
