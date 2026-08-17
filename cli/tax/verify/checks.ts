// 報告書だけで閉じる恒等式の検算。API と突き合わせる**前**に、列の読み違い・
// 行の欠落・編集済みファイルを弾くためのもの。
//
// R1（行内）: 年末数量 = 年始数量 + 年中購入数量 − 年中売却数量 + 移入数量 − 移出数量 − 支払手数料
// R2（行間）: JPY 行の年中購入金額 = Σ(暗号資産行の年中売却金額)、売却側はその逆
//
// いずれも実口座の報告書 1 件で成立を確認した関係式（値そのものは持ち込まない）。
// **確定仕様として受領したものではない**ため、不成立は fail ではなく報告に留める。
import { AnnualReportRow } from "../import-csv/annual-report-columns.js";
import { add, isZero, type Ratio, sub, ZERO } from "../ratio.js";
import { fromDecimalString, toExactDecimalString } from "../ratio-decimal.js";
import type { ReportCheck } from "../schema/verify.js";

/** 数値列の一覧は Zod スキーマの shape から導く（列を足したときに検算が置いていかれない）。 */
const NUMERIC = (Object.keys(AnnualReportRow.shape) as (keyof AnnualReportRow)[]).filter(
  (k) => k !== "currency",
);

const PLUS = ["opening_qty", "buy_qty", "buy_qty_btc", "deposit_qty"] as const;
const MINUS = ["sell_qty", "sell_qty_btc", "withdrawal_qty", "fee"] as const;
const LENDING = ["lend_qty", "return_qty", "lend_pnl"] as const;

/** decStr は Zod 検証済みなので読めるはずだが、読めなければ ZERO 扱いで検算を落とす。 */
function at(row: AnnualReportRow, field: keyof AnnualReportRow): Ratio {
  return fromDecimalString(row[field]) ?? ZERO;
}

const show = (r: Ratio): string => toExactDecimalString(r) ?? "?";

function flowIdentity(row: AnnualReportRow): ReportCheck {
  let expected = ZERO;
  for (const f of PLUS) expected = add(expected, at(row, f));
  for (const f of MINUS) expected = sub(expected, at(row, f));
  const residual = sub(at(row, "closing_qty"), expected);
  return {
    id: "R1",
    target: row.currency,
    ok: isZero(residual),
    detail: isZero(residual) ? "年末数量が年中フローと整合" : `年末数量の残差 ${show(residual)}`,
  };
}

const MIRROR = [
  ["R2-buy", "buy_jpy", "sell_jpy"],
  ["R2-sell", "sell_jpy", "buy_jpy"],
] as const;

function mirror(rows: readonly AnnualReportRow[], jpy: AnnualReportRow): ReportCheck[] {
  const others = rows.filter((r) => r !== jpy);
  return MIRROR.map(([id, jpyField, cryptoField]) => {
    const total = others.reduce((acc, r) => add(acc, at(r, cryptoField)), ZERO);
    const residual = sub(at(jpy, jpyField), total);
    return {
      id,
      target: "jpy",
      ok: isZero(residual),
      detail: isZero(residual)
        ? `JPY 行の ${jpyField} が暗号資産行の ${cryptoField} 合計と一致`
        : `JPY 行の ${jpyField} と暗号資産行の ${cryptoField} 合計の差 ${show(residual)}`,
    };
  });
}

export type ChecksResult = { checks: ReportCheck[]; warnings: string[] };

export function reportChecks(rows: readonly AnnualReportRow[]): ChecksResult {
  const checks: ReportCheck[] = [];
  const warnings: string[] = [];
  for (const row of rows) {
    if (NUMERIC.every((f) => isZero(at(row, f)))) continue; // 全ゼロ行は検算しても意味がない
    if (LENDING.some((f) => !isZero(at(row, f)))) {
      warnings.push(`${row.currency}: 貸出列に値があるため R1（年末数量の恒等式）は検算しません`);
      continue;
    }
    checks.push(flowIdentity(row));
  }
  const jpy = rows.find((r) => r.currency.toLowerCase() === "jpy");
  if (jpy === undefined) {
    warnings.push("報告書に JPY 行がないため R2（行間の恒等式）は検算しません");
  } else {
    checks.push(...mirror(rows, jpy));
  }
  return { checks, warnings };
}
