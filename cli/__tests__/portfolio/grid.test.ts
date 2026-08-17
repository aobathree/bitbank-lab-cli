import { describe, expect, it } from "vitest";
import { ymdUtc } from "../../date-utils.js";
import { EXIT } from "../../exit-codes.js";
import { buildGrid, candleLimitFor, MAX_POINTS } from "../../portfolio/grid.js";

const DAY = 86_400_000;
const JAN3_NOON = Date.UTC(2026, 0, 3, 12);

describe("buildGrid", () => {
  it("day は UTC 日境界へ切り下げて 1 日ずつ刻む", () => {
    const g = buildGrid(Date.UTC(2026, 0, 1, 9, 30), JAN3_NOON, "day");
    expect(g.success).toBe(true);
    if (!g.success) return;
    expect(g.data.points.map(ymdUtc)).toEqual(["20260101", "20260102", "20260103"]);
    expect(g.data.startMs).toBe(Date.UTC(2026, 0, 1));
  });

  it("month は UTC 月初へ切り下げて 1 か月ずつ刻む（暦依存）", () => {
    const g = buildGrid(Date.UTC(2025, 10, 20), Date.UTC(2026, 1, 5), "month");
    expect(g.success).toBe(true);
    if (!g.success) return;
    expect(g.data.points.map(ymdUtc)).toEqual(["20251101", "20251201", "20260101", "20260201"]);
  });

  it("ホスト TZ に依らず UTC 境界で刻む（JST 当日 09:00 は前日 UTC）", () => {
    // 2026-01-02T00:00+09:00 = 2026-01-01T15:00Z → UTC では 1/1
    const g = buildGrid(Date.parse("2026-01-01T15:00:00Z"), JAN3_NOON, "day");
    expect(g.success).toBe(true);
    if (g.success) expect(ymdUtc(g.data.points[0])).toBe("20260101");
  });

  it("当日の途中を since にしても 1 点は返す", () => {
    const g = buildGrid(JAN3_NOON, JAN3_NOON, "day");
    expect(g.success).toBe(true);
    if (g.success) expect(g.data.points).toEqual([Date.UTC(2026, 0, 3)]);
  });

  it("MAX_POINTS を超えたら古い側を落として truncated を立てる", () => {
    const g = buildGrid(JAN3_NOON - (MAX_POINTS + 50) * DAY, JAN3_NOON, "day");
    expect(g.success).toBe(true);
    if (!g.success) return;
    expect(g.data.points).toHaveLength(MAX_POINTS);
    expect(g.data.truncated).toBe(true);
    // 残すのは新しい側。最後の点は当日
    expect(g.data.points.at(-1)).toBe(Date.UTC(2026, 0, 3));
  });

  it("表現範囲内でも極端に広い窓を定数時間で返す（全点を作ってから切らない）", () => {
    // 全点生成 → slice だと --days=1e8（約 27 万年）で 1 億件の配列を組み、実測
    // 11.6 秒 / 849MB かけて 750 点を返していた。新しい側から必要数だけ数える
    const t0 = performance.now();
    const g = buildGrid(JAN3_NOON - 1e8 * DAY, JAN3_NOON, "day");
    const elapsed = performance.now() - t0;
    expect(g.success).toBe(true);
    if (!g.success) return;
    expect(g.data.points).toHaveLength(MAX_POINTS);
    expect(g.data.truncated).toBe(true);
    expect(g.data.points.at(-1)).toBe(Date.UTC(2026, 0, 3));
    // 修正前は 11,000ms 超。10 倍以上の余裕を見ても、生成量の退行はここで落ちる
    expect(elapsed).toBeLessThan(1_000);
  });

  it("月次でも新しい側から MAX_POINTS 点までに収める", () => {
    const g = buildGrid(JAN3_NOON - 1e8 * DAY, JAN3_NOON, "month");
    expect(g.success).toBe(true);
    if (!g.success) return;
    expect(g.data.points).toHaveLength(MAX_POINTS);
    expect(g.data.truncated).toBe(true);
    expect(g.data.points.at(-1)).toBe(Date.UTC(2026, 0, 1));
  });

  it("JS Date の表現範囲を超える since は PARAM エラー（静かに 1 点を返さない）", () => {
    // --days は正整数なら何桁でも通る。約 1.001e8 日遡ると getUTC* が NaN になり、
    // 境界の切り下げが NaN → ループ 0 周 → 「1 点だけの完全な系列」が返っていた
    const g = buildGrid(JAN3_NOON - 1.001e8 * DAY, JAN3_NOON, "day");
    expect(g.success).toBe(false);
    if (!g.success) expect(g.exitCode).toBe(EXIT.PARAM);
  });

  it("未来の since は PARAM エラー", () => {
    const g = buildGrid(JAN3_NOON + DAY, JAN3_NOON, "day");
    expect(g.success).toBe(false);
    if (!g.success) expect(g.exitCode).toBe(EXIT.PARAM);
  });
});

describe("candleLimitFor", () => {
  it("グリッド全体を覆う本数を返す（最低 2 本）", () => {
    const g = buildGrid(JAN3_NOON - 10 * DAY, JAN3_NOON, "day");
    expect(g.success).toBe(true);
    if (!g.success) return;
    expect(candleLimitFor(g.data, JAN3_NOON)).toBeGreaterThanOrEqual(11);
    const today = buildGrid(JAN3_NOON, JAN3_NOON, "day");
    if (today.success) expect(candleLimitFor(today.data, JAN3_NOON)).toBeGreaterThanOrEqual(2);
  });
});
