// 課税方式（総合課税 / 申告分離課税）の型。ADR-004 は「入口パラメータとして最初から
// 持たせる。分離課税の実装そのものは制度詳細が確定するまで着手しない」と決めている。
//
// マッピングと解決は `cli/tax/taxation.ts`（ここは型だけ。`method.ts` と同じ分け方）。
import { z } from "zod";

export const TaxationMode = z.enum(["comprehensive", "separate"]);
export type TaxationMode = z.infer<typeof TaxationMode>;

/**
 * 年→方式の確からしさ。`projected` は**施行日が未確定**なことだけに由来する
 * （計算の精度の話ではない）。
 */
export const TaxationCertainty = z.enum(["settled", "projected"]);
export type TaxationCertainty = z.infer<typeof TaxationCertainty>;

export const Taxation = z.object({
  mode: TaxationMode,
  certainty: TaxationCertainty,
  /** なぜその方式になるのか。レポートに載せて**数値の意味を固定する**ためのフィールド */
  basis: z.string(),
});
export type Taxation = z.infer<typeof Taxation>;
