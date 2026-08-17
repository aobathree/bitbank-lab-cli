import { describe, expect, it } from "vitest";
import { tradeHistoryDispatch } from "../../commands/private/trade-history-dispatch.js";
import { jstYearRangeMs } from "../../date-utils.js";
import { tradeHistoryFixture } from "../__fixtures__/private/trade-history.js";
import { TEST_CREDS } from "../test-helpers.js";

// モックは実 API 準拠: 1 約定の形状は __fixtures__/private/trade-history.ts に集約。
const BASE_TRADE = tradeHistoryFixture.trades[0];
const OPTS = { retries: 0, credentials: TEST_CREDS, nonce: "1" } as const;

function makeTrade(id: number, executedAt: number, pair = "btc_jpy") {
  return { ...BASE_TRADE, pair, trade_id: id, order_id: id, executed_at: executedAt };
}

/** trade ページ列を返すモック fetch。/spot/pairs はマスタを返す（URL も記録）。 */
function pagedFetch(pages: ReturnType<typeof makeTrade>[][], pairNames: string[] = ["btc_jpy"]) {
  let call = 0;
  const urls: string[] = [];
  const fetch: typeof globalThis.fetch = async (input) => {
    const url = typeof input === "string" ? input : input.toString();
    urls.push(url);
    if (url.includes("/spot/pairs")) {
      // pairs マスタの形状は cli/__tests__/public/pairs.test.ts と同じ実 API 形状
      const pairs = pairNames.map((name) => ({
        name,
        base_asset: name.split("_")[0],
        quote_asset: name.split("_")[1],
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
      }));
      return new Response(JSON.stringify({ success: 1, data: { pairs } }));
    }
    const trades = pages[Math.min(call, pages.length - 1)];
    call++;
    return new Response(JSON.stringify({ success: 1, data: { trades } }));
  };
  return { fetch, urls, calls: () => call };
}

describe("tradeHistoryDispatch", () => {
  it("delegates to tradeHistoryAll (paginates) when --all is set", async () => {
    const page1 = Array.from({ length: 1000 }, (_, i) => makeTrade(i + 1, 1000 + i));
    const page2 = Array.from({ length: 500 }, (_, i) => makeTrade(1001 + i, 2000 + i));
    const { fetch, calls } = pagedFetch([page1, page2]);
    const result = await tradeHistoryDispatch({ pair: "btc_jpy", all: true }, { fetch, ...OPTS });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toHaveLength(1500);
    expect(calls()).toBe(2);
  });

  it("propagates errors from tradeHistoryAll", async () => {
    const result = await tradeHistoryDispatch({ pair: undefined, all: true });
    expect(result.success).toBe(false);
  });

  it("delegates to single-page tradeHistory (no pagination) when --all is not set", async () => {
    const page = Array.from({ length: 1000 }, (_, i) => makeTrade(i + 1, 1000 + i));
    const { fetch, calls } = pagedFetch([page]);
    const result = await tradeHistoryDispatch({ pair: "btc_jpy", all: false }, { fetch, ...OPTS });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toHaveLength(1000);
    expect(calls()).toBe(1);
  });

  it("--all-pairs fetches the pairs master and spans every pair", async () => {
    const { fetch, urls } = pagedFetch([[makeTrade(1, 1000)]], ["btc_jpy", "eth_jpy"]);
    const result = await tradeHistoryDispatch(
      { pair: undefined, allPairs: true },
      { fetch, ...OPTS },
    );
    expect(result.success).toBe(true);
    expect(urls[0]).toContain("/spot/pairs");
    expect(urls.some((u) => u.includes("pair=btc_jpy"))).toBe(true);
    expect(urls.some((u) => u.includes("pair=eth_jpy"))).toBe(true);
  });

  it("rejects --all-pairs combined with --pair", async () => {
    const { fetch, urls } = pagedFetch([[]]);
    const result = await tradeHistoryDispatch(
      { pair: "btc_jpy", allPairs: true },
      { fetch, ...OPTS },
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("--all-pairs");
      expect(result.exitCode).toBe(4);
    }
    expect(urls).toHaveLength(0);
  });

  it("--year with --pair fetches that pair's JST year without the pairs master", async () => {
    const { startMs } = jstYearRangeMs(2026);
    const inYear = makeTrade(1, startMs + 1000);
    const before = makeTrade(2, startMs - 1000); // JST 2025 に属する
    const { fetch, urls } = pagedFetch([[inYear, before]]);
    const result = await tradeHistoryDispatch(
      { pair: "btc_jpy", year: "2026" },
      { fetch, ...OPTS },
    );
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.map((t) => t.trade_id)).toEqual([1]);
    expect(urls.some((u) => u.includes("/spot/pairs"))).toBe(false);
    expect(urls[0]).toContain(`since=${startMs}`);
  });

  it("--year without --pair (and without --all-pairs) requires a pair", async () => {
    const { fetch, urls } = pagedFetch([[]]);
    const result = await tradeHistoryDispatch(
      { pair: undefined, year: "2026" },
      { fetch, ...OPTS },
    );
    expect(result.success).toBe(false);
    if (!result.success) expect(result.exitCode).toBe(4);
    expect(urls).toHaveLength(0);
  });

  it("--all-pairs with --year applies the year window across pairs", async () => {
    const { startMs } = jstYearRangeMs(2026);
    const { fetch, urls } = pagedFetch(
      [[makeTrade(1, startMs + 1000), makeTrade(2, startMs - 1000)]],
      ["btc_jpy"],
    );
    const result = await tradeHistoryDispatch(
      { pair: undefined, allPairs: true, year: "2026" },
      { fetch, ...OPTS },
    );
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.map((t) => t.trade_id)).toEqual([1]);
    expect(urls[0]).toContain("/spot/pairs");
  });
});
