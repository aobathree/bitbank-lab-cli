// 100行超: 再構築（イベント種別ごとの残高への効き方）と突合（診断の分岐）を
// 一体で固定するため。片方だけでは「判定ではなく検出」という設計意図が担保できない。
//
// 残高再構築と突合（ガード(d) / P-17）。**判定ではなく検出**なので、閾値外でも
// 失敗にはせず残差の量と符号を返すことを固定する。
import { describe, expect, it } from "vitest";
import type { RawAsset } from "../../../tax/import/fetch-assets.js";
import { fromDecimalString, toExactDecimalString } from "../../../tax/ratio-decimal.js";
import { compareBalances } from "../../../tax/reconcile/compare.js";
import { DUST_THRESHOLD, dustFor } from "../../../tax/reconcile/compare-parts.js";
import { rebuildBalances } from "../../../tax/reconcile/rebuild.js";
import type { TaxEvent } from "../../../tax/schema/event.js";
import type { EventFlag } from "../../../tax/schema/primitives.js";

const common = {
  ts_utc: 1_767_225_600_000,
  ts_jst: "2026-01-01T09:00:00+09:00",
  year_jst: 2026,
  account_id: "bitbank:default",
  source_system: "API",
  recognition_policy: "DELIVERY_DATE",
  flags: [] as EventFlag[],
} as const;

const fee = (quote: string, base = "0") => ({
  quote_charged: quote,
  quote_occurred: quote,
  base,
});

const buy = (over: Partial<TaxEvent> = {}): TaxEvent =>
  ({
    ...common,
    event_id: "trade:1",
    source_ref: "1",
    kind: "TRADE_SPOT_BUY",
    market_type: "ORDERBOOK",
    pair_raw: "btc_jpy",
    currency: "btc",
    qty: "0.5",
    jpy_value: "5000000",
    costbasis_provenance: "PURCHASE",
    fee: fee("0"),
    ...over,
  }) as TaxEvent;

const asset = (a: string, onhand: string, withdrawing = "0"): RawAsset => ({
  asset: a,
  onhand_amount: onhand,
  withdrawing_amount: withdrawing,
});

describe("rebuildBalances", () => {
  it("買いは base を増やし quote を約定代金だけ減らす", () => {
    const r = rebuildBalances([buy()]);
    expect(r.balances.get("btc")?.n).toBe(1n);
    expect(r.balances.get("btc")?.d).toBe(2n);
    expect(r.balances.get("jpy")?.n).toBe(-5_000_000n);
  });

  it("手数料は符号そのまま引く（負のリベートは残高が増える）", () => {
    const r = rebuildBalances([buy({ fee: fee("-100") })]);
    expect(r.balances.get("jpy")?.n).toBe(-4_999_900n);
  });

  it("出庫は amount + fee を引く（付録E.3）", () => {
    const wd = {
      ...common,
      event_id: "wd:1",
      source_ref: "1",
      kind: "WITHDRAWAL",
      currency: "btc",
      qty: "1",
      transfer: { reason: "UNKNOWN", fee_qty: "0.0005" },
    } as TaxEvent;
    const r = rebuildBalances([wd]);
    const btc = r.balances.get("btc");
    expect(btc && toExactDecimalString(btc)).toBe("-1.0005"); // -(1 + 0.0005)
  });

  it("信用の決済は base を動かさず quote に realized_net だけ乗る", () => {
    const close = {
      ...common,
      event_id: "margin:1",
      source_ref: "1",
      kind: "MARGIN_CLOSE",
      market_type: "ORDERBOOK",
      pair_raw: "btc_jpy",
      currency: "btc",
      qty: "1",
      margin: { position_side: "long", role: "CLOSE", realized_net: "1000", fee_charged: "50" },
    } as TaxEvent;
    const r = rebuildBalances([close]);
    expect(r.balances.has("btc")).toBe(false);
    expect(r.balances.get("jpy")?.n).toBe(1000n); // fee は profit_loss にネット済み
  });

  it("非 JPY クォートは残差を作らず「突合不能」として両資産を外す", () => {
    const ex = buy({
      event_id: "trade:2",
      kind: "TRADE_EXCHANGE",
      pair_raw: "eth_btc",
      currency: "eth",
      jpy_value: undefined,
      costbasis_provenance: "EXCHANGE_FMV",
      flags: ["NON_JPY_QUOTE", "NO_RATE"],
    });
    const r = rebuildBalances([ex]);
    expect(r.balances.size).toBe(0);
    expect([...r.unreconcilable].sort()).toEqual(["btc", "eth"]);
  });
});

