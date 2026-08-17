// 100行超: 価格解決の分岐（足あり / 足なし / 一部欠落 / JPY のみ）と、そこから決まる
// 価格品質の 4 段階を 1 ケース 1 事実で固定するため。分岐を間引くと、どの経路で
// フォールバックへ落ちたかが検証されなくなる。
import { describe, expect, it } from "vitest";
import { currentPoint, priceQuality } from "../../portfolio/assemble.js";
import { buildEquitySeries } from "../../portfolio/equity.js";
import { NO_TRANSFERS, PAIR_ASSETS, trade } from "./factories.js";

const DAY1 = Date.UTC(2026, 0, 1);
const DAY2 = Date.UTC(2026, 0, 2);
const HOLDINGS = [{ asset: "btc", amount: 2 }];
const CURRENT_PRICES = new Map([["btc", 15_000_000]]);

function series(dailyOpens: Map<string, Map<string, number>>) {
  return buildEquitySeries({
    grid: [DAY1, DAY2],
    current: HOLDINGS,
    trades: [],
    transfers: NO_TRANSFERS,
    dailyOpens,
    currentPrices: CURRENT_PRICES,
    pairAssets: PAIR_ASSETS,
  });
}

describe("buildEquitySeries", () => {
  it("その日の 1day 足 open で評価する", () => {
    const opens = new Map([
      [
        "btc",
        new Map([
          ["20260101", 10_000_000],
          ["20260102", 12_000_000],
        ]),
      ],
    ]);
    const { points, fallbackAssets } = series(opens);
    expect(points.map((p) => p.value_jpy)).toEqual([20_000_000, 24_000_000]);
    expect(points.map((p) => p.date)).toEqual(["2026-01-01", "2026-01-02"]);
    expect(fallbackAssets).toEqual([]);
  });

  it("candle が取れない資産は現在価格へフォールバックし、最終点とスケールが揃う", () => {
    // フォールバックしないとこの資産だけ 0 円で積まれ、過去の点だけが沈む
    const { points, fallbackAssets } = series(new Map());
    const current = currentPoint(new Map([["btc", 2]]), CURRENT_PRICES, DAY2 + 3_600_000);
    expect(points.every((p) => p.value_jpy === current.value_jpy)).toBe(true);
    expect(current.value_jpy).toBe(30_000_000);
    expect(fallbackAssets).toEqual(["btc"]);
  });

  it("一部の日付だけ candle が欠けても、その日だけ現在価格で埋める", () => {
    const opens = new Map([["btc", new Map([["20260101", 10_000_000]])]]);
    const { points, fallbackAssets } = series(opens);
    expect(points.map((p) => p.value_jpy)).toEqual([20_000_000, 30_000_000]);
    expect(fallbackAssets).toEqual(["btc"]);
  });

  it("各時点で保有を復元してから評価する（約定を挟むと点ごとに数量が変わる）", () => {
    // DAY2 に 1 BTC 買い増し → DAY1 時点の保有は 1 BTC
    const { points } = buildEquitySeries({
      grid: [DAY1, DAY2],
      current: HOLDINGS,
      trades: [trade({ side: "buy", amount: 1, price: 12_000_000, executed_at: DAY2 })],
      transfers: NO_TRANSFERS,
      dailyOpens: new Map([
        [
          "btc",
          new Map([
            ["20260101", 10_000_000],
            ["20260102", 12_000_000],
          ]),
        ],
      ]),
      currentPrices: CURRENT_PRICES,
      pairAssets: PAIR_ASSETS,
    });
    // 巻き戻しで BTC は 2 → 1、支払った 12,000,000 JPY が戻る
    expect(points[0].value_jpy).toBe(1 * 10_000_000 + 12_000_000);
    // DAY2 00:00 の点も約定（同時刻以降）を巻き戻した後の状態
    expect(points[1].value_jpy).toBe(1 * 12_000_000 + 12_000_000);
  });

  it("JPY のみ保有ならフォールバックは発生しない", () => {
    const { points, fallbackAssets } = buildEquitySeries({
      grid: [DAY1],
      current: [{ asset: "jpy", amount: 500_000 }],
      trades: [],
      transfers: NO_TRANSFERS,
      dailyOpens: new Map(),
      currentPrices: CURRENT_PRICES,
      pairAssets: PAIR_ASSETS,
    });
    expect(points[0].value_jpy).toBe(500_000);
    expect(fallbackAssets).toEqual([]);
  });
});

describe("priceQuality", () => {
  it("保有暗号資産のフォールバック比率で level を決める", () => {
    expect(priceQuality([], [])).toEqual({ level: "jpy_only", fallback_assets: [] });
    expect(priceQuality(["btc"], [])).toEqual({ level: "complete", fallback_assets: [] });
    expect(priceQuality(["btc", "eth"], ["eth"])).toEqual({
      level: "partial_fallback",
      fallback_assets: ["eth"],
    });
    expect(priceQuality(["btc"], ["btc"])).toEqual({
      level: "fallback_only",
      fallback_assets: ["btc"],
    });
  });

  it("現在は保有していない（期間中に手放した）資産は level 判定に混ぜない", () => {
    expect(priceQuality(["btc"], ["btc", "sold"])).toEqual({
      level: "fallback_only",
      fallback_assets: ["btc"],
    });
  });
});
