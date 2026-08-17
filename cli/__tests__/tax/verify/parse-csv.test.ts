// CSV パーサと年間取引報告書の読み取り。**列名で引く**ことが本体の性質なので、
// 列の挿入・並べ替えで壊れないことと、欠けたら黙って進まないことを固定する。
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT } from "../../../exit-codes.js";
import { parseAnnualReport } from "../../../tax/import-csv/annual-report.js";
import { parseMarginReport } from "../../../tax/import-csv/margin-report.js";
import { MARGIN_HEADER_MARKER } from "../../../tax/import-csv/margin-report-columns.js";
import { parseCsv, readCsvFile } from "../../../tax/import-csv/parse-csv.js";
import { buildCsv, buildMarginCsv, HEADER, MARGIN_HEADER } from "./synthetic-report.js";

const table = (csv: string) => parseCsv(csv);

describe("parseCsv", () => {
  it("BOM を落とす（先頭セルが列名と一致しなくなるのを防ぐ）", () => {
    expect(parseCsv("﻿通貨名,年始数量\nbtc,1")[0][0]).toBe("通貨名");
  });

  it("CRLF と LF のどちらでも行を切る", () => {
    expect(parseCsv("a,b\r\nc,d\ne,f")).toEqual([
      ["a", "b"],
      ["c", "d"],
      ["e", "f"],
    ]);
  });

  it("引用符内のカンマ・改行・二重引用符を保持する", () => {
    expect(parseCsv('"a,1","b\nc","d""e"')).toEqual([["a,1", "b\nc", 'd"e']]);
  });

  it("末尾の改行で空行を作らない", () => {
    expect(parseCsv("a,b\n")).toEqual([["a", "b"]]);
  });
});

// ファイル読みは **throw を外へ出さない**（Result パターン）ことが要。巨大ファイルでは
// decode が RangeError を投げるので、読む前にサイズで閉じる。巨大 fixture は置かず、
// 上限を小さく注入して境界だけを固定する。
describe("readCsvFile", () => {
  let dir: string;
  const write = (name: string, body: string | Uint8Array): string => {
    const path = join(dir, name);
    writeFileSync(path, body);
    return path;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tax-csv-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("BOM 付き UTF-8 を読める（bitbank の書き出し形式）", () => {
    const r = readCsvFile(write("utf8.csv", "﻿通貨名,年始数量\nbtc,1\n"));
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data).toEqual([
        ["通貨名", "年始数量"],
        ["btc", "1"],
      ]);
    }
  });

  it("Shift_JIS（Excel 経由）を読み直せる", () => {
    // "通貨名,1"。先頭が 0x92 で UTF-8 としては不正なので Shift_JIS へ落ちる経路
    const sjis = new Uint8Array([0x92, 0xca, 0x89, 0xdd, 0x96, 0xbc, 0x2c, 0x31]);
    const r = readCsvFile(write("sjis.csv", sjis));
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toEqual([["通貨名", "1"]]);
  });

  it("どちらの符号化でも読めないバイト列は Result のエラー", () => {
    const r = readCsvFile(write("broken.csv", new Uint8Array([0x81, 0xff])));
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error).toContain("neither UTF-8 nor Shift_JIS");
      expect(r.exitCode).toBe(EXIT.PARAM);
    }
  });

  it("上限を超えるファイルは読まずに Result のエラー（Fatal へ抜けさせない）", () => {
    const r = readCsvFile(write("big.csv", "a,b\n".repeat(64)), 128);
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error).toContain("too large");
      expect(r.exitCode).toBe(EXIT.PARAM);
    }
  });

  it("上限ちょうどは通し、1 バイト超で落とす（境界を off-by-one で緩めない）", () => {
    const path = write("edge.csv", "a,b\n"); // 4 バイト
    expect(readCsvFile(path, 4).success).toBe(true);
    expect(readCsvFile(path, 3).success).toBe(false);
  });

  it("存在しないファイルは Result のエラー（statSync の throw を漏らさない）", () => {
    const r = readCsvFile(join(dir, "missing.csv"));
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error).toContain("Cannot read CSV file");
      expect(r.exitCode).toBe(EXIT.PARAM);
    }
  });
});

