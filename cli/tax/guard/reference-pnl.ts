// 100行超: GuardInput の各フィールドが「当年 / 全履歴」のどちらのスコープを受け取る
// 契約なのかを型定義に明記しているため。コード実体は 80 行（判定関数は 45 行前後）。
//
// 参考損益の表示ガード（v2 §1.2 (a)〜(c) + 付録E.4 (d) + 履歴打ち切り）。**B案の核心**。
// すべて満たす銘柄だけ参考損益を数値表示し、満たさない銘柄は取引集計のみを出して
// 「表示できない理由」を明示する。ガードは黙って通さない側に倒す。
//
// ガードが守る対象は「取得価額の確定性に依存する数値」（現物の `reference` と
// `nta_compat`）。verify-report の信用損益はこの定義から外れるため意図的に対象外にして
// ある（[ADR-006](../../../docs/adr/006-reference-pnl-guard-scope.md)）。

import type { CurrencyResult } from "../engine/run.js";
import type { Deferred } from "../ledger/from-events.js";
import type { AssetComparison } from "../reconcile/compare.js";
import type { TaxEvent } from "../schema/event.js";

/**
 * ガードの入力。**フィールドごとに渡すべき集計スコープが違う**（当年 / 全履歴）ので、
 * 各フィールドのコメントに書いた契約どおりに詰めること。混ぜると、当年に無関係な
 * 過年度の事情で当年がブロックされたり、逆に全履歴でしか見えない欠落を見逃したりする。
 * 組み立ては `report/build.ts` の 1 箇所だけ（そこが唯一のスコープ整合の担保）。
 */
export type GuardInput = {
  /**
   * (a) ユーザーの明示的なアテステーション（コマンドの --attest）。
   * スコープなし（当年の実行に対する 1 回の申告で、イベント集計から導かれる値ではない）。
   */
  attested: boolean;
  /**
   * **全履歴**の収集がページ上限で打ち切られたか。欠けたイベントが通貨ごとに偶然
   * ネットゼロだと残高突合（d）は MATCH のまま通るので、打ち切り自体を独立した
   * ブロック条件にする。打ち切りは入出金側も含み銘柄に正確に紐づけられないため、
   * 判定は全銘柄一括（`currency` 引数を見ない唯一の条件）。
   */
  truncated: boolean;
  /**
   * **当年（`year_jst`）**のイベント。(b) のフラグ検査と出庫警告の材料。
   * 全履歴を渡してはいけない — 過年度の未解決入庫まで当年をブロックしてしまう。
   */
  events: readonly TaxEvent[];
  /**
   * **当年**の仕訳を前年繰越（`--carryover`）の上で走らせたエンジン結果。
   * (c) の `openingKnown`・計算前提の違反・不変条件はここから読む。
   */
  results: Map<string, CurrencyResult>;
  /**
   * (d) **全履歴**の残高突合。年ウィンドウでは理論残高を再構築できないため、
   * ここだけは当年に絞らない。非 JPY クォートの約定が過去に 1 度でもある通貨は
   * UNRECONCILABLE のまま解けず、以後の全年度でブロックされる（fail-closed）。
   */
  reconciliation: readonly AssetComparison[];
  /**
   * **当年**のイベントのうち仕訳化できなかったもの（`events` と同じ年スコープ）。
   */
  deferred: readonly Deferred[];
  /**
   * `--carryover=zero`（当年が初年度）を**全履歴で反証した**銘柄。前年以前に同一銘柄の
   * イベントがあれば初年度ではないので、ゼロ確定の繰越を (c) の充足として認めない。
   * スコープは**全履歴**（当年イベントには前年の事情が現れないため、ここだけ年で絞らない）。
   * (b) の年スコープとは別軸 — こちらはフラグの伝播ではなく、ユーザーの事実主張の反証。
   * `--carryover=zero` 以外の実行では常に空。
   */
  carryoverZeroRejected: readonly string[];
};

export type GuardVerdict = { allowed: boolean; blockedBy: string[]; warnings: string[] };