describe("compareBalances", () => {
  const rebuilt = rebuildBalances([buy()]);

  it("ダスト閾値内は MATCH", () => {
    const rows = compareBalances(rebuilt, [asset("btc", "0.50005"), asset("jpy", "-5000000")]);
    expect(rows.find((r) => r.currency === "btc")?.diagnosis).toBe("MATCH");
  });

  it("実残高が多ければ未取込の取得（販売所買付など）を疑う", () => {
    const rows = compareBalances(rebuilt, [asset("btc", "0.6"), asset("jpy", "-5000000")]);
    const btc = rows.find((r) => r.currency === "btc");
    expect(btc?.diagnosis).toBe("MISSING_ACQUISITION");
    expect(btc?.residual).toBe("0.1");
    expect(btc?.withinDust).toBe(false);
  });

  it("実残高が少なければ未取込の処分（販売所売却・ダスト処分）を疑う", () => {
    const rows = compareBalances(rebuilt, [asset("btc", "0.4"), asset("jpy", "-5000000")]);
    expect(rows.find((r) => r.currency === "btc")?.diagnosis).toBe("MISSING_DISPOSAL");
    expect(rows.find((r) => r.currency === "btc")?.residual).toBe("-0.1");
  });

  it("改称後の新旧シンボルは正規化キーで合算する", () => {
    const r = rebuildBalances([buy({ pair_raw: "matic_jpy", currency: "pol", qty: "10" })]);
    const rows = compareBalances(r, [asset("pol", "6"), asset("matic", "4")]);
    expect(rows.find((x) => x.currency === "pol")?.diagnosis).toBe("MATCH");
  });

  it("突合不能な資産は残差ではなく UNRECONCILABLE として出す", () => {
    const r = rebuildBalances([
      buy({
        pair_raw: "eth_btc",
        currency: "eth",
        kind: "TRADE_EXCHANGE",
        jpy_value: undefined,
        costbasis_provenance: "EXCHANGE_FMV",
        flags: ["NON_JPY_QUOTE", "NO_RATE"],
      }),
    ]);
    const rows = compareBalances(r, [asset("eth", "3")]);
    expect(rows.find((x) => x.currency === "eth")?.diagnosis).toBe("UNRECONCILABLE");
  });

  it("資産別にダスト閾値を上書きできる", () => {
    const rows = compareBalances(rebuilt, [asset("btc", "0.6")], { btc: "0.2" });
    expect(rows.find((r) => r.currency === "btc")?.diagnosis).toBe("MATCH");
  });
});

describe("通貨別のダスト閾値", () => {
  // JPY の 1e-4 は「100 分の 1 銭」。約定代金の丸め由来の残差を毎回「未取込の処分」と
  // 誤診していた（実口座で確認）。取込漏れは円単位で現れるので円未満に材料性はない
  const compare = (currency: string, theo: string, actual: string) =>
    compareBalances(
      {
        balances: new Map([[currency, fromDecimalString(theo) as never]]),
        unreconcilable: new Set<string>(),
        problems: [],
      },
      [{ asset: currency, onhand_amount: actual, withdrawing_amount: "0" } as never],
    )[0];

  it("JPY は円未満を無視する（暗号資産の閾値を流用しない）", () => {
    const r = compare("jpy", "789.34844457975", "789.3463");
    expect(r.dust).toBe("1");
    expect(r).toMatchObject({ withinDust: true, diagnosis: "MATCH" });
  });

  it("JPY でも円単位の差は検出する", () => {
    expect(compare("jpy", "1000", "998")).toMatchObject({
      withinDust: false,
      diagnosis: "MISSING_DISPOSAL",
    });
  });

  it("突合できない行にも同じ閾値を返す（出力の dust が実際の基準と食い違わない）", () => {
    const r = compareBalances(
      {
        balances: new Map([["jpy", fromDecimalString("100") as never]]),
        unreconcilable: new Set(["jpy"]),
        problems: [],
      },
      [{ asset: "jpy", onhand_amount: "100", withdrawing_amount: "0" } as never],
    )[0];
    expect(r).toMatchObject({ diagnosis: "UNRECONCILABLE", dust: "1" });
  });

  it("暗号資産は 1e-4 のまま", () => {
    const r = compare("btc", "1.0002", "1");
    expect(r.dust).toBe("0.0001");
    expect(r.withinDust).toBe(false);
  });
});

describe("dustFor: 通貨キーの防御", () => {
  it("上書き > 通貨別既定 > 全体既定 の順で引く", () => {
    expect(dustFor("btc", { btc: "0.01" })).toBe("0.01");
    expect(dustFor("jpy")).toBe("1");
    expect(dustFor("eth")).toBe(DUST_THRESHOLD);
  });

  it("プロトタイプ由来のキーでも閾値の文字列を返す（継承プロパティを拾わない）", () => {
    // 素の Record 参照だと Object.prototype 側の関数が返り、閾値が数値として
    // 読めなくなる。上書き側・既定側のどちらの参照も hasOwn で閉じる
    expect(dustFor("constructor")).toBe(DUST_THRESHOLD);
    expect(dustFor("__proto__")).toBe(DUST_THRESHOLD);
    expect(dustFor("toString", { jpy: "1" })).toBe(DUST_THRESHOLD);
  });
});
