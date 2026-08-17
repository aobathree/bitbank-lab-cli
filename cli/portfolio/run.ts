// 100行超: 「現在の残高 → 履歴 → 価格 → 復元 → 組み立て」を通す 1 本のパイプライン。
// 各段の実装は scope / fetch-* / equity / net-flow / assemble に分けてあり、ここに残るのは
// 順序と受け渡しだけ。途中で切ると「どの順で何を渡すか」が 2 ファイルに割れて読めなくなる。
//
// **移植元**: `bitbankinc/bitbank-lab-mcp` の
// `src/handlers/analyzeMyPortfolioHandler.ts`（§6.6〜6.7 の資産推移構築、`ecf05ae` 時点）。
// 取得層は同リポの `src/handlers/portfolio/fetch.ts` に対応する。CLI 側は private GET の
// 呼び出しを既存コマンド（assets / trade-history / *-history）へ寄せているため 1 対 1 ではない。
import { pairs } from "../commands/public/pairs.js";
import type { PrivateHttpOptions } from "../http-private.js";
import type { Result } from "../types.js";
import { assemble, currentPoint, priceQuality } from "./assemble.js";
import { buildEquitySeries } from "./equity.js";
import { fetchHistory } from "./fetch-history.js";
import { fetchCurrentPrices, fetchDailyOpens } from "./fetch-prices.js";
import { buildGrid, candleLimitFor, type Granularity } from "./grid.js";
import { calcPeriodNetFlow } from "./net-flow.js";
import type { BalanceHistory } from "./schema.js";
import { candlePairsFor, currentHoldings, marketScope, pairAssetsOf } from "./scope.js";
import { buildWarnings } from "./warnings.js";

export type RunArgs = {
  sinceMs: number;
  nowMs: number;
  granularity: Granularity;
  maxPages: number;
  noCache: boolean;
};

export async function runBalanceHistory(
  args: RunArgs,
  opts?: PrivateHttpOptions,
): Promise<Result<BalanceHistory>> {
  const grid = buildGrid(args.sinceMs, args.nowMs, args.granularity);
  if (!grid.success) return grid;

  const market = await pairs(opts);
  if (!market.success) return market;
  const { allPairs, jpyPairs, allAssets } = marketScope(market.data);
  const pairAssets = pairAssetsOf(market.data);

  const holdings = await currentHoldings(opts);
  if (!holdings.success) return holdings;

  // 約定は全ペア（delist 込み）。JPY だけに絞ると BTC 建て履歴が取得されず巻き戻しが欠ける。
  const history = await fetchHistory(allPairs, allAssets, {
    since: String(grid.data.startMs),
    maxPages: args.maxPages,
    opts,
  });
  if (!history.success) return history;
  const { transfers } = history.data;

  const prices = await fetchCurrentPrices(opts);
  if (!prices.success) return prices;

  const candlePairs = candlePairsFor(
    jpyPairs,
    holdings.data,
    { trades: history.data.trades, ...transfers },
    pairAssets,
  );
  const dailyOpens = await fetchDailyOpens(
    candlePairs,
    candleLimitFor(grid.data, args.nowMs),
    args.noCache,
    opts,
  );

  // 信用約定（`position_side` あり）だけ除外する。現物残高を建玉数量ぶん動かさないので、
  // 現物と同じ式で巻き戻すと base も quote も狂う。tax 経路も `position_side` の有無で
  // spot / margin を分けている（cli/tax/import/to-events.ts）。移植元 MCP の
  // `paginateTrades` も `position_side == null` で現物に絞っており、そこに揃える。
  // 非 JPY クォートの現物は数量ベースで巻き戻せる（quote は pairs マスタから取る）。
  const marginFills = history.data.trades.filter((t) => t.position_side !== undefined);
  const spotTrades = history.data.trades.filter((t) => t.position_side === undefined);

  const series = buildEquitySeries({
    grid: grid.data.points,
    current: holdings.data,
    trades: spotTrades,
    transfers,
    dailyOpens,
    currentPrices: prices.data,
    pairAssets,
  });
  const { flow, unpricedAssets } = calcPeriodNetFlow(transfers, grid.data.startMs, prices.data);

  const historyTruncated =
    history.data.truncatedPairs.length > 0 ||
    history.data.truncatedAssets.length > 0 ||
    history.data.depositsTruncated;
  // 履歴の欠落とグリッドの間引きは原因が違うが、どちらも「求められた範囲を返せていない」。
  // partial / meta.truncated / completeness / warnings の 4 経路すべてに同じ判断を載せる
  // （1 経路でも漏らすと、その経路だけ読む呼び出し側が完全なデータと誤認する）。
  const truncated = historyTruncated || grid.data.truncated;

  const data = assemble({
    grid: grid.data,
    nowMs: args.nowMs,
    granularity: args.granularity,
    points: series.points,
    current: currentPoint(
      new Map(holdings.data.map((h) => [h.asset, h.amount])),
      prices.data,
      args.nowMs,
    ),
    flow,
    quality: priceQuality(
      holdings.data.map((h) => h.asset).filter((a) => a !== "jpy"),
      series.fallbackAssets,
    ),
    completeness: {
      complete: !truncated,
      truncated_pairs: history.data.truncatedPairs,
      truncated_assets: history.data.truncatedAssets,
      deposits_truncated: history.data.depositsTruncated,
      grid_truncated: grid.data.truncated,
    },
    warnings: buildWarnings({
      historyTruncated,
      gridTruncated: grid.data.truncated,
      marginPairs: [...new Set(marginFills.map((t) => t.pair))].sort(),
      unpricedAssets: [...new Set([...unpricedAssets, ...series.unpricedAssets])].sort(),
    }),
  });

  if (truncated) {
    return {
      success: true,
      data,
      partial: true,
      meta: {
        truncated: true,
        // 履歴欠落を優先して報告する（グリッド間引きより回復手段が重い）
        reason: historyTruncated ? "MAX_PAGES" : "MAX_POINTS",
        returnedRows: data.points.length,
      },
    };
  }
  return { success: true, data };
}
