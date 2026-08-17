// 販売所「売買履歴」CSV → 行。この層は解釈しない（判定は to-events-brokerage.ts）。

import { EXIT } from "../../exit-codes.js";
import type { Result } from "../../types.js";
import {
  BROKERAGE_COLUMNS,
  BROKERAGE_HEADER_MARKER,
  BrokerageRow,
  RECURRING_MARKER,
} from "./brokerage-columns.js";
import { readCsvFile } from "./parse-csv.js";
import { type ParsedReport, parseReportTable } from "./parse-report.js";

export type ParsedBrokerage = ParsedReport<BrokerageRow>;

const SPEC = {
  columns: BROKERAGE_COLUMNS as Record<string, string>,
  schema: BrokerageRow,
  marker: BROKERAGE_HEADER_MARKER,
  label: "Brokerage history",
};

export function parseBrokerage(table: readonly (readonly string[])[]): Result<ParsedBrokerage> {
  // 定期購入タブの CSV は注文ID を持つのでヘッダ検出は通ってしまう。取り違えを
  // 「列が足りない」ではなく「タブが違う」と伝える
  if (table.some((row) => row.some((cell) => cell.trim() === RECURRING_MARKER))) {
    return {
      success: false,
      error:
        "This is the recurring-purchase (定期購入) CSV, which is not supported yet. Download the 売買 tab instead.",
      exitCode: EXIT.PARAM,
    };
  }
  return parseReportTable(table, SPEC);
}

export function readBrokerage(path: string): Result<ParsedBrokerage> {
  const table = readCsvFile(path);
  if (!table.success) return table;
  return parseBrokerage(table.data);
}
