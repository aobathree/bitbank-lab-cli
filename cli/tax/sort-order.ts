// 同一タイムスタンプの安定順序。要求仕様 §3【方針】「同一タイムスタンプの複数約定は
// 約定ID で安定ソート」の実装で、**4 箇所（to-events / from-events / moving-average /
// nta-sheet）の単一ソース**。各所で生の `localeCompare` を書かない。
//
// 素の辞書順だと `"10:0" < "9:0"` になり、**取得順と食い違う**（`fetch-trades.ts` は
// `a.trade_id - b.trade_id` で数値順に取っている）。移動平均法は時系列順が結果を変えるので、
// 同一ミリ秒に取得と処分が混ざると譲渡原価が入れ替わる。総平均法は順序非依存なので影響しない。
//
// キーは `:` 区切りのセグメント列（仕訳は `<source_ref>:<seq>`、イベントは
// `<prefix>:<source_ref>`）。セグメントごとに、両方が数字だけなら数値順、それ以外は辞書順。
// 数値順は `Number()` 化せず「桁数 → 辞書順」で決める — 販売所の注文ID は任意長の文字列で、
// 2^53 を超えても順序を誤らないようにするため。
//
// **異なるソース（取引所の trade_id と販売所の注文ID）の ID 空間をまたぐ比較には意味が無い。**
// ここでは決定論性だけを保証し、順序を定義できない同時刻の扱いは別途ガード側で対処する。
import type { TaxEvent } from "./schema/event.js";
import type { LedgerEntry } from "./schema/ledger.js";

const DIGITS = /^\d+$/;

function compareSegment(a: string, b: string): number {
  // 桁数が違えば桁数の少ない方が小さい。同桁なら辞書順が数値順と一致する
  if (DIGITS.test(a) && DIGITS.test(b) && a.length !== b.length) return a.length - b.length;
  return a.localeCompare(b);
}

/** `:` 区切りのセグメント列として比べる。前方のセグメントが優先。 */
export function compareSortKeys(a: string, b: string): number {
  const as = a.split(":");
  const bs = b.split(":");
  for (let i = 0; i < Math.min(as.length, bs.length); i++) {
    const c = compareSegment(as[i] ?? "", bs[i] ?? "");
    if (c !== 0) return c;
  }
  return as.length - bs.length;
}

/** 仕訳の並び（`ts_utc` → `sort_key`）。エンジンと互換モードが同じ順序を見る。 */
export function byLedgerOrder(a: LedgerEntry, b: LedgerEntry): number {
  return a.ts_utc - b.ts_utc || compareSortKeys(a.sort_key, b.sort_key);
}

/** イベントの並び（`ts_utc` → `event_id`）。決定論性 NFR。 */
export function byEventOrder(a: TaxEvent, b: TaxEvent): number {
  return a.ts_utc - b.ts_utc || compareSortKeys(a.event_id, b.event_id);
}
