import { describe, expect, it } from "vitest";
import { withdrawalHistoryAllAssets } from "../../commands/private/withdrawal-history-all-assets.js";
import { jstYearRangeMs } from "../../date-utils.js";
import { withdrawalHistoryFixture } from "../__fixtures__/private/withdrawal-history.js";
import { TEST_CREDS } from "../test-helpers.js";

// モックは実 API 準拠: 1 出金の形状は __fixtures__/private/withdrawal-history.ts に集約し、
// pairs マスタの形状は cli/__tests__/public/pairs.test.ts と同じ実 API 形状（数値は文字列）。
const BASE_WITHDRAWAL = withdrawalHistoryFixture.withdrawals[0];
const OPTS = { retries: 0, credentials: TEST_CREDS, nonce: "1" } as const;

const BASE_PAIR = {
  name: "btc_jpy",
  base_asset: "btc",
  quote_asset: "jpy",
  maker_fee_rate_base: "0",
  taker_fee_rate_base: "0",
  maker_fee_rate_quote: "0",
  taker_fee_rate_quote: "0.0012",
  unit_amount: "0.0001",
  limit_max_amount: "1000",
  market_max_amount: "100",
  price_digits: 0,
  amount_digits: 4,
  is_enabled: true,
  stop_order: false,
  stop_order_and_cancel: false,
};

function makePair(name: string, isEnabled = true) {
  const [base, quote] = name.split("_");
  return { ...BASE_PAIR, name, base_asset: base, quote_asset: quote, is_enabled: isEnabled };
}

function makeWithdrawal(asset: string, uuid: string, requestedAt: number) {
  return { ...BASE_WITHDRAWAL, asset, uuid, requested_at: requestedAt };
}

/** URL でルーティングするモック fetch: /spot/pairs → マスタ、withdrawal_history → asset ごとのページ列 */
function routedFetch(
  pairsMaster: ReturnType<typeof makePair>[],
  byAsset: Record<string, ReturnType<typeof makeWithdrawal>[][]>,
) {
  const urls: string[] = [];
  const pageIdx: Record<string, number> = {};
  const fetch: typeof globalThis.fetch = async (input) => {
    const url = typeof input === "string" ? input : input.toString();
    urls.push(url);
    if (url.includes("/spot/pairs")) {
      return new Response(JSON.stringify({ success: 1, data: { pairs: pairsMaster } }));
    }
    const asset = new URL(url).searchParams.get("asset") ?? "";
    const pages = byAsset[asset] ?? [[]];
    const i = Math.min(pageIdx[asset] ?? 0, pages.length - 1);
    pageIdx[asset] = i + 1;
    return new Response(JSON.stringify({ success: 1, data: { withdrawals: pages[i] } }));
  };
  return { fetch, urls };
}

