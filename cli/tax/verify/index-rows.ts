// 報告書の行を資産キーで引けるようにする（現物 / 信用で共通）。
import { EXIT } from "../../exit-codes.js";
import type { Result } from "../../types.js";
import { canonicalAsset } from "../import/symbol-alias.js";
import { type Ratio, ZERO } from "../ratio.js";
import { fromDecimalString } from "../ratio-decimal.js";

/**
 * **正規化後に衝突したら黙って上書きせずエラーにする** — 旧名と新名の行が両方あると
 * 後勝ちで片方の数量が消え、その分がまるごと「取込漏れ」に見えてしまう
 * （合算すべきか別物かは人が判断する領域）。
 */
export function indexByCurrency<T extends { currency: string }>(
  rows: readonly T[],
  label: string,
): Result<Map<string, T>> {
  const out = new Map<string, T>();
  for (const row of rows) {
    const key = canonicalAsset(row.currency);
    if (out.has(key)) {
      return {
        success: false,
        error: `Duplicate ${label} currency after normalization: ${row.currency} (=> ${key})`,
        exitCode: EXIT.PARAM,
      };
    }
    out.set(key, row);
  }
  return { success: true, data: out };
}

/** decStr は Zod 検証済みなので読めるはずだが、読めなければ ZERO を返す。 */
export function readField<T extends Record<string, string>>(row: T, field: keyof T): Ratio {
  return fromDecimalString(row[field]) ?? ZERO;
}
