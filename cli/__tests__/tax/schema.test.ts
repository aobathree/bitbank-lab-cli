import { describe, expect, it } from "vitest";
import { TaxEvent } from "../../tax/schema/event.js";
import { LedgerEntry } from "../../tax/schema/ledger.js";

// 条件付き必須は superRefine で強制する（コメント依存にしない）というのが設計判断なので、
// 「必須が欠けたら reject される」ことをテストで固定する。

const baseEvent = {
  event_id: "trade:1",
  source_ref: "1",
  ts_utc: 1_767_225_600_000,
  ts_jst: "2026-01-01T09:00:00+09:00",
  year_jst: 2026,
  account_id: "bitbank:default",
  kind: "TRADE_SPOT_BUY" as const,
  market_type: "ORDERBOOK" as const,
  source_system: "API" as const,
  currency: "btc",
  qty: "0.1",
  costbasis_provenance: "PURCHASE" as const,
  recognition_policy: "DELIVERY_DATE" as const,
  flags: [],
};

describe("TaxEvent: 条件付き必須の強制", () => {
  it("完全な取得系イベントは通る", () => {
    expect(TaxEvent.safeParse(baseEvent).success).toBe(true);
  });

  it("取得系で costbasis_provenance が無いと reject", () => {
    const { costbasis_provenance: _omit, ...withoutProvenance } = baseEvent;
    const r = TaxEvent.safeParse(withoutProvenance);
    expect(r.success).toBe(false);
    expect(r.error?.issues[0].path).toEqual(["costbasis_provenance"]);
  });

  it("取得系でないイベントは costbasis_provenance 無しで通る", () => {
    const { costbasis_provenance: _omit, ...rest } = baseEvent;
    const sell = { ...rest, kind: "TRADE_SPOT_SELL" as const };
    expect(TaxEvent.safeParse(sell).success).toBe(true);
  });

  it("約定なのに market_type が無いと reject", () => {
    const { market_type: _omit, ...withoutMarket } = baseEvent;
    const r = TaxEvent.safeParse(withoutMarket);
    expect(r.success).toBe(false);
    expect(r.error?.issues[0].path).toEqual(["market_type"]);
  });

  // 販売所は API に一切現れない（v2 付録E.3 訂正）。取込経路の取り違えを型で落とす
  it("BROKERAGE を API / 約定履歴CSV 由来で作れない", () => {
    for (const source_system of ["API", "UI_CSV_TRADES"] as const) {
      const r = TaxEvent.safeParse({ ...baseEvent, market_type: "BROKERAGE", source_system });
      expect(r.success).toBe(false);
      expect(r.error?.issues[0].path).toEqual(["source_system"]);
    }
  });

  it("BROKERAGE は手入力（MANUAL）なら通る（CSV 未取得ユーザーの手動登録）", () => {
    const r = TaxEvent.safeParse({
      ...baseEvent,
      market_type: "BROKERAGE",
      source_system: "MANUAL",
    });
    expect(r.success).toBe(true);
  });

  it("BROKERAGE は UI CSV 経路なら通る", () => {
    const brokerage = {
      ...baseEvent,
      event_id: "brk:abc",
      market_type: "BROKERAGE" as const,
      source_system: "UI_CSV_BROKERAGE" as const,
      flags: ["BROKERAGE_SPREAD" as const],
    };
    expect(TaxEvent.safeParse(brokerage).success).toBe(true);
  });

  // 販売所はスプレッド内包で手数料列が無い。fee=0 として記帳すると集計欠落と区別できない
  it("BROKERAGE に fee を付けると reject", () => {
    const r = TaxEvent.safeParse({
      ...baseEvent,
      market_type: "BROKERAGE",
      source_system: "UI_CSV_BROKERAGE",
      fee: { quote_charged: "0", quote_occurred: "0", base: "0" },
    });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0].path).toEqual(["fee"]);
  });

  it("MARGIN_CLOSE は margin が必須", () => {
    const { costbasis_provenance: _omit, ...rest } = baseEvent;
    const r = TaxEvent.safeParse({ ...rest, kind: "MARGIN_CLOSE", market_type: undefined });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0].path).toEqual(["margin"]);
  });

  it("数量は十進文字列のみ（number を渡せない・指数表記も弾く）", () => {
    expect(TaxEvent.safeParse({ ...baseEvent, qty: 0.1 }).success).toBe(false);
    expect(TaxEvent.safeParse({ ...baseEvent, qty: "1e-8" }).success).toBe(false);
    expect(TaxEvent.safeParse({ ...baseEvent, qty: "0.00000001" }).success).toBe(true);
  });
});

const baseEntry = {
  event_id: "trade:1",
  seq: 0,
  kind: "ACQUIRE" as const,
  currency: "btc",
  year_jst: 2026,
  ts_utc: 1_767_225_600_000,
  sort_key: "1767225600000:1",
  qty: "0.1",
  cost_jpy: "1000000",
  category: "spot_buy",
  policy_ids: [],
};

describe("LedgerEntry: kind ごとの金額欄", () => {
  it("ACQUIRE は cost_jpy が必須", () => {
    expect(LedgerEntry.safeParse(baseEntry).success).toBe(true);
    const { cost_jpy: _omit, ...withoutCost } = baseEntry;
    const r = LedgerEntry.safeParse(withoutCost);
    expect(r.success).toBe(false);
    expect(r.error?.issues[0].path).toEqual(["cost_jpy"]);
  });

  it("DISPOSE に cost_jpy を付けると reject（集計から落ちるため）", () => {
    const r = LedgerEntry.safeParse({ ...baseEntry, kind: "DISPOSE", proceeds_jpy: "1200000" });
    expect(r.success).toBe(false);
    expect(r.error?.issues.map((i) => i.path[0])).toContain("cost_jpy");
  });

  it("INCOME / EXPENSE は amount_jpy を使う", () => {
    const { cost_jpy: _omit, ...rest } = baseEntry;
    for (const kind of ["INCOME", "EXPENSE"] as const) {
      const ok = { ...rest, kind, qty: "0", amount_jpy: "500", category: "rebate_income" };
      expect(LedgerEntry.safeParse(ok).success).toBe(true);
      expect(LedgerEntry.safeParse({ ...rest, kind, qty: "0" }).success).toBe(false);
    }
  });
});