describe("withdrawalHistoryAllAssets", () => {
  it("fetches every asset in the master's base/quote set (incl. delisted) and merges sorted by requested_at", async () => {
    // matic_jpy は is_enabled: false（delist 済み）だが履歴が残存し得るため対象に含む（実機 #4 と同じ判断）
    const master = [makePair("btc_jpy"), makePair("eth_jpy"), makePair("matic_jpy", false)];
    const { fetch, urls } = routedFetch(master, {
      btc: [[makeWithdrawal("btc", "a", 3000)]],
      eth: [[makeWithdrawal("eth", "b", 1000)]],
      matic: [[makeWithdrawal("matic", "c", 2000)]],
      jpy: [[]],
    });
    const result = await withdrawalHistoryAllAssets({}, { fetch, ...OPTS });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.map((w) => w.requested_at)).toEqual([1000, 2000, 3000]);
      expect(result.data.map((w) => w.asset)).toEqual(["eth", "matic", "btc"]);
    }
    expect(urls[0]).toContain("/spot/pairs");
    expect(urls.some((u) => u.includes("asset=matic"))).toBe(true);
    expect(urls.some((u) => u.includes("asset=jpy"))).toBe(true);
  });

  it("returns an empty list when no asset has history", async () => {
    const { fetch } = routedFetch([makePair("btc_jpy"), makePair("eth_jpy")], {});
    const result = await withdrawalHistoryAllAssets({}, { fetch, ...OPTS });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual([]);
  });

  it("paginates within each asset", async () => {
    const page1 = Array.from({ length: 1000 }, (_, i) => makeWithdrawal("btc", `p${i}`, 1000 + i));
    const page2 = [makeWithdrawal("btc", "p1000", 5000)];
    const { fetch } = routedFetch([makePair("btc_jpy"), makePair("eth_jpy")], {
      btc: [page1, page2],
      eth: [[makeWithdrawal("eth", "e1", 100)]],
      jpy: [[]],
    });
    const result = await withdrawalHistoryAllAssets({}, { fetch, ...OPTS });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toHaveLength(1002);
  });

  it("--year sets the JST range query on every asset and filters strictly", async () => {
    const { startMs, endMs } = jstYearRangeMs(2026);
    const { fetch, urls } = routedFetch([makePair("btc_jpy")], {
      btc: [
        [
          makeWithdrawal("btc", "in", startMs + 1000),
          makeWithdrawal("btc", "before", startMs - 1000), // JST 2025 に属する
        ],
      ],
      jpy: [[]],
    });
    const result = await withdrawalHistoryAllAssets({ year: "2026" }, { fetch, ...OPTS });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.map((w) => w.uuid)).toEqual(["in"]);
    // 全 asset のリクエストに年範囲が伝播すること（後続 asset の since/end 欠落は
    // 厳密フィルタで結果が同じになり検出できないため、URL 側で検証する）
    const withdrawalUrls = urls.filter((u) => u.includes("withdrawal_history"));
    expect(withdrawalUrls.length).toBeGreaterThanOrEqual(2); // btc + jpy
    for (const u of withdrawalUrls) {
      expect(u).toContain(`since=${startMs}`);
      expect(u).toContain(`end=${endMs}`);
    }
  });

  it("rejects --year combined with --since/--end before any fetch", async () => {
    const { fetch, urls } = routedFetch([makePair("btc_jpy")], {});
    const result = await withdrawalHistoryAllAssets(
      { year: "2026", since: "1000" },
      { fetch, ...OPTS },
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("--year");
      expect(result.exitCode).toBe(4);
    }
    expect(urls).toHaveLength(0);
  });

  it.each(["26", "0099", "abcd"])("rejects a malformed --year=%s", async (year) => {
    const { fetch, urls } = routedFetch([makePair("btc_jpy")], {});
    const result = await withdrawalHistoryAllAssets({ year }, { fetch, ...OPTS });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.exitCode).toBe(4);
    expect(urls).toHaveLength(0);
  });

  it("rejects an invalid --max-pages before any fetch", async () => {
    const { fetch, urls } = routedFetch([makePair("btc_jpy")], {});
    const result = await withdrawalHistoryAllAssets({ maxPages: "abc" }, { fetch, ...OPTS });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("max-pages");
      expect(result.exitCode).toBe(4);
    }
    expect(urls).toHaveLength(0);
  });

  it("marks partial with truncatedAssets when an asset hits --max-pages", async () => {
    const page1 = Array.from({ length: 1000 }, (_, i) => makeWithdrawal("btc", `p${i}`, 1000 + i));
    const page2 = Array.from(
      { length: 1000 },
      (_, i) => makeWithdrawal("btc", `q${i}`, 3000 + i), // 2 ページとも満杯 → maxPages=2 で打ち切り
    );
    const { fetch } = routedFetch([makePair("btc_jpy"), makePair("eth_jpy")], {
      btc: [page1, page2],
      eth: [[makeWithdrawal("eth", "e1", 100)]],
      jpy: [[]],
    });
    const result = await withdrawalHistoryAllAssets({ maxPages: "2" }, { fetch, ...OPTS });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toHaveLength(2001);
      expect(result.partial).toBe(true);
      expect(result.meta?.truncated).toBe(true);
      expect(result.meta?.reason).toBe("MAX_PAGES");
      expect(result.meta?.truncatedAssets).toEqual(["btc"]);
      expect(result.meta?.returnedRows).toBe(2001);
    }
  });

  it("propagates a per-asset fetch error with the asset name", async () => {
    const fetch: typeof globalThis.fetch = async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/spot/pairs")) {
        return new Response(
          JSON.stringify({
            success: 1,
            data: { pairs: [makePair("btc_jpy"), makePair("eth_jpy")] },
          }),
        );
      }
      const asset = new URL(url).searchParams.get("asset");
      if (asset === "eth")
        return new Response(JSON.stringify({ success: 0, data: { code: 20001 } }));
      return new Response(JSON.stringify({ success: 1, data: { withdrawals: [] } }));
    };
    const result = await withdrawalHistoryAllAssets({}, { fetch, ...OPTS });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/^eth: /);
  });

  it("propagates a pairs-master fetch failure", async () => {
    const fetch: typeof globalThis.fetch = async () =>
      new Response(JSON.stringify({ success: 0, data: { code: 70001 } }));
    const result = await withdrawalHistoryAllAssets({}, { fetch, ...OPTS });
    expect(result.success).toBe(false);
  });

  it("uses an explicit assets list without fetching the master", async () => {
    const { fetch, urls } = routedFetch([], {
      btc: [[makeWithdrawal("btc", "a", 1000)]],
    });
    const result = await withdrawalHistoryAllAssets({ assets: ["btc"] }, { fetch, ...OPTS });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toHaveLength(1);
    expect(urls.some((u) => u.includes("/spot/pairs"))).toBe(false);
  });
});
