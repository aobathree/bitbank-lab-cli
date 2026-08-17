// 100行超: 付録A の対応表（現物 / 信用 / 仕訳を作らないイベント）を 1 箇所で固定するため。
// 変換規則は表がひとつながりの契約なので、分割すると対応表との突合が追いにくくなる。
//
// イベント → 仕訳（付録A の対応表）。手数料の扱いが税務上の分岐点なので、
// 購入時（取得価額算入）・売却時（必要経費）・負値（リベート収入 P-04）を固定する。
import { describe, expect, it } from "vitest";
import { ledgerFromEvents } from "../../../tax/ledger/from-events.js";
import { add, sub, ZERO } from "../../../tax/ratio.js";
import { fromDecimalString, toExactDecimalString } from "../../../tax/ratio-decimal.js";
import type { TaxEvent } from "../../../tax/schema/event.js";
import type { LedgerEntry } from "../../../tax/schema/ledger.js";
import type { EventFlag } from "../../../tax/schema/primitives.js";

const common = {
  source_ref: "1",
  ts_utc: 1_767_225_600_000,
  ts_jst: "2026-01-01T09:00:00+09:00",
  year_jst: 2026,
  account_id: "bitbank:default",
  source_system: "API",
  currency: "btc",
  recognition_policy: "DELIVERY_DATE",
  market_type: "ORDERBOOK",
  pair_raw: "btc_jpy",
  flags: [] as EventFlag[],
} as const;

const fee = (quote: string) => ({ quote_charged: quote, quote_occurred: quote, base: "0" });

const buy = (feeQuote: string): TaxEvent =>
  ({
    ...common,
    event_id: "trade:1",
    kind: "TRADE_SPOT_BUY",
    qty: "0.1",
    jpy_value: "1000000",
    costbasis_provenance: "PURCHASE",
    fee: fee(feeQuote),
  }) as TaxEvent;

const sell = (feeQuote: string): TaxEvent =>
  ({
    ...common,
    event_id: "trade:2",
    source_ref: "2",
    kind: "TRADE_SPOT_SELL",
    qty: "0.1",
    jpy_value: "1200000",
    fee: fee(feeQuote),
  }) as TaxEvent;

describe("現物の仕訳化", () => {
  it("購入時手数料は取得価額に算入する（必要経費に再掲しない）", () => {
    const { entries } = ledgerFromEvents([buy("550")]);
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("ACQUIRE");
    expect(entries[0].cost_jpy).toBe("1000550"); // FAQ 1-5 の設例と同じ構造
  });

  it("売却時手数料は必要経費として別仕訳になる", () => {
    const { entries } = ledgerFromEvents([sell("600")]);
    expect(entries.map((e) => e.kind)).toEqual(["DISPOSE", "EXPENSE"]);
    expect(entries[0].proceeds_jpy).toBe("1200000");
    expect(entries[1].amount_jpy).toBe("600");
    expect(entries[1].category).toBe("expense_fee");
  });

  it("負の手数料（メイカーリベート）は収入計上する（P-04）", () => {
    const { entries } = ledgerFromEvents([buy("-12.3456")]);
    expect(entries.map((e) => e.kind)).toEqual(["ACQUIRE", "INCOME"]);
    // リベートは取得価額を減らさない（簿価中立）
    expect(entries[0].cost_jpy).toBe("1000000");
    expect(entries[1].amount_jpy).toBe("12.3456");
    expect(entries[1].policy_ids).toContain("P-04");
  });
});

