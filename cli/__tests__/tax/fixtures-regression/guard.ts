// 実データ fixtures を使う回帰テストの入口ガード（docs/dev/tax-fixtures-plan.md）。
//
// 3 状態を明確に分ける:
//   - **データ無し** → skip（fail にしない。CI は常にこの経路）
//   - **データ相違**（manifest の SHA-256 と不一致 / 欠落）→ **fail**
//     「想定と違うデータで通ったつもり」を防ぐため
//   - 一致 → フル実行
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const ENV_VAR = "BITBANK_TAX_FIXTURES";
const HERE = dirname(fileURLToPath(import.meta.url));
const MANIFEST = join(HERE, "manifest.json");

export type ManifestFile = { path: string; sha256: string };
type Manifest = { files: ManifestFile[] };

export type GuardState =
  | { kind: "skip"; reason: string }
  | { kind: "ready"; root: string; files: number }
  | { kind: "mismatch"; root: string; missing: string[]; differing: string[]; extra: string[] };

function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/** gen-fixtures-manifest.ts の walk() と同じ規則（raw/ 再帰・`.json` のみ）。 */
function walkRaw(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name);
    if (e.isDirectory()) return walkRaw(full);
    return e.isFile() && e.name.endsWith(".json") ? [full] : [];
  });
}

function readManifest(): Manifest {
  return JSON.parse(readFileSync(MANIFEST, "utf8")) as Manifest;
}

/** fixtures の在否と同一性を判定する。テスト側はこの結果だけを見て分岐する。 */
export function checkFixtures(): GuardState {
  const root = process.env[ENV_VAR];
  if (!root) return { kind: "skip", reason: `${ENV_VAR} 未設定` };
  if (!existsSync(join(root, "raw"))) {
    return { kind: "skip", reason: `${ENV_VAR}=${root} に raw/ が無い` };
  }
  const manifest = readManifest();
  if (manifest.files.length === 0) {
    return { kind: "skip", reason: "manifest.json が空（gen-fixtures-manifest.ts で生成する）" };
  }
  return compare(root, manifest.files);
}

/** manifest と実ファイルの突合本体。manifest を差し替えてテストできるよう分離する。 */
export function compare(root: string, files: ManifestFile[]): GuardState {
  const missing: string[] = [];
  const differing: string[] = [];
  for (const f of files) {
    const full = join(root, f.path);
    if (!existsSync(full)) {
      missing.push(f.path);
    } else if (sha256(full) !== f.sha256) {
      differing.push(f.path);
    }
  }
  // manifest に無いファイルも不一致に数える。再採取したのに manifest を更新していない場合、
  // 「古い部分集合だけで通ったつもり」になるのを防ぐ（本ガードの目的そのもの）
  const known = new Set(files.map((f) => f.path));
  const extra = walkRaw(join(root, "raw"))
    .map((f) => relative(root, f).split(sep).join("/"))
    .filter((p) => !known.has(p))
    .sort();
  if (missing.length > 0 || differing.length > 0 || extra.length > 0) {
    return { kind: "mismatch", root, missing, differing, extra };
  }
  return { kind: "ready", root, files: files.length };
}

/** 不一致の内訳を人が読める形にする（どのファイルが一致しなかったかを必ず列挙する）。 */
export function formatMismatch(s: Extract<GuardState, { kind: "mismatch" }>): string {
  const list = (label: string, xs: string[]) =>
    xs.length === 0
      ? ""
      : `\n  ${label} (${xs.length}):\n${xs.map((x) => `    - ${x}`).join("\n")}`;
  return (
    `fixtures が manifest と一致しません（**データ相違**。データ無しの skip とは別状態）。` +
    `${list("欠落", s.missing)}${list("内容相違", s.differing)}${list("manifest に無い", s.extra)}\n` +
    `  再採取した場合は次で manifest を更新してください:\n` +
    `    ${ENV_VAR}=${s.root} npx tsx scripts/dev/tax/gen-fixtures-manifest.ts`
  );
}
