// 100行超: 巻き戻しの符号・手数料の建て・時刻の取り方は、間違えても系列が滑らかなままで
// 読み手に気づかれない。実装は 50 行弱で、残りは「なぜその式なのか」と移植元との差分の根拠。
// これを削ると次に触る人が同じ罠を踏むため、行数のために短くしない。
//
// 現在の保有から約定・入出金を逆順に巻き戻し、指定日時の保有を復元する。
//
// **移植元**: 姉妹リポ `bitbankinc/bitbank-lab-mcp` の
// `src/handlers/portfolio/calc.ts#reconstructHoldingsAtDate`（`ecf05ae` 時点）。
// CLAUDE.md が「MCP は別リポ。直接 import しない」と定めているためコピーになっている。
// **逆算の符号・手数料の扱いを変えると静かに値がずれる**ので、片方だけ直さないこと。
import type { Deposit } from "../commands/private/deposit-history.js";
import type { Trade } from "../commands/private/trade-history.js";
import type { Withdrawal } from "../commands/private/withdrawal-history.js";
import type { PairAssets } from "./scope.js";

export type { PairAssets };

/** 数量の実質ゼロ判定。移植元と同じ閾値（浮動小数の残渣を保有として残さない） */
const DUST = 1e-12;

export type Holdings = Map<string, number>;

export type Transfers = {
  deposits: readonly Deposit[];
  withdrawals: readonly Withdrawal[];
};

/** 入庫が口座に反映された時刻。DONE なら confirmed_at が入るが、欠落していても
 *  レコードを落とすと再構築が静かに狂うので found_at へフォールバックする
 *  （found_at ≤ confirmed_at。移植元は confirmed_at 固定）。 */
function depositAt(d: Deposit): number {
  return d.confirmed_at ?? d.found_at;
}

/**
 * 差分を加算する。**途中経過が負でも消さない**のが要点。
 *
 * 巻き戻しは「約定 → 入庫 → 出庫」の 3 相に分かれるが、各相は同じ時点の状態に対する
 * 独立した加算なので、本来は順序に依存しない。ところが途中でゼロ以下を削除すると
 * **負の繰り越しが失われて順序依存になり、保有量が過大に出る**。
 * 例: 2 BTC 買い → 1 BTC 出庫 → 現在 1 BTC。正しくは期初 0 だが、約定相で
 * `1 - 2 = -1` を削除してしまうと出庫相が `0 + 1 = 1` を積んで 1 BTC になる。
 * 実質ゼロの掃除は全相を終えてから 1 回だけ行う（`reconstructHoldingsAtDate` 末尾）。
 */
function add(holdings: Holdings, asset: string, delta: number): void {
  holdings.set(asset, (holdings.get(asset) ?? 0) + delta);
}

/**
 * 約定 1 件を巻き戻す。base / quote は pairs マスタから渡す（ペア名の分割はしない）。
 *
 * base 残高の増減は **買い = `+qty - feeBase` / 売り = `-qty - feeBase`**
 * （base 建て手数料はどちら向きでも base から引かれる）。巻き戻しはその逆符号なので、
 * 買いは `qty - feeBase` を引き、**売りは `qty + feeBase` を戻す**。素朴に `qty` だけを
 * 動かすと手数料ぶんずれる。
 *
 * 売り側に `feeBase` を足す点は**移植元との差分**。移植元（MCP `calc.ts`）は売りで
 * `current + qty` にしており base 手数料を戻していない。本 CLI の理論残高再構築
 * （`cli/tax/reconcile/rebuild.ts#applyTrade`、独立実装との突合で残差一致を確認済み）は
 * 買い・売りの両方で base 手数料を base から引いており、そちらに揃えた。
 * 実口座では `fee_amount_base` が全行ゼロ（`docs/dev/tax-evidence/ANSWERS.md` §1）なので
 * 現状の出力は変わらないが、非ゼロが来たときに静かにずれない側へ倒す。
 *
 * quote 側は 買い = `qty × price + feeQuote` を戻し、売り = 受取（`qty × price - feeQuote`）
 * を除く。JPY 建てでも BTC 建てでも同じ数量演算（円換算は評価段が candle で行う）。
 */
function undoTrade(holdings: Holdings, t: Trade, base: string, quote: string): void {
  const qty = t.amount;
  const price = t.price;
  const feeQuote = t.fee_amount_quote || 0;
  const feeBase = t.fee_amount_base || 0;
  if (!Number.isFinite(qty) || !Number.isFinite(price)) return;

  if (t.side === "buy") {
    add(holdings, base, -(qty - feeBase));
    add(holdings, quote, qty * price + feeQuote);
  } else {
    add(holdings, base, qty + feeBase);
    add(holdings, quote, -(qty * price) + feeQuote);
  }
}

/**
 * `sinceMs` 時点の保有数量を復元する。
 *
 * - 対象の約定は `executed_at >= sinceMs`（新しい順に巻き戻す）
 * - `pairAssets` に無いペアの約定は巻き戻さない（base/quote を推定しない）
 * - 入出金は **`status === "DONE"` のみ**（未確定・キャンセルは口座残高を動かしていない）
 * - **出金の巻き戻しは `amount + fee`**。出金時に失った手数料も当時は口座にあった
 */
export function reconstructHoldingsAtDate(
  current: readonly { asset: string; amount: number }[],
  trades: readonly Trade[],
  sinceMs: number,
  transfers: Transfers,
  pairAssets: PairAssets,
): Holdings {
  const holdings: Holdings = new Map();
  for (const h of current) {
    if (Number.isFinite(h.amount) && h.amount > 0) holdings.set(h.asset, h.amount);
  }

  const recent = trades
    .filter((t) => t.executed_at >= sinceMs)
    .sort((a, b) => b.executed_at - a.executed_at);
  for (const t of recent) {
    const a = pairAssets.get(t.pair);
    if (!a) continue;
    undoTrade(holdings, t, a.base, a.quote);
  }

  for (const d of transfers.deposits) {
    if (d.status !== "DONE" || depositAt(d) < sinceMs) continue;
    add(holdings, d.asset, -d.amount);
  }
  for (const w of transfers.withdrawals) {
    if (w.status !== "DONE" || w.requested_at < sinceMs) continue;
    add(holdings, w.asset, w.amount + (w.fee || 0));
  }

  // 実質ゼロの掃除はここ 1 回だけ（上の add のコメント参照）。負値は履歴の欠落を意味するが、
  // 移植元と同じく保有なし扱いにする（欠落自体は completeness / warnings が別途申告する）。
  for (const [asset, amount] of holdings) {
    if (amount < DUST) holdings.delete(asset);
  }
  return holdings;
}