describe("信用の仕訳化", () => {
  const marginClose = (net: string): TaxEvent =>
    ({
      ...common,
      event_id: "margin:3",
      source_ref: "3",
      kind: "MARGIN_CLOSE",
      qty: "0.5",
      jpy_value: "5000000",
      margin: {
        position_side: "long",
        role: "CLOSE",
        realized_net: net,
        interest: "-5",
        fee_charged: "100",
        fee_occurred: "100",
      },
    }) as TaxEvent;

  // 報告書（信用）の「年中信用取引損益」は利息だけを控除した値で、取引手数料は
  // 「支払手数料」列に分かれる。API の profit_loss は手数料も控除済みなので、
  // 差益 / 差損へ載せる前に**手数料を足し戻す**（控除の取り消しであって二重控除ではない）
  it("決済益は手数料を足し戻した額を INCOME に、手数料を EXPENSE に分ける", () => {
    const { entries } = ledgerFromEvents([marginClose("1000")]);
    expect(entries.map((e) => e.kind)).toEqual(["INCOME", "EXPENSE"]);
    expect(entries[0].currency).toBe("btc");
    expect(entries[0].amount_jpy).toBe("1100"); // 1000 + 手数料 100
    expect(entries[1].category).toBe("margin_fee");
    expect(entries[1].amount_jpy).toBe("100");
  });

  /** 収入 − 経費（全仕訳）。Number を経由しない（安全整数を超える金額でも崩れないため）。 */
  const netOf = (entries: readonly LedgerEntry[]) =>
    entries.reduce((acc, e) => {
      const amount = fromDecimalString(e.amount_jpy ?? "0") ?? ZERO;
      return e.kind === "INCOME" ? add(acc, amount) : sub(acc, amount);
    }, ZERO);

  it("分け方を変えても所得の合計は変わらない（収入 − 経費が realized_net に戻る）", () => {
    for (const net of ["1000", "-2500", "123456789012345678901234567890"]) {
      const { entries } = ledgerFromEvents([marginClose(net)]);
      expect(toExactDecimalString(netOf(entries))).toBe(net);
    }
  });

  it("決済損でも手数料は別仕訳（EXPENSE は絶対値で計上）", () => {
    const { entries } = ledgerFromEvents([marginClose("-2500")]);
    expect(entries.map((e) => [e.kind, e.category, e.amount_jpy])).toEqual([
      ["EXPENSE", "margin_loss", "2400"], // -2500 + 手数料 100 = -2400
      ["EXPENSE", "margin_fee", "100"],
    ]);
  });

  it("負の手数料（メイカーリベート）は収入計上する（P-04・現物と同じ扱い）", () => {
    const e = marginClose("1000");
    const rebate = { ...e, margin: { ...e.margin, fee_charged: "-30" } } as TaxEvent;
    const { entries } = ledgerFromEvents([rebate]);
    expect(entries.map((e) => e.category)).toEqual(["margin_gain", "margin_rebate_income"]);
    expect(entries[0].amount_jpy).toBe("970"); // 1000 + (-30)
    expect(entries[1].amount_jpy).toBe("30");
  });

  it("fee_charged が無い決済は保留に回す（手数料ぶんずれた差益を黙って出さない）", () => {
    const e = marginClose("1000");
    const { margin, ...rest } = e;
    const broken = {
      ...rest,
      margin: { position_side: "long", role: "CLOSE", realized_net: "1000" },
    } as TaxEvent;
    const r = ledgerFromEvents([broken]);
    expect(r.entries).toEqual([]);
    expect(r.deferred[0].reason).toContain("fee_charged");
  });

  // 呼び出し元は MARGIN_CLOSE でしかここへ来ない（新規建ては手前で continue）ので、
  // realized_net が無いのは「新規建てだから」ではなく決済行の異常。空配列で捨てると
  // その決済の差益・差損・手数料が income / expense / reference_pnl から消える
  it("realized_net が無い決済は保留に回す（fee_charged 欠落と同じ扱い）", () => {
    const e = marginClose("1000");
    const { margin, ...rest } = e;
    const broken = {
      ...rest,
      margin: { position_side: "long", role: "CLOSE", fee_charged: "100", fee_occurred: "100" },
    } as TaxEvent;
    const r = ledgerFromEvents([broken]);
    expect(r.entries).toEqual([]);
    expect(r.deferred).toHaveLength(1);
    expect(r.deferred[0].reason).toContain("realized_net");
    expect(r.deferred[0].currency).toBe("btc"); // ガードが銘柄でブロックできること
  });

  it("新規建ては仕訳を作らない（決済年に帰属させるため）", () => {
    const open = { ...marginClose("0"), kind: "MARGIN_OPEN" } as TaxEvent;
    expect(ledgerFromEvents([open]).entries).toEqual([]);
  });
});

describe("仕訳を作らないイベント", () => {
  it("入出庫は課税イベントではないので仕訳ゼロ", () => {
    const deposit = { ...common, event_id: "dep:1", kind: "DEPOSIT", qty: "1" } as TaxEvent;
    const withdrawal = { ...common, event_id: "wd:1", kind: "WITHDRAWAL", qty: "1" } as TaxEvent;
    const r = ledgerFromEvents([deposit, withdrawal]);
    expect(r.entries).toEqual([]);
    expect(r.deferred).toEqual([]);
  });

  it("TRADE_EXCHANGE は deferred に積んで理由を残す（P0 では計算しない）", () => {
    const ex = {
      ...common,
      event_id: "trade:9",
      kind: "TRADE_EXCHANGE",
      qty: "1",
      costbasis_provenance: "EXCHANGE_FMV",
      flags: ["NON_JPY_QUOTE", "NO_RATE"],
    } as TaxEvent;
    const r = ledgerFromEvents([ex]);
    expect(r.entries).toEqual([]);
    expect(r.deferred[0].currency).toBe("btc");
    expect(r.deferred[0].reason).toContain("TRADE_EXCHANGE");
  });

  it("円換算額の無い現物約定は deferred（0 円として飲み込まない）", () => {
    const broken = { ...buy("0"), jpy_value: undefined } as TaxEvent;
    const r = ledgerFromEvents([broken]);
    expect(r.entries).toEqual([]);
    expect(r.deferred[0].reason).toContain("jpy_value");
  });
});
