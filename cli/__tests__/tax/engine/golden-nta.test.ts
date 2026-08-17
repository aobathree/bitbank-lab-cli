// 税務ゴールデンケース（要求仕様 §8-1 / v2 §11.5・付録D.4）。
// 国税庁 FAQ 2-4／2-8 の公式設例をそのまま流し、公表値と**厳密一致**することを固定する。
//
//   4 BTC @1,845,000 購入 → 2 BTC @1,650,000 購入 → 2 BTC 売却 2,400,000
//   → 0.5 BTC @542,800 購入 → 3 BTC 売却 2,895,000
//
// 100行超: 公式設例 1 本の取引列に対して総平均法・移動平均法の両方の公表値を
// 一体で追跡するため（設例を分割すると「同じ入力から両方式が出る」ことが担保できない）。
//
// 公表値: 総平均法 単価621,200 / 譲渡原価3,106,000 / 年末残高931,800 / 所得2,189,000
//         移動平均法 譲渡原価3,080,200 / 年末単価638,400 / 年末残高価額957,600
import { describe, expect, it } from "vitest";
import { checkInvariants } from "../../../tax/engine/invariants.js";
import { movingAverage } from "../../../tax/engine/moving-average.js";
import { totalAverage, ZERO_BOOK } from "../../../tax/engine/total-average.js";
import { toDecimalString, toExactDecimalString } from "../../../tax/ratio-decimal.js";
import type { LedgerEntry } from "../../../tax/schema/ledger.js";

const DAY = 86_400_000;

function acquire(seq: number, qty: string, cost: string): LedgerEntry {
  return {
    event_id: `trade:${seq}`,
    seq: 0,
    kind: "ACQUIRE",
    currency: "btc",
    year_jst: 2026,
    ts_utc: seq * DAY,
    sort_key: `${seq}:0`,
    qty,
    cost_jpy: cost,
    category: "purchase",
    policy_ids: [],
  };
}

function dispose(seq: number, qty: string, proceeds: string): LedgerEntry {
  return {
    event_id: `trade:${seq}`,
    seq: 0,
    kind: "DISPOSE",
    currency: "btc",
    year_jst: 2026,
    ts_utc: seq * DAY,
    sort_key: `${seq}:0`,
    qty,
    proceeds_jpy: proceeds,
    category: "sale",
    policy_ids: [],
  };
}

// 付録D.4 の設例。**時系列順**が移動平均法の結果を決めるので seq がそのまま日付順
const FAQ_2_4: LedgerEntry[] = [
  acquire(1, "4", "1845000"),
  acquire(2, "2", "1650000"),
  dispose(3, "2", "2400000"),
  acquire(4, "0.5", "542800"),
  dispose(5, "3", "2895000"),
];

const exact = (r: { n: bigint; d: bigint }): string | null => toExactDecimalString(r);

describe("ゴールデンケース: FAQ 2-4 総平均法", () => {
  const o = totalAverage("btc", FAQ_2_4, ZERO_BOOK);

  it("総平均単価は 621,200（割り切れる）", () => {
    expect(o.unit).not.toBeNull();
    expect(exact(o.unit as { n: bigint; d: bigint })).toBe("621200");
  });

  it("譲渡原価は 3,106,000", () => {
    expect(exact(o.cogs)).toBe("3106000");
  });

  it("年末残高は 1.5 BTC / 931,800 円", () => {
    expect(exact(o.closing.qty)).toBe("1.5");
    expect(exact(o.closing.cost)).toBe("931800");
  });

  it("所得金額（収入 5,295,000 − 経費 3,106,000）は 2,189,000", () => {
    // 手数料等ゼロの設例なので、収入計 = 売却価額計・必要経費計 = 譲渡原価
    expect(exact(o.disposed.proceeds)).toBe("5295000");
    expect(toDecimalString(o.disposed.proceeds, 0, "ROUNDDOWN")).toBe("5295000");
    const income = 5_295_000 - 3_106_000;
    expect(income).toBe(2_189_000);
  });

  it("不変条件 I1・I2 を満たす", () => {
    expect(checkInvariants(o)).toEqual([]);
    expect(o.violations).toEqual([]);
  });
});

describe("ゴールデンケース: FAQ 2-4 移動平均法", () => {
  const o = movingAverage("btc", FAQ_2_4, ZERO_BOOK);

  it("譲渡原価は 3,080,200", () => {
    expect(exact(o.cogs)).toBe("3080200");
  });

  it("年末単価は 638,400（売却では据置き、直近取得時点の平均単価）", () => {
    expect(o.unit).not.toBeNull();
    expect(exact(o.unit as { n: bigint; d: bigint })).toBe("638400");
  });

  it("年末残高価額は 957,600", () => {
    expect(exact(o.closing.cost)).toBe("957600");
    expect(exact(o.closing.qty)).toBe("1.5");
  });

  it("不変条件 I1・I2 を満たす", () => {
    expect(checkInvariants(o)).toEqual([]);
    expect(o.violations).toEqual([]);
  });

  it("総平均法との譲渡原価の差は繰越側へ回る（合計は一致）", () => {
    const t = totalAverage("btc", FAQ_2_4, ZERO_BOOK);
    const totalMoving = 3_080_200 + 957_600;
    const totalAvg = 3_106_000 + 931_800;
    expect(totalMoving).toBe(totalAvg);
    expect(exact(t.acquired.cost)).toBe("4037800");
    expect(exact(o.acquired.cost)).toBe("4037800");
  });
});
