// 年間取引報告書との突合の出力型。突合は**検出であって判定ではない**（残高突合と同じ規律）。
// 差が出ること自体が異常なのではなく、差の在り処と量を示すのがこのコマンドの仕事。
import { z } from "zod";
import { decStr } from "./primitives.js";

/**
 * 差の性格。`REPORT_EXCESS` は「報告書にあって API に無い」＝取込漏れ側で、
 * 販売所（即時売買）が第一候補になる（API に一切現れないため。付録E.3）。
 */
export const VerifyDiagnosis = z.enum([
  "MATCH",
  "FEE_ROUNDING", // API 手数料の 4 桁丸め（P-16）で説明できる範囲
  "REPORT_EXCESS", // 報告書 > API
  "API_EXCESS", // API > 報告書
]);
export type VerifyDiagnosis = z.infer<typeof VerifyDiagnosis>;

/**
 * 突合できる項目。**Zod を単一ソースにして、集計側の配列を `satisfies` で縛る**
 * （`aggregate.ts` の `COMPARED_FIELDS` / `margin-aggregate.ts` の `MARGIN_FIELDS`）。
 * どちらかにタイプミスが入れば型検査で落ちる。
 */
export const VerifyField = z.enum([
  "buy_qty",
  "buy_jpy",
  "sell_qty",
  "sell_jpy",
  "deposit_qty",
  "withdrawal_qty",
  "fee",
  "margin_pnl",
  "margin_fee",
  "margin_fee_occurred",
]);
export type VerifyField = z.infer<typeof VerifyField>;

/** 突合せずに参考表示だけする列（当 CLI が API から再現できない / 全履歴が要る）。 */
export const UnsupportedField = z.enum([
  "buy_qty_btc",
  "buy_btc",
  "sell_qty_btc",
  "sell_btc",
  "lend_qty",
  "return_qty",
  "lend_pnl",
  "end_short_position",
  "end_long_position",
]);
export type UnsupportedField = z.infer<typeof UnsupportedField>;

export const VerifyRow = z.object({
  /** どちらの報告書との比較か。現物と信用は別様式・別ファイル */
  report_kind: z.enum(["spot", "margin"]),
  currency: z.string(),
  field: VerifyField,
  report: decStr,
  api: decStr,
  /** 報告書 − API */
  diff: decStr,
  tolerance: decStr,
  within_tolerance: z.boolean(),
  diagnosis: VerifyDiagnosis,
  hint: z.string(),
});
export type VerifyRow = z.infer<typeof VerifyRow>;

/** 報告書だけで閉じる恒等式の検算（列の読み違いと欠損行の検出）。 */
export const ReportCheck = z.object({
  id: z.string(),
  target: z.string(),
  ok: z.boolean(),
  detail: z.string(),
});
export type ReportCheck = z.infer<typeof ReportCheck>;

export const VerifyReport = z.object({
  year_jst: z.number().int(),
  source: z.object({
    csv_rows: z.number().int(),
    /** 信用の報告書を渡さなかったときは 0 */
    margin_csv_rows: z.number().int(),
    events: z.number().int(),
    pending: z.number().int(),
    truncated: z.boolean(),
  }),
  rows: z.array(VerifyRow),
  /**
   * **現物の報告書だけが対象**。信用の様式は 4 列がそれぞれ独立した年間集計で、
   * 列どうしを結ぶ恒等式が存在しないため検算する対象が無い（空配列になる）。
   */
  report_checks: z.array(ReportCheck),
  /** 当 CLI が API から再現できない列に値がある行（BTC 建て・貸出） */
  unsupported: z.array(z.object({ currency: z.string(), field: UnsupportedField, value: decStr })),
  unknown_columns: z.array(z.string()),
  warnings: z.array(z.string()),
  disclaimers: z.array(z.string()),
});
export type VerifyReport = z.infer<typeof VerifyReport>;
