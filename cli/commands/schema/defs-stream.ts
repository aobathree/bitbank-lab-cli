import { p, type SchemaDef } from "./types.js";

const s = { type: "string" };
const nn = { type: ["number", "null"] };

export const streamSchemas: Record<string, SchemaDef> = {
  stream: {
    category: "stream",
    params: {
      pair: p("string", "Trading pair (e.g. btc_jpy)"),
      private: p("boolean", "Use private channel (requires auth)"),
      channel: p("string", "Channel name override"),
      filter: p("string", "JSON path filter"),
    },
    output: { type: "object", description: "Real-time event data (varies by channel)" },
  },
  watch: {
    category: "stream",
    params: {
      channel: p("string", "Required. Channel to subscribe", {
        enum: ["ticker"],
        positional: true,
      }),
      pair: p("string", "Required. Trading pair (e.g. btc_jpy)", { positional: true }),
      // 停止条件を付けないと SIGINT まで動き続ける。skill 経路では必須（watch-live）。
      duration: p("string", "Stop after N seconds (default: run until interrupted)"),
      count: p("string", "Stop after N events (default: run until interrupted)"),
      "idle-timeout": p("string", "Reconnect when no event arrives for N seconds", {
        default: "30",
      }),
      "max-retries": p("string", 'Max reconnect attempts, or "infinite" to opt in', {
        default: "100",
      }),
      "backoff-cap": p("string", "Reconnect backoff cap in seconds", { default: "32" }),
    },
    // 1 イベント 1 行で流れる（--format=table は TTY 向けの整形のみ）。
    output: {
      type: "object",
      properties: { ts: s, pair: s, last: nn, bid: nn, ask: nn, high: nn, low: nn, vol: nn },
    },
  },
};
