import { describe, expect, it } from "vitest";
import { withdrawalHistoryAll } from "../../commands/private/withdrawal-history-all.js";
import { jstYearRangeMs } from "../../date-utils.js";
import { withdrawalHistoryFixture } from "../__fixtures__/private/withdrawal-history.js";
import { TEST_CREDS } from "../test-helpers.js";

// モックは実 API 準拠: 1 出金の形状は __fixtures__/private/withdrawal-history.ts に集約し、
// ページング検証用に uuid / requested_at だけ差し替える（deposit-history-all.test.ts のミラー）。
const BASE = withdrawalHistoryFixture.withdrawals[0];
const OPTS = { retries: 0, credentials: TEST_CREDS, nonce: "1" } as const;

function makeWithdrawal(uuid: string, requestedAt: number) {
  return { ...BASE, uuid, requested_at: requestedAt };
}

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

describe("withdrawalHistoryAll", () => {
  it("rejects missing asset before any fetch (asset is required)", async () => {
    const { fetch, calls } = pagedFetch([[]]);
    const result = await withdrawalHistoryAll({ asset: undefined }, { fetch, ...OPTS });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.exitCode).toBe(4);
    expect(calls()).toBe(0);
  });

  it("fetches a single page when fewer than PAGE_SIZE", async () => {
    const withdrawals = [makeWithdrawal("a", 1000), makeWithdrawal("b", 1001)];
    const { fetch } = pagedFetch([withdrawals]);
    const result = await withdrawalHistoryAll({ asset: "xrp" }, { fetch, ...OPTS });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toHaveLength(2);
  });

  it("paginates backward via end and returns chronological order", async () => {
    const page1 = Array.from({ length: 1000 }, (_, i) => makeWithdrawal(`p1-${i}`, 5000 + i));
    const page2 = Array.from({ length: 300 }, (_, i) => makeWithdrawal(`p2-${i}`, 1000 + i));
    const { fetch, urls } = pagedFetch([page1, page2]);
    const result = await withdrawalHistoryAll({ asset: "xrp" }, { fetch, ...OPTS });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toHaveLength(1300);
      // 昇順（時系列）にソートされている
      expect(result.data[0].requested_at).toBe(1000);
      expect(result.data.at(-1)?.requested_at).toBe(5999);
    }
    // 2 ページ目は 1 ページ目最古(5000)より前へ end を進める
    expect(urls[1]).toContain("end=5000");
  });

  it("deduplicates by uuid at page boundaries", async () => {
    const page1 = Array.from({ length: 1000 }, (_, i) => makeWithdrawal(`d-${i}`, 5000 + i));
    const page2 = [page1[0], makeWithdrawal("new", 100)]; // 先頭が重複
    const { fetch } = pagedFetch([page1, page2]);
    const result = await withdrawalHistoryAll({ asset: "xrp" }, { fetch, ...OPTS });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toHaveLength(1001);
  });

  it("stops at --max-pages and returns partial + truncated meta", async () => {
    let call = 0;
    const fetch: typeof globalThis.fetch = async () => {
      const base = call * 1000;
      const withdrawals = Array.from({ length: 1000 }, (_, i) =>
        makeWithdrawal(`m-${base + i}`, base + i),
      );
      call++;
      return new Response(JSON.stringify({ success: 1, data: { withdrawals } }));
    };
    const result = await withdrawalHistoryAll({ asset: "xrp", maxPages: "3" }, { fetch, ...OPTS });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toHaveLength(3000);
      expect(result.partial).toBe(true);
      expect(result.meta?.truncated).toBe(true);
      expect(result.meta?.reason).toBe("MAX_PAGES");
    }
    expect(call).toBe(3);
  });

  it("dedup-stop takes precedence over --max-pages", async () => {
    const page1 = Array.from({ length: 1000 }, (_, i) => makeWithdrawal(`x-${i}`, 5000 + i));
    const { fetch } = pagedFetch([page1, [...page1]]); // 2 ページ目は全て重複
    const result = await withdrawalHistoryAll({ asset: "xrp", maxPages: "10" }, { fetch, ...OPTS });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toHaveLength(1000);
      expect(result.partial).toBeUndefined();
    }
  });

  it.each(["0", "-1", "1.5", "abc"])("rejects --max-pages=%s with PARAM exit code", async (mp) => {
    const result = await withdrawalHistoryAll({ asset: "xrp", maxPages: mp });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("max-pages");
      expect(result.exitCode).toBe(4);
    }
  });

  it("rejects --max-pages that overflows safe integer", async () => {
    const result = await withdrawalHistoryAll({ asset: "xrp", maxPages: "9".repeat(400) });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain("safe integer");
  });

  it("--year sets the JST range query and filters to the exact JST year", async () => {
    const { startMs, endMs } = jstYearRangeMs(2026);
    const inYear = makeWithdrawal("in", startMs + 1000);
    const before = makeWithdrawal("before", startMs - 1000); // JST 2025 に属する
    const { fetch, urls } = pagedFetch([[inYear, before]]);
    const result = await withdrawalHistoryAll({ asset: "xrp", year: "2026" }, { fetch, ...OPTS });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.map((w) => w.uuid)).toEqual(["in"]);
    expect(urls[0]).toContain(`since=${startMs}`);
    expect(urls[0]).toContain(`end=${endMs}`);
  });

  it("rejects --year combined with --since/--end", async () => {
    const result = await withdrawalHistoryAll({ asset: "xrp", year: "2026", since: "1000" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("--year");
      expect(result.exitCode).toBe(4);
    }
  });

  it("rejects a malformed --year", async () => {
    const result = await withdrawalHistoryAll({ asset: "xrp", year: "26" });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.exitCode).toBe(4);
  });
});
