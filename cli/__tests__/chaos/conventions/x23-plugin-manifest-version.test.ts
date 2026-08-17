import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEV_PLACEHOLDER, readVersion, TARGETS } from "../../../../scripts/sync-version.js";

/** リリース版数の置き場所は 2 系統あり、**同期のタイミングが違う**。
 *
 *  1. `package.json` — npm tarball 向け。publish 直前に release.yml が
 *     `npm version <tag>` で注入する。git 上は `0.0.0-dev` のプレースホルダ。
 *     ここに実バージョンを手で書くと tag と一致して `npm version` が
 *     "Version not changed" で落ちる（前科: bitbank-lab-mcp#30 の v0.4.0）
 *  2. plugin manifest 5 種 — marketplace / plugin client 向け。tarball には
 *     入らず（`files` 対象外）、**git tag のツリー**から読まれる。release.yml は
 *     tag push 後に走るので CI からは直せず、tag を切る前に
 *     `scripts/sync-version.ts <version>` で書いて commit する必要がある
 *
 *  1 と 2 を取り違えると、どちらも「ローカルもテストも green のまま配布物だけ壊れる」
 *  経路になる。前科: 5 種の manifest が 0.2.0 のまま 0.3.0 がリリースされた。
 *  tag との一致は release.yml の `--check` が見るので、ここでは tag に依存しない
 *  不変条件（プレースホルダであること・5 種が揃っていること）だけを固定する。
 */
function readJson<T>(rel: string): T {
  return JSON.parse(readFileSync(join(process.cwd(), rel), "utf-8")) as T;
}

/** `npm pack --dry-run` の実出力を同梱判定の単一ソースにする（x22 と同じ）。 */
function packedPaths(): string[] {
  const out = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const parsed = JSON.parse(out) as { files: { path: string }[] }[];
  return parsed[0].files.map((f) => f.path);
}

describe("Chaos X-23: release version placement (package.json placeholder vs plugin manifests)", () => {
  it("package.json keeps the dev placeholder (never a real version)", () => {
    const pkg = readJson<{ version: string }>("package.json");
    expect(
      pkg.version,
      `package.json の version は ${DEV_PLACEHOLDER} 固定。実バージョンは publish 直前に ` +
        "release.yml が tag から注入する。手で上げると `npm version` が落ちる",
    ).toBe(DEV_PLACEHOLDER);
  });

  it("package-lock.json carries the same placeholder", () => {
    // `npm version` は package.json と package-lock.json の両方を書き換える。
    // 片方だけ手で戻すとプレースホルダが割れる（前科: このテストを入れた PR 自身）
    const lock = readJson<{ version: string; packages: Record<string, { version?: string }> }>(
      "package-lock.json",
    );
    for (const [where, version] of [
      ["root", lock.version],
      ['packages[""]', lock.packages[""]?.version],
    ] as const) {
      expect(
        version,
        `package-lock.json の ${where} が ${DEV_PLACEHOLDER} と揃っていない。` +
          "`npm version 0.0.0-dev --no-git-tag-version --allow-same-version` で揃える",
      ).toBe(DEV_PLACEHOLDER);
    }
  });

  it("all plugin manifests carry the same version", () => {
    const found = TARGETS.map((rel) => [rel, readVersion(rel)] as const);

    for (const [rel, version] of found) {
      expect(version, `${rel} に version フィールドが無い`).not.toBeNull();
    }

    const distinct = [...new Set(found.map(([, version]) => version))];
    expect(
      distinct,
      `plugin manifest の version が割れている: ${found.map(([r, v]) => `${r}=${v}`).join(", ")}\n` +
        "`npx tsx scripts/sync-version.ts <version>` で揃えてコミットする",
    ).toHaveLength(1);
  });

  it("plugin manifests are not shipped in the npm tarball (they are read from the git tree)", () => {
    // 判定は `npm pack --dry-run` の実出力を単一ソースにする（x22 と同じ理由）。
    // `files` の文字列一致だけでは、`*.json` やディレクトリ追加で manifest が
    // 紛れ込む経路を拾えない。tarball に入ると「publish 時に同期すれば足りる」という
    // 誤解が復活するので、載っていない側を実出力で固定する
    const packed = new Set(packedPaths());
    for (const rel of TARGETS) {
      expect(
        packed.has(rel),
        `${rel} が npm tarball に含まれている。plugin manifest の読み手は git tag の\n` +
          "ツリーであって tarball ではない。package.json の files から外す",
      ).toBe(false);
    }
  });
});
