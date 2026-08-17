// 順序を**定義できない**同時刻の検出（移動平均法だけの問題）。
//
// `sort-order.ts` は同一ソース内のタイブレークを約定ID の数値順に揃えたが、
// **取引所の `trade_id` と販売所の注文ID は別の ID 空間**で、数値の大小に意味が無い。
// しかも販売所 CSV の日時は秒精度（`jstDateTimeToMs` で `.000` ms に落ちる）ので、
// 秒未満の実際の前後関係は原理的に復元できない。どちらを先にしても根拠が無い。
//
// 移動平均法は時系列順が譲渡原価を変えるので、この状況では**数値を出さない**。
// 総平均法は順序非依存なので呼ばない（`moving-average.ts` からのみ使う）。
//
// **止めるのは順序が結果を変える組み合わせだけ。** 同一ミリ秒でも取得どうし・処分どうしは
// 可換なので通す。販売所は全行が `.000` ms に落ちる以上、無条件に止めると順序と無関係な
// 同時刻まで巻き込んで誤ブロックになる。
//
// 検出結果は `violations` に積む。`pending`（取込の保留リスト）には積まない —
// `evaluateGuard` が見るのは仕訳層の `deferred` と `violations` で `collected.pending` は
// 見ないため、pending に積んでも参考損益は止まらず、誤った数値が出たままになる。
import { ID_PREFIX } from "../import/event-base.js";
import type { LedgerEntry } from "../schema/ledger.js";

/**
 * ID 空間。**`trade` と `margin` は同じ `trade_id` 空間**（同一エンドポイントの同一列）
 * なので分けない。分けると現物と信用が同時刻に並んだだけで誤検知する。
 */
function idSpace(eventId: string): string {
  return eventId.startsWith(`${ID_PREFIX.brokerage}:`) ? "brokerage" : "exchange";
}

/**
 * 引数は**銘柄で絞り込み済み**の仕訳（`runEngine` が銘柄ごとに分割してから呼ぶ）。
 * 銘柄をまたぐ同時刻は簿価に影響しないので、ここでは見ない。
 */
export function orderAmbiguities(currency: string, entries: readonly LedgerEntry[]): string[] {
  const byTs = new Map<number, LedgerEntry[]>();
  for (const e of entries) {
    // 簿価を動かすのは取得と処分だけ。手数料・リベート（INCOME/EXPENSE）は順序に無関係
    if (e.kind !== "ACQUIRE" && e.kind !== "DISPOSE") continue;
    const list = byTs.get(e.ts_utc);
    if (list) list.push(e);
    else byTs.set(e.ts_utc, [e]);
  }

  const violations: string[] = [];
  for (const [ts, group] of byTs) {
    if (group.length < 2) continue;
    const spaces = new Set(group.map((e) => idSpace(e.event_id)));
    if (spaces.size < 2) continue; // 同一ソース内は約定ID の数値順で決まる
    const kinds = new Set(group.map((e) => e.kind));
    if (!kinds.has("ACQUIRE") || !kinds.has("DISPOSE")) continue; // 同種は可換
    const ids = group
      .map((e) => e.event_id)
      .sort()
      .join(", ");
    violations.push(
      `${currency}: 同一時刻（ts_utc=${ts}）に取引所と販売所の取得・処分が混在しています` +
        `（${ids}）。販売所の日時は秒精度で前後関係を復元できず、移動平均法では` +
        `順序が譲渡原価を変えるため数値を出しません（総平均法は順序に依存しません）`,
    );
  }
  return violations.sort();
}
