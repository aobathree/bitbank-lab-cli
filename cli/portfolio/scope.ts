// 巡回対象（ペア・資産）と現在の保有の解決。取得も復元もしない、範囲決めだけの層。
import { assets } from "../commands/private/assets.js";
import type { Deposit } from "../commands/private/deposit-history.js";
import type { Trade } from "../commands/private/trade-history.js";
import type { Withdrawal } from "../commands/private/withdrawal-history.js";
import type { Pair } from "../commands/public/pairs.js";
import type { PrivateHttpOptions } from "../http-private.js";
import type { Result } from "../types.js";

export type Holding = { asset: string; amount: number };

/** pairs マスタから巡回対象を決めるのに要るフィールドだけ。型ソースは
 *  `cli/commands/public/pairs.ts` の Zod（`PairSchema` → `z.infer`）。 */
export type PairScope = Pick<Pair, "name" | "base_asset" | "quote_asset">;

/** 約定の base / quote。ペア名の分割ではなくマスタのフィールドを使う。 */
export type PairAssets = ReadonlyMap<string, { base: string; quote: string }>;

export function pairAssetsOf(
  list: readonly PairScope[],
): Map<string, { base: string; quote: string }> {
  return new Map(list.map((p) => [p.name, { base: p.base_asset, quote: p.quote_asset }]));
}

/** 出庫は asset 必須・約定は pair 必須なので、pairs マスタ（delist 込み）から巡回対象を
 *  作る。取引の無いペア／資産でも 1 リクエストで空が返るだけ。delist 済みでも履歴は
 *  残るため `is_enabled` では絞らない（trade-history --all-pairs / tax resolveMarket と同じ）。
 *
 *  約定の取得は **全ペア**（`allPairs`）。BTC 建て等の非 JPY クォートも履歴が残るため、
 *  JPY だけに絞ると巻き戻しから静かに欠ける。評価用 candle は JPY 建てだけ
 *  （`jpyPairs` / `candlePairsFor`）で足りる。 */
export function marketScope(list: readonly PairScope[]): {
  allPairs: string[];
  jpyPairs: string[];
  allAssets: string[];
} {
  const allPairs: string[] = [];
  const jpyPairs: string[] = [];
  const assetSet = new Set<string>();
  for (const p of list) {
    allPairs.push(p.name);
    if (p.quote_asset === "jpy") jpyPairs.push(p.name);
    assetSet.add(p.base_asset);
    assetSet.add(p.quote_asset);
  }
  return {
    allPairs: allPairs.sort(),
    jpyPairs: jpyPairs.sort(),
    allAssets: [...assetSet].sort(),
  };
}

/** 現在の保有数量。**出金申請中（withdrawing）を足し戻す**: onhand からは既に引かれて
 *  いる一方、巻き戻しでは status=DONE の出庫しか戻さないので、足さないと申請中の資産が
 *  過去の全時点で欠ける（cli/tax/import/fetch-assets.ts と同じ「実残高」の定義）。 */
export async function currentHoldings(opts?: PrivateHttpOptions): Promise<Result<Holding[]>> {
  const r = await assets({ showAll: true }, opts);
  if (!r.success) return r;
  const rows = r.data
    .map((a) => ({ asset: a.asset, amount: a.onhand_amount + a.withdrawing_amount }))
    .filter((h) => h.amount > 0);
  return { success: true, data: rows };
}

/**
 * candle を引くペア = 現在の保有 ∪ 期間内に動いた資産（いずれも JPY 建て評価用）。
 *
 * 現在の保有だけで引くと、**期間中に全量売却した銘柄**が過去の点で現在価格に落ちる
 * （復元では当時保有していたことになるのに、その日の始値が無い）。
 * base / quote はすべて pairs マスタから取る（ペア名の `_jpy` 除去で base を推定しない）。
 */
export function candlePairsFor(
  jpyPairs: readonly string[],
  holdings: readonly Holding[],
  history: { trades: Trade[]; deposits: Deposit[]; withdrawals: Withdrawal[] },
  pairAssets: PairAssets,
): string[] {
  const touched = new Set(holdings.map((h) => h.asset));
  for (const t of history.trades) {
    const a = pairAssets.get(t.pair);
    if (!a) continue;
    touched.add(a.base);
    touched.add(a.quote);
  }
  for (const d of history.deposits) touched.add(d.asset);
  for (const w of history.withdrawals) touched.add(w.asset);
  return jpyPairs.filter((p) => {
    const a = pairAssets.get(p);
    return a?.quote === "jpy" && touched.has(a.base);
  });
}
