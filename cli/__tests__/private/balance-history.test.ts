// コマンド層（引数の解決と検証）のテスト。復元そのものの検証は
// cli/__tests__/portfolio/ に置いてある。
import { describe, expect, it } from "vitest";
import { type BalanceHistoryArgs, balanceHistory } from "../../commands/private/balance-history.js";
import { EXIT } from "../../exit-codes.js";
import { mockMarket } from "../portfolio/mock-market.js";
import { TEST_CREDS } from "../test-helpers.js";

const OPTS = { retries: 0, credentials: TEST_CREDS, nonce: "1" } as const;

/** 引数エラーは API へ到達する前に返る（認証・レート制限を消費しない）。 */
function failingFetch(): typeof globalThis.fetch {
  return async () => {
    throw new Error("must not reach the API");
  };
}

describe("balanceHistory の引数検証", () => {
  it("--since と --days の併用は PARAM エラー（API を叩かない）", async () => {
    const r = await balanceHistory(
      { since: "1000", days: "7" },
      { fetch: failingFetch(), ...OPTS },
    );
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.exitCode).toBe(EXIT.PARAM);
      expect(r.error).toContain("--since cannot be combined with --days");
    }
  });

  it("--since が非数値なら PARAM エラー", async () => {
    const r = await balanceHistory({ since: "yesterday" }, { fetch: failingFetch(), ...OPTS });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.exitCode).toBe(EXIT.PARAM);
  });

  it("--days が非正整数なら PARAM エラー", async () => {
    for (const days of ["0", "-3", "1.5", "abc"]) {
      const r = await balanceHistory({ days }, { fetch: failingFetch(), ...OPTS });
      expect(r.success, days).toBe(false);
      if (!r.success) expect(r.exitCode).toBe(EXIT.PARAM);
    }
  });

  it("未知の --granularity は候補を添えて PARAM エラー", async () => {
    // CLI フラグは生文字列で入ってくる（handler の extract は Record<string, unknown>）。
    // 型で弾けない入力を Zod が受け止めることを、キャストして実行時に確かめる
    const args = { granularity: "week" } as unknown as BalanceHistoryArgs;
    const r = await balanceHistory(args, { fetch: failingFetch(), ...OPTS });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.exitCode).toBe(EXIT.PARAM);
      expect(r.error).toContain("'day' | 'month'");
    }
  });

  it("--max-pages が非正整数なら PARAM エラー", async () => {
    const r = await balanceHistory({ maxPages: "0" }, { fetch: failingFetch(), ...OPTS });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.exitCode).toBe(EXIT.PARAM);
  });

  it("未来の --since は PARAM エラー", async () => {
    const future = String(Date.now() + 86_400_000);
    const r = await balanceHistory({ since: future }, { fetch: failingFetch(), ...OPTS });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.exitCode).toBe(EXIT.PARAM);
  });
});

describe("balanceHistory の既定値", () => {
  it("引数なしなら直近 30 日・日次で、注記付きの結果を返す", async () => {
    const { fetch } = mockMarket({ assets: { jpy: "1000000" }, prices: {}, candles: {} });
    const r = await balanceHistory({ noCache: true }, { fetch, ...OPTS });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.granularity).toBe("day");
    // 起点は UTC 日境界へ切り下がるので 31 点（30 日前〜当日）
    expect(r.data.points).toHaveLength(31);
    expect(r.data.note).not.toBe("");
    expect(r.data.completeness.complete).toBe(true);
  });

  it("--days で窓を狭められる", async () => {
    const { fetch } = mockMarket({ assets: { jpy: "1000000" }, prices: {}, candles: {} });
    const r = await balanceHistory({ days: "3", noCache: true }, { fetch, ...OPTS });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.points).toHaveLength(4);
  });
});
