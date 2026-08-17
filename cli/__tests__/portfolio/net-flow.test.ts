import { describe, expect, it } from "vitest";
import { calcPeriodNetFlow } from "../../portfolio/net-flow.js";
import { deposit, withdrawal } from "./factories.js";

const SINCE = 500;
const PRICES = new Map([["xrp", 300]]);

describe("calcPeriodNetFlow", () => {
  it("元本（net_flow）と出金手数料（withdrawal_fee）を分離する", () => {
    const { flow } = calcPeriodNetFlow(
      {
        deposits: [deposit({ asset: "jpy", amount: 100_000 })],
        withdrawals: [withdrawal({ asset: "jpy", amount: 50_000, fee: 550 })],
      },
      SINCE,
      PRICES,
    );
    // 手数料を元本に混ぜると 49_450 になる。混ぜないので 50_000 が引かれる
    expect(flow.net_flow_jpy).toBe(50_000);
    expect(flow.withdrawal_fee_jpy).toBe(550);
  });

  it("暗号資産の入出庫は現在価格で仮評価し、手数料も同じ価格で円換算する", () => {
    const { flow } = calcPeriodNetFlow(
      { deposits: [], withdrawals: [withdrawal({ asset: "xrp", amount: 100, fee: 0.15 })] },
      SINCE,
      PRICES,
    );
    expect(flow.net_flow_jpy).toBe(-30_000);
    expect(flow.withdrawal_fee_jpy).toBe(45); // 0.15 × 300
  });

  it("status !== DONE / since より前の入出金は計上しない", () => {
    const { flow } = calcPeriodNetFlow(
      {
        deposits: [
          deposit({ asset: "jpy", amount: 100_000, status: "FOUND" }),
          deposit({ asset: "jpy", amount: 200_000, uuid: "old", confirmed_at: SINCE - 1 }),
        ],
        withdrawals: [withdrawal({ asset: "jpy", amount: 50_000, fee: 550, status: "PENDING" })],
      },
      SINCE,
      PRICES,
    );
    expect(flow).toEqual({ net_flow_jpy: 0, withdrawal_fee_jpy: 0 });
  });

  it("価格が引けない資産は 0 円で計上せず、資産名を返して申告する", () => {
    const { flow, unpricedAssets } = calcPeriodNetFlow(
      { deposits: [deposit({ asset: "zzz", amount: 5 })], withdrawals: [] },
      SINCE,
      PRICES,
    );
    expect(flow.net_flow_jpy).toBe(0);
    expect(unpricedAssets).toEqual(["zzz"]);
  });

  it("入出金が無ければゼロ（調整後増減が単純増減と一致する）", () => {
    const { flow, unpricedAssets } = calcPeriodNetFlow(
      { deposits: [], withdrawals: [] },
      SINCE,
      PRICES,
    );
    expect(flow).toEqual({ net_flow_jpy: 0, withdrawal_fee_jpy: 0 });
    expect(unpricedAssets).toEqual([]);
  });
});
