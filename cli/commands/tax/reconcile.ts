// `bitbank tax reconcile` — 理論残高と /user/assets の突合（ガード(d) / P-17）。
//
// **判定ではなく検出**。閾値外でもコマンドは成功で返し、残差の量と符号を報告する。
// 実口座では販売所取引が API に現れないため「全資産で残差ゼロ」は成立しない
// （UI CSV 取込は P0-6）。ここで残差が出ること自体が取込漏れの検出手段になっている。
import type { PrivateHttpOptions } from "../../http-private.js";
import { readBrokerage } from "../../tax/import-csv/brokerage.js";
import { DUST_THRESHOLD } from "../../tax/reconcile/compare.js";
import { runReconcile } from "../../tax/reconcile/run.js";
import type { ReconciliationReport } from "../../tax/schema/report.js";
import type { Result } from "../../types.js";
import { parseMaxPages } from "../private/input-schemas.js";
import { resolveMarket } from "./market.js";

const MAX_PAGES_DEFAULT = 1000;

export type TaxReconcileArgs = { maxPages?: string; brokerageCsv?: string };

/** 出力契約は Zod が単一ソース（pnl / verify-report と同じ扱い）。 */
export type TaxReconcileData = ReconciliationReport;

export async function taxReconcile(
  args: TaxReconcileArgs,
  opts?: PrivateHttpOptions,
): Promise<Result<TaxReconcileData>> {
  const mp = parseMaxPages(args.maxPages, MAX_PAGES_DEFAULT);
  if (!mp.success) return mp;

  const brokerage = args.brokerageCsv === undefined ? undefined : readBrokerage(args.brokerageCsv);
  if (brokerage !== undefined && !brokerage.success) return brokerage;

  const market = await resolveMarket(opts);
  if (!market.success) return market;

  const r = await runReconcile(
    market.data,
    { maxPages: mp.data, brokerage: brokerage?.success === true ? brokerage.data.rows : undefined },
    opts,
  );
  if (!r.success) return r;

  const data: TaxReconcileData = {
    dust_threshold: DUST_THRESHOLD,
    rows: r.data.comparisons.map((c) => ({
      currency: c.currency,
      theoretical: c.theoretical,
      actual: c.actual,
      residual: c.residual,
      dust: c.dust,
      within_dust: c.withinDust,
      diagnosis: c.diagnosis,
      hint: c.hint,
    })),
    unreconcilable: [...r.data.rebuilt.unreconcilable].sort(),
    problems: r.data.rebuilt.problems,
    warnings: r.data.collected.warnings,
    pending: r.data.collected.pending,
    counts: { events: r.data.collected.events.length, pending: r.data.collected.pending.length },
  };
  return r.partial ? { success: true, data, partial: true, meta: r.meta } : { success: true, data };
}
