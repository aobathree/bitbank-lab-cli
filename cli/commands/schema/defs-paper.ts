// 100行超: paper 9 コマンドの params / output（agents カタログの単一ソース）を宣言的に集約。
// state（残高・約定履歴・指値）のフィールドを 1 つずつ列挙するため出力項目数に比例して伸びる。
import { p, type SchemaDef } from "./types.js";

const s = { type: "string" };
const n = { type: "number" };
const b = { type: "boolean" };
const strings = { type: "array", items: s };
const numbersByKey = { type: "object", additionalProperties: n };

const historyEntry = {
  type: "object",
  properties: {
    id: s,
    pair: s,
    side: s,
    type: s,
    amount: n,
    fillPrice: n,
    feeQuote: n,
    filledAt: s,
  },
};

const openOrder = {
  type: "object",
  properties: { id: s, pair: s, side: s, type: s, price: n, amount: n, createdAt: s },
};

const pnlRow = {
  type: "object",
  properties: {
    pair: s,
    position: n,
    avgCost: n,
    currentPrice: n,
    realizedPnl: n,
    unrealizedPnl: n,
    totalPnl: n,
  },
};

export const paperSchemas: Record<string, SchemaDef> = {
  init: {
    category: "paper",
    params: {
      jpy: p("string", "Required. Initial virtual JPY balance (e.g. 1000000)"),
      force: p("boolean", "Overwrite an existing paper state instead of failing"),
    },
    output: {
      type: "object",
      properties: {
        version: n,
        createdAt: s,
        updatedAt: s,
        initialJpy: n,
        balances: numbersByKey,
        history: { type: "array", items: historyEntry },
        lastTickAt: s,
        openOrders: { type: "array", items: openOrder },
      },
    },
  },
  assets: {
    category: "paper",
    params: {},
    output: {
      type: "array",
      items: { type: "object", properties: { asset: s, total: n, locked: n, available: n } },
    },
  },
  "create-order": {
    category: "paper",
    params: {
      pair: p("string", "Trading pair (e.g. btc_jpy)"),
      side: p("string", "Order side", { enum: ["buy", "sell"] }),
      type: p("string", "Order type", { enum: ["market", "limit"] }),
      amount: p("string", "Order amount"),
      price: p("string", "Limit price (required for limit orders)"),
      "refresh-pairs": p("boolean", "Bypass the pairs cache before validating order size"),
    },
    // market は ticker で即時 fill、limit は openOrders に積むだけなので出力形が分かれる。
    output: {
      oneOf: [
        { type: "object", properties: { ...historyEntry.properties, balances: numbersByKey } },
        { type: "object", properties: { placed: openOrder } },
      ],
    },
  },
  "active-orders": {
    category: "paper",
    params: {},
    output: { type: "array", items: openOrder },
  },
  "cancel-order": {
    category: "paper",
    params: { id: p("string", "Required. Open order id to cancel") },
    output: { type: "object", properties: { canceled: openOrder } },
  },
  tick: {
    category: "paper",
    params: {
      pair: p("string", "Resolve fills for this pair only (default: every pair with open orders)"),
    },
    output: {
      type: "object",
      properties: {
        filled: { type: "array", items: historyEntry },
        warnings: strings,
        lastTickAt: s,
      },
    },
  },
  "trade-history": {
    category: "paper",
    params: {},
    output: { type: "array", items: historyEntry },
  },
  reset: {
    category: "paper",
    params: {
      confirm: p(
        "boolean",
        "Required. Deletes the local paper state; the command refuses to run without it",
      ),
    },
    output: { type: "object", properties: { deleted: b } },
  },
  pnl: {
    category: "paper",
    params: { pair: p("string", "Report a single JPY pair (default: every JPY pair traded)") },
    output: {
      type: "object",
      properties: {
        perPair: { type: "object", additionalProperties: pnlRow },
        total: { type: "object", properties: { realizedPnl: n, unrealizedPnl: n, totalPnl: n } },
      },
    },
  },
};
