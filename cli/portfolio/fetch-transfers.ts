// 入庫・出庫履歴の取得。停止条件を「新規行ゼロ」に倒した cli/paginate.ts を使う理由は
// fetch-history.ts の冒頭コメントを参照（短いページを最終ページと見なさない）。

import { type Deposit, depositHistory } from "../commands/private/deposit-history.js";
import { type Withdrawal, withdrawalHistory } from "../commands/private/withdrawal-history.js";
import { paginate } from "../paginate.js";
import type { Result } from "../types.js";
import type { HistoryArgs } from "./fetch-history.js";

const PAGE_SIZE = 1000;

/** 入庫は 2 系統必須（asset 省略 = crypto / asset=jpy = fiat。両者は排他）。
 *  片方だけだと円入金が丸ごと落ち、再構築の JPY 残高が静かにずれる。 */
export async function fetchDeposits(
  a: HistoryArgs,
): Promise<Result<{ deposits: Deposit[]; truncated: boolean }>> {
  const deposits: Deposit[] = [];
  const seen = new Set<string>();
  let truncated = false;

  for (const asset of [undefined, "jpy"] as const) {
    const paged = await paginate<Deposit>({
      fetchPage: (cursor) =>
        depositHistory({ asset, count: String(PAGE_SIZE), since: a.since, end: cursor }, a.opts),
      keyOf: (d) => d.uuid,
      // 後方 end 走査: このページ最古の found_at より前へ（境界重複は dedup が吸収）
      nextCursor: (rows) => String(Math.min(...rows.map((d) => d.found_at))),
      maxPages: a.maxPages,
      pageSize: PAGE_SIZE,
    });
    if (!paged.success) {
      return { success: false, error: `deposit(${asset ?? "crypto"}): ${paged.error}` };
    }
    for (const d of paged.data.rows) {
      if (seen.has(d.uuid)) continue;
      seen.add(d.uuid);
      deposits.push(d);
    }
    truncated = truncated || paged.data.truncated;
  }

  deposits.sort((a2, b) => a2.found_at - b.found_at || a2.uuid.localeCompare(b.uuid));
  return { success: true, data: { deposits, truncated } };
}

/** 出庫は `asset` が必須なので全資産を巡回する（資産一覧は呼び出し側が渡す）。 */
export async function fetchWithdrawals(
  assets: readonly string[],
  a: HistoryArgs,
): Promise<Result<{ withdrawals: Withdrawal[]; truncatedAssets: string[] }>> {
  const withdrawals: Withdrawal[] = [];
  const truncatedAssets: string[] = [];
  const seen = new Set<string>();

  for (const asset of assets) {
    const paged = await paginate<Withdrawal>({
      fetchPage: (cursor) =>
        withdrawalHistory({ asset, count: String(PAGE_SIZE), since: a.since, end: cursor }, a.opts),
      keyOf: (w) => w.uuid,
      nextCursor: (rows) => String(Math.min(...rows.map((w) => w.requested_at))),
      maxPages: a.maxPages,
      pageSize: PAGE_SIZE,
    });
    if (!paged.success) return { success: false, error: `${asset}: ${paged.error}` };
    for (const w of paged.data.rows) {
      if (seen.has(w.uuid)) continue;
      seen.add(w.uuid);
      withdrawals.push(w);
    }
    if (paged.data.truncated) truncatedAssets.push(asset);
  }

  withdrawals.sort((x, y) => x.requested_at - y.requested_at || x.uuid.localeCompare(y.uuid));
  return { success: true, data: { withdrawals, truncatedAssets } };
}
