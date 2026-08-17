// 各日付で保有を復元し、その日の 1day 足始値で JPY 建て評価する。価格の解決と
// フォールバックは price-map.ts が担う。
//
// **移植元**: `bitbankinc/bitbank-lab-mcp` の
// `src/handlers/portfolio/calc.ts#{calcPortfolioValue,buildEquitySeries}`（`ecf05ae` 時点）。

import type { Trade } from "../commands/private/trade-history.js";
import { ymdUtc } from "../date-utils.js";
import { type DailyOpens, newPriceOrigin, resolvePrices } from "./price-map.js";
import {
  type Holdings,
  type PairAssets,
  reconstructHoldingsAtDate,
  type Transfers,
} from "./reconstruct.js";
// 出力 DTO の型ソースは Zod（schema.ts）。ここで別定義を持つと契約が分岐する
import type { EquityPoint } from "./schema.js";

export type { EquityPoint };

export function calcPortfolioValue(
  holdings: Holdings,
  prices: ReadonlyMap<string, number>,
): number {
  let total = 0;
  for (const [asset, amount] of holdings) {
    if (asset === "jpy") {
      total += amount;
      continue;
    }
    const price = prices.get(asset);
    if (price !== undefined) total += amount * price;
  }
  return total;
}

export type EquityInput = {
  /** UTC 日境界（granularity=month なら月初）の epoch ms。昇順 */
  grid: readonly number[];
  current: readonly { asset: string; amount: number }[];
  trades: readonly Trade[];
  transfers: Transfers;
  dailyOpens: DailyOpens;
  /** 現在 ticker 価格。candle 欠落時のフォールバック兼、最終点の評価に使う */
  currentPrices: ReadonlyMap<string, number>;
  /** pairs マスタの base/quote。巻き戻しでペア名分割をしないための辞書 */
  pairAssets: PairAssets;
};

/** 系列と、価格の由来（フォールバックに頼った資産・価格が一切無い資産）を返す。
 *  最終点（現在評価額）は呼び出し側が足す — 復元ではなく実測値なので区別する。 */
export function buildEquitySeries(input: EquityInput): {
  points: EquityPoint[];
  fallbackAssets: string[];
  unpricedAssets: string[];
} {
  const origin = newPriceOrigin();
  const points: EquityPoint[] = [];

  for (const timestamp of input.grid) {
    const holdings = reconstructHoldingsAtDate(
      input.current,
      input.trades,
      timestamp,
      input.transfers,
      input.pairAssets,
    );
    const ymd = ymdUtc(timestamp);
    const prices = resolvePrices(holdings, ymd, input.dailyOpens, input.currentPrices, origin);
    points.push({
      date: `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`,
      timestamp,
      value_jpy: Math.round(calcPortfolioValue(holdings, prices)),
    });
  }

  return {
    points,
    fallbackAssets: [...origin.fallback].sort(),
    unpricedAssets: [...origin.unpriced].sort(),
  };
}
