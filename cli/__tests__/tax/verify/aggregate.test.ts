// API イベント → 報告書と同じ軸への集計。報告書は**現物**の様式なので、
// 現物以外を混ぜると円行の差が別の原因で膨らみ「販売所ぶん」と誤読される。
import { describe, expect, it } from "vitest";
import { toExactDecimalString } from "../../../tax/ratio-decimal.js";
import type { TaxEvent } from "../../../tax/schema/event.js";
import { aggregateForReport } from "../../../tax/verify/aggregate.js";

let seq = 0;
const base = (over: Partial<TaxEvent> & Pick<TaxEvent, "kind" | "currency" | "qty">): TaxEvent =>
  ({
    event_id: `e:${seq++}`,
    source_ref: String(seq),
    ts_utc: 1_767_225_600_000,
    ts_jst: "2026-01-01T09:00:00+09:00",
    year_jst: 2026,
    account_id: "bitbank:default",
    source_system: "API",
    recognition_policy: "DELIVERY_DATE",
    flags: [],
    ...over,
  }) as TaxEvent;

const at = (r: { n: bigint; d: bigint }) => toExactDecimalString(r);

describe("aggregateForReport", () => {
  it("約定 1 件を base 側と quote 側の両方へ計上する（JPY 行は鏡像）", () => {
    const a = aggregateForReport([
      base({
        kind: "TRADE_SPOT_SELL",
        currency: "btc",
        qty: "0.5",
        jpy_value: "5000000",
        pair_raw: "btc_jpy",
        market_type: "ORDERBOOK",
        fee: { quote_charged: "6000", quote_occurred: "6000", base: "0" },
      }),
    ]);
    expect(at(a.byCurrency.get("btc")?.sell_qty as never)).toBe("0.5");
    expect(at(a.byCurrency.get("jpy")?.buy_jpy as never)).toBe("5000000");
    expect(at(a.byCurrency.get("jpy")?.fee as never)).toBe("6000");
  });

  it("出庫は 移出数量 と 支払手数料 に分けて積む（付録E.3）", () => {
    const a = aggregateForReport([
      base({
        kind: "WITHDRAWAL",
        currency: "eth",
        qty: "1.5",
        transfer: { reason: "UNKNOWN", fee_qty: "0.005" },
      }),
      base({ kind: "DEPOSIT", currency: "eth", qty: "2", transfer: { reason: "UNKNOWN" } }),
    ]);
    const eth = a.byCurrency.get("eth");
    expect(at(eth?.withdrawal_qty as never)).toBe("1.5");
    expect(at(eth?.fee as never)).toBe("0.005");
    expect(at(eth?.deposit_qty as never)).toBe("2");
  });

  it("信用取引は除外し、件数を警告に出す（黙って落とさない）", () => {
    const a = aggregateForReport([
      base({
        kind: "MARGIN_CLOSE",
        currency: "eth",
        qty: "1",
        pair_raw: "eth_jpy",
        margin: { position_side: "long", role: "CLOSE", realized_net: "12345" },
      }),
    ]);
    expect(a.byCurrency.size).toBe(0);
    expect(a.warnings.join()).toContain("信用取引 1 件");
  });

  it("非 JPY クォートの約定は除外し、件数を警告に出す", () => {
    const a = aggregateForReport([
      base({
        kind: "TRADE_EXCHANGE",
        currency: "xrp",
        qty: "100",
        pair_raw: "xrp_btc",
        market_type: "ORDERBOOK",
        costbasis_provenance: "EXCHANGE_FMV",
        flags: ["NON_JPY_QUOTE", "NO_RATE"],
      }),
    ]);
    expect(a.byCurrency.size).toBe(0);
    expect(a.warnings.join()).toContain("非 JPY クォート");
  });

  it("報告書の軸に載らない種別は種類を控えて警告に出す（黙って消さない）", () => {
    const a = aggregateForReport([
      base({ kind: "AIRDROP", currency: "xrp", qty: "100", costbasis_provenance: "REWARD_FMV" }),
    ]);
    expect(a.byCurrency.size).toBe(0);
    expect(a.warnings.join()).toContain("AIRDROP");
  });

  it("読めない金額は 0 に潰さず警告へ回す（差が取込漏れに見えるのを防ぐ）", () => {
    const a = aggregateForReport([
      base({ kind: "DEPOSIT", currency: "btc", qty: "0x10", transfer: { reason: "UNKNOWN" } }),
    ]);
    expect(a.warnings.join()).toContain("十進文字列として読めません");
  });
});
