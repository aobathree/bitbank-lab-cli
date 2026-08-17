#!/usr/bin/env npx tsx
// Write (or verify) the release version across the plugin manifests.
//
// これらのマニフェストは **npm tarball に入らない**（package.json の `files` 対象外）。
// 読み手は marketplace / plugin client で、参照するのは **git tag のツリー**。
// release.yml は tag が push された後に走るため、CI からでは tagged tree を直せない。
// よって書き込みは「tag を切る前のローカル作業」、CI 側は `--check` で照合だけする。
//
// package.json は対象外。あちらは `0.0.0-dev` を置いたままにして publish 直前に
// `npm version <tag>` が注入する。手で実バージョンを書くと tag と一致してしまい
// `npm version` が "Version not changed" で落ちる（bitbank-lab-mcp#30 と同じ罠）。
//
// 置換は正規表現で行う（JSON.parse → stringify だと各ファイルの字下げとキー順が壊れる）。
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** version を同期する plugin manifest。`.claude-plugin/marketplace.json` は
 *  marketplace カタログで version を持たないため対象外。 */
export const TARGETS = [
  ".claude-plugin/plugin.json",
  ".cursor-plugin/plugin.json",
  ".codex-plugin/plugin.json",
  "gemini-extension.json",
  "plugin.json",
] as const;

/** package.json に置く固定プレースホルダ。実バージョンは publish 直前に注入される。 */
export const DEV_PLACEHOLDER = "0.0.0-dev";

const VERSION_RE = /("version"\s*:\s*")([^"]+)(")/;

/** manifest に書かれている version 文字列を返す（フィールドが無ければ null）。 */
export function readVersion(rel: string): string | null {
  return readFileSync(join(ROOT, rel), "utf-8").match(VERSION_RE)?.[2] ?? null;
}

function write(version: string): number {
  let changed = 0;
  for (const rel of TARGETS) {
    const before = readFileSync(join(ROOT, rel), "utf-8");
    const after = before.replace(VERSION_RE, `$1${version}$3`);
    if (after === before) continue;
    writeFileSync(join(ROOT, rel), after);
    console.log(`  ${rel} -> ${version}`);
    changed++;
  }
  console.log(`sync-version: ${changed}/${TARGETS.length} manifests written as ${version}`);
  return 0;
}

function check(version: string): number {
  const mismatched = TARGETS.map((rel) => [rel, readVersion(rel)] as const).filter(
    ([, found]) => found !== version,
  );
  if (mismatched.length === 0) {
    console.log(`sync-version: all ${TARGETS.length} manifests match ${version}`);
    return 0;
  }
  console.error(`sync-version: expected ${version}, but the committed manifests say:`);
  for (const [rel, found] of mismatched) {
    console.error(`  ${rel}: ${found ?? "(no version field)"}`);
  }
  console.error("");
  console.error("plugin manifest は tag のツリーから読まれるので CI では直せない。");
  console.error(`修正手順: npx tsx scripts/sync-version.ts ${version} → commit → tag を切り直す`);
  return 1;
}

function main(): void {
  const args = process.argv.slice(2);
  const checking = args[0] === "--check";
  const version = (checking ? args[1] : args[0])?.replace(/^v/, "");
  if (!version) {
    console.error("usage: sync-version.ts [--check] <version>   (e.g. 0.3.0 / v0.3.0)");
    process.exit(2);
  }
  for (const rel of TARGETS) {
    if (readVersion(rel) === null) {
      console.error(`sync-version: no version field found in ${rel}`);
      process.exit(1);
    }
  }
  process.exit(checking ? check(version) : write(version));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
