// 100行超: 打ち切りの往復に加えて「--carryover=zero の反証」を**実 API 形状のまま**
// 通すため。反証は全履歴（前年イベント）と当年の突合が同時に成立して初めて再現でき、
// buildReport 単体テストでは組めない。
//
// pnl 経路を打ち切りあり / なしで 1 往復ずつ通す。差分は --max-pages だけなので、
// 「打ち切ると参考損益が消えて警告が出る」ことを他の要因抜きで固定できる。
import { describe, expect, it } from "vitest";
import { runPnlReport } from "../../../tax/report/run.js";
import type { Taxation } from "../../../tax/schema/taxation.js";
import { tradeHistoryFixture } from "../../__fixtures__/private/trade-history.js";
import { TEST_CREDS } from "../../test-helpers.js";

// 現物約定にする（fixture は信用行なので position_side 等を落とす。
// JSON.stringify が undefined のキーを落とすので、API 応答にも現れない）
const trade = {
  ...tradeHistoryFixture.trades[0],
  executed_at: 1_767_225_600_000, // 2026-01-01T09:00 JST
  position_side: undefined,
  profit_loss: undefined,
  interest: undefined,
};

const taxation: Taxation = {
  mode: "comprehensive",
  certainty: "settled",
  basis: "2026 年分は総合課税",
};

/** 約定 1 件だけ返す mock。2 回目以降は空なので maxPages に余裕があれば打ち切られない。 */
function mockApi(): typeof globalThis.fetch {
  let served = false;
  return (async (input: string | URL) => {
    const { pathname } = new URL(String(input));
    let data: unknown = { withdrawals: [] };
    if (pathname.endsWith("/user/spot/trade_history")) {
      data = { trades: served ? [] : [trade] };
      served = true;
    } else if (pathname.endsWith("/user/deposit_history")) {
      data = { deposits: [] };
    } else if (pathname.endsWith("/user/assets")) {
      // 理論残高（0.001 btc）と一致させて btc をガード(d) MATCH にする。
      // jpy は突合行には出るが ledger に無いので参考損益の対象にならない
      data = { assets: [{ asset: "btc", onhand_amount: "0.001", withdrawing_amount: "0" }] };
    }
    return new Response(JSON.stringify({ success: 1, data }));
  }) as typeof globalThis.fetch;
}

function run(maxPages: number) {
  return runPnlReport(
    { year: 2026, method: "total-average", taxation, attested: true, allZero: true, maxPages },
    { pairs: ["btc_jpy"], assets: ["btc"] },
    { fetch: mockApi(), retries: 0, credentials: TEST_CREDS, nonce: "1" },
  );
}

describe("runPnlReport の打ち切り時の振る舞い", () => {
  it("打ち切りが無ければ参考損益を出し、打ち切り警告も出さない", async () => {
    const r = await run(5);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.source.full_history.truncated).toBe(false);
    expect(r.data.source.year.events).toBe(1);
    expect(r.data.currencies[0].currency).toBe("btc");
    expect(r.data.currencies[0].reference).toBeDefined();
    expect(r.data.warnings.join()).not.toContain("打ち切");
  });

  it("打ち切られたら参考損益を出さず、理由と警告を残す", async () => {
    const r = await run(1);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.partial).toBe(true);
    expect(r.data.source.full_history.truncated).toBe(true);
    // 突合は MATCH のままでもブロックする（欠けたイベントが打ち消し合う場合の穴）
    expect(r.data.reconciliation.find((x) => x.currency === "btc")?.diagnosis).toBe("MATCH");
    expect(r.data.currencies[0].reference).toBeUndefined();
    expect(r.data.currencies[0].blocked_by.join()).toContain("打ち切られています");
    // レポート本体だけを読む経路にも残す（verify-report と同じ文言）
    expect(r.data.warnings.join()).toContain("打ち切られています");
  });
});

