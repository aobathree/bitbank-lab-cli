// 読み取り失敗の「理由の別」を固定する。パスはマスクで落ちる（error-sanitize.ts）ので、
// 理由まで捨てると「ファイルが無い」のか「権限で読めない」のかを利用者が切り分けられない。
// 特に macOS の TCC（保護フォルダ）は stat を通して open だけ止めるため `ls` が成功してしまい、
// 実口座の再検証では EPERM に行き着くまで遠回りした。errno 由来の文言をここで固定する。
//
// 実 fs では EPERM を再現できない（root で走ると chmod が効かない）のでモックで投げる。
// 実ファイルを使う readCsvFile のテストは tax/verify/parse-csv.test.ts 側にある。
//
// 100行超: 同じ fs モック配線の上で「errno 別の理由 / 理由を足さない経路 / 正常系」を
// 対で固定する。分割するとモック配線が二重化し、片方だけ直る事故を招く。
import type { Stats } from "node:fs";
import { readFileSync, statSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EXIT } from "../../../exit-codes.js";
import { readCsvFile } from "../../../tax/import-csv/parse-csv.js";

vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  statSync: vi.fn(),
  readFileSync: vi.fn(),
}));

const stat = vi.mocked(statSync);
const read = vi.mocked(readFileSync);

/** errno を持つ例外。Node の fs が投げる形（Error + `code`）に合わせる。 */
const errno = (code: string): Error => Object.assign(new Error(`${code}: mocked`), { code });

/** サイズ判定を通す stat。read 側の errno を見たいときに使う。 */
const statOk = (): void => {
  stat.mockReturnValue({ size: 8 } as Stats);
};

const errorOf = (path = "report.csv"): string => {
  const r = readCsvFile(path);
  if (r.success) throw new Error("expected failure");
  expect(r.exitCode).toBe(EXIT.PARAM); // 分類は変えない（読めない理由が何であれ入力起因）
  return r.error;
};

beforeEach(() => {
  stat.mockReset();
  read.mockReset();
});

describe("readCsvFile: 読み取り失敗の理由", () => {
  it("ENOENT は「ファイルが無い」と分かる（stat で落ちる経路）", () => {
    stat.mockImplementation(() => {
      throw errno("ENOENT");
    });
    expect(errorOf()).toBe("Cannot read CSV file: report.csv (file not found)");
  });

  it("EPERM は「権限で読めない」と分かる（stat は通り read で落ちる TCC の形）", () => {
    statOk();
    read.mockImplementation(() => {
      throw errno("EPERM");
    });
    expect(errorOf()).toBe("Cannot read CSV file: report.csv (permission denied)");
  });

  it("EACCES も EPERM と同じ「権限で読めない」に寄せる", () => {
    statOk();
    read.mockImplementation(() => {
      throw errno("EACCES");
    });
    expect(errorOf()).toBe("Cannot read CSV file: report.csv (permission denied)");
  });

  it("マップしていない errno は推測で言い換えず現行の文言のまま", () => {
    statOk();
    read.mockImplementation(() => {
      throw errno("EIO");
    });
    expect(errorOf()).toBe("Cannot read CSV file: report.csv");
  });

  it("code を持たない例外でも throw を漏らさず現行の文言のまま", () => {
    statOk();
    read.mockImplementation(() => {
      throw new Error("boom");
    });
    expect(errorOf()).toBe("Cannot read CSV file: report.csv");
  });

  it("読めるときは従来どおりパースする（モック配線が経路を潰していないこと）", () => {
    statOk();
    read.mockReturnValue(Buffer.from("a,b\nc,d\n"));
    const r = readCsvFile("report.csv");
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data).toEqual([
        ["a", "b"],
        ["c", "d"],
      ]);
    }
  });

  // 完全一致で見る。部分一致だと「理由が足された」以外の文言変化を取り逃がす
  it("サイズ上限超過の文言は据え置き（別経路として既に理由が出ている）", () => {
    stat.mockReturnValue({ size: 999 } as Stats);
    const r = readCsvFile("report.csv", 8);
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error).toBe("CSV file is too large: 999 bytes exceeds the 8 byte limit: report.csv");
    }
  });
});
