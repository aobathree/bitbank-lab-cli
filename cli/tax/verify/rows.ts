// 突合行の組み立て（許容幅・診断）。現物 / 信用の突合が共有する。
// ヒント文言は現物 / 信用とも hints.ts が持つ（ここは両者に共通する部品だけ）。
import { abs, cmp, fromBigint, isZero, mul, type Ratio, ratio, sub, ZERO } from "../ratio.js";
import { fromDecimalString, toDecimalString, toExactDecimalString } from "../ratio-decimal.js";
import { DUST_THRESHOLD } from "../reconcile/compare-parts.js";
import type { VerifyDiagnosis, VerifyField, VerifyRow } from "../schema/verify.js";
import type { ComparedField } from "./aggregate.js";

const DUST = fromDecimalString(DUST_THRESHOLD) ?? ZERO;

/** 手数料以外の既定許容幅（残高突合と同じダスト閾値）。 */
export const DUST_TOLERANCE: Ratio = DUST;

/** API 手数料は小数第 4 位丸め（付録E.1 / P-16）。1 件あたりの最大誤差は 0.5×10^-4。 */
const FEE_HALF_ULP = ratio(1n, 20_000n);

/**
 * 手数料だけ許容幅を件数に比例させる。報告書側が丸め前合計なら差は必ず出るが、
 * その差は **件数 × 半 ulp** を超えられない。固定閾値だと件数が増えるほど
 * 「取込漏れ」と誤診し、逆に緩い固定値にすると本物の欠落を見逃す。
 */
export function feeTolerance(feeRoundedCount: number): Ratio {
  const bound = mul(fromBigint(BigInt(feeRoundedCount)), FEE_HALF_ULP);
  return cmp(bound, DUST) > 0 ? bound : DUST;
}

export function toleranceFor(field: ComparedField, feeRoundedCount: number): Ratio {
  return field === "fee" ? feeTolerance(feeRoundedCount) : DUST;
}

/** 有限小数同士の和なので厳密表現になる。理論上の取りこぼしだけ丸めて出す。 */
function dec(r: Ratio): string {
  return toExactDecimalString(r) ?? toDecimalString(r, 12, "HALF_UP");
}

export type RowArgs = {
  reportKind: "spot" | "margin";
  currency: string;
  field: VerifyField;
  report: Ratio;
  api: Ratio;
  tolerance: Ratio;
  hint: (diagnosis: VerifyDiagnosis) => string;
};

/** 報告書・API とも 0 の項目は行にしない（全銘柄 × 全項目のゼロ行で埋まるため）。 */
export function buildRow(args: RowArgs): VerifyRow | null {
  if (isZero(args.report) && isZero(args.api)) return null;
  const diff = sub(args.report, args.api);
  const magnitude = abs(diff);
  const diagnosis: VerifyDiagnosis =
    cmp(magnitude, DUST) <= 0
      ? "MATCH"
      : cmp(magnitude, args.tolerance) <= 0
        ? "FEE_ROUNDING"
        : cmp(diff, ZERO) > 0
          ? "REPORT_EXCESS"
          : "API_EXCESS";
  return {
    report_kind: args.reportKind,
    currency: args.currency,
    field: args.field,
    report: dec(args.report),
    api: dec(args.api),
    diff: dec(diff),
    tolerance: dec(args.tolerance),
    within_tolerance: cmp(magnitude, args.tolerance) <= 0,
    diagnosis,
    hint: args.hint(diagnosis),
  };
}
