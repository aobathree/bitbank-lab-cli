// 実データ fixtures の同一性マニフェストを生成する（docs/dev/tax-fixtures-plan.md）。
//   BITBANK_TAX_FIXTURES=/path/to/fixtures npx tsx scripts/dev/tax/gen-fixtures-manifest.ts
//
// 出力先は「読む側と同居」させる: cli/__tests__/tax/fixtures-regression/manifest.json
// 記録するのは **相対パスと SHA-256 のみ**。集計値（件数・金額）は書かない
// （絶対件数は口座規模の情報になるため。同一性の担保は SHA-256 だけで足りる）。
// 走査規則（raw/ 配下を再帰・`.json` のみ）は guard.ts と一致させること。
// ずれると manifest に無いファイルを「余剰」と誤検出する。
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { ENV_VAR, fixturesRoot, rawRoot } from "./fixtures-root.js";

const OUT = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../cli/__tests__/tax/fixtures-regression/manifest.json",
);

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name);
    if (e.isDirectory()) return walk(full);
    return e.isFile() && e.name.endsWith(".json") ? [full] : [];
  });
}

function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

const root = fixturesRoot();
const raw = rawRoot();
if (!existsSync(raw)) {
  throw new Error(`${ENV_VAR} が指す ${raw} が存在しません`);
}

// パス区切りを POSIX 化して OS 間で同一のマニフェストになるようにする
const files = walk(raw)
  .map((f) => ({ path: relative(root, f).split(sep).join("/"), sha256: sha256(f) }))
  .sort((a, b) => (a.path < b.path ? -1 : 1));

const manifest = {
  note:
    "実データ fixtures の同一性マニフェスト（生成物）。実データは本リポジトリに置かない。" +
    "集計値（件数・金額）は記録しない。パスは実ファイル名をそのまま用いる（不一致ファイルの特定に必要なため）。",
  generator: "scripts/dev/tax/gen-fixtures-manifest.ts",
  env_var: ENV_VAR,
  files,
};
writeFileSync(OUT, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`written: ${OUT} (${files.length} files)`);
