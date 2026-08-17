import { describe, expect, it } from "vitest";
import { withdrawalHistoryDispatch } from "../../commands/private/withdrawal-history-dispatch.js";
import { jstYearRangeMs } from "../../date-utils.js";
import { withdrawalHistoryFixture } from "../__fixtures__/private/withdrawal-history.js";
import { mockFetchDataCapture, TEST_CREDS } from "../test-helpers.js";

// モックは実 API 準拠: 1 出金の形状は __fixtures__/private/withdrawal-history.ts に集約。
const BASE_WITHDRAWAL = withdrawalHistoryFixture.withdrawals[0];
const OPTS = { retries: 0, credentials: TEST_CREDS, nonce: "1" } as const;

const BASE_PAIR = {
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

function makeWithdrawal(uuid: string, requestedAt: number, asset = "xrp") {
  return { ...BASE_WITHDRAWAL, asset, uuid, requested_at: requestedAt };
}

// 単一 asset 経路（--all / --year+--asset / 素通し）用: /spot/pairs を叩かない前提の
// 単純な呼び出し回数ベースのページ列モック
function pagedFetch(pages: ReturnType<typeof makeWithdrawal>[][]) {
  let call = 0;
  const urls: string[] = [];
  const fetch: typeof globalThis.fetch = async (input) => {
    urls.push(typeof input === "string" ? input : input.toString());
    const withdrawals = pages[Math.min(call, pages.length - 1)];
    call++;
    return new Response(JSON.stringify({ success: 1, data: { withdrawals } }));
  };
  return { fetch, urls, calls: () => call };
}

// --all-assets 経路用: base 資産ごとに quote=jpy のペアを 1 本作り、asset クエリで
// ルーティングする（1 ペアが base + quote=jpy の 2 asset を生むため呼び出し回数ベースでは
// asset 間でデータが混線する。withdrawal-history-all-assets.test.ts の routedFetch と同型）。
function routedFetch(
  baseAssets: string[],
  byAsset: Record<string, ReturnType<typeof makeWithdrawal>[][]>,
) {
  const urls: string[] = [];
  const pageIdx: Record<string, number> = {};
  const fetch: typeof globalThis.fetch = async (input) => {
    const url = typeof input === "string" ? input : input.toString();
    urls.push(url);
    if (url.includes("/spot/pairs")) {
      const pairs = baseAssets.map((base) => ({
        ...BASE_PAIR,
        name: `${base}_jpy`,
        base_asset: base,
        quote_asset: "jpy",
      }));
      return new Response(JSON.stringify({ success: 1, data: { pairs } }));
    }
    const asset = new URL(url).searchParams.get("asset") ?? "";
    const pages = byAsset[asset] ?? [[]];
    const i = Math.min(pageIdx[asset] ?? 0, pages.length - 1);
    pageIdx[asset] = i + 1;
    return new Response(JSON.stringify({ success: 1, data: { withdrawals: pages[i] } }));
  };
  return { fetch, urls };
}

describe("withdrawalHistoryDispatch", () => {
  it("delegates to withdrawalHistoryAll (paginates) when --all is set", async () => {
    const page1 = Array.from({ length: 1000 }, (_, i) => makeWithdrawal(`a-${i}`, 5000 + i));
    const page2 = Array.from({ length: 10 }, (_, i) => makeWithdrawal(`b-${i}`, 100 + i));
    const { fetch, calls } = pagedFetch([page1, page2]);
    const result = await withdrawalHistoryDispatch({ asset: "xrp", all: true }, { fetch, ...OPTS });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toHaveLength(1010);
    expect(calls()).toBe(2);
  });

  it("propagates a downstream API error from withdrawalHistoryAll", async () => {
    // asset は有効値にして、パラメータ検証ではなく API エラーの伝播を検証する
    const fetch: typeof globalThis.fetch = async () =>
      new Response(JSON.stringify({ success: 0, data: { code: 20001 } }));
    const result = await withdrawalHistoryDispatch({ asset: "xrp", all: true }, { fetch, ...OPTS });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain("20001");
  });

  it("rejects a missing asset before any fetch", async () => {
    const { fetch, urls } = pagedFetch([[]]);
    const result = await withdrawalHistoryDispatch(
      { asset: undefined, all: true },
      { fetch, ...OPTS },
    );
    expect(result.success).toBe(false);
    expect(urls).toHaveLength(0);
  });

  it("delegates to single-page withdrawalHistory (no pagination) when --all is not set", async () => {
    const page = Array.from({ length: 1000 }, (_, i) => makeWithdrawal(`a-${i}`, 1000 + i));
    const { fetch, calls } = pagedFetch([page]);
    const result = await withdrawalHistoryDispatch(
      { asset: "xrp", all: false },
      { fetch, ...OPTS },
    );
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toHaveLength(1000);
    expect(calls()).toBe(1);
  });

  it("delegates to single-page fetch (real fixture shape) when neither --all nor --year", async () => {
    const cap = mockFetchDataCapture(withdrawalHistoryFixture);
    const result = await withdrawalHistoryDispatch(
      { asset: "xrp", all: false },
      { fetch: cap.fetch, ...OPTS },
    );
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toHaveLength(2);
    expect(cap.urls).toHaveLength(1);
  });

  it("--all-assets fetches the pairs master and spans every asset", async () => {
    const { fetch, urls } = routedFetch(["xrp", "btc"], {
      xrp: [[makeWithdrawal("a", 1000, "xrp")]],
      btc: [[makeWithdrawal("b", 2000, "btc")]],
      jpy: [[]],
    });
    const result = await withdrawalHistoryDispatch(
      { asset: undefined, allAssets: true },
      { fetch, ...OPTS },
    );
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toHaveLength(2);
    expect(urls[0]).toContain("/spot/pairs");
    expect(urls.some((u) => u.includes("asset=xrp"))).toBe(true);
    expect(urls.some((u) => u.includes("asset=btc"))).toBe(true);
    expect(urls.some((u) => u.includes("asset=jpy"))).toBe(true);
  });

  // "" は --asset= の明示指定。truthy 判定だと未指定扱いで全走査が始まるため回帰テスト
  it.each(["xrp", ""])('rejects --all-assets combined with --asset="%s"', async (asset) => {
    const { fetch, urls } = pagedFetch([[]]);
    const result = await withdrawalHistoryDispatch({ asset, allAssets: true }, { fetch, ...OPTS });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("--all-assets");
      expect(result.exitCode).toBe(4);
    }
    expect(urls).toHaveLength(0);
  });

  it("--year with --asset fetches that asset's JST year without the pairs master", async () => {
    const { startMs } = jstYearRangeMs(2026);
    const inYear = makeWithdrawal("in", startMs + 1000);
    const before = makeWithdrawal("before", startMs - 1000); // JST 2025 に属する
    const { fetch, urls } = pagedFetch([[inYear, before]]);
    const result = await withdrawalHistoryDispatch(
      { asset: "xrp", year: "2026" },
      { fetch, ...OPTS },
    );
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.map((w) => w.uuid)).toEqual(["in"]);
    expect(urls.some((u) => u.includes("/spot/pairs"))).toBe(false);
    expect(urls[0]).toContain(`since=${startMs}`);
  });

  it("--year without --asset (and without --all-assets) requires an asset", async () => {
    const { fetch, urls } = pagedFetch([[]]);
    const result = await withdrawalHistoryDispatch(
      { asset: undefined, year: "2026" },
      { fetch, ...OPTS },
    );
    expect(result.success).toBe(false);
    if (!result.success) expect(result.exitCode).toBe(4);
    expect(urls).toHaveLength(0);
  });

  it("--all-assets with --year applies the year window across assets", async () => {
    const { startMs, endMs } = jstYearRangeMs(2026);
    const { fetch, urls } = routedFetch(["xrp"], {
      xrp: [[makeWithdrawal("in", startMs + 1000), makeWithdrawal("before", startMs - 1000)]],
      jpy: [[]],
    });
    const result = await withdrawalHistoryDispatch(
      { asset: undefined, allAssets: true, year: "2026" },
      { fetch, ...OPTS },
    );
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.map((w) => w.uuid)).toEqual(["in"]);
    expect(urls[0]).toContain("/spot/pairs");
    // 年範囲が全 asset のリクエストへ伝播すること（all-assets テストと同じ URL 検証）
    const withdrawalUrls = urls.filter((u) => u.includes("withdrawal_history"));
    expect(withdrawalUrls.length).toBeGreaterThanOrEqual(2); // xrp + jpy
    for (const u of withdrawalUrls) {
      expect(u).toContain(`since=${startMs}`);
      expect(u).toContain(`end=${endMs}`);
    }
  });
});
