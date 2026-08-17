// 性能（要求仕様 §7 NFR: 単一ユーザー・単年で 10^5 イベントを実用時間で処理）。
// ADR-005 の計測どおり、総平均法は除算が通貨・年あたり 1 回なので 10^5 でも即時。
// 非丸めの移動平均法は分母肥大で 10^5 に届かないため、**黙って遅くならず明示的に止まる**
// ことをテストで固定する（劣化を隠さないのが本テストの目的）。
import { describe, expect, it } from "vitest";
import { checkI1 } from "../../../tax/engine/invariants.js";
import { MAX_DISPOSALS_UNROUNDED, movingAverage } from "../../../tax/engine/moving-average.js";
import { totalAverage, ZERO_BOOK } from "../../../tax/engine/total-average.js";
import type { LedgerEntry } from "../../../tax/schema/ledger.js";

/** 取得と処分を交互に並べた合成台帳（保有が負にならないよう取得を先行させる）。 */
function synthetic(count: number): LedgerEntry[] {
  const entries: LedgerEntry[] = [];
  for (let i = 0; i < count; i++) {
    const acquire = i % 2 === 0;
    entries.push({
      event_id: `e${i}`,
      seq: 0,
      kind: acquire ? "ACQUIRE" : "DISPOSE",
      currency: "btc",
      year_jst: 2026,
      ts_utc: 1_767_225_600_000 + i * 1000,
      sort_key: `${String(i).padStart(8, "0")}:0`,
      qty: "0.00012345",
      ...(acquire ? { cost_jpy: `${1000 + (i % 97)}` } : { proceeds_jpy: `${1100 + (i % 89)}` }),
      category: acquire ? "purchase" : "sale",
      policy_ids: [],
    });
  }
  return entries;
}

describe("性能: 総平均法", () => {
  it("10 万件を実用時間で処理し、I1 も厳密に成立する", () => {
    const entries = synthetic(100_000);
    const started = performance.now();
    const o = totalAverage("btc", entries, ZERO_BOOK);
    const elapsed = performance.now() - started;

    expect(o.violations).toEqual([]);
    expect(checkI1(o)).toEqual([]);
    // 実測は 1 秒未満。CI のばらつきを吸収する余裕を持たせた上限
    expect(elapsed, `total-average 100k took ${Math.round(elapsed)}ms`).toBeLessThan(20_000);
  });
});

describe("性能: 移動平均法（非丸め）", () => {
  it("上限を超える売却件数では計算に入らず明示的に止まる", () => {
    // 上限超なので即座に返る（入ってしまうと実用時間で返らない）
    const entries = synthetic((MAX_DISPOSALS_UNROUNDED + 1) * 2);
    const started = performance.now();
    const o = movingAverage("btc", entries, ZERO_BOOK);
    const elapsed = performance.now() - started;

    expect(o.violations.join()).toContain("上限");
    expect(o.unit).toBeNull();
    expect(elapsed, `guard should short-circuit, took ${Math.round(elapsed)}ms`).toBeLessThan(
      5_000,
    );
  });

  it("上限内なら通常どおり計算する", () => {
    const o = movingAverage("btc", synthetic(200), ZERO_BOOK);
    expect(o.violations).toEqual([]);
    expect(checkI1(o)).toEqual([]);
  });
});
