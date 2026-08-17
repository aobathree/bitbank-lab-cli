// balance-history の params / output（agents カタログの単一ソース）。
// 出力は再構築の前提（価格品質・履歴の完全性・注記）まで含む — 前提を外すと
// skill 側で書き忘れたときに誤読が復活するため、短くする方向では削らない。
import { GRANULARITIES } from "../../portfolio/grid.js";
import { p, type SchemaDef } from "./types.js";

const n = { type: "number" };
const s = { type: "string" };
const b = { type: "boolean" };
const strings = { type: "array", items: s };

const equityPoint = {
  type: "object",
  properties: { date: s, timestamp: n, value_jpy: n },
};

export const privateBalanceSchemas: Record<string, SchemaDef> = {
  "balance-history": {
    category: "private",
    params: {
      since: p("string", "Window start (Unix ms); cannot be combined with --days"),
      days: p("string", "Window length in days back from now (default: 30)"),
      granularity: p("string", "Grid step for reconstructed points (UTC boundaries)", {
        enum: GRANULARITIES,
        default: "day",
      }),
      "max-pages": p(
        "string",
        "Max history pages per pair/asset (default: 1000; positive integer). " +
          "Hitting the cap sets completeness.complete=false and partial=true",
      ),
      "no-cache": p("boolean", "Bypass the local 1day candle cache"),
    },
    output: {
      type: "object",
      properties: {
        as_of: s,
        since: s,
        granularity: { type: "string", enum: [...GRANULARITIES] },
        points: { type: "array", items: equityPoint },
        current: equityPoint,
        flow: {
          type: "object",
          properties: { net_flow_jpy: n, withdrawal_fee_jpy: n },
        },
        change: {
          type: "object",
          properties: {
            start_value_jpy: n,
            change_jpy: n,
            change_pct: n,
            adjusted_change_jpy: n,
            adjusted_change_pct: n,
          },
        },
        price_quality: {
          type: "object",
          properties: {
            level: {
              type: "string",
              enum: ["complete", "partial_fallback", "fallback_only", "jpy_only"],
            },
            fallback_assets: strings,
          },
        },
        completeness: {
          type: "object",
          properties: {
            complete: b,
            truncated_pairs: strings,
            truncated_assets: strings,
            deposits_truncated: b,
            grid_truncated: b,
          },
        },
        warnings: strings,
        note: s,
        assumptions: strings,
      },
    },
  },
};
