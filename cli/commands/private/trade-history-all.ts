// trade-history.ts を自動ページングで全件取得するラッパー（単一 pair）。
// CLI の --all/--all-pairs/--year 振り分けは trade-history-dispatch.ts、
// 全ペア横断は trade-history-all-pairs.ts が担う
import type { PrivateHttpOptions } from "../../http-private.js";
import type { Result } from "../../types.js";
import { validatePair } from "../../validators.js";
import { parseMaxPages } from "./input-schemas.js";
import { type Trade, tradeHistory } from "./trade-history.js";

// bitbank API の1リクエストあたり最大取得件数
const PAGE_SIZE = 1000;
// 既定の最大ページ数。誤起動・API 仕様変更で無限化しないための安全弁
export const MAX_PAGES_DEFAULT = 1000;

type TradeHistoryAllArgs = {
  pair: string | undefined;
  since?: string;
  end?: string;
  maxPages?: string;
};

export async function tradeHistoryAll(
  args: TradeHistoryAllArgs,
  opts?: PrivateHttpOptions,
): Promise<Result<Trade[]>> {
  const pv = validatePair(args.pair);
  if (!pv.success) return pv;

  const mp = parseMaxPages(args.maxPages, MAX_PAGES_DEFAULT);
  if (!mp.success) return mp;
  const maxPages = mp.data;

  const allTrades: Trade[] = [];
  const seen = new Set<number>();
  let since = args.since;

  for (let page = 0; page < maxPages; page++) {
    const result = await tradeHistory(
      {
        pair: pv.data,
        count: String(PAGE_SIZE),
        order: "asc",
        since,
        end: args.end,
      },
      opts,
    );
    if (!result.success) return result;

    const trades = result.data;
    let added = 0;
    for (const t of trades) {
      if (!seen.has(t.trade_id)) {
        seen.add(t.trade_id);
        allTrades.push(t);
        added++;
      }
    }

    if (trades.length < PAGE_SIZE) return { success: true, data: allTrades };
    if (added === 0) return { success: true, data: allTrades };

    const last = trades[trades.length - 1];
    since = String(last.executed_at);
  }

  return {
    success: true,
    data: allTrades,
    partial: true,
    meta: { truncated: true, reason: "MAX_PAGES", returnedRows: allTrades.length },
  };
}
