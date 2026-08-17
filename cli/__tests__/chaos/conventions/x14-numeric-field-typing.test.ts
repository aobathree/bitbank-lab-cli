import { execSync } from "node:child_process";
import { describe, expect, it } from "vitest";

// 数値らしいフィールド（price/amount/pnl/rate/fee/vol を含む名前）が
// 生の z.string() のまま定義されていないかを検知する。
// 防御版の numStr / nullableNumStr （cli/schema-helpers.ts）に統一する規約。
//
// PR #6 でゼロ件にする。違反が増えたら同じ helper に移行すること。
const NUMERIC_FIELD_PATTERN =
  "^[[:space:]]+\\w*(price|amount|pnl|rate|fee|vol)\\w*[[:space:]]*:[[:space:]]*z\\.string\\(\\)";

// 名前が numeric キーワードを含むが実際は文字列のフィールド（enum 等）
const NON_NUMERIC_SUFFIXES = ["_type", "_id", "_status", "_label", "_address", "_hash", "_kind"];

function isFalsePositive(line: string): boolean {
  const match = line.match(/(\w+)\s*:\s*z\.string\(\)/);
  if (!match) return false;
  const fieldName = match[1];
  return NON_NUMERIC_SUFFIXES.some((sfx) => fieldName.endsWith(sfx));
}

function violationsIn(dir: string): string[] {
  const cmd = `grep -rEn '${NUMERIC_FIELD_PATTERN}' ${dir} --include='*.ts' || true`;
  return execSync(cmd, { encoding: "utf-8" })
    .trim()
    .split("\n")
    .filter((l) => l !== "")
    .filter((l) => !isFalsePositive(l));
}

describe("Chaos X-14: numeric-like fields are not z.string()", () => {
  it("cli/commands/ defines no numeric-like field as z.string()", () => {
    const violations = violationsIn("cli/commands/");
    if (violations.length > 0) {
      expect.fail(
        `Numeric-like fields defined as z.string() (should use numStr / nullableNumStr from cli/schema-helpers.ts):\n${violations.join("\n")}`,
      );
    }
  });

  // 税務経路は number 化してはいけない（ADR-005 / v2 付録F）。そこで numStr ではなく
  // decStr（十進文字列のまま保持）を使う。**生の z.string() は同様に禁止**なので、
  // ディレクトリを分けて規約から外れるのではなく、規約側を cli/tax/ へ広げる。
  it("cli/tax/ defines no numeric-like field as z.string() (must use decStr)", () => {
    const violations = violationsIn("cli/tax/");
    if (violations.length > 0) {
      expect.fail(
        `Numeric-like fields defined as z.string() (tax path must use decStr from cli/schema-helpers.ts):\n${violations.join("\n")}`,
      );
    }
  });
});
