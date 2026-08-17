// 資産推移の再構築系（読み取り専用の private GET）。private-transfer-handlers.ts と
// 同じくドメインでファイルを分けている。計算本体は cli/portfolio/。
import type { CommandEntry } from "./handler-types.js";
import { bool, str, valStr } from "./handler-types.js";
import { handler } from "./make-handler.js";

export const privateBalanceCommands: Record<string, CommandEntry> = {
  "balance-history": {
    description:
      "Reconstruct the JPY equity curve by rewinding trades and transfers from current balances",
    options: {
      since: str,
      days: str,
      granularity: str,
      "max-pages": str,
      "no-cache": bool(),
    },
    handler: handler("./private/balance-history.js", "balanceHistory", (_a, v) => ({
      since: valStr(v, "since"),
      days: valStr(v, "days"),
      granularity: valStr(v, "granularity"),
      maxPages: valStr(v, "max-pages"),
      noCache: v["no-cache"] === true,
    })),
  },
};
