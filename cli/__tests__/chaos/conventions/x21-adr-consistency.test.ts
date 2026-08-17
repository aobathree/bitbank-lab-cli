import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/** docs/adr/ の採番・構成の不変条件を検査する（手順は `.claude/rules/adr.md`）。
 *
 * 本命は「並行ブランチでの採番衝突」。このリポジトリは `claude/new-session-*` が
 * 並行する運用で、2 セッションがそれぞれ `007-foo.md` と `007-bar.md` を作ると
 * **ファイル名が違うので git は競合を出さず、両方マージされる**。番号が重複した
 * まま main に入り、誰も気づかない。
 *
 * このテストは PR 単体では番号重複を検出できない（各ブランチには片方の ADR しか
 * 無いので両方緑になる）。main への push で初めて落ちる。CI が
 * `push: branches: [main]` を持つので、そこが検出点になる。
 *
 * **欠番は検査しない。** chaos 自身が既に x07 欠番であり、欠番は無害。逆に欠番を
 * 禁じると「破棄された番号の再利用」を促すことになり、そちらの方が危険。
 */
const ADR_DIR = resolve(import.meta.dirname, "../../../../docs/adr");

/** ADR 以外（索引等）を docs/adr/ に置くならここに明示する。パターン外のファイルを
 * 既定で違反にすることで、採番されない ADR の混入を黙って見逃さない */
const NON_ADR_FILES = ["README.md"];

const FILENAME_RE = /^(\d{3})-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;
/** 検査対象は**先頭行の H1 だけ**。本文中の任意行を探すと、先頭タイトルの番号が
 * ファイル名とズレていても、後続に正しい `# ADR-NNN:` が 1 行あれば通ってしまう
 * （リネーム時に本文の参照だけ直してタイトルを直し忘れる、が実際に起きる形）。
 * `#` の後ろとコロンの後ろも 1 個以上の空白に固定し、`.claude/rules/adr.md` が
 * 定める `# ADR-NNN: <タイトル>` そのものだけを許す */
const TITLE_RE = /^# ADR-(\d{3}):[ \t]+\S/;

/** 必須は 4 節。「理由」を必須に含めると **ADR-005 が落ちる**（理由が「決定」と
 * 「検討した代替案」に分散していて、独立した「## 理由」節を持たない）。ADR-005 に
 * 空に近い「理由」節を後付けするのは改悪なので、テスト側を 4 節必須に留め、
 * 5 節目の「理由」は `.claude/rules/adr.md` のテンプレートで推奨に格下げする */
const REQUIRED_SECTIONS = ["ステータス", "コンテキスト", "決定", "影響"];

/** 先頭語だけを見る。`Superseded by [ADR-009](...)` のように後続を伴う書き方と、
 * ADR-005 / ADR-006 の `Accepted（2026-07-25）` のような日付付きを両方許すため */
const KNOWN_STATUSES = ["Proposed", "Accepted", "Superseded", "Deprecated"];

/** `.md` で事前に絞らない。絞ると `007-foo.txt` や `007-foo.MD` が列挙から丸ごと
 * 消えて、番号重複の検査からも外れる（NON_ADR_FILES の「明示した例外以外は違反」
 * という契約に反する fail-open）。拡張子の判定は FILENAME_RE に一本化する。
 * dotfile だけは除く（`.DS_Store` 等の gitignore 済み OS 生成物でローカル実行が
 * 落ちるのを避ける。ADR が dotfile になることは無い）。 */
function adrFiles(): string[] {
  return readdirSync(ADR_DIR)
    .filter((f) => !f.startsWith(".") && !NON_ADR_FILES.includes(f))
    .filter((f) => statSync(resolve(ADR_DIR, f)).isFile())
    .sort();
}

/** フェンス内の行は見出し・ステータスとして数えない（ADR-005 は本文中に
 * コードブロックを多用する） */
function body(file: string): string {
  let inFence = false;
  return readFileSync(resolve(ADR_DIR, file), "utf-8")
    .split("\n")
    .filter((line) => {
      if (/^\s*```/.test(line)) {
        inFence = !inFence;
        return false;
      }
      return !inFence;
    })
    .join("\n");
}

function sectionsOf(src: string): string[] {
  return [...src.matchAll(/^##\s+(.+?)\s*$/gm)].map((m) => m[1]);
}

function statusWord(src: string): string | null {
  const m = src.match(/^##\s+ステータス\s*$\n+([^\n]+)/m);
  return m ? (m[1].trim().split(/[\s（(]/)[0] ?? null) : null;
}

const FILES = adrFiles();

describe("Chaos X-21: docs/adr/ numbering and structure", () => {
  it("ADR が 1 本以上ある（列挙が空振りしていない）", () => {
    expect(
      FILES.length,
      `${ADR_DIR} に ADR が 1 本も無い。列挙が壊れていないか確認する`,
    ).toBeGreaterThan(0);
  });

  it("ファイル名が NNN-kebab-case.md 形式", () => {
    const bad = FILES.filter((f) => !FILENAME_RE.test(f));
    expect(
      bad,
      `docs/adr/ のファイル名は NNN-kebab-case.md 形式にする（例: 007-foo-bar.md）。` +
        ` ADR 以外を置くなら x21 の NON_ADR_FILES に明示する。違反: ${bad.join(", ")}`,
    ).toEqual([]);
  });

  // 本命。番号が違えばファイル名も違うため、git は並行ブランチの採番衝突を検出しない
  it("番号の重複がない", () => {
    const byNumber = new Map<string, string[]>();
    for (const f of FILES) {
      const n = f.match(FILENAME_RE)?.[1];
      if (n) byNumber.set(n, [...(byNumber.get(n) ?? []), f]);
    }
    const dup = [...byNumber].filter(([, fs]) => fs.length > 1);
    expect(
      dup.map(([n, fs]) => `ADR-${n}: ${fs.join(" / ")}`),
      "ADR 番号が重複している。後発の ADR を最大番号 + 1 へリネームする（.claude/rules/adr.md）",
    ).toEqual([]);
  });

  for (const file of FILES) {
    const num = file.match(FILENAME_RE)?.[1];
    if (!num) continue; // 形式違反は上の it が報告する

    describe(file, () => {
      it("先頭行の見出しの ADR-NNN がファイル名の番号と一致する", () => {
        const firstLine = body(file).trimStart().split(/\r?\n/, 1)[0] ?? "";
        const m = firstLine.match(TITLE_RE);
        expect(m, `先頭行が '# ADR-NNN: <タイトル>' 形式でない。実際: ${firstLine}`).not.toBeNull();
        expect(m?.[1], `見出しの番号がファイル名 (${num}) と一致しない`).toBe(num);
      });

      it("必須 4 節が揃っている", () => {
        const found = sectionsOf(body(file));
        const missing = REQUIRED_SECTIONS.filter((s) => !found.includes(s));
        expect(missing, `不足している節（h2 で書く）: ${missing.join(" / ")}`).toEqual([]);
      });

      it("ステータスが既知の語彙", () => {
        const status = statusWord(body(file));
        expect(
          status,
          `ステータスは ${KNOWN_STATUSES.join(" / ")} のいずれか（日付や 'by ADR-NNN' の付記は可）。実際: ${status}`,
        ).toBeOneOf(KNOWN_STATUSES);
      });
    });
  }
});
