// 100行超: 「止める条件」と「止めてはいけない条件」を対で並べるため。片側だけだと
// 過剰ブロック（販売所は全行が .000 ms なので同時刻自体が起きやすい）に気づけない。
//
// 順序を定義できない同時刻（取引所 trade_id × 販売所 注文ID）の検出。
// 移動平均法だけの問題で、総平均法は順序非依存。
import { describe, expect, it } from "vitest";
import { movingAverage } from "../../../tax/engine/moving-average.js";
import { orderAmbiguities } from "../../../tax/engine/order-ambiguity.js";
import { runEngine } from "../../../tax/engine/run.js";
import { totalAverage, ZERO_BOOK } from "../../../tax/engine/total-average.js";
import { evaluateGuard } from "../../../tax/guard/reference-pnl.js";
import type { LedgerEntry } from "../../../tax/schema/ledger.js";

const SAME_MS = 1_767_225_600_000;
const base = { currency: "btc", year_jst: 2026, policy_ids: [] as string[] };

const acquire = (eventId: string, ts = SAME_MS): LedgerEntry => ({
  ...base,
  event_id: eventId,
  seq: 0,
  kind: "ACQUIRE",
  ts_utc: ts,
  sort_key: `${eventId.split(":")[1]}:0`,
  qty: "1",
  cost_jpy: "2000000",
  category: "purchase",
});

const dispose = (eventId: string, ts = SAME_MS): LedgerEntry => ({
  ...base,
  event_id: eventId,
  seq: 0,
  kind: "DISPOSE",
  ts_utc: ts,
  sort_key: `${eventId.split(":")[1]}:0`,
  qty: "1",
  proceeds_jpy: "3000000",
  category: "sale",
});

describe("止める: 順序が結果を変え、かつ順序を決められない組み合わせ", () => {
  const entries = [dispose("trade:9"), acquire("brk:100000001")];

  it("同一時刻に取引所と販売所の取得・処分が混在すれば違反にする", () => {
    const v = orderAmbiguities("btc", entries);
    expect(v).toHaveLength(1);
    expect(v[0]).toContain("取引所と販売所");
    expect(v[0]).toContain("trade:9");
    expect(v[0]).toContain("brk:100000001");
  });

  it("移動平均法の violations に載り、参考損益のガードが止める", () => {
    const o = movingAverage("btc", entries, ZERO_BOOK);
    expect(o.violations.join()).toContain("取引所と販売所");

    const results = runEngine({ entries, method: "moving-average", opening: { btc: ZERO_BOOK } });
    const verdict = evaluateGuard(
      {
        attested: true,
        truncated: false,
        events: [],
        results,
        reconciliation: [],
        deferred: [],
        carryoverZeroRejected: [],
      },
      "btc",
    );
    expect(verdict.allowed).toBe(false);
    expect(verdict.blockedBy.join()).toContain("計算前提の違反");
  });

  it("総平均法は順序非依存なので違反にしない", () => {
    expect(totalAverage("btc", entries, ZERO_BOOK).violations).toEqual([]);
  });
});

describe("止めない: 順序が結果を変えないか、順序が決まっている組み合わせ", () => {
  it("同一ソース内の同時刻は約定ID の数値順で決まる（sort-order.ts）", () => {
    expect(orderAmbiguities("btc", [dispose("trade:9"), acquire("trade:10")])).toEqual([]);
  });

  // trade と margin は同じ trade_id 空間（同一エンドポイントの同一列）。
  // 分けると現物と信用が同時刻に並んだだけで誤検知する
  it("trade と margin は別 ID 空間として扱わない", () => {
    expect(orderAmbiguities("btc", [dispose("trade:9"), acquire("margin:10")])).toEqual([]);
  });

  // 販売所は全行が .000 ms へ落ちるので同時刻自体は珍しくない。
  // 取得どうし・処分どうしは可換なので、ここで止めると誤ブロックになる
  it("異ソースでも取得どうしなら可換なので通す", () => {
    expect(orderAmbiguities("btc", [acquire("trade:9"), acquire("brk:100000001")])).toEqual([]);
  });

  it("異ソースでも処分どうしなら可換なので通す", () => {
    expect(orderAmbiguities("btc", [dispose("trade:9"), dispose("brk:100000001")])).toEqual([]);
  });

  it("時刻が違えば順序は決まっている", () => {
    const v = orderAmbiguities("btc", [dispose("trade:9"), acquire("brk:1", SAME_MS + 1)]);
    expect(v).toEqual([]);
  });

  it("同時刻の仕訳が 1 本だけなら比較相手がいない", () => {
    expect(orderAmbiguities("btc", [dispose("trade:9")])).toEqual([]);
  });
});
