// 建玉の新規 / 決済判定（付録E.2）。**`profit_loss != 0` では判定できない**ことを
// 「損益ゼロの決済」ケースで固定する（要求仕様 §3.1 が明示的に禁じている誤実装）。
import { describe, expect, it } from "vitest";
import { trackMargin } from "../../../tax/import/margin-tracker.js";
import type { RawTrade } from "../../../tax/import/raw-trade.js";
import { tradeHistoryFixture } from "../../__fixtures__/private/trade-history.js";

const base = tradeHistoryFixture.trades[0];
const row = (id: number, side: string, positionSide: string, over: Partial<RawTrade> = {}) =>
  ({
    ...base,
    trade_id: id,
    side,
    position_side: positionSide,
    executed_at: base.executed_at + id,
    ...over,
  }) as RawTrade;

describe("trackMargin", () => {
  it("long は buy=OPEN / sell=CLOSE、short はその逆", () => {
    const r = trackMargin([
      row(1, "buy", "long"),
      row(2, "sell", "long"),
      row(3, "sell", "short"),
      row(4, "buy", "short"),
    ]);
    expect([...r.roles.entries()]).toEqual([
      [1, "OPEN"],
      [2, "CLOSE"],
      [3, "OPEN"],
      [4, "CLOSE"],
    ]);
  });

  it("損益ゼロの決済も CLOSE と判定できる（profit_loss では判定しない）", () => {
    const r = trackMargin([
      row(1, "buy", "long", { profit_loss: "0" }),
      row(2, "sell", "long", { profit_loss: "0" }),
    ]);
    expect(r.roles.get(2)).toBe("CLOSE");
    expect(r.anomalies).toEqual([]);
  });

  it("long と short を同時に持っても別建玉として追跡する", () => {
    const r = trackMargin([row(1, "buy", "long"), row(2, "sell", "short"), row(3, "sell", "long")]);
    expect(r.roles.get(3)).toBe("CLOSE");
    expect(r.outstanding).toEqual([{ key: "btc_jpy:short", qty: "0.001" }]);
  });

  it("建玉残を超える決済は取込漏れの疑いとして報告する", () => {
    const r = trackMargin([
      row(1, "buy", "long", { amount: "1" }),
      row(2, "sell", "long", { amount: "3" }),
    ]);
    expect(r.anomalies).toHaveLength(1);
    expect(r.anomalies[0].reason).toContain("建玉残");
  });

  it("未知の position_side は判定せず保留にする", () => {
    const r = trackMargin([row(1, "buy", "sideways")]);
    expect(r.roles.size).toBe(0);
    expect(r.anomalies[0].reason).toContain("未知の position_side/side");
  });

  it("現物行（position_side なし）は対象外", () => {
    const { position_side: _omit, ...spot } = base;
    expect(trackMargin([spot as RawTrade]).roles.size).toBe(0);
  });
});
