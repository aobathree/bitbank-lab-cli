// loadCarryover の読み取り失敗の「理由の別」を固定する。errno → 文言の変換は
// cli/fs-error.ts が単一ソースで、readCsvFile 側（tax/import-csv/parse-csv-errno.test.ts）
// と同じ 3 分岐になることをここでも確かめる（片方だけ直る事故を防ぐ）。
//
// parseCarryover 本体（正規化・重複・decimal 検証）のテストは tax/commands.test.ts 側にある。
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EXIT } from "../../exit-codes.js";
import { loadCarryover } from "../../tax/carryover.js";

vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  readFileSync: vi.fn(),
}));

const read = vi.mocked(readFileSync);

/** errno を持つ例外。Node の fs が投げる形（Error + `code`）に合わせる。 */
const errno = (code: string): Error => Object.assign(new Error(`${code}: mocked`), { code });

const throws = (e: unknown): void => {
  read.mockImplementation(() => {
    throw e;
  });
};

const errorOf = (path = "carryover.json"): string => {
  const r = loadCarryover(path);
  if (r.success) throw new Error("expected failure");
  expect(r.exitCode).toBe(EXIT.PARAM); // 分類は変えない
  return r.error;
};

// 式形の arrow にしない。mock を返すと vitest が teardown 関数と見なして呼んでしまう
beforeEach(() => {
  read.mockReset();
});

describe("loadCarryover: 読み取り失敗の理由", () => {
  it("ENOENT は「ファイルが無い」と分かる", () => {
    throws(errno("ENOENT"));
    expect(errorOf()).toBe("Cannot read carryover file: carryover.json (file not found)");
  });

  it("EPERM は「権限で読めない」と分かる", () => {
    throws(errno("EPERM"));
    expect(errorOf()).toBe("Cannot read carryover file: carryover.json (permission denied)");
  });

  it("EACCES も EPERM と同じ「権限で読めない」に寄せる", () => {
    throws(errno("EACCES"));
    expect(errorOf()).toBe("Cannot read carryover file: carryover.json (permission denied)");
  });

  it("マップしていない errno は推測で言い換えず現行の文言のまま", () => {
    throws(errno("EISDIR"));
    expect(errorOf()).toBe("Cannot read carryover file: carryover.json");
  });

  it("code を持たない例外でも throw を漏らさず現行の文言のまま", () => {
    throws(new Error("boom"));
    expect(errorOf()).toBe("Cannot read carryover file: carryover.json");
  });

  it("JSON が壊れている経路の文言は変えない（読めてはいるので理由を足さない）", () => {
    read.mockReturnValue("{ broken");
    const r = loadCarryover("carryover.json");
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error).toBe("Carryover file is not valid JSON: carryover.json");
  });

  it("読めるときは従来どおりパースする（モック配線が経路を潰していないこと）", () => {
    read.mockReturnValue('{ "btc": { "qty": "1.5", "cost_jpy": "931800" } }');
    const r = loadCarryover("carryover.json");
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.btc.qty).toEqual({ n: 3n, d: 2n });
  });
});
