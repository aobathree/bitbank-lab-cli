// 再構築に要る private 履歴（約定・入庫・出庫）を 1 本にまとめる入口。
//
// **`*-history-all` コマンドを使わない理由**: あちらは「要求 count より短いページ =
// 最終ページ」で停止する。入出金履歴の count 上限はエンドポイント固有（公式上限 100 の
// 記述あり）で、サーバがクランプすると初回ページでその条件が成立し、**残りを取らないまま
// 完了扱い**になる。再構築は入出金が 1 件欠けただけで静かに狂うので、停止条件を
// 「新規行ゼロ」に倒した cli/paginate.ts を使い、打ち切りを truncated で伝播する。

import type { Deposit } from "../commands/private/deposit-history.js";
import { type Trade, tradeHistory } from "../commands/private/trade-history.js";
import type { Withdrawal } from "../commands/private/withdrawal-history.js";
import type { PrivateHttpOptions } from "../http-private.js";
import { paginate } from "../paginate.js";
import type { Result } from "../types.js";
import { fetchDeposits, fetchWithdrawals } from "./fetch-transfers.js";

const PAGE_SIZE = 1000;

export type HistoryArgs = { since: string; maxPages: number; opts?: PrivateHttpOptions };

export type FetchedHistory = {
  trades: Trade[];
  transfers: { deposits: Deposit[]; withdrawals: Withdrawal[] };
  truncatedPairs: string[];
  truncatedAssets: string[];
  depositsTruncated: boolean;
};

/** 約定は昇順（since 前進）で辿る。ペアは呼び出し側が pairs マスタから渡す。 */
async function fetchTrades(
  pairs: readonly string[],
  a: HistoryArgs,
): Promise<Result<{ trades: Trade[]; truncatedPairs: string[] }>> {
  const trades: Trade[] = [];
  const truncatedPairs: string[] = [];
  for (const pair of pairs) {
    const paged = await paginate<Trade>({
      fetchPage: (cursor) =>
        tradeHistory(
          { pair, count: String(PAGE_SIZE), order: "asc", since: cursor ?? a.since },
          a.opts,
        ),
      keyOf: (t) => `${t.pair}:${t.trade_id}`,
      nextCursor: (rows) => String(rows[rows.length - 1].executed_at),
      maxPages: a.maxPages,
      pageSize: PAGE_SIZE,
    });
    if (!paged.success) return { success: false, error: `${pair}: ${paged.error}` };
    trades.push(...paged.data.rows);
    if (paged.data.truncated) truncatedPairs.push(pair);
  }
  trades.sort((x, y) => x.executed_at - y.executed_at || x.trade_id - y.trade_id);
  return { success: true, data: { trades, truncatedPairs } };
}

export async function fetchHistory(
  pairs: readonly string[],
  assets: readonly string[],
  a: HistoryArgs,
): Promise<Result<FetchedHistory>> {
  const t = await fetchTrades(pairs, a);
  if (!t.success) return t;
  const d = await fetchDeposits(a);
  if (!d.success) return d;
  const w = await fetchWithdrawals(assets, a);
  if (!w.success) return w;

  return {
    success: true,
    data: {
      trades: t.data.trades,
      transfers: { deposits: d.data.deposits, withdrawals: w.data.withdrawals },
      truncatedPairs: t.data.truncatedPairs,
      truncatedAssets: w.data.truncatedAssets,
      depositsTruncated: d.data.truncated,
    },
  };
}
