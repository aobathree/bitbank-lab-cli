// balance-history の出力契約。Zod が型の単一ソース（CLAUDE.md）。
import { z } from "zod";
import { GRANULARITIES } from "./grid.js";

export const EquityPointSchema = z.object({
  /** UTC 日付（`YYYY-MM-DD`） */
  date: z.string(),
  timestamp: z.number(),
  value_jpy: z.number(),
});

/** 期間中の資金移動。**元本（net_flow）と出金手数料（withdrawal_fee）は混ぜない**。 */
export const NetFlowSchema = z.object({
  /** 純入出金額（元本移動のみ。出金手数料を含まない）。正 = 入金超、負 = 出金超 */
  net_flow_jpy: z.number(),
  /** 期間中の出金手数料合計（JPY）。調整後増減にコストとして残る */
  withdrawal_fee_jpy: z.number(),
});

/** 価格品質。過去点がどれだけ現在価格の代替に依存しているか。 */
const PriceQualitySchema = z.object({
  level: z.enum(["complete", "partial_fallback", "fallback_only", "jpy_only"]),
  /** 1day 足を引けず現在価格で代替した資産 */
  fallback_assets: z.array(z.string()),
});

/**
 * 履歴の完全性。**再構築は入出金が 1 件欠けただけで静かに狂う**ので、
 * 打ち切りは必ずここに出す（Result 側でも `partial` / `meta.truncated` を立てる）。
 */
const CompletenessSchema = z.object({
  /** 申告すべき打ち切りが 1 つも無いか（履歴欠落・グリッド間引きの両方を含む）。
   *  false のとき Result 側にも `partial` / `meta.truncated` が立つ */
  complete: z.boolean(),
  truncated_pairs: z.array(z.string()),
  truncated_assets: z.array(z.string()),
  deposits_truncated: z.boolean(),
  /** グリッド点が MAX_POINTS を超え、古い側を落としたか */
  grid_truncated: z.boolean(),
});

export const BalanceHistorySchema = z.object({
  as_of: z.string(),
  since: z.string(),
  granularity: z.enum(GRANULARITIES),
  /** 復元された各時点の評価額（昇順） */
  points: z.array(EquityPointSchema),
  /** 最終点。復元値ではなく現在の実測評価額 */
  current: EquityPointSchema,
  flow: NetFlowSchema,
  change: z.object({
    start_value_jpy: z.number(),
    change_jpy: z.number(),
    change_pct: z.number().optional(),
    /** 単純増減 − 純入出金。市場変動 + 出金手数料コストが残る */
    adjusted_change_jpy: z.number(),
    adjusted_change_pct: z.number().optional(),
  }),
  price_quality: PriceQualitySchema,
  completeness: CompletenessSchema,
  warnings: z.array(z.string()),
  note: z.string(),
  assumptions: z.array(z.string()),
});

export type BalanceHistory = z.infer<typeof BalanceHistorySchema>;
export type PriceQuality = z.infer<typeof PriceQualitySchema>;
export type EquityPoint = z.infer<typeof EquityPointSchema>;
export type NetFlow = z.infer<typeof NetFlowSchema>;
