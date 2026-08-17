// 各時点の保有に対する価格の解決とフォールバック。
//
// **移植元**: `bitbankinc/bitbank-lab-mcp` の `src/handlers/portfolio/calc.ts`
// （`buildEquitySeries` 内の価格解決部分。`ecf05ae` 時点）。
import type { Holdings } from "./reconstruct.js";

/** asset → (UTC 日付キー `YYYYMMDD` → その日の 1day 足始値)。 */
export type DailyOpens = ReadonlyMap<string, ReadonlyMap<string, number>>;

/** 価格の由来の記録。系列全体で 1 つ持ち回り、最後に価格品質・warning へ落とす。 */
export type PriceOrigin = { fallback: Set<string>; unpriced: Set<string> };

export function newPriceOrigin(): PriceOrigin {
  return { fallback: new Set(), unpriced: new Set() };
}

/**
 * `ymd` 時点の保有について asset → 価格を解決する。
 *
 * **1day 足が取れない資産は現在価格へフォールバックする**。フォールバックしないと
 * その資産だけ評価額 0 で積まれ、過去の点と最終点（現在評価額）でスケールが合わなくなる
 * （JPY のみ保有・candle 全失敗でも系列が壊れないようにするための移植元の判断）。
 */
export function resolvePrices(
  holdings: Holdings,
  ymd: string,
  dailyOpens: DailyOpens,
  currentPrices: ReadonlyMap<string, number>,
  origin: PriceOrigin,
): Map<string, number> {
  const prices = new Map<string, number>();
  for (const asset of holdings.keys()) {
    if (asset === "jpy") continue;
    const open = dailyOpens.get(asset)?.get(ymd);
    if (open !== undefined) {
      prices.set(asset, open);
      continue;
    }
    origin.fallback.add(asset);
    const fb = currentPrices.get(asset);
    // 足も現在価格も無い資産は評価から落ちる（0 円で積むのと同じ）。全時点で一貫して
    // 落ちるのでスケールは崩れないが、黙って消してはいけないので申告する。
    if (fb === undefined) origin.unpriced.add(asset);
    else prices.set(asset, fb);
  }
  return prices;
}
