// 信用の新規 / 決済判定（付録E.2）。API には新規・決済の区別が無く、
// **`profit_loss != 0` での判定は損益ゼロの決済で誤るため使えない**（要求仕様 §3.1）。
// `position_side` と side の組で向きを決め、数量の積み上げで整合を検査する。
import { add, cmp, isZero, type Ratio, sub, ZERO } from "../ratio.js";
import { fromDecimalString, toExactDecimalString } from "../ratio-decimal.js";
import type { RawTrade } from "./raw-trade.js";

export type MarginRole = "OPEN" | "CLOSE";
export type MarginAnomaly = { trade_id: number; reason: string };
export type MarginTracking = {
  roles: Map<number, MarginRole>;
  anomalies: MarginAnomaly[];
  /** 年末（走査終端）で残った建玉。未決済は当年損益に含めない（v2 §5） */
  outstanding: { key: string; qty: string }[];
};

/** long は buy で増え sell で減る。short はその逆。side が未知なら判定しない。 */
function roleOf(positionSide: string, side: string): MarginRole | null {
  if (side !== "buy" && side !== "sell") return null;
  if (positionSide === "long") return side === "buy" ? "OPEN" : "CLOSE";
  if (positionSide === "short") return side === "sell" ? "OPEN" : "CLOSE";
  return null;
}

/** 信用行（position_side を持つ行）を時系列順に走査して役割を確定させる。 */
export function trackMargin(trades: readonly RawTrade[]): MarginTracking {
  const roles = new Map<number, MarginRole>();
  const anomalies: MarginAnomaly[] = [];
  const open = new Map<string, Ratio>();

  for (const t of trades) {
    if (t.position_side === undefined) continue;
    const role = roleOf(t.position_side, t.side);
    if (role === null) {
      anomalies.push({
        trade_id: t.trade_id,
        reason: `未知の position_side/side の組: ${t.position_side}/${t.side}`,
      });
      continue;
    }
    const qty = fromDecimalString(t.amount);
    if (qty === null) {
      anomalies.push({ trade_id: t.trade_id, reason: `amount が十進文字列でない: ${t.amount}` });
      continue;
    }
    roles.set(t.trade_id, role);

    const key = `${t.pair}:${t.position_side}`;
    const before = open.get(key) ?? ZERO;
    const after = role === "OPEN" ? add(before, qty) : sub(before, qty);
    // 決済が建玉残を超える = 取込漏れ（過去分の欠落）か未観測の形状。黙って進めない
    if (role === "CLOSE" && cmp(after, ZERO) < 0) {
      anomalies.push({
        trade_id: t.trade_id,
        reason: `決済数量が建玉残を超えています（${key}。過年度分の取込漏れの可能性）`,
      });
    }
    open.set(key, after);
  }

  const outstanding = [...open.entries()]
    .filter(([, qty]) => !isZero(qty))
    // 数量は有限小数の和なので必ず厳密な十進表現になる（丸めは起きない）
    .map(([key, qty]) => ({ key, qty: toExactDecimalString(qty) ?? "" }));
  return { roles, anomalies, outstanding };
}
