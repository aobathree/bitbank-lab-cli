// 年間取引報告書（**信用**）CSV の列定義。現物とは別様式・別ファイルで、
// 通貨（ペア）単位に 4 項目だけを持つ。
//
// 決定的な違い（社内設計資料 2024-11 / 国税庁への照会結果）:
// - 損益は**個別法（FIFO）**で算出する。現物の総平均法・移動平均法とは別系統。
//   しかも**取引所の `profit_loss` は使わず、生約定から再計算**している
//   （バッチ仕様: amount / price / interest から FIFO で算出）
// - **年中信用取引損益は取引手数料を控除していない**（控除するのは利息だけ）。
//   `long損益 = 決済価格 − 建値` / `short損益 = 建値 − 決済価格`、そこから利息を引く。
//   手数料は「支払手数料」列に分けて載り、申告時にユーザーが現物の手数料と合算して
//   国税庁計算書の「手数料等」欄へ入れる（手数料は消費税の課税対象という整理）
// - **支払手数料は発生ベース**（要件定義:「新規建・決済時に**発生した**取引手数料の総和」）。
//   精算ベース（決済レコードに建て分を寄せる `fee_amount_quote`）だと建て時が 0 になり
//   「新規建時に発生した手数料」が成立しないので、`fee_occurred_amount_quote` 側にあたる。
//   総額はどちらでも同じで、**年をまたぐ建玉があるときだけ計上年が変わる**
// - 年末建玉は法人向け（みなし決済損益額）。個人の申告には不要
//
// **実物の様式は実機確認 #10 で確定**（2025 年分・実口座）。現物と揃っていない点が多い:
// - 見出しは `年中信用取引損益（円）` / `支払手数料（円）` と**単位注記付き**
//   （バッチ仕様の「CSVラベル名」表どおり。要件定義の出力項目リストは注記なしで食い違う。
//   `parse-report.ts` が注記を落として照合するので、どちらの様式でも読める）
// - **買建玉が先、売建玉が後**（現物の並びから類推すると逆になる）
// - **BOM なし・LF・末尾改行なし**（現物は BOM 付き・CRLF）
// - メタ行のタイトルが「年間取引報告書（信用取引）」（現物は「年間取引報告書」）
// - 桁は小数 8 桁固定。損益は負値を取り得る（`decStr` に正値制約を付けない理由）
import { z } from "zod";
import { decStr } from "../../schema-helpers.js";
import type { UnsupportedField } from "../schema/verify.js";

export const MarginReportRow = z.object({
  currency: z.string(),
  end_short_position: decStr,
  end_long_position: decStr,
  margin_pnl: decStr,
  margin_fee: decStr,
});
export type MarginReportRow = z.infer<typeof MarginReportRow>;

/** 並びは実物の見出し順（実機確認 #10）。照合は列名なので順序に依存しない。 */
export const MARGIN_COLUMNS = {
  通貨名: "currency",
  年末保有中買建玉: "end_long_position",
  年末保有中売建玉: "end_short_position",
  年中信用取引損益: "margin_pnl",
  支払手数料: "margin_fee",
} as const satisfies Record<string, keyof MarginReportRow>;

export const MARGIN_HEADER_MARKER = "年中信用取引損益";

/** 全履歴が要るため年ウィンドウでは復元できない列（比較せず参考表示に留める）。 */
export const POSITION_FIELDS = [
  "end_short_position",
  "end_long_position",
] as const satisfies readonly (keyof MarginReportRow & UnsupportedField)[];
