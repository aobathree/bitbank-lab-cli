import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkFixtures, compare, ENV_VAR, formatMismatch } from "./guard.js";

// ガード自体のテスト（実データ不要）。実データ回帰は fixtures.test.ts が担う。
describe("fixtures ガード: 3 状態の判定", () => {
  it("環境変数が無ければ skip（fail にしない）", () => {
    const saved = process.env[ENV_VAR];
    delete process.env[ENV_VAR];
    const s = checkFixtures();
    expect(s.kind).toBe("skip");
    if (s.kind === "skip") expect(s.reason).toContain(ENV_VAR);
    if (saved !== undefined) process.env[ENV_VAR] = saved;
  });

  it("環境変数が指す先に raw/ が無ければ skip", () => {
    const saved = process.env[ENV_VAR];
    process.env[ENV_VAR] = "/nonexistent-path-for-test";
    const s = checkFixtures();
    expect(s.kind).toBe("skip");
    if (s.kind === "skip") expect(s.reason).toContain("raw/");
    if (saved === undefined) delete process.env[ENV_VAR];
    else process.env[ENV_VAR] = saved;
  });

  it("不一致メッセージは skip と区別でき、対象ファイルを列挙し、再生成手順を含む", () => {
    const msg = formatMismatch({
      kind: "mismatch",
      root: "/tmp/fx",
      missing: ["raw/batch1/a.json"],
      differing: ["raw/batch1/b.json", "raw/batch2/c.json"],
      extra: [],
    });
    expect(msg).toContain("データ相違");
    expect(msg).toContain("skip とは別状態");
    expect(msg).toContain("raw/batch1/a.json");
    expect(msg).toContain("raw/batch1/b.json");
    expect(msg).toContain("raw/batch2/c.json");
    expect(msg).toContain("欠落 (1)");
    expect(msg).toContain("内容相違 (2)");
    expect(msg).toContain("gen-fixtures-manifest.ts");
  });

  // 再採取したのに manifest を更新していないと、古い部分集合だけで通ってしまう。
  // それを「一致」と report しないのがこのガードの目的
  it("manifest に無いファイル（余剰）も不一致として列挙する", () => {
    const msg = formatMismatch({
      kind: "mismatch",
      root: "/tmp/fx",
      missing: [],
      differing: [],
      extra: ["raw/batch3/new.json"],
    });
    expect(msg).toContain("manifest に無い (1)");
    expect(msg).toContain("raw/batch3/new.json");
  });
});

describe("fixtures ガード: manifest との突合", () => {
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");

  function fixtureRoot(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), "fx-"));
    for (const [rel, body] of Object.entries(files)) {
      const full = join(root, rel);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, body);
    }
    return root;
  }

  it("manifest と完全一致なら ready", () => {
    const root = fixtureRoot({ "raw/a.json": "{}\n" });
    expect(compare(root, [{ path: "raw/a.json", sha256: sha("{}\n") }])).toEqual({
      kind: "ready",
      root,
      files: 1,
    });
  });

  // 再採取したのに manifest を更新しないと、古い部分集合だけで「通ったつもり」になる
  it("manifest に無いファイルが raw/ にあれば mismatch（extra に入る）", () => {
    const root = fixtureRoot({ "raw/a.json": "{}\n", "raw/batch2/new.json": "{}\n" });
    const s = compare(root, [{ path: "raw/a.json", sha256: sha("{}\n") }]);
    expect(s.kind).toBe("mismatch");
    if (s.kind === "mismatch") {
      expect(s.extra).toEqual(["raw/batch2/new.json"]);
      expect(s.missing).toEqual([]);
      expect(s.differing).toEqual([]);
    }
  });

  it("内容が変わっていれば differing に入る", () => {
    const root = fixtureRoot({ "raw/a.json": "{changed}\n" });
    const s = compare(root, [{ path: "raw/a.json", sha256: sha("{}\n") }]);
    expect(s.kind).toBe("mismatch");
    if (s.kind === "mismatch") expect(s.differing).toEqual(["raw/a.json"]);
  });

  it("`.json` 以外は余剰に数えない（生成器の走査規則と一致させる）", () => {
    const root = fixtureRoot({ "raw/a.json": "{}\n", "raw/notes.md": "memo\n" });
    expect(compare(root, [{ path: "raw/a.json", sha256: sha("{}\n") }]).kind).toBe("ready");
  });
});
