// 出力層の表示丸め。**丸めが起きるのは（ratio-decimal.ts を除けば）ここだけ**。
// 厳密値に対して 1 回だけ適用し、丸め済みの値を再度丸めない（v2 付録F・ADR-005）。
import type { Ratio } from "../ratio.js";
import { toDecimalString, toExactDecimalString } from "../ratio-decimal.js";

/** 数量の表示桁。bitbank の amount_precision の最大値に合わせた上限。 */
const QTY_SCALE = 8;
/** 単価の表示桁。割り切れないことが普通なので明示的に丸める。 */
const UNIT_SCALE = 8;

/** 円未満切捨て（v2 §3【方針】の出力層処理）。 */
export function yen(r: Ratio): string {
  return toDecimalString(r, 0, "ROUNDDOWN");
}

/** 厳密に十進表現できればそのまま、できなければ scale 桁で切捨て表示する。 */
function exactOr(r: Ratio, scale: number): string {
  return toExactDecimalString(r) ?? toDecimalString(r, scale, "ROUNDDOWN");
}

export function qty(r: Ratio): string {
  return exactOr(r, QTY_SCALE);
}

export function unitPrice(r: Ratio | null): string {
  // 単価が引けない（数量ゼロ）ケースは計算書 (E) の IF と同じく 0 を出す
  return r === null ? "0" : exactOr(r, UNIT_SCALE);
}
