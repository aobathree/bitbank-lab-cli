// 年間取引報告書（信用）CSV → 行。現物と同じくこの層は解釈しない。
import type { Result } from "../../types.js";
import { MARGIN_COLUMNS, MARGIN_HEADER_MARKER, MarginReportRow } from "./margin-report-columns.js";
import { readCsvFile } from "./parse-csv.js";
import { type ParsedReport, parseReportTable } from "./parse-report.js";

export type ParsedMarginReport = ParsedReport<MarginReportRow>;

const SPEC = {
  columns: MARGIN_COLUMNS as Record<string, string>,
  schema: MarginReportRow,
  // 現物と信用は 1 列目がどちらも「通貨名」なので、**信用にしかない列**を目印にする。
  // 取り違えて渡されたときに「列が足りない」ではなく「様式が違う」と分かる
  marker: MARGIN_HEADER_MARKER,
  label: "Annual report (margin)",
};

export function parseMarginReport(
  table: readonly (readonly string[])[],
): Result<ParsedMarginReport> {
  return parseReportTable(table, SPEC);
}

export function readMarginReport(path: string): Result<ParsedMarginReport> {
  const table = readCsvFile(path);
  if (!table.success) return table;
  return parseMarginReport(table.data);
}
