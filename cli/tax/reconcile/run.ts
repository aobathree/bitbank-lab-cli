// 残高突合の実行（収集 → 再構築 → /user/assets と突合）。
// **全履歴でしか成立しない**ので、期間指定は受け取らない（要求仕様 §10-2）。
import type { PrivateHttpOptions } from "../../http-private.js";
import type { Result } from "../../types.js";
import { type Collected, collectEvents } from "../import/collect.js";
import { fetchAssets } from "../import/fetch-assets.js";
import type { BrokerageRow } from "../import-csv/brokerage-columns.js";
import { type AssetComparison, compareBalances } from "./compare.js";
import { type Rebuilt, rebuildBalances } from "./rebuild.js";

export type Market = { pairs: string[]; assets: string[] };

export type ReconcileOutcome = {
  collected: Collected;
  rebuilt: Rebuilt;
  comparisons: AssetComparison[];
};

export async function runReconcile(
  market: Market,
  args: {
    maxPages?: number;
    dustByCurrency?: Record<string, string>;
    brokerage?: readonly BrokerageRow[];
  } = {},
  opts?: PrivateHttpOptions,
): Promise<Result<ReconcileOutcome>> {
  const collected = await collectEvents(
    {
      pairs: market.pairs,
      assets: market.assets,
      maxPages: args.maxPages,
      brokerage: args.brokerage,
    },
    opts,
  );
  if (!collected.success) return collected;

  const assets = await fetchAssets(opts);
  if (!assets.success) return assets;

  const rebuilt = rebuildBalances(collected.data.events);
  const comparisons = compareBalances(rebuilt, assets.data, args.dustByCurrency ?? {});
  const data: ReconcileOutcome = { collected: collected.data, rebuilt, comparisons };

  // 履歴が打ち切られていれば突合結果は信用できない。partial のまま上へ返す
  return collected.partial
    ? { success: true, data, partial: true, meta: collected.meta }
    : { success: true, data };
}
