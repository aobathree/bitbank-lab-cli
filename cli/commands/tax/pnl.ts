// `bitbank tax pnl` — 取引集計 + （ガード成立時のみ）参考損益。
// 出力は「税務上の所得金額」ではなく**税計算用参考データ**（v2 §1.1）。免責はレポートに常時付く。
import { EXIT } from "../../exit-codes.js";
import type { PrivateHttpOptions } from "../../http-private.js";
import { CARRYOVER_ZERO, loadCarryover } from "../../tax/carryover.js";
import { readBrokerage } from "../../tax/import-csv/brokerage.js";
import { runPnlReport } from "../../tax/report/run.js";
import { DEFAULT_METHOD, Method } from "../../tax/schema/method.js";
import type { TaxReport } from "../../tax/schema/report.js";
import { resolveTaxation } from "../../tax/taxation.js";
import type { Result } from "../../types.js";
import { formatZodError } from "../../validators.js";
import { parseMaxPages, resolveYearWindow } from "../private/input-schemas.js";
import { resolveMarket } from "./market.js";

const MAX_PAGES_DEFAULT = 1000;

export type TaxPnlArgs = {
  year?: string;
  method?: string;
  /** 課税方式の**確認**。年から決まる値と食い違えばエラー（上書きではない） */
  taxation?: string;
  /** 前年繰越 JSON のパス、または "zero"（当年が初年度） */
  carryover?: string;
  /** (a) アテステーション。付けないと参考損益は出ない */
  attest?: boolean;
  maxPages?: string;
  brokerageCsv?: string;
};

export async function taxPnl(
  args: TaxPnlArgs,
  opts?: PrivateHttpOptions,
): Promise<Result<TaxReport>> {
  const mp = parseMaxPages(args.maxPages, MAX_PAGES_DEFAULT);
  if (!mp.success) return mp;
  if (args.year === undefined) {
    return { success: false, error: "--year is required (JST tax year)", exitCode: EXIT.PARAM };
  }
  const win = resolveYearWindow({ year: args.year });
  if (!win.success) return win;
  const year = win.data.filterYear;
  if (year === undefined) {
    return { success: false, error: "--year is required (JST tax year)", exitCode: EXIT.PARAM };
  }
  const method = Method.safeParse(args.method ?? DEFAULT_METHOD);
  if (!method.success) {
    return { success: false, error: formatZodError(method.error), exitCode: EXIT.PARAM };
  }
  // 課税方式は年で決まる。API を叩く前に確定させる（決まらない年で認証を消費しない）
  const taxation = resolveTaxation(year, args.taxation);
  if (!taxation.success) return taxation;

  const allZero = args.carryover === CARRYOVER_ZERO;
  const carryover =
    args.carryover !== undefined && !allZero ? loadCarryover(args.carryover) : undefined;
  if (carryover !== undefined && !carryover.success) return carryover;

  const brokerage = args.brokerageCsv === undefined ? undefined : readBrokerage(args.brokerageCsv);
  if (brokerage !== undefined && !brokerage.success) return brokerage;

  const market = await resolveMarket(opts);
  if (!market.success) return market;

  return runPnlReport(
    {
      year,
      method: method.data,
      taxation: taxation.data,
      attested: args.attest === true,
      opening: carryover?.success ? carryover.data : undefined,
      allZero,
      maxPages: mp.data,
      brokerage: brokerage?.success === true ? brokerage.data.rows : undefined,
    },
    market.data,
    opts,
  );
}
