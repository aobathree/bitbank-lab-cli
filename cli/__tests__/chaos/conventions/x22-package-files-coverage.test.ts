import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, sep } from "node:path";
import { describe, expect, it } from "vitest";

/** package.json の `files` は**ディレクトリを 1 つずつ列挙**している（`cli/*.ts` は
 * ルート直下のファイルにしかマッチしない）。新しいサブディレクトリを `cli/` へ足しても
 * 追記を忘れると、**ローカルとテストは全部 green のまま npm 版だけが実行時に落ちる**
 * （ERR_MODULE_NOT_FOUND）。tsc も biome も vitest も検知できない経路なのでここで固定する。
 *
 * 前科: `cli/portfolio/`（balance-history の計算本体）を追加した際、`files` への追記が
 * 漏れてコマンドが npm 経由で起動不能な状態で PR に出た。
 *
 * 判定は `npm pack --dry-run` の実出力を単一ソースにする。`files` のグロブ意味論を
 * 自前で再現すると、その再現自体がズレる。
 */

const PACKAGED = new Set(packedPaths());

function packedPaths(): string[] {
  const out = execFileSync("npm", ["pack", "--dry-run", "--json"], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const parsed = JSON.parse(out) as { files: { path: string }[] }[];
  return parsed[0].files.map((f) => f.path);
}

/** 配布対象になるべき cli/ 配下の .ts（テストと fixtures は除く）。
 *  `npm pack --json` は常に POSIX 区切りで返すので、join() の結果も揃える
 *  （Windows では `\` になり、揃えないと全件が「未同梱」に化ける）。 */
function shippableSources(): string[] {
  return readdirSync("cli", { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && e.name.endsWith(".ts"))
    .map((e) => join(e.parentPath, e.name).split(sep).join("/"))
    .filter((f) => !f.includes("__tests__"));
}

describe("Chaos X-22: cli/ のソースが npm パッケージから漏れない", () => {
  it("パッケージに cli/ のファイルが含まれている（列挙ロジックの退行検知）", () => {
    expect([...PACKAGED].filter((p) => p.startsWith("cli/")).length).toBeGreaterThan(0);
  });

  it("cli/ 配下の全ソースが package.json の files でカバーされている", () => {
    const missing = shippableSources().filter((f) => !PACKAGED.has(f));
    if (missing.length > 0) {
      expect.fail(
        `npm パッケージに含まれないソースがあります（package.json の "files" に追記してください）:\n${missing.join("\n")}`,
      );
    }
  });

  it("bin と agents カタログも同梱される（CLI 起動と機械可読カタログの前提）", () => {
    expect(PACKAGED.has("bin/bitbank")).toBe(true);
    expect(PACKAGED.has("agents/tool-catalog.json")).toBe(true);
  });
});
