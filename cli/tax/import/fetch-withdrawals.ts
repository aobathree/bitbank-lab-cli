// 出庫履歴の取得（GET /user/withdrawal_history）。**asset が必須**なので全資産を巡回する
// （要求仕様 §2.1）。資産一覧は呼び出し側が渡す（fetch-trades.ts と同じ注入方針）。
import { type PrivateHttpOptions, privateGet } from "../../http-private.js";
import { paginate } from "../../paginate.js";
import { parseResponse } from "../../parse-response.js";
import type { Result } from "../../types.js";
import { type RawWithdrawal, RawWithdrawalHistory } from "./raw-transfer.js";

// count の上限はエンドポイントごとに異なる可能性がある（約定履歴は 1000 と実測済み、
// 入出庫は未確定）。サーバが上限へクランプしても paginate は「新規行ゼロ」で止まるので
// 取りこぼさない — この値は 1 往復あたりの取得量の希望であって、停止判定には使わない。
const PAGE_SIZE = 1000;
export const MAX_PAGES_DEFAULT = 1000;

export type FetchWithdrawalsArgs = {
  assets: string[];
  since?: string;
  end?: string;
  maxPages?: number;
};

export type FetchedWithdrawals = {
  withdrawals: RawWithdrawal[];
  deduped: number;
  truncatedAssets: string[];
};

async function page(
  asset: string,
  cursor: string | undefined,
  since: string | undefined,
  opts?: PrivateHttpOptions,
): Promise<Result<RawWithdrawal[]>> {
  const params: Record<string, string> = {
    asset,
    count: String(PAGE_SIZE),
    ...(since !== undefined ? { since } : {}),
    ...(cursor !== undefined ? { end: cursor } : {}),
  };
  const r = await privateGet<unknown>("/user/withdrawal_history", params, opts);
  return parseResponse(r, RawWithdrawalHistory, "withdrawals");
}

export async function fetchWithdrawals(
  args: FetchWithdrawalsArgs,
  opts?: PrivateHttpOptions,
): Promise<Result<FetchedWithdrawals>> {
  const withdrawals: RawWithdrawal[] = [];
  const truncatedAssets: string[] = [];
  const seen = new Set<string>();
  let deduped = 0;

  for (const asset of args.assets) {
    const paged = await paginate<RawWithdrawal>({
      fetchPage: (cursor) => page(asset, cursor, args.since, opts),
      keyOf: (w) => w.uuid,
      // 後方 end 走査: このページ最古の requested_at より前へ
      nextCursor: (rows) => String(Math.min(...rows.map((w) => w.requested_at))),
      maxPages: args.maxPages ?? MAX_PAGES_DEFAULT,
      initialCursor: args.end,
      pageSize: PAGE_SIZE,
    });
    if (!paged.success) {
      return { success: false, error: `${asset}: ${paged.error}`, exitCode: paged.exitCode };
    }
    deduped += paged.data.deduped;
    // uuid は資産横断で一意な前提。重なった場合も二重計上しないよう再排除する
    for (const w of paged.data.rows) {
      if (seen.has(w.uuid)) {
        deduped++;
        continue;
      }
      seen.add(w.uuid);
      withdrawals.push(w);
    }
    if (paged.data.truncated) truncatedAssets.push(asset);
  }

  withdrawals.sort((a, b) => a.requested_at - b.requested_at || a.uuid.localeCompare(b.uuid));
  return { success: true, data: { withdrawals, deduped, truncatedAssets } };
}
