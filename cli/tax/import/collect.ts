// API 3 エンドポイントの取得 → 正規化までを 1 本にまとめる入口。
// ペア・資産の一覧は呼び出し側（コマンド層）が /spot/pairs から解決して渡す。
import type { PrivateHttpOptions } from "../../http-private.js";
import type { Result } from "../../types.js";
import type { BrokerageRow } from "../import-csv/brokerage-columns.js";
import { fetchDeposits } from "./fetch-deposits.js";
import { fetchTrades } from "./fetch-trades.js";
import { fetchWithdrawals } from "./fetch-withdrawals.js";
import { type NormalizeResult, toEvents } from "./to-events.js";

export type CollectArgs = {
  pairs: string[];
  assets: string[];
  /** 省略時は全履歴。残高突合（ガード(d)）は全履歴でしか成立しない */
  since?: string;
  end?: string;
  maxPages?: number;
  /** 販売所「売買履歴」CSV の行。API では取得できないので呼び出し側が読んで渡す */
  brokerage?: readonly BrokerageRow[];
};

/**
 * 打ち切りをレポート本体（`warnings`）に残す文言。partial envelope と stderr 警告は
 * レポートだけを読む経路からは見えないので、pnl / verify-report で同じ一言を出す。
 */
export const TRUNCATED_WARNING =
  "履歴がページ上限で打ち切られています。差は取込漏れを含みます（--max-pages）";

export type Collected = NormalizeResult & {
  counts: { trades: number; deposits: number; withdrawals: number; deduped: number };
  /** ページ上限で打ち切られた = 履歴が欠けている。集計を信用してはいけない */
  truncated: boolean;
  truncatedPairs: string[];
  truncatedAssets: string[];
};

export async function collectEvents(
  args: CollectArgs,
  opts?: PrivateHttpOptions,
): Promise<Result<Collected>> {
  const window = { since: args.since, end: args.end, maxPages: args.maxPages };

  const trades = await fetchTrades({ pairs: args.pairs, ...window }, opts);
  if (!trades.success) return trades;
  const deposits = await fetchDeposits(window, opts);
  if (!deposits.success) return deposits;
  const withdrawals = await fetchWithdrawals({ assets: args.assets, ...window }, opts);
  if (!withdrawals.success) return withdrawals;

  const normalized = toEvents({
    trades: trades.data.trades,
    deposits: deposits.data.deposits,
    withdrawals: withdrawals.data.withdrawals,
    brokerage: args.brokerage,
  });

  const truncatedPairs = trades.data.truncatedPairs;
  const truncatedAssets = withdrawals.data.truncatedAssets;
  const truncated =
    truncatedPairs.length > 0 || truncatedAssets.length > 0 || deposits.data.truncated;

  const data: Collected = {
    ...normalized,
    counts: {
      trades: trades.data.trades.length,
      deposits: deposits.data.deposits.length,
      withdrawals: withdrawals.data.withdrawals.length,
      deduped: trades.data.deduped + deposits.data.deduped + withdrawals.data.deduped,
    },
    truncated,
    truncatedPairs,
    truncatedAssets,
  };
  if (truncated) {
    return {
      success: true,
      data,
      partial: true,
      meta: { truncated: true, reason: "MAX_PAGES", returnedRows: data.events.length },
    };
  }
  return { success: true, data };
}
