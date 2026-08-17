// 報告書だけで閉じる恒等式（R1 / R2）。API と突き合わせる前に列の読み違い・行の欠落を
// 弾くための検算なので、**成立しないときに黙って通さない**ことを固定する。
import { describe, expect, it } from "vitest";
import { parseAnnualReport } from "../../../tax/import-csv/annual-report.js";
import { parseCsv } from "../../../tax/import-csv/parse-csv.js";
import { reportChecks } from "../../../tax/verify/checks.js";
import { buildCsv, type Row } from "./synthetic-report.js";

function checks(rows: readonly Row[]) {
  const parsed = parseAnnualReport(parseCsv(buildCsv(rows)));
  if (!parsed.success) throw new Error(parsed.error);
  return reportChecks(parsed.data.rows);
}

const byId = (r: ReturnType<typeof checks>, id: string, target?: string) =>
  r.checks.find((c) => c.id === id && (target === undefined || c.target === target));

/** R1: 年末 = 年始 + 購入 − 売却 + 移入 − 移出 − 手数料 */
const flow: Row = {
  通貨名: "eth",
  年始数量: "1",
  JPY建て年中購入数量: "2",
  JPY建て年中売却数量: "0.5",
  移入数量: "0.25",
  移出数量: "0.75",
  支払手数料: "0.001",
  年末数量: "1.999",
};

describe("R1（行内の恒等式）", () => {
  it("年末数量が年中フローと整合すれば ok", () => {
    expect(byId(checks([flow]), "R1", "eth")?.ok).toBe(true);
  });

  it("整合しなければ残差を出す（黙って通さない）", () => {
    const r = checks([{ ...flow, 年末数量: "2" }]);
    expect(byId(r, "R1", "eth")).toMatchObject({ ok: false });
    expect(byId(r, "R1", "eth")?.detail).toContain("0.001");
  });

  it("移出手数料を年末数量に含めた解釈だと落ちる（列の読み違いを検出できる）", () => {
    // 支払手数料を引かない実装＝報告書の列解釈が違う。残差は手数料ぶんだけ出る
    expect(byId(checks([{ ...flow, 支払手数料: "0" }]), "R1", "eth")?.ok).toBe(false);
  });

  it("全ゼロ行は検算しない（意味のある検査にならない）", () => {
    expect(checks([{ 通貨名: "bcc" }]).checks.filter((c) => c.id === "R1")).toEqual([]);
  });

  it("貸出列に値があれば R1 をスキップして警告する（恒等式の形が未確認のため）", () => {
    const r = checks([{ ...flow, 貸出数量: "1" }]);
    expect(byId(r, "R1", "eth")).toBeUndefined();
    expect(r.warnings.join()).toContain("貸出列");
  });
});

describe("R2（行間の恒等式）", () => {
  const crypto: Row = {
    通貨名: "btc",
    JPY建て年中購入数量: "1",
    JPY建て年中購入金額: "1000",
    JPY建て年中売却数量: "0.5",
    JPY建て年中売却金額: "600",
    年末数量: "0.5",
  };
  const jpy: Row = {
    通貨名: "jpy",
    年始数量: "1000",
    JPY建て年中購入数量: "600",
    JPY建て年中購入金額: "600",
    JPY建て年中売却数量: "1000",
    JPY建て年中売却金額: "1000",
    年末数量: "600",
  };

  it("JPY 行が暗号資産行の鏡像になっていれば ok", () => {
    const r = checks([crypto, jpy]);
    expect(byId(r, "R2-buy")?.ok).toBe(true);
    expect(byId(r, "R2-sell")?.ok).toBe(true);
  });

  it("行が欠けていれば差として現れる", () => {
    // 暗号資産行が 1 本抜けた CSV（手で削られた等）は JPY 行との差で気づける
    const r = checks([jpy]);
    expect(byId(r, "R2-buy")).toMatchObject({ ok: false });
    expect(byId(r, "R2-sell")?.detail).toContain("1000");
  });

  it("JPY 行が無ければ検算せず警告する", () => {
    const r = checks([crypto]);
    expect(byId(r, "R2-buy")).toBeUndefined();
    expect(r.warnings.join()).toContain("JPY 行");
  });
});
