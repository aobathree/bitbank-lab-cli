// 評価に使う価格の取得（public のみ）。1day 足の始値マップと、現在 ticker 価格。

import { candles } from "../commands/public/candles.js";
import { tickersJpy } from "../commands/public/tickers.js";
import { ymdUtc } from "../date-utils.js";
import type { HttpOptions } from "../http.js";
import type { Result } from "../types.js";
import type { DailyOpens } from "./price-map.js";

// candles-range / candles と同じ並列数（throttle.ts の lowWaterMark 配慮）
const BATCH_SIZE = 10;

/** asset → 現在価格（JPY）。`last` が null のペアは載せない（0 円評価を避ける）。 */
export async function fetchCurrentPrices(opts?: HttpOptions): Promise<Result<Map<string, number>>> {
  const r = await tickersJpy(opts);
  if (!r.success) return r;
  const prices = new Map<string, number>();
  for (const t of r.data) {
    if (t.last !== null && t.pair.endsWith("_jpy")) {
      prices.set(t.pair.slice(0, -"_jpy".length), t.last);
    }
  }
  return { success: true, data: prices };
}

/**
 * 各 asset の 1day 足始値を UTC 日付キー（`YYYYMMDD`）で引ける形にする。
 *
 * **取得に失敗したペアはエラーにしない**。評価側が現在価格へフォールバックするので、
 * 1 ペアの candle 欠落で系列全体を落とすほうが有害。欠落そのものは
 * `buildEquitySeries` が「実際に代替へ落ちた資産」として拾い、価格品質に載せる
 * （ここで返しても、その資産を当時保有していたかは分からない）。
 */
export async function fetchDailyOpens(
  pairs: readonly string[],
  limit: number,
  noCache: boolean,
  opts?: HttpOptions,
): Promise<DailyOpens> {
  const dailyOpens = new Map<string, Map<string, number>>();

  for (let i = 0; i < pairs.length; i += BATCH_SIZE) {
    const batch = pairs.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map((pair) => candles({ pair, type: "1day", limit, noCache }, opts)),
    );
    for (let j = 0; j < results.length; j++) {
      const pair = batch[j];
      const asset = pair.slice(0, -"_jpy".length);
      const r = results[j];
      if (!r.success) continue;
      const byDate = new Map<string, number>();
      for (const c of r.data) {
        if (Number.isFinite(c.open) && c.open > 0) byDate.set(ymdUtc(c.timestamp), c.open);
      }
      if (byDate.size > 0) dailyOpens.set(asset, byDate);
    }
  }

  return dailyOpens;
}
