// 年間取引報告書（現物 / 信用）に共通する読み取り。**列名で引く**（位置で引かない）。
// 位置で引くと列が 1 本挿入されただけで以降が全部ずれ、しかも数字としては読めてしまうので
// 気づけない。1 行目は氏名・発行者のメタ行なので、ヘッダは目印の列名で探す。
import type { z } from "zod";
import { EXIT } from "../../exit-codes.js";
import type { Result } from "../../types.js";
import { formatZodError } from "../../validators.js";

export type ParsedReport<T> = {
  rows: T[];
  /** 未知の列見出し。様式が変わった兆候なので握り潰さず上へ報告する */
  unknownColumns: string[];
};

export type ReportSpec<T> = {
  /** 列見出し → フィールド名 */
  columns: Record<string, string>;
  schema: z.ZodType<T>;
  /** ヘッダ行を見つけるための目印の列名 */
  marker: string;
  /** エラーメッセージに出す報告書の呼び名 */
  label: string;
};

const err = (error: string): Result<never> => ({ success: false, error, exitCode: EXIT.PARAM });

/**
 * 見出し末尾の単位注記（「支払手数料**（円）**」等）を落とす。信用の社内資料は
 * 「出力項目」リストが注記なし・「CSVラベル名」表が注記ありで**食い違っていた**ため、
 * どちらの様式でも読めるようにする。注記付きを弾くと、正しいファイルに対して
 * 「様式が違う」と出る（しかも目印の列なのでファイル全体が読めない）。
 */
function stripUnitNote(name: string): string {
  return name.replace(/[（(][^（）()]*[）)]$/, "").trim();
}

/**
 * 厳密一致を先に試し、注記を落とした形が**宣言済みの列名と完全一致するときだけ**採用する。
 * 部分一致では拾わないので別の列に化けることはない。「（税抜）/（税込）」のように
 * 落とすと衝突する様式は、下の重複検出が人に判断を返す。
 */
function fieldFor(name: string, columns: Record<string, string>): string | undefined {
  return columns[name] ?? columns[stripUnitNote(name)];
}

function locateColumns(
  header: readonly string[],
  columns: Record<string, string>,
): { at: Map<string, number>; unknown: string[]; duplicated: string[] } {
  const at = new Map<string, number>();
  const unknown: string[] = [];
  const duplicated: string[] = [];
  header.forEach((cell, i) => {
    const name = cell.trim();
    if (name === "") return;
    const field = fieldFor(name, columns);
    if (field === undefined) unknown.push(name);
    // 同じ既知列が 2 本あると後勝ちで上書きされ、**編集済み CSV から誤った値を
    // 黙って採用する**。どちらが正しいかは人にしか決められないので拒否する
    else if (at.has(field)) duplicated.push(name);
    else at.set(field, i);
  });
  return { at, unknown, duplicated };
}

export function parseReportTable<T>(
  table: readonly (readonly string[])[],
  spec: ReportSpec<T>,
): Result<ParsedReport<T>> {
  const h = table.findIndex((row) =>
    row.some((cell) => {
      const name = cell.trim();
      return name === spec.marker || stripUnitNote(name) === spec.marker;
    }),
  );
  if (h === -1) return err(`${spec.label} header not found (no "${spec.marker}" column)`);

  const { at, unknown, duplicated } = locateColumns(table[h], spec.columns);
  if (duplicated.length > 0) {
    return err(`${spec.label} has duplicate columns: ${duplicated.join(", ")}`);
  }
  const missing = Object.values(spec.columns).filter((f) => !at.has(f));
  if (missing.length > 0) return err(`${spec.label} is missing columns: ${missing.join(", ")}`);

  const rows: T[] = [];
  for (let i = h + 1; i < table.length; i++) {
    const cells = table[i];
    if (cells.every((c) => c.trim() === "")) continue; // 末尾の空行
    const raw: Record<string, string> = {};
    for (const [field, index] of at) raw[field] = (cells[index] ?? "").trim();
    const parsed = spec.schema.safeParse(raw);
    if (!parsed.success) {
      return err(`${spec.label} line ${i + 1}: ${formatZodError(parsed.error)}`);
    }
    rows.push(parsed.data);
  }
  if (rows.length === 0) return err(`${spec.label} has no data rows`);
  return { success: true, data: { rows, unknownColumns: unknown } };
}
