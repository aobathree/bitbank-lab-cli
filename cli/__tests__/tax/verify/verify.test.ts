// 100行超: 突合の入口（compareAnnualReport）と許容幅の判定は同じ CSV フィクスチャと
// イベント組み立てヘルパーを共有する。分けると helper を丸ごと複製することになり、
// フィクスチャの二重管理のほうが読み違いを生む。
// 年間取引報告書 × API 集計の突合。**販売所（即時売買）は API に現れない**ので、
// 差が出ること自体は正常。ここで固定するのは「差がどの項目にどの向きで立つか」と
// 「手数料の丸め差を取込漏れと誤診しないこと」。
import { describe, expect, it } from "vitest";
import { parseAnnualReport } from "../../../tax/import-csv/annual-report.js";
import { parseCsv } from "../../../tax/import-csv/parse-csv.js";
import type { TaxEvent } from "../../../tax/schema/event.js";
import type { VerifyRow } from "../../../tax/schema/verify.js";
import { aggregateForReport } from "../../../tax/verify/aggregate.js";
import { compareAnnualReport } from "../../../tax/verify/annual-report.js";
import { buildCsv, type Row } from "./synthetic-report.js";

let seq = 0;
const spot = (
  kind: "TRADE_SPOT_BUY" | "TRADE_SPOT_SELL",
  currency: string,
  qty: string,
  jpy: string,
  feeQuote = "0",
): TaxEvent => ({
  event_id: `trade:${seq++}`,
  source_ref: String(seq),
  ts_utc: 1_767_225_600_000,
  ts_jst: "2026-01-01T09:00:00+09:00",
  year_jst: 2026,
  account_id: "bitbank:default",
  kind,
  market_type: "ORDERBOOK",
  source_system: "API",
  currency,
  qty,
  jpy_value: jpy,
  pair_raw: `${currency}_jpy`,
  fee: { quote_charged: feeQuote, quote_occurred: feeQuote, base: "0" },
  recognition_policy: "DELIVERY_DATE",
  flags: ["FEE_API_ROUNDED"],
  ...(kind === "TRADE_SPOT_BUY" ? { costbasis_provenance: "PURCHASE" as const } : {}),
});

function compare(rows: readonly Row[], events: readonly TaxEvent[]) {
  const report = parseAnnualReport(parseCsv(buildCsv(rows)));
  if (!report.success) throw new Error(report.error);
  return compareAnnualReport(report.data, aggregateForReport(events));
}

const ok = (...args: Parameters<typeof compare>) => {
  const r = compare(...args);
  if (!r.success) throw new Error(r.error);
  return r.data;
};

const find = (data: { rows: VerifyRow[] }, currency: string, field: string) =>
  data.rows.find((x) => x.currency === currency && x.field === field);

