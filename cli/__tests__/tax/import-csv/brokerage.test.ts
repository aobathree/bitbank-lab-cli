// 100行超: 販売所 CSV は「パース → イベント化 → 二重計上ガード」が 1 本の経路で、
// どこで落ちても取込漏れ / 二重計上に直結する。経路をまとめて固定する。
//
// 販売所（即時売買）は **API に一切現れない唯一の取得経路**（付録E.3）。ここで固定するのは
// 手数料欄を作らないこと・JST として日時を読むこと・注文ID の交差を弾くこと。
import { describe, expect, it } from "vitest";
import { toEvents } from "../../../tax/import/to-events.js";
import { parseBrokerage } from "../../../tax/import-csv/brokerage.js";
import { parseCsv } from "../../../tax/import-csv/parse-csv.js";
import { brokerageEvent } from "../../../tax/import-csv/to-events-brokerage.js";
import { TaxEvent } from "../../../tax/schema/event.js";
import { tradeHistoryFixture } from "../../__fixtures__/private/trade-history.js";

/** 実口座の CSV は置かない（公開フォーク）。列名・列順だけ実物に合わせた合成データ。 */
const HEADER = "注文ID,通貨,売/買,数量,指値価格,売買日時";
type Row = { id?: string; cur?: string; side?: string; qty?: string; px?: string; at?: string };
const line = (r: Row) =>
  [
    r.id ?? "10000000001",
    r.cur ?? "btc",
    r.side ?? "買",
    r.qty ?? "0.00009542",
    r.px ?? "10479030",
    r.at ?? "2026/07/13 16:43:12",
  ].join(",");
const csv = (rows: Row[]) => [HEADER, ...rows.map(line)].join("\r\n");

const rowsOf = (rows: Row[]) => {
  const r = parseBrokerage(parseCsv(csv(rows)));
  if (!r.success) throw new Error(r.error);
  return r.data.rows;
};
const eventOf = (r: Row) => brokerageEvent(rowsOf([r])[0]);

describe("販売所 CSV のパース", () => {
  it("メタ行が無く 1 行目がヘッダでも読める", () => {
    expect(rowsOf([{}])[0]).toMatchObject({ order_id: "10000000001", currency: "btc", side: "買" });
  });

  it("定期購入タブの CSV は「タブが違う」と分かるエラーになる", () => {
    // 注文ID を持つのでヘッダ検出は通る。「列が足りない」だと原因が伝わらない
    const recurring =
      "定期購入結果,注文ID,コイン,数量,価格,注文日時\n成功,1,btc,0.001,10000000,2026/07/13 16:43:12";
    const r = parseBrokerage(parseCsv(recurring));
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error).toContain("recurring-purchase");
  });

  it("数量・価格が 0 や負なら受け付けない（負の取得価額を作らない）", () => {
    for (const bad of [{ qty: "0" }, { qty: "-0.001" }, { px: "0" }, { px: "-1" }]) {
      const r = parseBrokerage(parseCsv(csv([bad])));
      expect(r.success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("注文ID・通貨・日時が空なら受け付けない（重複排除が壊れる）", () => {
    for (const bad of [{ id: "" }, { cur: "" }, { at: "" }]) {
      const r = parseBrokerage(parseCsv(csv([bad])));
      expect(r.success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("数量は十進文字列のまま保持する（number 化しない）", () => {
    expect(rowsOf([{ qty: "0.00009542" }])[0].qty).toBe("0.00009542");
  });
});

describe("販売所行 → イベント", () => {
  it("約定代金は 数量 × 価格 を丸めずに持つ（CSV に代金列が無いため）", () => {
    const e = eventOf({ qty: "0.00009542", px: "10479030" });
    expect("kind" in e && e.jpy_value).toBe("999.9090426");
  });

  it("手数料の欄そのものを作らない（fee=0 と混同しない）", () => {
    const e = eventOf({});
    expect("kind" in e && e.fee).toBeUndefined();
    expect("kind" in e && e.flags).toContain("BROKERAGE_SPREAD");
    expect("kind" in e && e.flags).toContain("API_UNREACHABLE");
    expect("kind" in e && e.market_type).toBe("BROKERAGE");
    expect("kind" in e && e.source_system).toBe("UI_CSV_BROKERAGE");
  });

  it("スキーマの条件付き必須を満たす（BROKERAGE の取込元・手数料欄の制約）", () => {
    expect(TaxEvent.safeParse(eventOf({})).success).toBe(true);
  });

  it("日時は JST として読む（UTC として読むと年分が 1 つずれる）", () => {
    // 2025/12/31 23:00 JST は UTC では 12/31 14:00。UTC 読みだと year_jst が 2026 になる
    const e = eventOf({ at: "2025/12/31 23:00:00" });
    expect("kind" in e && e.year_jst).toBe(2025);
    expect("kind" in e && e.ts_jst).toBe("2025-12-31T23:00:00+09:00");
  });

  it("売りは TRADE_SPOT_SELL、買いは取得なので costbasis_provenance が付く", () => {
    const sell = eventOf({ side: "売" });
    const buy = eventOf({});
    expect("kind" in sell && sell.kind).toBe("TRADE_SPOT_SELL");
    expect("kind" in buy && buy.kind).toBe("TRADE_SPOT_BUY");
    expect("kind" in sell ? sell.costbasis_provenance : "n/a").toBeUndefined();
    expect("kind" in buy ? buy.costbasis_provenance : "n/a").toBe("PURCHASE");
  });

  it("未知の 売/買 と読めない日時は保留へ回す（黙って捨てない）", () => {
    expect(eventOf({ side: "buy" })).toMatchObject({ reason: expect.stringContaining("売/買") });
    expect(eventOf({ at: "2026-07-13T16:43:12Z" })).toMatchObject({
      reason: expect.stringContaining("売買日時"),
    });
    expect(eventOf({ at: "2026/02/31 10:00:00" })).toMatchObject({
      reason: expect.stringContaining("売買日時"),
    });
  });
});

describe("二重計上のガード", () => {
  const apiTrade = tradeHistoryFixture.trades[0];
  const merged = (rows: Row[]) =>
    toEvents({ trades: [apiTrade], deposits: [], withdrawals: [], brokerage: rowsOf(rows) });

  it("注文ID が API の約定と一致する行は保留へ回す", () => {
    const r = merged([{ id: String(apiTrade.order_id) }]);
    expect(r.events.some((e) => e.source_system === "UI_CSV_BROKERAGE")).toBe(false);
    expect(r.pending[0].reason).toContain("二重計上");
  });

  it("CSV 内で注文ID が重複していれば 1 件だけ採る", () => {
    const r = merged([{ id: "900001" }, { id: "900001" }]);
    expect(r.events.filter((e) => e.source_system === "UI_CSV_BROKERAGE")).toHaveLength(1);
    expect(r.pending[0].reason).toContain("重複");
  });

  it("交差しなければ API 由来と同じ列に載り、時系列に並ぶ", () => {
    const r = merged([{ id: "900002", at: "2020/01/01 00:00:00" }]);
    expect(r.events.map((e) => e.event_id)).toContain("brk:900002");
    expect(r.events).toHaveLength(2);
    const ts = r.events.map((e) => e.ts_utc);
    expect(ts).toEqual([...ts].sort((a, b) => a - b));
  });
});
