// 期間中の純入出金（元本移動）と出金手数料（コスト）を分離して算出する。
//
// **移植元**: `bitbankinc/bitbank-lab-mcp` の
// `src/handlers/portfolio/calc.ts#calcPeriodNetFlow`（`ecf05ae` 時点）。
// **元本と手数料を混ぜてはいけない**。混ぜると「入出金を除いた増減」がコストぶん狂う。
import type { Deposit } from "../commands/private/deposit-history.js";
import type { Transfers } from "./reconstruct.js";
// 出力 DTO の型ソースは Zod（schema.ts）
import type { NetFlow } from "./schema.js";

export type { NetFlow };

function depositAt(d: Deposit): number {
  return d.confirmed_at ?? d.found_at;
}

/** 暗号資産の入出庫は**現在価格で仮評価**する（当時の価格ではない）。この近似は
 *  出力の note / assumptions に明記する。価格不明の資産は 0 円ではなく「計上しない」。 */
function jpyValue(asset: string, amount: number, prices: ReadonlyMap<string, number>): number {
  if (asset === "jpy") return amount;
  const price = prices.get(asset);
  if (price === undefined || !Number.isFinite(amount) || amount <= 0) return 0;
  return amount * price;
}

/** 価格が引けず金額に換算できなかった入出庫（呼び出し側が warning にする）。 */
function unpriced(asset: string, prices: ReadonlyMap<string, number>): boolean {
  return asset !== "jpy" && prices.get(asset) === undefined;
}

export function calcPeriodNetFlow(
  transfers: Transfers,
  sinceMs: number,
  prices: ReadonlyMap<string, number>,
): { flow: NetFlow; unpricedAssets: string[] } {
  const unpricedAssets = new Set<string>();
  let netFlow = 0;
  let withdrawalFee = 0;

  for (const d of transfers.deposits) {
    if (d.status !== "DONE" || depositAt(d) < sinceMs) continue;
    if (unpriced(d.asset, prices)) unpricedAssets.add(d.asset);
    netFlow += jpyValue(d.asset, d.amount, prices);
  }

  for (const w of transfers.withdrawals) {
    if (w.status !== "DONE" || w.requested_at < sinceMs) continue;
    if (unpriced(w.asset, prices)) unpricedAssets.add(w.asset);
    // 元本（外部フロー）と手数料（コスト）を分離する
    netFlow -= jpyValue(w.asset, w.amount, prices);
    const fee = w.fee || 0;
    if (fee > 0) withdrawalFee += jpyValue(w.asset, fee, prices);
  }

  return {
    flow: {
      net_flow_jpy: Math.round(netFlow),
      withdrawal_fee_jpy: Math.round(withdrawalFee),
    },
    unpricedAssets: [...unpricedAssets].sort(),
  };
}
