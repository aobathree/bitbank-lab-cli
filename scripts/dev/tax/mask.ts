// マスキング: 識別子のみ MASKED_<FIELD>_<n> に置換（同一値は同一トークン → 突合構造を保持）。
// 数量・金額・日時・フィールド名・構造は一切変更しない。
// 対象: uuid / account_uuid / txid / address / label / destination_tag /
//        bank_name / branch_name / account_number / account_owner
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const RAW = process.argv[2];
if (!RAW) throw new Error("usage: tsx mask.ts <dir>");

// bitbank 側が返す定数プレースホルダー（個人識別子ではない）はそのまま保持する
const PLACEHOLDER = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx";

const MASK_FIELDS = new Set([
  "uuid",
  "account_uuid",
  "txid",
  "address",
  "label",
  "destination_tag",
  "bank_name",
  "branch_name",
  "account_number",
  "account_owner",
]);

const tokens = new Map<string, string>(); // "<field>:<value>" -> token
const counters = new Map<string, number>();

function tokenFor(field: string, value: unknown): string {
  const key = `${field}:${String(value)}`;
  const hit = tokens.get(key);
  if (hit) return hit;
  const n = (counters.get(field) ?? 0) + 1;
  counters.set(field, n);
  const t = `MASKED_${field.toUpperCase()}_${n}`;
  tokens.set(key, t);
  return t;
}

function maskNode(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(maskNode);
  if (node !== null && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      if (
        MASK_FIELDS.has(k) &&
        v !== null &&
        v !== undefined &&
        v !== PLACEHOLDER &&
        !(typeof v === "string" && v.startsWith("MASKED_"))
      ) {
        out[k] = tokenFor(k, v);
      } else {
        out[k] = maskNode(v);
      }
    }
    return out;
  }
  return node;
}

// **再帰的に**走査する。collect2.ts は `raw/batch2-<stamp>/` 配下に保存するため、
// 直下だけを見ると**未マスクの生データを残したまま「masked」と報告する**
let maskedFiles = 0;
function maskDir(dir: string): void {
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : 1,
  )) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      maskDir(p);
      continue;
    }
    if (!e.name.endsWith(".json")) continue;
    const body = JSON.parse(readFileSync(p, "utf8"));
    writeFileSync(p, `${JSON.stringify(maskNode(body), null, 2)}\n`);
    maskedFiles++;
    console.log(`masked: ${relative(RAW, p)}`);
  }
}
maskDir(RAW);
console.log(`masked files: ${maskedFiles}`);
console.log(
  `unique tokens: ${[...counters.entries()].map(([f, n]) => `${f}=${n}`).join(", ")}`,
);
