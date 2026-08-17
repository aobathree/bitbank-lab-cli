// SCHEMA_SNAPSHOT.json を再生成する（raw/ を持つ環境で実行する）。
//   BITBANK_TAX_FIXTURES=/path/to/fixtures node scripts/dev/tax/tests/gen-schema-snapshot.mjs
// 出力先は repo 標準の回帰テストディレクトリ。生成物はそのままコミットできる。
// present は always / partial の区分のみで、絶対件数は出さない（口座規模の情報になるため）。
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSnapshot } from "./lib.mjs";

const out = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../cli/__tests__/tax/fixtures-regression/SCHEMA_SNAPSHOT.json",
);
writeFileSync(out, `${JSON.stringify(buildSnapshot(), null, 2)}\n`);
console.log(`written: ${out}`);
