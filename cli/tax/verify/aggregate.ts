// 100行超: 「報告書と同じ軸」の項目定義と、その軸へイベントを流し込むループ。
// 定義（COMPARED_FIELDS / ComparedField / zeroFigures）は突合側からも参照されるが、
// 定義と集計ループを分けても同一クラスタ内の相互参照が増えるだけで、「報告書の軸」の
// 単一ソースがどこなのかが分かりにくくなる
// （信用側 margin-aggregate.ts も同じ形で 1 ファイルに収めている）。
//
// API 由来イベントを、年間取引報告書（現物）と同じ軸へ集計する。
//
// 報告書の JPY 行は暗号資産行の鏡像（暗号資産を売れば円が増える）なので、
// 約定 1 件を base 側と quote 側の両方へ計上する。数量と金額が同値になるのは
// 円そのものの行だから。
//
// **信用取引は除外する**（現物の報告書には現れない。別様式）。除外を黙って
// 行うと JPY 行の差が信用損益ぶんずれて「販売所ぶん」と誤読されるため件数を警告に出す。

import { splitPair } from "../import/symbol-alias.js";
import { add, type Ratio, ZERO } from "../ratio.js";
import { fromDecimalString } from "../ratio-decimal.js";
import type { TaxEvent } from "../schema/event.js";
import type { VerifyField } from "../schema/verify.js";

export const COMPARED_FIELDS = [
  "buy_qty",
  "buy_jpy",
  "sell_qty",
  "sell_jpy",
  "deposit_qty",
  "withdrawal_qty",
  "fee",
] as const satisfies readonly VerifyField[];
export type ComparedField = (typeof COMPARED_FIELDS)[number];

export type Figures = Record<ComparedField, Ratio> & {
  /** API 4 桁丸め（付録E.1 / P-16）の手数料が何件寄与したか。許容幅の算出に使う */
  fee_rounded_count: number;
};

export type Aggregated = { byCurrency: Map<string, Figures>; warnings: string[] };

/** 報告書にしか現れない銘柄の API 側（= 全項目ゼロ）としても使う。 */
export function zeroFigures(): Figures {
  const f = { fee_rounded_count: 0 } as Figures;
  for (const k of COMPARED_FIELDS) f[k] = ZERO;
  return f;
}

export function aggregateForReport(events: readonly TaxEvent[]): Aggregated {
  const byCurrency = new Map<string, Figures>();
  const warnings: string[] = [];
  const slot = (currency: string): Figures => {
    const found = byCurrency.get(currency);
    if (found) return found;
    const fresh = zeroFigures();
    byCurrency.set(currency, fresh);
    return fresh;
  };
  /** 読めない値は黙って 0 にしない（差が「取込漏れ」に見えてしまう）。 */
  const num = (value: string | undefined, label: string, ref: string): Ratio => {
    if (value === undefined) return ZERO;
    const r = fromDecimalString(value);
    if (r !== null) return r;
    warnings.push(`${ref}: ${label} を十進文字列として読めません（${value}）`);
    return ZERO;
  };
  const bump = (f: Figures, k: ComparedField, v: Ratio): void => {
    f[k] = add(f[k], v);
  };

  let margin = 0;
  let nonJpyQuote = 0;
  // 報告書の軸に載らない kind（付与・手動調整など）。**握り潰さず種類を控えて警告に出す**
  const unhandled = new Set<string>();
  for (const e of events) {
    if (e.kind === "MARGIN_OPEN" || e.kind === "MARGIN_CLOSE") {
      margin++;
    } else if (e.kind === "TRADE_EXCHANGE" || e.flags.includes("NON_JPY_QUOTE")) {
      nonJpyQuote++;
    } else if (e.kind === "TRADE_SPOT_BUY" || e.kind === "TRADE_SPOT_SELL") {
      const base = slot(e.currency);
      const quote = slot(splitPair(e.pair_raw ?? "")?.quote ?? "jpy");
      const qty = num(e.qty, "qty", e.event_id);
      const notional = num(e.jpy_value, "jpy_value", e.event_id);
      const buy = e.kind === "TRADE_SPOT_BUY";
      bump(base, buy ? "buy_qty" : "sell_qty", qty);
      bump(base, buy ? "buy_jpy" : "sell_jpy", notional);
      bump(quote, buy ? "sell_qty" : "buy_qty", notional);
      bump(quote, buy ? "sell_jpy" : "buy_jpy", notional);
      bump(base, "fee", num(e.fee?.base, "fee.base", e.event_id));
      bump(quote, "fee", num(e.fee?.quote_charged, "fee.quote_charged", e.event_id));
      base.fee_rounded_count++;
      quote.fee_rounded_count++;
    } else if (e.kind === "DEPOSIT") {
      bump(slot(e.currency), "deposit_qty", num(e.qty, "qty", e.event_id));
    } else if (e.kind === "WITHDRAWAL") {
      const f = slot(e.currency);
      bump(f, "withdrawal_qty", num(e.qty, "qty", e.event_id));
      // 付録E.3: 出金は amount と fee が別建て。報告書も ⑦移出数量 と ⑩支払手数料 に分かれる
      bump(f, "fee", num(e.transfer?.fee_qty, "transfer.fee_qty", e.event_id));
    } else {
      unhandled.add(e.kind);
    }
  }
  if (margin > 0) {
    warnings.push(`信用取引 ${margin} 件を集計から除外しました（現物の報告書には現れません）`);
  }
  if (nonJpyQuote > 0) {
    warnings.push(`非 JPY クォートの約定 ${nonJpyQuote} 件を集計から除外しました（BTC 建て列）`);
  }
  if (unhandled.size > 0) {
    warnings.push(
      `報告書の軸に対応しない種別を集計に含めていません: ${[...unhandled].sort().join(", ")}`,
    );
  }
  return { byCurrency, warnings };
}