/** (b) を崩すフラグ。いずれも「取得価額が未確定」を意味する。 */
const BLOCKING_FLAGS = [
  "UNRESOLVED_TRANSFER",
  "GRANT_SUSPECT",
  "NON_JPY_QUOTE",
  "NO_RATE",
  "UNOBSERVED_SHAPE",
] as const;

const FLAG_REASON: Record<(typeof BLOCKING_FLAGS)[number], string> = {
  UNRESOLVED_TRANSFER: "(b) 未解決の入庫があります（入庫理由と取得価額の由来が未確定）",
  GRANT_SUSPECT: "(b) 付与とみられる入庫があります（取得価額の由来が未確定）",
  NON_JPY_QUOTE: "(b) 非 JPY クォートの約定があります（交換の完全計算は P0 では未対応）",
  NO_RATE: "(b) 円換算額を決められない約定があります",
  UNOBSERVED_SHAPE: "(b) 未観測の形状（暗号資産建て手数料など）があります",
};

function flagReasons(events: readonly TaxEvent[], currency: string): string[] {
  const hit = new Set<string>();
  for (const e of events) {
    if (e.currency !== currency) continue;
    for (const f of BLOCKING_FLAGS) if (e.flags.includes(f)) hit.add(FLAG_REASON[f]);
  }
  return [...hit];
}

function reconcileReason(rows: readonly AssetComparison[], currency: string): string | null {
  const row = rows.find((r) => r.currency === currency);
  if (row === undefined) return null; // 突合対象外（当年に動きのない銘柄）
  if (row.diagnosis === "MATCH") return null;
  return `(d) 残高突合が一致しません（残差 ${row.residual}: ${row.hint}）`;
}

export function evaluateGuard(input: GuardInput, currency: string): GuardVerdict {
  const blockedBy: string[] = [];
  const warnings: string[] = [];

  // 履歴が欠けていれば (a)〜(d) の成否によらず集計自体を信用できない
  if (input.truncated) {
    blockedBy.push(
      "履歴がページ上限で打ち切られています（全履歴が必要です。--max-pages を上げて再実行してください）",
    );
  }
  if (!input.attested) {
    blockedBy.push(
      "(a) アテステーション未取得: bitbank 以外の取引所・ウォレット・他アカウントでの" +
        "同一銘柄の保有・取引がないことの確認が必要です（--attest）",
    );
  }
  blockedBy.push(...flagReasons(input.events, currency));

  const result = input.results.get(currency);
  if (result === undefined || !result.openingKnown) {
    // 「繰越を書き忘れた」と「zero と書いたが反証された」は、ユーザーが次に取る行動が
    // 違う。同じ文言だと後者に「--carryover を付けてください」と言うことになる
    blockedBy.push(
      input.carryoverZeroRejected.includes(currency)
        ? "(c) --carryover=zero は使えません（前年以前にこの銘柄の取引・入出庫があり、" +
            "当年は初年度ではありません。前年末の数量と簿価をファイルで指定してください）"
        : "(c) 前年末残高（数量・簿価）が未確定です（--carryover で指定してください）",
    );
  }
  const reconcile = reconcileReason(input.reconciliation, currency);
  if (reconcile !== null) blockedBy.push(reconcile);

  for (const d of input.deferred) {
    if (d.currency === currency) blockedBy.push(`(b) 仕訳化できないイベント: ${d.reason}`);
  }
  if (result !== undefined) {
    for (const v of result.outcome.violations) blockedBy.push(`計算前提の違反: ${v}`);
    for (const v of result.invariants) blockedBy.push(`不変条件 ${v.id}: ${v.detail}`);
  }

  // 出庫自体は譲渡ではないので計算は続行できる（v2 §1.2）。警告だけ付ける
  if (input.events.some((e) => e.kind === "WITHDRAWAL" && e.currency === currency)) {
    warnings.push("出庫があります。出庫先での売却・使用・決済は本レポートに含まれません");
  }
  return { allowed: blockedBy.length === 0, blockedBy: [...new Set(blockedBy)], warnings };
}
