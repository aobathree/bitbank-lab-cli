// 銘柄ごとにエンジンを回す薄い層。評価方法は「暗号資産の種類ごと」に選定するもの
// （所令119の2、FAQ 2-5）なので、全体既定 + 銘柄別上書きという形にしてある。
import type { LedgerEntry } from "../schema/ledger.js";
import {
  checkI3,
  checkInvariants,
  currenciesByEvent,
  type InvariantViolation,
} from "./invariants.js";
import { movingAverage } from "./moving-average.js";
import { totalAverage, ZERO_BOOK } from "./total-average.js";
import type { AverageOutcome, Method, OpeningBalances } from "./types.js";

export type RunArgs = {
  entries: readonly LedgerEntry[];
  /** 全銘柄の既定。個人の法定評価方法は総平均法（届出がない場合） */
  method: Method;
  /** 銘柄別の上書き（届出済みのユーザー向け） */
  methodByCurrency?: Record<string, Method>;
  /** 前年繰越。**未入力の銘柄は「不明」であってゼロではない**（ガード(c) が見る） */
  opening: OpeningBalances;
};

export type CurrencyResult = {
  outcome: AverageOutcome;
  invariants: InvariantViolation[];
  /** 前年繰越が入力されていたか。false なら参考損益は出せない */
  openingKnown: boolean;
};

/** JPY 自体は評価対象の暗号資産ではないので銘柄集計から外す。 */
const NON_CRYPTO = new Set(["jpy"]);

export function runEngine(args: RunArgs): Map<string, CurrencyResult> {
  const byCurrency = new Map<string, LedgerEntry[]>();
  for (const e of args.entries) {
    if (NON_CRYPTO.has(e.currency)) continue;
    const list = byCurrency.get(e.currency);
    if (list) list.push(e);
    else byCurrency.set(e.currency, [e]);
  }
  // 繰越だけあって当年の動きが無い銘柄も年末残高の繰越先として集計対象に入れる
  for (const currency of Object.keys(args.opening)) {
    if (!NON_CRYPTO.has(currency) && !byCurrency.has(currency)) byCurrency.set(currency, []);
  }

  // I3（交換取引の支払側 proceeds == 受取側 cost）は通貨をまたぐので、分割前の
  // 全台帳で 1 回だけ評価し、そのイベントに関与した通貨すべてへ配る
  const crossCurrency = checkI3(args.entries);
  const eventCurrencies = currenciesByEvent(args.entries);
  const i3For = (currency: string): InvariantViolation[] =>
    crossCurrency.filter(
      (v) => v.event_id !== undefined && eventCurrencies.get(v.event_id)?.has(currency),
    );

  const results = new Map<string, CurrencyResult>();
  for (const [currency, entries] of byCurrency) {
    const method = args.methodByCurrency?.[currency] ?? args.method;
    const openingKnown = Object.hasOwn(args.opening, currency);
    const opening = args.opening[currency] ?? ZERO_BOOK;
    const outcome =
      method === "total-average"
        ? totalAverage(currency, entries, opening)
        : movingAverage(currency, entries, opening);
    results.set(currency, {
      outcome,
      invariants: [...checkInvariants(outcome), ...i3For(currency)],
      openingKnown,
    });
  }
  return results;
}
