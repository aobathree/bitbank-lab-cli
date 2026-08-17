// 100行超: 移動平均法と、その実用上限（ADR-005 の計測根拠）を 1 ファイルに集約。
// 上限は移動平均法にしか意味がなく、別ファイルにしても利用者はここだけだった。
//
// 移動平均法（v2 §3）。**時系列順が結果を変える**ので安定ソートが前提。
//
//   取得: cost += 取得価額 ; qty += 数量 ; 単価 = cost / qty      ← 丸めない
//   処分: cogs = cost / qty × 数量（全量処分なら簿価残の全額。P-03）
//
// 単価は処分では更新しない（据置）。「年末 1 単位当たり取得価額 = 12/31 に最も近い
// 取得時点の平均単価」という FAQ 2-4 の定義がそのままこの形になる。
import { add, cmp, div, eq, isZero, mul, type Ratio, sub, ZERO } from "../ratio.js";
import type { LedgerEntry } from "../schema/ledger.js";
import { byLedgerOrder } from "../sort-order.js";
import { orderAmbiguities } from "./order-ambiguity.js";
import { type EntrySums, readAmount, sumEntries } from "./sum-entries.js";
import type { AverageOutcome, Book } from "./types.js";

// 非丸め移動平均法の実用上限（ADR-005 の計測）。
//
// 売却のたびに簿価の分母へ数量の分子が乗り、gcd 約分後も 1 売却あたり約 3.8 bit
// （数量が 8 桁バラバラだと約 13 bit）純増する。BigInt のコストは bit 長の二乗で効くため、
// これを超えると所要時間が非線形に伸びて実用時間で返らなくなる。
//
// **黙って精度を落とさず明示的に止める**（ADR-005: 閾値超での再正規化は「丸め済みの
// 中間値に再度丸めを適用しない」という中核原則に反するので採らない）。判定は計算に
// 入る前に行う — 入ってしまってからでは止められない。
export const MAX_DISPOSALS_UNROUNDED = 5000;

function countDisposals(entries: readonly LedgerEntry[]): number {
  return entries.filter((e) => e.kind === "DISPOSE").length;
}

/** 上限超で打ち切った結果。数値は出さず（unit=null / cogs=0）理由だけを返す。 */
function abortedOutcome(
  currency: string,
  disposals: number,
  opening: Book,
  totals: EntrySums,
  violations: string[],
): AverageOutcome {
  return {
    currency,
    method: "moving-average",
    opening,
    acquired: totals.acquired,
    disposed: totals.disposed,
    unit: null,
    cogs: ZERO,
    closing: opening,
    income: totals.income,
    expense: totals.expense,
    violations: [
      ...violations,
      `${currency}: 移動平均法（非丸め）の売却件数が上限 ${MAX_DISPOSALS_UNROUNDED} 件を` +
        `超えています（${disposals} 件）。総平均法を使うか、国税庁計算書互換モード` +
        `（NTA_SHEET_2025_12・売却の都度 ROUNDUP）の実装をお待ちください`,
    ],
  };
}

function step(
  book: Book,
  unit: Ratio | null,
  e: LedgerEntry,
  violations: string[],
): { book: Book; unit: Ratio | null; cogs: Ratio } {
  const qty = readAmount(e.qty, "qty", e, violations);
  if (e.kind === "ACQUIRE") {
    const cost = add(book.cost, readAmount(e.cost_jpy, "cost_jpy", e, violations));
    const next = { qty: add(book.qty, qty), cost };
    // 数量ゼロへの取得（数量 0 の調整仕訳）では単価を引けないので据置く
    return { book: next, unit: isZero(next.qty) ? unit : div(next.cost, next.qty), cogs: ZERO };
  }
  if (e.kind !== "DISPOSE") return { book, unit, cogs: ZERO };

  // 数量超過の検証は数量ゼロの早期 return より**先**に置く。保有が負の異常状態では
  // cmp(0, 負) > 0 が真になり、ここが唯一の検知点になる（後続の取得で数量が正へ
  // 戻ると期末には現れず、I1 も I2 も通ってしまう）
  if (cmp(qty, book.qty) > 0) {
    violations.push(
      `${e.event_id}#${e.seq}: 処分数量が保有数量を超えています（取込漏れか前年繰越の未入力）`,
    );
    return { book, unit, cogs: ZERO };
  }
  // 数量ゼロの処分では簿価も単価も動かさない。下の P-03 判定は qty と book.qty が
  // 両方ゼロでも真になるため、数量ゼロの調整仕訳で残った簿価が丸ごと cogs へ流れ、
  // 売却代金ゼロの参考損失になってしまう。簿価は期末に残し I2 違反として検知させる
  if (isZero(qty)) return { book, unit, cogs: ZERO };
  // P-03: 全量処分では簿価残を全額原価へ掃き出す（端数を残さない）
  const cogs = eq(qty, book.qty) ? book.cost : mul(div(book.cost, book.qty), qty);
  return { book: { qty: sub(book.qty, qty), cost: sub(book.cost, cogs) }, unit, cogs };
}

export function movingAverage(
  currency: string,
  entries: readonly LedgerEntry[],
  opening: Book,
): AverageOutcome {
  const totals = sumEntries(entries);
  // 順序を定義できない同時刻は、打ち切り判定より**先**に積む（打ち切っても理由を残す）
  const violations = [...totals.violations, ...orderAmbiguities(currency, entries)];

  // 実用上限の判定は計算に入る前に（ADR-005。入ってしまうと実用時間で返らない）
  const disposals = countDisposals(entries);
  if (disposals > MAX_DISPOSALS_UNROUNDED) {
    return abortedOutcome(currency, disposals, opening, totals, violations);
  }
  // 同一ミリ秒は約定ID の数値順（`sort-order.ts` が単一ソース）。辞書順だと "10" < "9" で
  // 取得順と食い違い、取得と処分が混ざったミリ秒で譲渡原価が入れ替わる
  const ordered = [...entries].sort(byLedgerOrder);

  let book = opening;
  let unit: Ratio | null = isZero(opening.qty) ? null : div(opening.cost, opening.qty);
  let cogs = ZERO;
  for (const e of ordered) {
    const r = step(book, unit, e, violations);
    book = r.book;
    unit = r.unit;
    cogs = add(cogs, r.cogs);
  }

  return {
    currency,
    method: "moving-average",
    opening,
    acquired: totals.acquired,
    disposed: totals.disposed,
    unit,
    cogs,
    closing: book,
    income: totals.income,
    expense: totals.expense,
    violations,
  };
}
