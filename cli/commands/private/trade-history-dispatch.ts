// trade-history の --all / --all-pairs / --year を各フェッチャへ振り分ける。
// 依存方向: dispatch → all-pairs → all → leaf（循環なし）
import { EXIT } from "../../exit-codes.js";
import type { PrivateHttpOptions } from "../../http-private.js";
import type { Result } from "../../types.js";
import { validatePair } from "../../validators.js";
import { type Trade, type TradeHistoryArgs, tradeHistory } from "./trade-history.js";
import { tradeHistoryAll } from "./trade-history-all.js";
import { tradeHistoryAllPairs } from "./trade-history-all-pairs.js";

type TradeHistoryDispatchArgs = TradeHistoryArgs & {
  all?: boolean;
  allPairs?: boolean;
  year?: string;
  maxPages?: string;
};

/** --all-pairs は全ペア横断、--year は年分の全件取得（--all を含意）、--all は単一 pair 全件。 */
export async function tradeHistoryDispatch(
  args: TradeHistoryDispatchArgs,
  opts?: PrivateHttpOptions,
): Promise<Result<Trade[]>> {
  if (args.allPairs) {
    if (args.pair !== undefined) {
      return {
        success: false,
        error: "--all-pairs cannot be combined with --pair (it spans every pair)",
        exitCode: EXIT.PARAM,
      };
    }
    return tradeHistoryAllPairs(
      { since: args.since, end: args.end, year: args.year, maxPages: args.maxPages },
      opts,
    );
  }
  if (args.year !== undefined) {
    // 単一 pair の年分取得。明示リストで all-pairs の year 処理を再利用（pairs マスタは叩かない）
    const pv = validatePair(args.pair);
    if (!pv.success) return pv;
    return tradeHistoryAllPairs(
      {
        pairs: [pv.data],
        year: args.year,
        since: args.since,
        end: args.end,
        maxPages: args.maxPages,
      },
      opts,
    );
  }
  if (args.all) {
    return tradeHistoryAll(
      { pair: args.pair, since: args.since, end: args.end, maxPages: args.maxPages },
      opts,
    );
  }
  return tradeHistory(args, opts);
}
