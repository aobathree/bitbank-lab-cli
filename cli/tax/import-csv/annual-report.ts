// 年間取引報告書（現物）CSV → 行。**この層は解釈しない**（名寄せも合算もしない）。
import type { Result } from "../../types.js";
import { AnnualReportRow, COLUMNS, HEADER_MARKER } from "./annual-report-columns.js";
import { readCsvFile } from "./parse-csv.js";
import { type ParsedReport, parseReportTable } from "./parse-report.js";

export type ParsedAnnualReport = ParsedReport<AnnualReportRow>;

const SPEC = {
  columns: COLUMNS as Record<string, string>,
  schema: AnnualReportRow,
  marker: HEADER_MARKER,
  label: "Annual report (spot)",
};

export function parseAnnualReport(
  table: readonly (readonly string[])[],
): Result<ParsedAnnualReport> {
  return parseReportTable(table, SPEC);
}

export function readAnnualReport(path: string): Result<ParsedAnnualReport> {
  const table = readCsvFile(path);
  if (!table.success) return table;
  return parseAnnualReport(table.data);
}
