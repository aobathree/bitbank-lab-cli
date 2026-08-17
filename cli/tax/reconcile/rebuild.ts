// 理論残高の再構築（ガード(d) の前半）。原型は scripts/dev/tax/reconcile.ts で、
// **独立実装との突合で全資産の残差一致を確認済みの検証済みオラクル**（要求仕様 §10-2）。
// 原型は恒久保全し、本モジュールとの結果一致は skip ゲート付きテストで常時検証する。
//
// 税務仕訳（ledger/from-events.ts）とは**別の帳簿**である点に注意。仕訳側は出庫で
// 数量を減らさない（自己移転前提。v2 §13.3）が、残高はもちろん減る。

import { splitPair } from "../import/symbol-alias.js";
import { add, isZero, type Ratio, sub, ZERO } from "../ratio.js";
import { fromDecimalString } from "../ratio-decimal.js";
import type { TaxEvent } from "../schema/event.js";

export type Rebuilt = {
  balances: Map<string, Ratio>;
  /** 円換算・数量の前提が崩れていて突合できない資産（非 JPY クォート等） */
  unreconcilable: Set<string>;
  problems: string[];
};

type Acc = { balances: Map<string, Ratio>; problems: string[] };

function bump(acc: Acc, currency: string, delta: Ratio): void {
  if (isZero(delta)) return;
  acc.balances.set(currency, add(acc.balances.get(currency) ?? ZERO, delta));
}

/** decStr を読む。読めなければ問題として記録し ZERO を返す（黙って 0 にしない）。 */
function num(acc: Acc, value: string | undefined, label: string, ref: string): Ratio {
  if (value === undefined) return ZERO;
  const r = fromDecimalString(value);
  if (r === null) {
    acc.problems.push(`${ref}: ${label} を十進文字列として読めません（${value}）`);
    return ZERO;
  }
  return r;
}

function applyTrade(acc: Acc, e: TaxEvent, quote: string): void {
  const qty = num(acc, e.qty, "qty", e.event_id);
  const notional = num(acc, e.jpy_value, "jpy_value", e.event_id);
  const sign = e.kind === "TRADE_SPOT_BUY" ? 1 : -1;
  bump(acc, e.currency, sign > 0 ? qty : sub(ZERO, qty));
  bump(acc, quote, sign > 0 ? sub(ZERO, notional) : notional);
  // 手数料は符号そのままで引く（負値＝メイカーリベートは自然に増加になる）
  bump(acc, e.currency, sub(ZERO, num(acc, e.fee?.base, "fee.base", e.event_id)));
  bump(acc, quote, sub(ZERO, num(acc, e.fee?.quote_charged, "fee.quote_charged", e.event_id)));
}

export function rebuildBalances(events: readonly TaxEvent[]): Rebuilt {
  const acc: Acc = { balances: new Map(), problems: [] };
  const unreconcilable = new Set<string>();

  for (const e of events) {
    const pair = e.pair_raw === undefined ? null : splitPair(e.pair_raw);
    if (e.flags.includes("NON_JPY_QUOTE")) {
      // 非 JPY クォートは quote 側の数量が円換算額と別物なので、この帳簿では扱えない。
      // 残差を黙って作らず「突合不能」として当該資産をまるごと外す（設計メモ §4-4）
      unreconcilable.add(e.currency);
      if (pair) unreconcilable.add(pair.quote);
      continue;
    }
    if (e.kind === "TRADE_SPOT_BUY" || e.kind === "TRADE_SPOT_SELL") {
      applyTrade(acc, e, pair?.quote ?? "jpy");
    } else if (e.kind === "MARGIN_CLOSE") {
      // 信用は base 残高を動かさない。quote へは profit_loss（ネット）だけが乗る。
      // fee / interest は profit_loss に織り込み済みなので別途引かない（二重計上）
      bump(acc, pair?.quote ?? "jpy", num(acc, e.margin?.realized_net, "realized_net", e.event_id));
    } else if (e.kind === "DEPOSIT") {
      bump(acc, e.currency, num(acc, e.qty, "qty", e.event_id));
    } else if (e.kind === "WITHDRAWAL") {
      // 付録E.3: 資産減少 = amount + fee
      const total = add(
        num(acc, e.qty, "qty", e.event_id),
        num(acc, e.transfer?.fee_qty, "transfer.fee_qty", e.event_id),
      );
      bump(acc, e.currency, sub(ZERO, total));
    }
  }
  return { balances: acc.balances, unreconcilable, problems: acc.problems };
}
