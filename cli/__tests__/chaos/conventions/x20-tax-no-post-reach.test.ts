import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/** tax は「private GET のみ・POST は絶対に叩かない」が中核制約
 * （ADR-004 / CLAUDE.md の tax 例外節 / .claude/rules/commands.md）。
 * x09（paper）・x11（profile）は直接 import だけを見るが、tax は
 * cli/tax/ と cli/commands/tax/ に層が分かれていて経路が長いため、
 * relative import を辿った推移的到達で検査する。
 * `import type ...` は compile time に消えて API を呼べないので x09 に倣って除外する
 * （tax は `import type { PrivateHttpOptions } from "../../http-private.js"` を多用する。
 * これは GET ヘルパーの型なので禁止対象ではない）。
 * `import { type X, value }` のような inline type 指定は value import 側に残るので辿る。
 */

const ROOTS = ["cli/tax", "cli/commands/tax"];
const FORBIDDEN = "cli/http-private-post.ts";

/** `[^;]*?` が文をまたがないので、複数行 import も side-effect import も取り違えない
 * （biome の `semicolons: "always"` 前提）。specifier は relative のみ拾う。 */
const STATIC_IMPORT_RE = /(?:^|\n)[ \t]*(?:import|export)([^;]*?)\bfrom\s*["'](\.[^"']*)["']/g;
const DYNAMIC_IMPORT_RE = /\bimport\(\s*["'](\.[^"']*)["']\s*\)/g;
/** `from` を持たない side-effect import（束縛は無いがモジュールは評価される） */
const BARE_IMPORT_RE = /(?:^|\n)[ \t]*import\s*["'](\.[^"']*)["']/g;

function tsFilesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && e.name.endsWith(".ts"))
    .map((e) => join(e.parentPath, e.name))
    .filter((f) => !f.includes("__tests__"));
}

function relativeImports(file: string): string[] {
  const src = readFileSync(file, "utf-8");
  const specs: string[] = [];
  for (const [, clause, spec] of src.matchAll(STATIC_IMPORT_RE)) {
    if (/^\s+type\b/.test(clause)) continue;
    specs.push(spec);
  }
  for (const [, spec] of src.matchAll(DYNAMIC_IMPORT_RE)) specs.push(spec);
  for (const [, spec] of src.matchAll(BARE_IMPORT_RE)) specs.push(spec);
  return specs;
}

/** NodeNext の `.js` 指定を実ファイル（`.ts` / ディレクトリの index.ts）に戻す */
function resolveSpec(from: string, spec: string): string | null {
  const base = resolve(dirname(from), spec).replace(/\.js$/, "");
  for (const candidate of [`${base}.ts`, join(base, "index.ts")]) {
    if (existsSync(candidate)) return relative(process.cwd(), candidate);
  }
  return null;
}

/** seed から relative import を BFS。到達したファイル → そこまでの経路を返す。 */
function walkFromTax(): { chains: Map<string, string[]>; unresolved: string[] } {
  const seeds = ROOTS.flatMap(tsFilesUnder);
  const chains = new Map<string, string[]>();
  const unresolved: string[] = [];
  const queue = seeds.map((file) => [file]);
  while (queue.length > 0) {
    const chain = queue.shift() as string[];
    const file = chain[chain.length - 1];
    if (chains.has(file)) continue;
    chains.set(file, chain);
    for (const spec of relativeImports(file)) {
      const target = resolveSpec(file, spec);
      if (target === null) unresolved.push(`${file}: ${spec}`);
      else if (!chains.has(target)) queue.push([...chain, target]);
    }
  }
  return { chains, unresolved };
}

const reach = walkFromTax();

describe("Chaos X-20: tax は POST ヘルパーに到達しない（private GET のみ）", () => {
  it(`cli/tax/ ・ cli/commands/tax/ から ${FORBIDDEN} に推移的に到達しない`, () => {
    // 禁止対象が rename / typo で存在しなくなると chain は常に undefined になり、
    // 何も検査しないまま緑になる（fail-open）。先に存在を固定して fail-closed にする
    expect(
      existsSync(FORBIDDEN),
      `${FORBIDDEN} が存在しない。POST ヘルパーを rename したなら FORBIDDEN を追随させる`,
    ).toBe(true);
    const chain = reach.chains.get(FORBIDDEN);
    expect(
      chain,
      `tax は private GET のみで POST を叩いてはいけない（ADR-004 / CLAUDE.md tax 例外節）。到達経路:\n  ${chain?.join("\n    -> ")}`,
    ).toBeUndefined();
  });

  it("import グラフを実際に辿れている（自壊検知）", () => {
    expect(
      reach.unresolved,
      `relative import を解決できなかった。検査に穴が空くので resolveSpec を直す:\n${reach.unresolved.join("\n")}`,
    ).toEqual([]);
    // GET ヘルパーには到達する = tax の外へ辺を辿れている証拠
    expect(reach.chains.get("cli/http-private.ts"), "cli/http-private.ts に到達しなかった").toEqual(
      expect.arrayContaining(["cli/http-private.ts"]),
    );
    expect(reach.chains.size, "seed 数（tax 配下のファイル数）を上回る到達がない").toBeGreaterThan(
      ROOTS.flatMap(tsFilesUnder).length,
    );
  });
});
