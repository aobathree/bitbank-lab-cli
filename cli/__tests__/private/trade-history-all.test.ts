import { describe, expect, it } from "vitest";
import { tradeHistoryAll } from "../../commands/private/trade-history-all.js";
import { tradeHistoryFixture } from "../__fixtures__/private/trade-history.js";
import { mockFetchData, TEST_CREDS } from "../test-helpers.js";

// モックは実 API 準拠: 1 約定の形状は __fixtures__/private/trade-history.ts に集約し、
// ページング検証用に id / executed_at だけ差し替える。
const BASE_TRADE = tradeHistoryFixture.trades[0];

function makeTrade(id: number, executedAt: number) {
  return { ...BASE_TRADE, trade_id: id, order_id: id, executed_at: executedAt };
}

/**
 * ページ列を順に返しつつリクエスト URL を記録する。
 * URL を見ないモックだと `since` の前進先を取り違えても（先頭の executed_at を使う、
 * そもそも進めない等）結果が同じになり検出できないため、カーソル系はこれで検査する。
 */
function pagedFetch(pages: ReturnType<typeof makeTrade>[][]): {
  fetch: typeof globalThis.fetch;
  urls: string[];
} {
  const urls: string[] = [];
  let call = 0;
  const fetch: typeof globalThis.fetch = async (input) => {
    urls.push(typeof input === "string" ? input : input.toString());
    const trades = pages[call++];
    // 余分なページを空で返すと「止まるべきところで止まらない」実装も通ってしまう
    if (trades === undefined) throw new Error(`unexpected request #${call}`);
    return new Response(JSON.stringify({ success: 1, data: { trades } }));
  };
  return { fetch, urls };
}

