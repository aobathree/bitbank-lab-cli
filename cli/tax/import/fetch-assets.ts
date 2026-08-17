// 残高突合の基準（GET /user/assets）。既存の assets コマンドは numStr で number 化
// するため、突合には decStr 保持のこちらを使う。
//
// 実残高は `onhand_amount + withdrawing_amount` で見る。出庫中（DONE 未満）の数量は
// onhand から引かれている一方、理論残高側では DONE の出庫しか引いていないため、
// 足し戻さないと出金申請中の資産が常に残差として出る。

import { z } from "zod";
import { type PrivateHttpOptions, privateGet } from "../../http-private.js";
import { parseResponse } from "../../parse-response.js";
import { decStr } from "../../schema-helpers.js";
import type { Result } from "../../types.js";

export const RawAsset = z.object({
  asset: z.string(),
  onhand_amount: decStr,
  withdrawing_amount: decStr,
});
export type RawAsset = z.infer<typeof RawAsset>;

const RawAssets = z.object({ assets: z.array(RawAsset) });

export function fetchAssets(opts?: PrivateHttpOptions): Promise<Result<RawAsset[]>> {
  return privateGet<unknown>("/user/assets", undefined, opts).then((r) =>
    parseResponse(r, RawAssets, "assets"),
  );
}
