// `bitbank tax verify-report` — bitbank 公式の年間取引報告書と API 由来の集計を
// 突き合わせる。検証アンカー #1（ロードマップ）の自動化。
//
// 現物と信用は**別様式・別ファイル**なので別フラグで受ける（`--csv` / `--margin-csv`）。
// どちらか一方だけでも実行できる。
//
// **検出であって判定ではない**。差があってもコマンドは成功で返す。販売所（即時売買）は
// API に一切現れない（付録E.3）ため、CSV 未投入の口座では購入・売却に差が残るのが正常で、
// その差の量こそが「あと何を取り込めばよいか」を示す。
import { EXIT } from "../../exit-codes.js";
import type { PrivateHttpOptions } from "../../http-private.js";
import { readAnnualReport } from "../../tax/import-csv/annual-report.js";
import { readBrokerage } from "../../tax/import-csv/brokerage.js";
import { readMarginReport } from "../../tax/import-csv/margin-report.js";
import type { VerifyReport } from "../../tax/schema/verify.js";
import { runVerifyReport } from "../../tax/verify/run.js";
import type { Result } from "../../types.js";
import { parseMaxPages, resolveYearWindow } from "../private/input-schemas.js";
import { resolveMarket } from "./market.js";

const MAX_PAGES_DEFAULT = 1000;

export type TaxVerifyReportArgs = {
  year?: string;
  csv?: string;
  marginCsv?: string;
  brokerageCsv?: string;
  maxPages?: string;
};

export async function taxVerifyReport(
  args: TaxVerifyReportArgs,
  opts?: PrivateHttpOptions,
): Promise<Result<VerifyReport>> {
  if (args.csv === undefined && args.marginCsv === undefined) {
    return {
      success: false,
      error: "--csv (spot) or --margin-csv (margin) is required",
      exitCode: EXIT.PARAM,
    };
  }
  const mp = parseMaxPages(args.maxPages, MAX_PAGES_DEFAULT);
  if (!mp.success) return mp;
  const win = resolveYearWindow({ year: args.year });
  if (!win.success) return win;
  const year = win.data.filterYear;
  if (year === undefined) {
    return { success: false, error: "--year is required (JST tax year)", exitCode: EXIT.PARAM };
  }

  // CSV は API を叩く前に読む（壊れていれば認証・レート制限を消費せずに落ちる）
  const spot = args.csv === undefined ? undefined : readAnnualReport(args.csv);
  if (spot !== undefined && !spot.success) return spot;
  const margin = args.marginCsv === undefined ? undefined : readMarginReport(args.marginCsv);
  if (margin !== undefined && !margin.success) return margin;
  const brokerage = args.brokerageCsv === undefined ? undefined : readBrokerage(args.brokerageCsv);
  if (brokerage !== undefined && !brokerage.success) return brokerage;

  const market = await resolveMarket(opts);
  if (!market.success) return market;

  return runVerifyReport(
    {
      year,
      report: spot?.success === true ? spot.data : undefined,
      marginReport: margin?.success === true ? margin.data : undefined,
      since: win.data.since,
      end: win.data.end,
      maxPages: mp.data,
      brokerage: brokerage?.success === true ? brokerage.data.rows : undefined,
    },
    market.data,
    opts,
  );
}
