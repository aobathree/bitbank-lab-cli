// 100行超: 報告書定義との対応（手数料の足し戻し）と、参考損益ガードを通さない理由を
// 冒頭で説明しているため。コード実体は 80 行未満で、責務は 1 つ（信用の年次集計）のまま。
//
// API 由来イベントを、年間取引報告書（信用）と同じ軸へ集計する。
//
// ここから作る VerifyRow（`margin_pnl` / `margin_fee` / `margin_fee_occurred`）は、
// 参考損益の表示ガード（`guard/reference-pnl.ts` の `evaluateGuard`）を**通さない**。
// 全出力の中で銘柄別・年別の損益数値がガード外で出る唯一の箇所だが、迂回ではなく
// **意図的な設計**である（[ADR-006](../../../docs/adr/006-reference-pnl-guard-scope.md)）:
//
//   1. これは bitbank 自身が年間取引報告書と API の両方に既に出している**実現値どうしの
//      突合**であり、CLI 独自の所得計算ではない（CLI がやるのは手数料の足し戻しだけ）
//   2. ガードが守るのは「取得価額の確定性に依存する現物の参考損益」であり、信用の実現損益は
//      個別法（FIFO）で建玉ごとに確定する別系統で、取得価額計算に依存しない
//
// ガード配下へ移すと、突合の目的（報告書と API の食い違いの検出）が (b) 未解決入庫や
// (c) 前年繰越といった無関係な条件で塞がれる。移す変更は ADR-006 の再検討を伴う。
//
// 報告書の定義（社内設計資料）は `年中信用取引損益 = 値幅損益 − 利息` で、
// **取引手数料は控除していない**。一方 API の `profit_loss` は
// `値幅損益 − Σ手数料 − 利息`（実機確認 #2 で検算済み）なので、
//
//     報告書の損益 = profit_loss + 決済レコードの fee_amount_quote
//
// が定義上の対応になる。手数料を足し戻さずに比べると、差がまるごと手数料ぶん出る。
//
// 手数料は 2 通りの積み方を両方出す。報告書が「精算ベース（決済時に建て分と合算）」と
// 「発生ベース（各約定日）」のどちらで合計しているかは資料から確定できず、年をまたぐ
// 建玉があると両者はずれる。どちらが一致したかで基準が判明する。
import { splitPair } from "../import/symbol-alias.js";
import { add, type Ratio, ZERO } from "../ratio.js";
import { fromDecimalString } from "../ratio-decimal.js";
import type { TaxEvent } from "../schema/event.js";
import type { VerifyField } from "../schema/verify.js";

export const MARGIN_FIELDS = [
  "margin_pnl",
  "margin_fee",
  "margin_fee_occurred",
] as const satisfies readonly VerifyField[];
export type MarginField = (typeof MARGIN_FIELDS)[number];

// 件数は 2 本持つ。丸めが起きる回数が精算と発生で違うため（許容幅の算出は
// margin-report.ts の `toleranceOf` が単一ソース。理由もそこに書いてある）
export type MarginFigures = Record<MarginField, Ratio> & {
  /** 決済レコード数（精算ベースはここでしか丸めが起きない） */
  closes: number;
  /** 発生手数料を持つレコード数。建てと決済で別々に丸められるので両方数える */
  feeOccurredCount: number;
};
export type MarginAggregated = { byCurrency: Map<string, MarginFigures>; warnings: string[] };

function zero(): MarginFigures {
  const f = { closes: 0, feeOccurredCount: 0 } as MarginFigures;
  for (const k of MARGIN_FIELDS) f[k] = ZERO;
  return f;
}

export function aggregateMarginForReport(events: readonly TaxEvent[]): MarginAggregated {
  const byCurrency = new Map<string, MarginFigures>();
  const warnings: string[] = [];
  const slot = (currency: string): MarginFigures => {
    const found = byCurrency.get(currency);
    if (found) return found;
    const fresh = zero();
    byCurrency.set(currency, fresh);
    return fresh;
  };
  const num = (value: string | undefined, label: string, ref: string): Ratio => {
    if (value === undefined) return ZERO;
    const r = fromDecimalString(value);
    if (r !== null) return r;
    warnings.push(`${ref}: ${label} を十進文字列として読めません（${value}）`);
    return ZERO;
  };

  let nonJpyQuote = 0;
  let missingNet = 0;
  for (const e of events) {
    if (e.kind !== "MARGIN_OPEN" && e.kind !== "MARGIN_CLOSE") continue;
    if (e.flags.includes("NON_JPY_QUOTE")) {
      nonJpyQuote++;
      continue;
    }
    // 報告書の通貨名は base_asset（ペアではない）
    const f = slot(splitPair(e.pair_raw ?? "")?.base ?? e.currency);
    const chargedStr = e.margin?.fee_charged;
    const charged = num(chargedStr, "margin.fee_charged", e.event_id);
    f.margin_fee = add(f.margin_fee, charged);
    if (e.margin?.fee_occurred !== undefined) f.feeOccurredCount++;
    f.margin_fee_occurred = add(
      f.margin_fee_occurred,
      num(e.margin?.fee_occurred, "margin.fee_occurred", e.event_id),
    );
    if (e.kind !== "MARGIN_CLOSE") continue;
    f.closes++;
    // 手数料が不明なら「手数料を足し戻した損益」は**算出できない**。0 として足すと
    // 手数料ぶん少ない損益になり、しかも差の原因が分からなくなる（仕訳側も保留に回す）
    if (e.margin?.realized_net === undefined || chargedStr === undefined) {
      missingNet++;
      continue;
    }
    // 手数料を**足し戻して**報告書の定義（値幅 − 利息）へ揃える
    const net = num(e.margin.realized_net, "margin.realized_net", e.event_id);
    f.margin_pnl = add(f.margin_pnl, add(net, charged));
  }
  if (nonJpyQuote > 0) {
    warnings.push(`非 JPY クォートの信用約定 ${nonJpyQuote} 件を集計から除外しました`);
  }
  if (missingNet > 0) {
    warnings.push(
      `realized_net または fee_charged を欠く決済 ${missingNet} 件を損益集計から除外しました（差はこの分を含みます）`,
    );
  }
  return { byCurrency, warnings };
}
