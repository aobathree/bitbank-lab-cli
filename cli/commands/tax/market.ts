// 税務取込の走査対象（ペア一覧・資産一覧）を /spot/pairs から解決する。
// **delist 済みを含む全ペア**を対象にする（実機確認 #4: delist 済みペアにも履歴が
// 残存し得るため `is_enabled` では絞らない）。BTC 建てペアも含めて取り、非 JPY クォート
// の検出はペアのフラグではなく取り込んだ行の quote 通貨で行う（設計メモ §4-4）。

import type { HttpOptions } from "../../http.js";
import type { Market } from "../../tax/reconcile/run.js";
import type { Result } from "../../types.js";
import { pairs } from "../public/pairs.js";

export async function resolveMarket(opts?: HttpOptions): Promise<Result<Market>> {
  const r = await pairs(opts);
  if (!r.success) return r;
  const assets = new Set<string>();
  for (const p of r.data) {
    assets.add(p.base_asset);
    assets.add(p.quote_asset);
  }
  return { success: true, data: { pairs: r.data.map((p) => p.name), assets: [...assets] } };
}
