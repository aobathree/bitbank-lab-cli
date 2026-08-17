// 付与（キャンペーン / エアドロップ / レンディング利用料）の痕跡判定（付録E.3）。
// これらに履歴 API は存在しないため、入庫行の形状から**疑い**を立てるしかない。
// 判定はラベルであって断定ではない（種別は API から判定不能）。ここで立つのは
// GRANT_SUSPECT フラグだけで、取得価額の解決は手動調整（P1）に委ねる。

import { isInteger } from "../ratio.js";
import { fromDecimalString } from "../ratio-decimal.js";
import type { RawDeposit } from "./raw-transfer.js";

/** 秒以下が 00.000（= 分境界ちょうど）。実観測はさらに正時ちょうどだったが、
 *  条件を締めると付与を取りこぼす。**過検出は手動確認で済むが過少検出は取得原価の
 *  誤りに直結する**ので、付録E.3 と同じ「緩い側に倒す」判断を fiat にも適用する。 */
const MINUTE_MS = 60_000;

function hasSubYenFraction(amount: string): boolean {
  const r = fromDecimalString(amount);
  return r !== null && !isInteger(r);
}

/**
 * 付与の痕跡か。2 系統のパターンを見る（付録E.3）:
 * - crypto: `txid == null`（チェーン外の付与）。プレースホルダ address を伴う形が
 *   実観測されたが、address 一致まで必須にすると取りこぼすため txid 単独で立てる
 * - fiat(jpy): 円未満端数・`found_at == confirmed_at`・秒以下 00.000 の **3 条件すべて**
 */
export function isGrantSuspect(d: RawDeposit): boolean {
  if (d.asset.toLowerCase() !== "jpy") return d.txid == null;
  return (
    hasSubYenFraction(d.amount) &&
    d.confirmed_at != null &&
    d.found_at === d.confirmed_at &&
    d.found_at % MINUTE_MS === 0
  );
}
