// 復元結果を出力契約（schema.ts）へ組み立てる。数値の丸めはここ（境界）で 1 回だけ。
//
// **移植元**: `bitbankinc/bitbank-lab-mcp` の
// `src/handlers/portfolio/calc.ts#buildPeriodPerformance`（`ecf05ae` 時点）。増減・調整後増減と
// パーセントの丸め（`Math.round(x * 10000) / 100`）はそこから持ってきている。
// 出力フィールドの構成（`points` / `completeness` / `price_quality` 等）は CLI 側の契約で、
// 移植元に対応物は無い。
import { ymdUtc } from "../date-utils.js";
import type { EquityPoint } from "./equity.js";
import { calcPortfolioValue } from "./equity.js";
import type { Grid } from "./grid.js";
import type { NetFlow } from "./net-flow.js";
import { RECONSTRUCTION_ASSUMPTIONS, RECONSTRUCTION_NOTE } from "./note.js";
import type { Holdings } from "./reconstruct.js";
import type { BalanceHistory, PriceQuality } from "./schema.js";

function isoUtc(ms: number): string {
  return new Date(ms).toISOString();
}

function pct(numerator: number, denominator: number): number | undefined {
  if (denominator <= 0) return undefined;
  return Math.round((numerator / denominator) * 10000) / 100;
}

/** 現在の実測評価額（復元値ではない）。系列の最終点になる。 */
export function currentPoint(
  holdings: Holdings,
  prices: ReadonlyMap<string, number>,
  nowMs: number,
): EquityPoint {
  const ymd = ymdUtc(nowMs);
  return {
    date: `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`,
    timestamp: nowMs,
    value_jpy: Math.round(calcPortfolioValue(holdings, prices)),
  };
}

/** 保有暗号資産のうち何割が現在価格の代替に落ちたかで価格品質を決める。 */
export function priceQuality(cryptoAssets: string[], fallbackAssets: string[]): PriceQuality {
  const fallback = fallbackAssets.filter((a) => cryptoAssets.includes(a)).sort();
  if (cryptoAssets.length === 0) return { level: "jpy_only", fallback_assets: [] };
  if (fallback.length === 0) return { level: "complete", fallback_assets: [] };
  const level = fallback.length === cryptoAssets.length ? "fallback_only" : "partial_fallback";
  return { level, fallback_assets: fallback };
}

export type AssembleInput = {
  grid: Grid;
  nowMs: number;
  granularity: BalanceHistory["granularity"];
  points: EquityPoint[];
  current: EquityPoint;
  flow: NetFlow;
  quality: PriceQuality;
  completeness: BalanceHistory["completeness"];
  warnings: string[];
};

export function assemble(i: AssembleInput): BalanceHistory {
  const startValue = i.points[0]?.value_jpy ?? i.current.value_jpy;
  const change = i.current.value_jpy - startValue;
  const adjusted = change - i.flow.net_flow_jpy;
  return {
    as_of: isoUtc(i.nowMs),
    since: isoUtc(i.grid.startMs),
    granularity: i.granularity,
    points: i.points,
    current: i.current,
    flow: i.flow,
    change: {
      start_value_jpy: startValue,
      change_jpy: change,
      change_pct: pct(change, startValue),
      adjusted_change_jpy: adjusted,
      adjusted_change_pct: pct(adjusted, startValue),
    },
    price_quality: i.quality,
    completeness: i.completeness,
    warnings: i.warnings,
    note: RECONSTRUCTION_NOTE,
    assumptions: [...RECONSTRUCTION_ASSUMPTIONS],
  };
}