describe("parseAnnualReport", () => {
  const ok = (csv: string) => {
    const r = parseAnnualReport(table(csv));
    if (!r.success) throw new Error(r.error);
    return r.data;
  };

  it("1 行目のメタ行を飛ばしてヘッダ行を見つける", () => {
    const d = ok(buildCsv([{ 通貨名: "btc", 年始数量: "1.5" }]));
    expect(d.rows).toHaveLength(1);
    expect(d.rows[0]).toMatchObject({ currency: "btc", opening_qty: "1.5" });
  });

  it("列が挿入されても位置ずれしない（列名で引く）", () => {
    // 位置で引く実装なら「メモ」以降が 1 列ずつずれ、数字は読めてしまうので気づけない
    const header = [...HEADER.slice(0, 2), "メモ", ...HEADER.slice(2)];
    const d = ok(buildCsv([{ 通貨名: "btc", 年末数量: "2" }], header));
    expect(d.rows[0].closing_qty).toBe("2");
    expect(d.unknownColumns).toEqual(["メモ"]);
  });

  it("必須列が欠けたら明示エラー（欠測をゼロとして進めない）", () => {
    const header = HEADER.filter((h) => h !== "支払手数料");
    const r = parseAnnualReport(table(buildCsv([{ 通貨名: "btc" }], header)));
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error).toContain("fee");
  });

  it("十進文字列として読めない値は行番号付きで落とす", () => {
    // 桁区切り付き（引用符でくくられた `1,000`）。number 化する実装なら通ってしまう
    const r = parseAnnualReport(table(buildCsv([{ 通貨名: "btc", 年始数量: '"1,000"' }])));
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error).toContain("line 3");
  });

  it("同じ既知列が 2 本あればエラー（後勝ちで誤った値を採用しない）", () => {
    const header = [...HEADER, "支払手数料"];
    const r = parseAnnualReport(table(buildCsv([{ 通貨名: "btc" }], header)));
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error).toContain("duplicate columns: 支払手数料");
  });

  it("ヘッダが無ければエラー（別の CSV を渡された場合）", () => {
    expect(parseAnnualReport(table("date,amount\n2026-01-01,1")).success).toBe(false);
  });

  it("末尾の空行は行にしない", () => {
    expect(ok(`${buildCsv([{ 通貨名: "btc" }])}\r\n,,,,,,,,,,,,,,,,`).rows).toHaveLength(1);
  });
});

// 信用の社内資料は「出力項目」リストが注記なし・「CSVラベル名」表が `（円）` 付きで
// **食い違っていた**。実機確認 #10 で**実物は注記付き**と判明している（`MARGIN_HEADER`）。
// 注記付きを弾くと、正しいファイルに「様式が違う」と出る（しかも目印の列なので
// ファイル全体が読めない）。資料の片方だけに賭けず、両方の様式を固定する。
describe("見出しの単位注記", () => {
  /** 要件定義側の様式（注記なし）。実物ではないが、資料が食い違うので読めること */
  const plain = MARGIN_HEADER.map((h) => h.replace("（円）", ""));

  it("実物の様式（「（円）」付き）で読める", () => {
    const r = parseMarginReport(table(buildMarginCsv([{ 通貨名: "btc" }])));
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.unknownColumns).toEqual([]);
  });

  it("目印の列だけが注記付きでも見つかる（見つからないとファイル全体が読めない）", () => {
    // ヘッダ行の探索は列の対応付けとは**別の照合**なので、目印列だけを注記付きにして
    // 単独で固定する（全列を注記付きにすると上のケースと同じになり、何も切り分けない）
    const onlyMarker = plain.map((h) => (h === MARGIN_HEADER_MARKER ? `${h}（円）` : h));
    expect(parseMarginReport(table(buildMarginCsv([{ 通貨名: "btc" }], onlyMarker))).success).toBe(
      true,
    );
  });

  it("注記なしの見出しも読める（資料の片方はこの様式だった）", () => {
    const r = parseMarginReport(table(buildMarginCsv([{ 通貨名: "btc" }], plain)));
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.unknownColumns).toEqual([]);
  });

  it("実物の列順（買建玉が先）で買と売を取り違えない", () => {
    // 位置で引く実装なら**入れ替わったまま黙って通る**。値で区別できる形で固定する
    const r = parseMarginReport(
      table(buildMarginCsv([{ 通貨名: "btc", 年末保有中買建玉: "2", 年末保有中売建玉: "3" }])),
    );
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.rows[0].end_long_position).toBe("2");
      expect(r.data.rows[0].end_short_position).toBe("3");
    }
  });

  it("注記の有無で同じ列が 2 本あればエラー（どちらが正かは人が決める）", () => {
    const dup = [...MARGIN_HEADER, "支払手数料（円）"];
    const r = parseMarginReport(table(buildMarginCsv([{ 通貨名: "btc" }], dup)));
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error).toContain("duplicate columns");
  });

  it("注記を落としても未知の列は未知のまま（部分一致で別の列に化けない）", () => {
    const extra = [...MARGIN_HEADER, "翌年繰越（円）"];
    const r = parseMarginReport(table(buildMarginCsv([{ 通貨名: "btc" }], extra)));
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.unknownColumns).toEqual(["翌年繰越（円）"]);
  });
});
