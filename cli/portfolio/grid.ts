// 評価時点のグリッド（UTC 日境界 / UTC 月初）。
//
// **移植元**: `bitbankinc/bitbank-lab-mcp` の `src/handlers/analyzeMyPortfolioHandler.ts`
// （§6.7 の `monthDates` / `yearDates` 構築、`ecf05ae` 時点）。
// **意図的な差分**: 移植元は dayjs の JST（`Asia/Tokyo`）で刻むが、本ファイルは UTC で刻む。
// bitbank の candlestick は UTC 基準（cli/date-utils.ts の単一ソース。1day 足は UTC 00:00
// 起点）で、CLI は「JST は表示用のみ」が規約（ADR-004 の税務例外の外）なため。
// MAX_POINTS による間引きは CLI 側の追加（移植元は期間が年初来固定で上限を持たない）。
import { EXIT } from "../exit-codes.js";
import type { Result } from "../types.js";

export const GRANULARITIES = ["day", "month"] as const;
export type Granularity = (typeof GRANULARITIES)[number];

/** グリッド点の上限。誤指定で候補が膨らんでも復元ループが暴走しないための安全弁
 *  （day で約 2 年分）。超過ぶんは切り捨てず、新しい側から `maxPoints` 点を残す。 */
export const MAX_POINTS = 750;

function utcDayStart(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function utcMonthStart(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

/** 1 つ前の評価時点。月は暦依存なので Date.UTC に月送りを任せる。 */
function prevPoint(ms: number, granularity: Granularity): number {
  if (granularity === "day") return ms - 86_400_000;
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1);
}

export type Grid = {
  /** 昇順の評価時点（epoch ms）。最後の点は現在の期間の開始（当日 / 当月初） */
  points: number[];
  /** 実際に系列の起点になった時点。--since を丸めた後の値 */
  startMs: number;
  /** MAX_POINTS で古い側を落としたか */
  truncated: boolean;
};

/**
 * `[sinceMs, nowMs]` を granularity 単位の境界へ刻む。sinceMs は期間の開始境界へ
 * 切り下げる（--since=1/15 12:00 なら 1/15 00:00 UTC から）。
 */
export function buildGrid(sinceMs: number, nowMs: number, granularity: Granularity): Result<Grid> {
  if (sinceMs > nowMs) {
    return { success: false, error: "--since must not be in the future", exitCode: EXIT.PARAM };
  }
  const align = granularity === "day" ? utcDayStart : utcMonthStart;
  // JS Date の表現範囲（±8.64e15 ms）を超えると getUTC* が NaN を返し、境界の切り下げが
  // NaN になる。ループが 0 周して「1 点だけの完全な系列」を静かに返してしまうので弾く
  // （--days は正整数なら何桁でも通るため、約 1.001e8 日でこの範囲に入る）。
  const startAligned = align(sinceMs);
  if (!Number.isFinite(startAligned)) {
    return {
      success: false,
      error: "--since/--days is out of the representable date range",
      exitCode: EXIT.PARAM,
    };
  }
  // **新しい側から MAX_POINTS 点だけ生成する**。全点を作ってから切り詰めると、表現範囲内
  // でも極端な窓（--days=1e8 ≒ 27 万年）で 1 億件の配列を組んでしまう（実測 11.6 秒 /
  // 849MB で、返すのは結局 750 点）。残すのは新しい側なので、逆順に必要数だけ数える。
  const last = align(nowMs);
  const points: number[] = [];
  let ms = last;
  while (ms >= startAligned && points.length < MAX_POINTS) {
    points.push(ms);
    ms = prevPoint(ms, granularity);
  }
  points.reverse();

  // ループを抜けた時点でまだ startAligned に届いていない = 古い側を落とした
  return { success: true, data: { points, startMs: points[0], truncated: ms >= startAligned } };
}

/** 1day 足を何本取れば grid 全体をカバーできるか（candles の --limit 相当）。 */
export function candleLimitFor(grid: Grid, nowMs: number): number {
  const spanDays = Math.ceil((nowMs - grid.startMs) / 86_400_000);
  return Math.max(2, spanDays + 2);
}
