// 年間取引報告書（現物）と API 由来集計の突合。**検出であって判定ではない**。
// 差が出ること自体は異常ではない（販売所は API に一切現れないため、CSV 未投入の
// 口座では購入・売却の差が必ず残る）。この差を数量として示すのがこのモジュールの仕事。

import type { Result } from "../../types.js";
import type { ParsedAnnualReport } from "../import-csv/annual-report.js";
import type { AnnualReportRow } from "../import-csv/annual-report-columns.js";
import { UNSUPPORTED_FIELDS } from "../import-csv/annual-report-columns.js";
import { isZero, ZERO } from "../ratio.js";
import type { ReportCheck, UnsupportedField, VerifyRow } from "../schema/verify.js";
import { type Aggregated, COMPARED_FIELDS, zeroFigures } from "./aggregate.js";
import { reportChecks } from "./checks.js";
import { spotHint } from "./hints.js";
import { indexByCurrency, readField } from "./index-rows.js";
import { buildRow, toleranceFor } from "./rows.js";

export type Unsupported = { currency: string; field: UnsupportedField; value: string };

export type VerifyOutcome = {
  rows: VerifyRow[];
  checks: ReportCheck[];
  unsupported: Unsupported[];
  warnings: string[];
};

function unsupportedOf(rows: readonly AnnualReportRow[]): Unsupported[] {
  const out: Unsupported[] = [];
  for (const row of rows) {
    for (const field of UNSUPPORTED_FIELDS) {
      if (!isZero(readField(row, field))) {
        out.push({ currency: row.currency, field, value: row[field] });
      }
    }
  }
  return out;
}

export function compareAnnualReport(
  report: ParsedAnnualReport,
  aggregated: Aggregated,
): Result<VerifyOutcome> {
  const indexed = indexByCurrency(report.rows, "report");
  if (!indexed.success) return indexed;

  const checked = reportChecks(report.rows);
  const warnings = [...checked.warnings, ...aggregated.warnings];
  const unsupported = unsupportedOf(report.rows);
  if (unsupported.length > 0) {
    warnings.push(
      `当 CLI が API から再現できない列（BTC 建て / 貸出）に値があります: ${unsupported.length} 件。該当銘柄の差はこの分を含みます`,
    );
  }

  const currencies = [...new Set([...indexed.data.keys(), ...aggregated.byCurrency.keys()])].sort();
  const rows: VerifyRow[] = [];
  for (const currency of currencies) {
    const reported = indexed.data.get(currency);
    const api = aggregated.byCurrency.get(currency) ?? zeroFigures();
    if (reported === undefined) {
      warnings.push(`${currency}: 報告書に行がありません（API 側の集計のみで比較しています）`);
    }
    for (const field of COMPARED_FIELDS) {
      const row = buildRow({
        reportKind: "spot",
        currency,
        field,
        report: reported === undefined ? ZERO : readField(reported, field),
        api: api[field],
        tolerance: toleranceFor(field, api.fee_rounded_count),
        hint: spotHint(field),
      });
      if (row !== null) rows.push(row);
    }
  }
  return { success: true, data: { rows, checks: checked.checks, unsupported, warnings } };
}
