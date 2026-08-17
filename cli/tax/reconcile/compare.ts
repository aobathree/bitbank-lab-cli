// 理論残高 vs /user/assets の突合（ガード(d) / P-17）。
//
// **判定ではなく検出**（要求仕様 §10-2）。閾値外を失敗として扱わず、残差の量と符号を
// 報告する。実口座では販売所取引が API に現れないため「全資産で残差ゼロ」は成立しない。
import type { RawAsset } from "../import/fetch-assets.js";
import { abs, cmp, isZero, sub, ZERO } from "../ratio.js";
import { fromDecimalString } from "../ratio-decimal.js";
import {
  type AssetComparison,
  actualByCurrency,
  type Diagnosis,
  dustFor,
  row,
} from "./compare-parts.js";
import type { Rebuilt } from "./rebuild.js";

export { type AssetComparison, type Diagnosis, DUST_THRESHOLD } from "./compare-parts.js";

export function compareBalances(
  rebuilt: Rebuilt,
  assets: readonly RawAsset[],
  dustByCurrency: Record<string, string> = {},
): AssetComparison[] {
  const actual = actualByCurrency(assets);
  const currencies = new Set<string>([...rebuilt.balances.keys(), ...actual.keys()]);
  const out: AssetComparison[] = [];

  for (const currency of [...currencies].sort()) {
    const theo = rebuilt.balances.get(currency) ?? ZERO;
    const act = actual.get(currency);
    // 突合できない分岐でも「その資産に適用される閾値」は同じ。既定値を返すと
    // 出力の dust が実際の基準と食い違う（JPY だけ 0.0001 と表示される）
    const dustStr = dustFor(currency, dustByCurrency);
    if (act === null) {
      out.push(row(currency, theo, ZERO, ZERO, false, "UNREADABLE", dustStr));
      continue;
    }
    const actualValue = act ?? ZERO;
    if (rebuilt.unreconcilable.has(currency)) {
      out.push(row(currency, theo, actualValue, ZERO, false, "UNRECONCILABLE", dustStr));
      continue;
    }
    // 活動も残高も無い資産は行にしない（pairs マスタ全巡回でゼロ行が大量に出るため）
    if (isZero(theo) && isZero(actualValue)) continue;

    const residual = sub(actualValue, theo);
    const dust = fromDecimalString(dustStr) ?? ZERO;
    const withinDust = cmp(abs(residual), dust) <= 0;
    const diagnosis: Diagnosis = withinDust
      ? "MATCH"
      : cmp(residual, ZERO) < 0
        ? "MISSING_DISPOSAL"
        : "MISSING_ACQUISITION";
    out.push(row(currency, theo, actualValue, residual, withinDust, diagnosis, dustStr));
  }
  return out;
}
