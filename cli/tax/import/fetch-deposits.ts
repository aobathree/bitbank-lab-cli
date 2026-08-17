// 入庫履歴の取得（GET /user/deposit_history）。
// **2 系統取得が必須**（要求仕様 §2.1・付録E.3）: `asset` 省略 = crypto のみ /
// `asset=jpy` 明示 = fiat が返り、両者は排他。省略のみだと円入金が丸ごと落ちる。
import { type PrivateHttpOptions, privateGet } from "../../http-private.js";
import { paginate } from "../../paginate.js";
import { parseResponse } from "../../parse-response.js";
import type { Result } from "../../types.js";
import { type RawDeposit, RawDepositHistory } from "./raw-transfer.js";

// count の上限はエンドポイントごとに異なる可能性がある（約定履歴は 1000 と実測済み、
// 入出庫は未確定）。サーバが上限へクランプしても paginate は「新規行ゼロ」で止まるので
// 取りこぼさない — この値は 1 往復あたりの取得量の希望であって、停止判定には使わない。
const PAGE_SIZE = 1000;
export const MAX_PAGES_DEFAULT = 1000;

export type FetchDepositsArgs = { since?: string; end?: string; maxPages?: number };
export type FetchedDeposits = { deposits: RawDeposit[]; deduped: number; truncated: boolean };

async function page(
  asset: string | undefined,
  cursor: string | undefined,
  since: string | undefined,
  opts?: PrivateHttpOptions,
): Promise<Result<RawDeposit[]>> {
  const params: Record<string, string> = {
    count: String(PAGE_SIZE),
    ...(asset !== undefined ? { asset } : {}),
    ...(since !== undefined ? { since } : {}),
    ...(cursor !== undefined ? { end: cursor } : {}),
  };
  const r = await privateGet<unknown>("/user/deposit_history", params, opts);
  return parseResponse(r, RawDepositHistory, "deposits");
}

/** 系統ごとの取得。asset=undefined が crypto、"jpy" が fiat。 */
function fetchLeg(
  asset: string | undefined,
  args: FetchDepositsArgs,
  opts?: PrivateHttpOptions,
): Promise<Result<{ rows: RawDeposit[]; deduped: number; truncated: boolean }>> {
  return paginate<RawDeposit>({
    fetchPage: (cursor) => page(asset, cursor, args.since, opts),
    keyOf: (d) => d.uuid,
    // 後方 end 走査: このページ最古の found_at より前へ。境界重複は dedup が吸収する
    nextCursor: (rows) => String(Math.min(...rows.map((d) => d.found_at))),
    maxPages: args.maxPages ?? MAX_PAGES_DEFAULT,
    initialCursor: args.end,
    pageSize: PAGE_SIZE,
  });
}

export async function fetchDeposits(
  args: FetchDepositsArgs,
  opts?: PrivateHttpOptions,
): Promise<Result<FetchedDeposits>> {
  const crypto = await fetchLeg(undefined, args, opts);
  if (!crypto.success) return crypto;
  const fiat = await fetchLeg("jpy", args, opts);
  if (!fiat.success) return fiat;

  // 2 系統は排他だが、仕様変更で重なった場合に黙って二重計上しないよう uuid で再排除する
  const seen = new Set<string>();
  const deposits: RawDeposit[] = [];
  let deduped = crypto.data.deduped + fiat.data.deduped;
  for (const d of [...crypto.data.rows, ...fiat.data.rows]) {
    if (seen.has(d.uuid)) {
      deduped++;
      continue;
    }
    seen.add(d.uuid);
    deposits.push(d);
  }
  deposits.sort((a, b) => a.found_at - b.found_at || a.uuid.localeCompare(b.uuid));
  return {
    success: true,
    data: { deposits, deduped, truncated: crypto.data.truncated || fiat.data.truncated },
  };
}
