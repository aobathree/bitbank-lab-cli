// 約定履歴の全ペア横断取得（GET /user/spot/trade_history）。ペア一覧は呼び出し側が
// 渡す（cli/tax/ から cli/commands/ を import しないための注入。テストも楽になる）。
import { type PrivateHttpOptions, privateGet } from "../../http-private.js";
import { paginate } from "../../paginate.js";
import { parseResponse } from "../../parse-response.js";
import type { Result } from "../../types.js";
import { type RawTrade, RawTradeHistory } from "./raw-trade.js";

const PAGE_SIZE = 1000;
export const MAX_PAGES_DEFAULT = 1000;

export type FetchTradesArgs = {
  pairs: string[];
  since?: string;
  end?: string;
  maxPages?: number;
};

export type FetchedTrades = {
  trades: RawTrade[];
  deduped: number;
  /** ページ上限に当たったペア。空でなければ呼び出し側が partial を立てる */
  truncatedPairs: string[];
};

async function fetchPairPage(
  pair: string,
  cursor: string | undefined,
  end: string | undefined,
  opts?: PrivateHttpOptions,
): Promise<Result<RawTrade[]>> {
  const params: Record<string, string> = {
    pair,
    count: String(PAGE_SIZE),
    order: "asc",
    ...(cursor !== undefined ? { since: cursor } : {}),
    ...(end !== undefined ? { end } : {}),
  };
  const r = await privateGet<unknown>("/user/spot/trade_history", params, opts);
  return parseResponse(r, RawTradeHistory, "trades");
}

export async function fetchTrades(
  args: FetchTradesArgs,
  opts?: PrivateHttpOptions,
): Promise<Result<FetchedTrades>> {
  const trades: RawTrade[] = [];
  const truncatedPairs: string[] = [];
  // trade_id は event_id（`trade:<trade_id>`）の一意性の根拠。ペア横断で衝突すると
  // 下流で片方が黙って上書きされるので、交差を検出したら明示エラーで止める
  const ownerPair = new Map<number, string>();
  let deduped = 0;

  for (const pair of args.pairs) {
    const paged = await paginate<RawTrade>({
      fetchPage: (cursor) => fetchPairPage(pair, cursor ?? args.since, args.end, opts),
      keyOf: (t) => `${t.pair}:${t.trade_id}`,
      // 昇順取得なので最終行の executed_at が次ページの since になる
      nextCursor: (rows) => String(rows[rows.length - 1].executed_at),
      maxPages: args.maxPages ?? MAX_PAGES_DEFAULT,
      pageSize: PAGE_SIZE,
    });
    if (!paged.success) {
      return { success: false, error: `${pair}: ${paged.error}`, exitCode: paged.exitCode };
    }
    for (const t of paged.data.rows) {
      const owner = ownerPair.get(t.trade_id);
      if (owner !== undefined && owner !== t.pair) {
        return {
          success: false,
          error:
            `trade_id ${t.trade_id} が ${owner} と ${t.pair} の両方に出現しました。` +
            `event_id の一意性が崩れるため取込を中止します`,
        };
      }
      ownerPair.set(t.trade_id, t.pair);
      trades.push(t);
    }
    deduped += paged.data.deduped;
    if (paged.data.truncated) truncatedPairs.push(pair);
  }

  trades.sort((a, b) => a.executed_at - b.executed_at || a.trade_id - b.trade_id);
  return { success: true, data: { trades, deduped, truncatedPairs } };
}
