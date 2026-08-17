// 国税庁計算書 互換出力の型（v2 付録D.6）。**計算は `cli/tax/compat/nta-sheet.ts`**。
// `schema/taxation.ts` と同じ分け方で、型だけをここに置く。
//
// ここに置く理由は依存の向き: `schema/report.ts`（出力契約）も compat 実装も
// この型を要る。compat 側に置くと契約がロジックに依存してしまう。
import { z } from "zod";
import { decStr } from "./primitives.js";

/**
 * 互換モードの識別子。**ファイルを特定してピン留めしている**（付録D.1 の SHA-256）ので、
 * 様式が差し替わったら新しいモードを足す。任意文字列にすると未知のモードが
 * 有効な出力として通ってしまうため、リテラルで固定する。
 */
export const NTA_SHEET_MODE = "NTA_SHEET_2025_12";

export const NtaCompat = z.object({
  mode: z.literal(NTA_SHEET_MODE),
  cogs_jpy: decStr,
  closing_cost_jpy: decStr,
  /** 計算書の【参考】収入金額計（総平均法は切捨て済み） */
  income_total_jpy: decStr,
  /** 計算書の【参考】必要経費計（総平均法は切上げ済み） */
  expense_total_jpy: decStr,
  income_jpy: decStr,
  /** 翌年へ繰り越す取得価額。DISPLAY 精度（表示書式 `#,##0` = 四捨五入） */
  carryover_cost_jpy: decStr,
  /**
   * 不変条件 I4（要求仕様 §3）: 丸め起因の乖離額。向きは **既定 − 互換**で、
   * 正なら既定の方が大きい。対応する既定側は `reference` の
   * `cogs_jpy` / `revenue_total_jpy` / `expense_total_jpy` / `reference_pnl_jpy`。
   * 差が無い欄も 0 として出す（**差が無いこと自体が情報**なので落とさない）。
   */
  delta: z.object({
    cogs_jpy: decStr,
    income_total_jpy: decStr,
    expense_total_jpy: decStr,
    income_jpy: decStr,
  }),
});
export type NtaCompat = z.infer<typeof NtaCompat>;
