import { bool, type CommandEntry, str, valStr } from "./handler-types.js";
import { handler } from "./make-handler.js";

export const taxCommands: Record<string, CommandEntry> = {
  events: {
    description: "Normalize trade/deposit/withdrawal history into tax events (read-only)",
    options: { year: str, "brokerage-csv": str, "max-pages": str },
    handler: handler("./tax/events.js", "taxEvents", (_a, v) => ({
      year: valStr(v, "year"),
      brokerageCsv: valStr(v, "brokerage-csv"),
      maxPages: valStr(v, "max-pages"),
    })),
  },
  reconcile: {
    description: "Compare rebuilt theoretical balances against /user/assets (detect, not judge)",
    options: { "brokerage-csv": str, "max-pages": str },
    handler: handler("./tax/reconcile.js", "taxReconcile", (_a, v) => ({
      brokerageCsv: valStr(v, "brokerage-csv"),
      maxPages: valStr(v, "max-pages"),
    })),
  },
  "verify-report": {
    description: "Reconcile the official annual trade report CSV against API-derived totals",
    options: { year: str, csv: str, "margin-csv": str, "brokerage-csv": str, "max-pages": str },
    handler: handler("./tax/verify-report.js", "taxVerifyReport", (_a, v) => ({
      year: valStr(v, "year"),
      csv: valStr(v, "csv"),
      marginCsv: valStr(v, "margin-csv"),
      brokerageCsv: valStr(v, "brokerage-csv"),
      maxPages: valStr(v, "max-pages"),
    })),
  },
  pnl: {
    description: "Transaction summary + reference P&L when the display guards all pass",
    options: {
      year: str,
      method: str,
      taxation: str,
      carryover: str,
      attest: bool(),
      "brokerage-csv": str,
      "max-pages": str,
    },
    handler: handler("./tax/pnl.js", "taxPnl", (_a, v) => ({
      year: valStr(v, "year"),
      method: valStr(v, "method"),
      taxation: valStr(v, "taxation"),
      carryover: valStr(v, "carryover"),
      attest: v.attest === true,
      brokerageCsv: valStr(v, "brokerage-csv"),
      maxPages: valStr(v, "max-pages"),
    })),
  },
};
