import { describe, expect, it } from "vitest";
import { tradeHistoryAllPairs } from "../../commands/private/trade-history-all-pairs.js";
import { jstYearRangeMs } from "../../date-utils.js";
import { tradeHistoryFixture } from "../__fixtures__/private/trade-history.js";
import { TEST_CREDS } from "../test-helpers.js";

// モックは実 API 準拠: 1 約定の形状は __fixtures__/private/trade-history.ts に集約し、
// pair / trade_id / executed_at だけ差し替える。pairs マスタの形状は
// cli/__tests__/public/pairs.test.ts と同じ実 API 形状（数値は文字列）。
const BASE_TRADE = tradeHistoryFixture.trades[0];
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
  return { ...BASE_PAIR, name, is_enabled: isEnabled };
}

function makeTrade(pair: string, id: number, executedAt: number) {
  return { ...BASE_TRADE, pair, trade_id: id, order_id: id, executed_at: executedAt };
}

/** URL でルーティングするモック fetch: /spot/pairs → マスタ、trade_history → pair ごとのページ列 */
function routedFetch(
  pairsMaster: ReturnType<typeof makePair>[],
  byPair: Record<string, ReturnType<typeof makeTrade>[][]>,
) {
  const urls: string[] = [];
  const pageIdx: Record<string, number> = {};
  const fetch: typeof globalThis.fetch = async (input) => {
    const url = typeof input === "string" ? input : input.toString();
    urls.push(url);
    if (url.includes("/spot/pairs")) {
      return new Response(JSON.stringify({ success: 1, data: { pairs: pairsMaster } }));
    }
    const pair = new URL(url).searchParams.get("pair") ?? "";
    const pages = byPair[pair] ?? [[]];
    const i = Math.min(pageIdx[pair] ?? 0, pages.length - 1);
    pageIdx[pair] = i + 1;
    return new Response(JSON.stringify({ success: 1, data: { trades: pages[i] } }));
  };
  return { fetch, urls };
}