describe("compareAnnualReport", () => {
  it("API に現れない買付（販売所）が購入側の REPORT_EXCESS として立つ", () => {
    const data = ok(
      [
        { 通貨名: "btc", JPY建て年中購入数量: "2", JPY建て年中購入金額: "20000000", 年末数量: "2" },
        {
          通貨名: "jpy",
          年始数量: "20000000",
          JPY建て年中売却数量: "20000000",
          JPY建て年中売却金額: "20000000",
        },
      ],
      [spot("TRADE_SPOT_BUY", "btc", "1", "10000000")],
    );
    expect(find(data, "btc", "buy_qty")).toMatchObject({
      diff: "1",
      diagnosis: "REPORT_EXCESS",
      report_kind: "spot",
    });
    expect(find(data, "btc", "buy_jpy")?.diff).toBe("10000000");
    expect(find(data, "btc", "buy_qty")?.hint).toContain("販売所");
    // 円側は鏡像。買付が漏れていれば「円の売却」も同額漏れる
    expect(find(data, "jpy", "sell_jpy")).toMatchObject({
      diff: "10000000",
      diagnosis: "REPORT_EXCESS",
    });
  });

  it("報告書と API が一致していれば全項目 MATCH", () => {
    const data = ok(
      [
        { 通貨名: "btc", JPY建て年中購入数量: "1", JPY建て年中購入金額: "10000000", 年末数量: "1" },
        {
          通貨名: "jpy",
          年始数量: "10000000",
          JPY建て年中売却数量: "10000000",
          JPY建て年中売却金額: "10000000",
        },
      ],
      [spot("TRADE_SPOT_BUY", "btc", "1", "10000000")],
    );
    expect(data.rows.map((r) => r.diagnosis)).toEqual(data.rows.map(() => "MATCH"));
    expect(data.checks.every((c) => c.ok)).toBe(true);
  });

  it("報告書に行が無い銘柄は警告を出しつつ API 側だけで比較する", () => {
    const data = ok(
      [
        {
          通貨名: "jpy",
          年始数量: "10000000",
          JPY建て年中売却数量: "10000000",
          JPY建て年中売却金額: "10000000",
        },
      ],
      [spot("TRADE_SPOT_BUY", "btc", "1", "10000000")],
    );
    expect(find(data, "btc", "buy_qty")).toMatchObject({ report: "0", diagnosis: "API_EXCESS" });
    expect(data.warnings.join()).toContain("btc: 報告書に行がありません");
  });

  it("名寄せ後に衝突する行は明示エラー（片方の数量が黙って消えるのを防ぐ）", () => {
    const r = compare(
      [
        { 通貨名: "matic", 年末数量: "1" },
        { 通貨名: "pol", 年末数量: "2" },
      ],
      [],
    );
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error).toContain("Duplicate report currency");
  });

  it("ヒントは年分の取り違えを第一候補に挙げる（実運用で最初に踏んだ原因）", () => {
    const data = ok(
      [{ 通貨名: "btc", JPY建て年中購入数量: "2", JPY建て年中購入金額: "20000000", 年末数量: "2" }],
      [],
    );
    expect(find(data, "btc", "buy_qty")?.hint).toContain("対象年");
  });

  it("BTC 建て列に値があれば unsupported として出す（差の原因を隠さない）", () => {
    const data = ok([{ 通貨名: "xrp", BTC建て年中購入数量: "100", 年末数量: "100" }], []);
    expect(data.unsupported).toEqual([{ currency: "xrp", field: "buy_qty_btc", value: "100" }]);
    expect(data.warnings.join()).toContain("再現できない列");
  });
});

describe("手数料の許容幅", () => {
  /** 円側の手数料だけ差をつけた最小構成。R1 / R2 が閉じるように年末数量を合わせる。 */
  const withFee = (reportFee: string) => {
    const trades = Array.from({ length: 4 }, () =>
      spot("TRADE_SPOT_BUY", "btc", "0.1", "100000", "25"),
    );
    return ok(
      [
        {
          通貨名: "btc",
          JPY建て年中購入数量: "0.4",
          JPY建て年中購入金額: "400000",
          年末数量: "0.4",
        },
        {
          通貨名: "jpy",
          年始数量: "500000",
          JPY建て年中売却数量: "400000",
          JPY建て年中売却金額: "400000",
          支払手数料: reportFee,
          年末数量: String(100000 - Number(reportFee)),
        },
      ],
      trades,
    );
  };

  it("4 桁丸めで説明できる差は FEE_ROUNDING（許容幅は件数 × 半 ulp）", () => {
    const row = find(withFee("100.00015"), "jpy", "fee");
    expect(row).toMatchObject({ diagnosis: "FEE_ROUNDING", tolerance: "0.0002" });
  });

  it("丸めで説明できない差は REPORT_EXCESS のまま残す", () => {
    expect(find(withFee("100.5"), "jpy", "fee")).toMatchObject({ diagnosis: "REPORT_EXCESS" });
  });
});