// 前年の入庫だけがある銘柄に `--carryover=zero` を使うと、当年イベントにブロックフラグが
// 立たず（(b) は当年スコープ）、残高突合も入庫を数量に含めたまま MATCH する。ゼロ確定を
// そのまま (c) の充足として認めると、**入庫分を母集団から落とした単価**がガードを全部
// 通って出てしまう。ここは「他の条件が全部揃っていること」まで含めて固定する。
const PRIOR_YEAR_MS = 1_735_689_600_000; // 2025-01-01T09:00 JST
const THIS_YEAR_MS = 1_767_225_600_000; // 2026-01-01T09:00 JST

const spot = (over: Record<string, unknown>) => ({
  ...trade,
  fee_amount_quote: "0",
  fee_occurred_amount_quote: "0",
  ...over,
});

/** 2025 に 1 BTC 入庫、2026 に 1 BTC を 600 万で購入し 700 万で売却。期末残高 1 BTC。 */
function carryoverMock(): typeof globalThis.fetch {
  let served = false;
  return (async (input: string | URL) => {
    const { pathname } = new URL(String(input));
    let data: unknown = { withdrawals: [] };
    if (pathname.endsWith("/user/spot/trade_history")) {
      data = {
        trades: served
          ? []
          : [
              spot({
                trade_id: 1,
                side: "buy",
                amount: "1",
                price: "6000000",
                executed_at: THIS_YEAR_MS,
              }),
              spot({
                trade_id: 2,
                side: "sell",
                amount: "1",
                price: "7000000",
                executed_at: THIS_YEAR_MS + 86_400_000,
              }),
            ],
      };
      served = true;
    } else if (pathname.endsWith("/user/deposit_history")) {
      // txid あり = 付与ではない外部入庫（GRANT_SUSPECT ではなく UNRESOLVED_TRANSFER）
      data = {
        deposits: [
          {
            uuid: "dep-2025",
            asset: "btc",
            amount: "1",
            txid: "0xdeadbeef",
            status: "DONE",
            found_at: PRIOR_YEAR_MS,
            confirmed_at: PRIOR_YEAR_MS,
          },
        ],
      };
    } else if (pathname.endsWith("/user/assets")) {
      // 入庫 1 + 購入 1 − 売却 1 = 1。全履歴の突合なので MATCH する
      data = { assets: [{ asset: "btc", onhand_amount: "1", withdrawing_amount: "0" }] };
    }
    return new Response(JSON.stringify({ success: 1, data }));
  }) as typeof globalThis.fetch;
}

describe("--carryover=zero の反証", () => {
  it("前年に同一銘柄のイベントがあれば、ゼロ確定を (c) の充足として認めない", async () => {
    const r = await runPnlReport(
      { year: 2026, method: "total-average", taxation, attested: true, allZero: true },
      { pairs: ["btc_jpy"], assets: ["btc"] },
      { fetch: carryoverMock(), retries: 0, credentials: TEST_CREDS, nonce: "1" },
    );
    expect(r.success).toBe(true);
    if (!r.success) return;
    const btc = r.data.currencies.find((c) => c.currency === "btc");

    // 反証が無ければ (a)〜(d) は全部揃う。つまり止めているのはこの条件だけ
    expect(r.data.reconciliation.find((x) => x.currency === "btc")?.diagnosis).toBe("MATCH");
    expect(r.data.source.full_history.truncated).toBe(false);
    expect(btc?.blocked_by).toHaveLength(1);
    expect(btc?.blocked_by[0]).toContain("--carryover=zero は使えません");

    // 入庫分を落とした単価（譲渡原価 600 万・参考損益 +100 万）を出さない
    expect(btc?.reference).toBeUndefined();
    expect(btc?.nta_compat).toBeUndefined();
    // 取引集計はガードの成否に関係なく常に出す
    expect(btc?.summary.acquired_cost_jpy).toBe("6000000");
    expect(btc?.summary.proceeds_jpy).toBe("7000000");
  });
});