describe("tradeHistoryAll", () => {
  it("returns error when pair is missing", async () => {
    const result = await tradeHistoryAll({ pair: undefined });
    expect(result.success).toBe(false);
  });

  it("fetches single page when fewer than 1000", async () => {
    const trades = Array.from({ length: 3 }, (_, i) => makeTrade(i + 1, 1000 + i));

    const result = await tradeHistoryAll(
      { pair: "btc_jpy" },
      { fetch: mockFetchData({ trades }), retries: 0, credentials: TEST_CREDS, nonce: "1" },
    );
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toHaveLength(3);
  });

  it("paginates across multiple pages", async () => {
    const page1 = Array.from({ length: 1000 }, (_, i) => makeTrade(i + 1, 1000 + i));
    const page2 = Array.from({ length: 500 }, (_, i) => makeTrade(1001 + i, 2000 + i));
    let call = 0;
    const fetch: typeof globalThis.fetch = async () => {
      const trades = call++ === 0 ? page1 : page2;
      return new Response(JSON.stringify({ success: 1, data: { trades } }));
    };

    const result = await tradeHistoryAll(
      { pair: "btc_jpy" },
      { fetch, retries: 0, credentials: TEST_CREDS, nonce: "1" },
    );
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toHaveLength(1500);
  });

  it("deduplicates trades at page boundaries", async () => {
    const page1 = Array.from({ length: 1000 }, (_, i) => makeTrade(i + 1, 1000 + i));
    // page2 starts with a duplicate of the last trade from page1
    const page2 = [page1[999], makeTrade(1001, 3000)];
    let call = 0;
    const fetch: typeof globalThis.fetch = async () => {
      const trades = call++ === 0 ? page1 : page2;
      return new Response(JSON.stringify({ success: 1, data: { trades } }));
    };

    const result = await tradeHistoryAll(
      { pair: "btc_jpy" },
      { fetch, retries: 0, credentials: TEST_CREDS, nonce: "1" },
    );
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toHaveLength(1001);
  });

  it("advances the since cursor to the previous page's last executed_at", async () => {
    const page1 = Array.from({ length: 1000 }, (_, i) => makeTrade(i + 1, 1000 + i));
    const page2 = Array.from({ length: 3 }, (_, i) => makeTrade(1001 + i, 5000 + i));
    const { fetch, urls } = pagedFetch([page1, page2]);

    const result = await tradeHistoryAll(
      { pair: "btc_jpy" },
      { fetch, retries: 0, credentials: TEST_CREDS, nonce: "1" },
    );

    expect(result.success).toBe(true);
    expect(urls).toHaveLength(2);
    // 1 ページ目はカーソルを持たない（compactParams が undefined を落とす）
    expect(new URL(urls[0]).searchParams.get("since")).toBeNull();
    // 2 ページ目は前ページ「最終」行から再開する（先頭でも件数でもない）
    expect(new URL(urls[1]).searchParams.get("since")).toBe(String(page1[999].executed_at));
  });

  it("requests asc order and a full page every time, and forwards --end", async () => {
    const page1 = Array.from({ length: 1000 }, (_, i) => makeTrade(i + 1, 1000 + i));
    const { fetch, urls } = pagedFetch([page1, []]);

    await tradeHistoryAll(
      { pair: "btc_jpy", end: "9999" },
      { fetch, retries: 0, credentials: TEST_CREDS, nonce: "1" },
    );

    expect(urls).toHaveLength(2);
    for (const u of urls) {
      const q = new URL(u).searchParams;
      // desc だと「最終行の executed_at から再開」が過去へ逆走する
      expect(q.get("order")).toBe("asc");
      expect(q.get("count")).toBe("1000");
      expect(q.get("end")).toBe("9999");
    }
  });

  it("re-fetches and dedups trades sharing the boundary millisecond", async () => {
    // 末尾 3 件が同一 executed_at。since はミリ秒なので次ページに必ず重複が返る
    const page1 = Array.from({ length: 1000 }, (_, i) =>
      makeTrade(i + 1, i < 997 ? 1000 + i : 2000),
    );
    const page2 = [...page1.slice(997), makeTrade(1001, 2001)];
    const { fetch, urls } = pagedFetch([page1, page2]);

    const result = await tradeHistoryAll(
      { pair: "btc_jpy" },
      { fetch, retries: 0, credentials: TEST_CREDS, nonce: "1" },
    );

    expect(new URL(urls[1]).searchParams.get("since")).toBe("2000");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toHaveLength(1001);
      expect(new Set(result.data.map((t) => t.trade_id)).size).toBe(1001);
    }
  });

  it("stops on an empty page after an exactly-full page (not partial)", async () => {
    const page1 = Array.from({ length: 1000 }, (_, i) => makeTrade(i + 1, 1000 + i));
    const { fetch, urls } = pagedFetch([page1, []]);

    const result = await tradeHistoryAll(
      { pair: "btc_jpy" },
      { fetch, retries: 0, credentials: TEST_CREDS, nonce: "1" },
    );

    expect(result.success).toBe(true);
    // ちょうど上限なら「次が空」を確かめるまで完了と言えない（1 回で止まったら不足）
    expect(urls).toHaveLength(2);
    if (result.success) {
      expect(result.data).toHaveLength(1000);
      // 上限到達ではないので打ち切り扱いにしない
      expect(result.partial).toBeUndefined();
    }
  });

  it("stops at --max-pages cap and returns partial + truncated meta", async () => {
    // Each page returns a full PAGE_SIZE worth of NEW trade_ids so loop never breaks naturally.
    let call = 0;
    const fetch: typeof globalThis.fetch = async () => {
      const base = call * 1000;
      const trades = Array.from({ length: 1000 }, (_, i) => makeTrade(base + i + 1, base + i));
      call++;
      return new Response(JSON.stringify({ success: 1, data: { trades } }));
    };

    const result = await tradeHistoryAll(
      { pair: "btc_jpy", maxPages: "3" },
      { fetch, retries: 0, credentials: TEST_CREDS, nonce: "1" },
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toHaveLength(3000);
      expect(result.partial).toBe(true);
      expect(result.meta?.truncated).toBe(true);
      expect(result.meta?.reason).toBe("MAX_PAGES");
      expect(result.meta?.returnedRows).toBe(3000);
    }
    expect(call).toBe(3);
  });

  it("dedup-stop takes precedence over --max-pages when duplicates arrive first", async () => {
    const page1 = Array.from({ length: 1000 }, (_, i) => makeTrade(i + 1, 1000 + i));
    // page2 is full PAGE_SIZE but all duplicates → dedup-stop triggers before max-pages.
    const page2 = [...page1];
    let call = 0;
    const fetch: typeof globalThis.fetch = async () => {
      const trades = call++ === 0 ? page1 : page2;
      return new Response(JSON.stringify({ success: 1, data: { trades } }));
    };

    const result = await tradeHistoryAll(
      { pair: "btc_jpy", maxPages: "10" },
      { fetch, retries: 0, credentials: TEST_CREDS, nonce: "1" },
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toHaveLength(1000);
      expect(result.partial).toBeUndefined();
      expect(result.meta?.truncated).toBeUndefined();
    }
  });

  it("rejects --max-pages=0 with PARAM exit code", async () => {
    const result = await tradeHistoryAll({ pair: "btc_jpy", maxPages: "0" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("max-pages");
      expect(result.exitCode).toBe(4);
    }
  });

  it("rejects --max-pages=-1 with PARAM exit code", async () => {
    const result = await tradeHistoryAll({ pair: "btc_jpy", maxPages: "-1" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("max-pages");
      expect(result.exitCode).toBe(4);
    }
  });

  it("rejects --max-pages=1.5 with PARAM exit code", async () => {
    const result = await tradeHistoryAll({ pair: "btc_jpy", maxPages: "1.5" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("max-pages");
      expect(result.exitCode).toBe(4);
    }
  });

  it("rejects --max-pages=abc with PARAM exit code", async () => {
    const result = await tradeHistoryAll({ pair: "btc_jpy", maxPages: "abc" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("max-pages");
      expect(result.exitCode).toBe(4);
    }
  });

  it("rejects --max-pages with digits that overflow to Infinity (safe-integer guard)", async () => {
    const huge = "9".repeat(400);
    const result = await tradeHistoryAll({ pair: "btc_jpy", maxPages: huge });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("safe integer");
      expect(result.exitCode).toBe(4);
    }
  });

  it("rejects --max-pages just above Number.MAX_SAFE_INTEGER", async () => {
    // 2^53 = 9007199254740992, the first integer that loses precision.
    const result = await tradeHistoryAll({ pair: "btc_jpy", maxPages: "9007199254740992" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("safe integer");
      expect(result.exitCode).toBe(4);
    }
  });
});