describe("tradeHistoryAllPairs", () => {
  it("fetches every pair in the master (incl. delisted) and merges sorted by executed_at", async () => {
    // matic_jpy は is_enabled: false（delist 済み）だが履歴が残存し得るため対象に含む（実機 #4）
    const master = [makePair("btc_jpy"), makePair("eth_jpy"), makePair("matic_jpy", false)];
    const { fetch, urls } = routedFetch(master, {
      btc_jpy: [[makeTrade("btc_jpy", 1, 3000)]],
      eth_jpy: [[makeTrade("eth_jpy", 2, 1000)]],
      matic_jpy: [[makeTrade("matic_jpy", 3, 2000)]],
    });
    const result = await tradeHistoryAllPairs({}, { fetch, ...OPTS });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.map((t) => t.executed_at)).toEqual([1000, 2000, 3000]);
      expect(result.data.map((t) => t.pair)).toEqual(["eth_jpy", "matic_jpy", "btc_jpy"]);
    }
    expect(urls[0]).toContain("/spot/pairs");
    expect(urls.some((u) => u.includes("pair=matic_jpy"))).toBe(true);
  });

  it("returns an empty list when no pair has history", async () => {
    const { fetch } = routedFetch([makePair("btc_jpy"), makePair("eth_jpy")], {});
    const result = await tradeHistoryAllPairs({}, { fetch, ...OPTS });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual([]);
  });

  it("keeps trades sharing a trade_id across pairs (composite dedup key)", async () => {
    // trade_id の pair 横断一意性は未確認 → pair:trade_id の複合キーで誤 dedup を防ぐ
    const { fetch } = routedFetch([makePair("btc_jpy"), makePair("eth_jpy")], {
      btc_jpy: [[makeTrade("btc_jpy", 1, 1000)]],
      eth_jpy: [[makeTrade("eth_jpy", 1, 2000)]],
    });
    const result = await tradeHistoryAllPairs({}, { fetch, ...OPTS });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toHaveLength(2);
  });

  it("paginates within each pair", async () => {
    const page1 = Array.from({ length: 1000 }, (_, i) => makeTrade("btc_jpy", i + 1, 1000 + i));
    const page2 = [makeTrade("btc_jpy", 1001, 5000)];
    const { fetch } = routedFetch([makePair("btc_jpy"), makePair("eth_jpy")], {
      btc_jpy: [page1, page2],
      eth_jpy: [[makeTrade("eth_jpy", 9001, 100)]],
    });
    const result = await tradeHistoryAllPairs({}, { fetch, ...OPTS });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toHaveLength(1002);
  });

  it("--year sets the JST range query on every pair and filters strictly", async () => {
    const { startMs, endMs } = jstYearRangeMs(2026);
    const { fetch, urls } = routedFetch([makePair("btc_jpy")], {
      btc_jpy: [
        [
          makeTrade("btc_jpy", 1, startMs + 1000),
          makeTrade("btc_jpy", 2, startMs - 1000), // JST 2025 に属する
        ],
      ],
    });
    const result = await tradeHistoryAllPairs({ year: "2026" }, { fetch, ...OPTS });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.map((t) => t.trade_id)).toEqual([1]);
    const tradeUrl = urls.find((u) => u.includes("trade_history"));
    expect(tradeUrl).toContain(`since=${startMs}`);
    expect(tradeUrl).toContain(`end=${endMs}`);
  });

  it("rejects --year combined with --since/--end before any fetch", async () => {
    const { fetch, urls } = routedFetch([makePair("btc_jpy")], {});
    const result = await tradeHistoryAllPairs({ year: "2026", since: "1000" }, { fetch, ...OPTS });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("--year");
      expect(result.exitCode).toBe(4);
    }
    expect(urls).toHaveLength(0);
  });

  // "0099" は Date.UTC の 0〜99 年→1900 年代補正で範囲とフィルタが食い違うため形式で拒否
  it.each(["26", "0099", "abcd"])("rejects a malformed --year=%s", async (year) => {
    const { fetch, urls } = routedFetch([makePair("btc_jpy")], {});
    const result = await tradeHistoryAllPairs({ year }, { fetch, ...OPTS });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.exitCode).toBe(4);
    expect(urls).toHaveLength(0);
  });

  it("rejects an invalid --max-pages before any fetch", async () => {
    const { fetch, urls } = routedFetch([makePair("btc_jpy")], {});
    const result = await tradeHistoryAllPairs({ maxPages: "abc" }, { fetch, ...OPTS });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("max-pages");
      expect(result.exitCode).toBe(4);
    }
    expect(urls).toHaveLength(0);
  });

  it("marks partial with truncatedPairs when a pair hits --max-pages", async () => {
    const page1 = Array.from({ length: 1000 }, (_, i) => makeTrade("btc_jpy", i + 1, 1000 + i));
    const page2 = Array.from({ length: 1000 }, (_, i) => makeTrade("btc_jpy", 1001 + i, 3000 + i));
    const { fetch } = routedFetch([makePair("btc_jpy"), makePair("eth_jpy")], {
      btc_jpy: [page1, page2], // 2 ページとも満杯 → maxPages=2 で打ち切り
      eth_jpy: [[makeTrade("eth_jpy", 9001, 100)]],
    });
    const result = await tradeHistoryAllPairs({ maxPages: "2" }, { fetch, ...OPTS });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toHaveLength(2001);
      expect(result.partial).toBe(true);
      expect(result.meta?.truncated).toBe(true);
      expect(result.meta?.reason).toBe("MAX_PAGES");
      expect(result.meta?.truncatedPairs).toEqual(["btc_jpy"]);
      expect(result.meta?.returnedRows).toBe(2001);
    }
  });

  it("propagates a per-pair fetch error with the pair name", async () => {
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
      const pair = new URL(url).searchParams.get("pair");
      if (pair === "eth_jpy")
        return new Response(JSON.stringify({ success: 0, data: { code: 20001 } }));
      return new Response(JSON.stringify({ success: 1, data: { trades: [] } }));
    };
    const result = await tradeHistoryAllPairs({}, { fetch, ...OPTS });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/^eth_jpy: /);
  });

  it("propagates a pairs-master fetch failure", async () => {
    const fetch: typeof globalThis.fetch = async () =>
      new Response(JSON.stringify({ success: 0, data: { code: 70001 } }));
    const result = await tradeHistoryAllPairs({}, { fetch, ...OPTS });
    expect(result.success).toBe(false);
  });

  it("uses an explicit pairs list without fetching the master", async () => {
    const { fetch, urls } = routedFetch([], {
      btc_jpy: [[makeTrade("btc_jpy", 1, 1000)]],
    });
    const result = await tradeHistoryAllPairs({ pairs: ["btc_jpy"] }, { fetch, ...OPTS });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toHaveLength(1);
    expect(urls.some((u) => u.includes("/spot/pairs"))).toBe(false);
  });
});
