// 100行超: tax コマンドの output（agents カタログの単一ソース）を宣言的に集約。
// レポートのフィールドを 1 つずつ列挙するため、出力項目数に比例して伸びる。
import { Method } from "../../tax/schema/method.js";
import { NTA_SHEET_MODE } from "../../tax/schema/nta.js";
import { TaxationMode } from "../../tax/schema/taxation.js";
import { p, type SchemaDef } from "./types.js";

const s = { type: "string" };
const n = { type: "number" };
const b = { type: "boolean" };
const strings = { type: "array", items: s };

const maxPages = p("string", "Max pages per pair/asset (safety valve)");
const year = p("string", "Tax year in JST (e.g. 2026)");
const brokerageCsv = p(
  "string",
  "Path to the bitbank brokerage (dealer) trade history CSV \u2014 not available via API",
);

const summaryProps = {
  acquired_qty: s,
  acquired_cost_jpy: s,
  disposed_qty: s,
  proceeds_jpy: s,
  income_jpy: s,
  expense_jpy: s,
};

const referenceProps = {
  unit_price_jpy: s,
  cogs_jpy: s,
  closing_qty: s,
  closing_cost_jpy: s,
  revenue_total_jpy: s,
  expense_total_jpy: s,
  reference_pnl_jpy: s,
};

const ntaCompatProps = {
  // 任意文字列にすると未知のモードが有効な出力として通る（schema/nta.ts が単一ソース）
  mode: { type: "string", enum: [NTA_SHEET_MODE] },
  cogs_jpy: s,
  closing_cost_jpy: s,
  income_total_jpy: s,
  expense_total_jpy: s,
  income_jpy: s,
  carryover_cost_jpy: s,
  // I4: 丸め起因の乖離額（既定 − 互換）。schema/nta.ts が単一ソース
  delta: {
    type: "object",
    properties: {
      cogs_jpy: s,
      income_total_jpy: s,
      expense_total_jpy: s,
      income_jpy: s,
    },
  },
};

const reconciliationRow = {
  type: "object",
  properties: {
    currency: s,
    theoretical: s,
    actual: s,
    residual: s,
    within_dust: b,
    diagnosis: s,
    hint: s,
  },
};

export const taxSchemas: Record<string, SchemaDef> = {
  events: {
    category: "tax",
    params: { year, "brokerage-csv": brokerageCsv, "max-pages": maxPages },
    output: {
      type: "object",
      properties: {
        events: { type: "array", items: { type: "object" } },
        pending: {
          type: "array",
          items: { type: "object", properties: { source_ref: s, reason: s } },
        },
        warnings: strings,
        counts: {
          type: "object",
          properties: { trades: n, deposits: n, withdrawals: n, deduped: n },
        },
      },
    },
  },
  reconcile: {
    category: "tax",
    params: { "brokerage-csv": brokerageCsv, "max-pages": maxPages },
    output: {
      type: "object",
      properties: {
        dust_threshold: s,
        rows: { type: "array", items: reconciliationRow },
        unreconcilable: strings,
        problems: strings,
        warnings: strings,
        counts: { type: "object", properties: { events: n, pending: n } },
      },
    },
  },
  "verify-report": {
    category: "tax",
    params: {
      year,
      csv: p("string", "Path to the bitbank annual trade report CSV (spot)"),
      "margin-csv": p("string", "Path to the bitbank annual trade report CSV (margin)"),
      "brokerage-csv": brokerageCsv,
      "max-pages": maxPages,
    },
    output: {
      type: "object",
      properties: {
        year_jst: n,
        source: {
          type: "object",
          properties: { csv_rows: n, margin_csv_rows: n, events: n, pending: n, truncated: b },
        },
        rows: {
          type: "array",
          items: {
            type: "object",
            properties: {
              report_kind: s,
              currency: s,
              field: s,
              report: s,
              api: s,
              diff: s,
              tolerance: s,
              within_tolerance: b,
              diagnosis: s,
              hint: s,
            },
          },
        },
        report_checks: {
          type: "array",
          items: { type: "object", properties: { id: s, target: s, ok: b, detail: s } },
        },
        unsupported: {
          type: "array",
          items: { type: "object", properties: { currency: s, field: s, value: s } },
        },
        unknown_columns: strings,
        warnings: strings,
        disclaimers: strings,
      },
    },
  },
  pnl: {
    category: "tax",
    params: {
      year,
      method: p("string", "Valuation method", {
        enum: Method.options,
        default: "total-average",
      }),
      taxation: p(
        "string",
        "Confirm the taxation regime for the year (derived from --year; mismatch is an error)",
        {
          enum: TaxationMode.options,
        },
      ),
      carryover: p("string", 'Path to carryover JSON, or "zero" for a first year'),
      attest: p(
        "boolean",
        "Attest that no holdings/trades of the same asset exist outside this bitbank account",
      ),
      "brokerage-csv": brokerageCsv,
      "max-pages": maxPages,
    },
    output: {
      type: "object",
      properties: {
        year_jst: n,
        method: s,
        taxation: { type: "object", properties: { mode: s, certainty: s, basis: s } },
        attested: b,
        // スコープが名前で分かるように当年 / 全履歴で分ける（schema/report.ts と対）
        source: {
          type: "object",
          properties: {
            year: { type: "object", properties: { events: n, deferred: n } },
            full_history: { type: "object", properties: { pending: n, deduped: n, truncated: b } },
          },
        },
        currencies: {
          type: "array",
          items: {
            type: "object",
            properties: {
              currency: s,
              method: s,
              summary: { type: "object", properties: summaryProps },
              reference: { type: "object", properties: referenceProps },
              nta_compat: { type: "object", properties: ntaCompatProps },
              blocked_by: strings,
              warnings: strings,
              policy_ids: strings,
            },
          },
        },
        reconciliation: { type: "array", items: reconciliationRow },
        pending: {
          type: "array",
          items: { type: "object", properties: { source_ref: s, reason: s } },
        },
        warnings: strings,
        disclaimers: strings,
      },
    },
  },
};
