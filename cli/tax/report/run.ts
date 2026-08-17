// 参考損益レポートの実行パイプライン。
// 収集は**全履歴**で行う（残高突合＝ガード(d) が全履歴でしか成立しないため）。
// 仕訳化は当年分（year_jst）だけに絞る。前年分は繰越（--carryover）で受け取る。
import type { PrivateHttpOptions } from "../../http-private.js";
import type { Result } from "../../types.js";
import { runEngine } from "../engine/run.js";
import { ZERO_BOOK } from "../engine/total-average.js";
import type { OpeningBalances } from "../engine/types.js";
import type { BrokerageRow } from "../import-csv/brokerage-columns.js";
import { ledgerFromEvents } from "../ledger/from-events.js";
import { type Market, runReconcile } from "../reconcile/run.js";
import type { Method } from "../schema/method.js";
import type { TaxReport } from "../schema/report.js";
import type { Taxation } from "../schema/taxation.js";
import { buildReport } from "./build.js";

export type PnlArgs = {
  year: number;
  method: Method;
  taxation: Taxation;
  attested: boolean;
  /** 明示された前年繰越。`allZero` のときは当年を初年度として全銘柄ゼロ確定にする */
  opening?: OpeningBalances;
  allZero?: boolean;
  maxPages?: number;
  /** 販売所「売買履歴」CSV の行（API には現れない経路） */
  brokerage?: readonly BrokerageRow[];
};

/**
 * `--carryover=zero`: 当年に出てくる銘柄をゼロ確定の繰越として埋める。
 *
 * ただし「当年が初年度」はユーザーの主張であると同時に、**全履歴で反証できる事実**でもある。
 * 前年以前に同一銘柄のイベントが 1 件でもあれば初年度ではないので、その銘柄は埋めない
 * （ガード (c) が止める）。前年の入庫だけがある銘柄は当年イベントにブロックフラグが立たず、
 * 残高突合は入庫を数量に含めたまま MATCH し得るため、ここで止めないと**入庫分を母集団から
 * 落とした平均単価**がガードを全部通って数値で出る。
 *
 * 前年に出庫しきって残高ゼロだった銘柄も巻き込むが（その場合ゼロは正しい繰越）、
 * 簿価ゼロを機械で証明はできないので fail-closed に倒す。明示の `--carryover` ファイルなら
 * 通る — そちらは反証できないユーザーの主張として (c) が受ける。
 */
function zeroOpening(
  currencies: Iterable<string>,
  priorYear: ReadonlySet<string>,
): OpeningBalances {
  const opening: OpeningBalances = {};
  for (const c of currencies) if (!priorYear.has(c)) opening[c] = ZERO_BOOK;
  return opening;
}

export async function runPnlReport(
  args: PnlArgs,
  market: Market,
  opts?: PrivateHttpOptions,
): Promise<Result<TaxReport>> {
  const reconciled = await runReconcile(
    market,
    { maxPages: args.maxPages, brokerage: args.brokerage },
    opts,
  );
  if (!reconciled.success) return reconciled;
  const { collected, comparisons } = reconciled.data;

  // 年分は JST だけで判定する（要求仕様 §4。12/28 JST = 12/27 UTC の例が実在する）
  const yearEvents = collected.events.filter((e) => e.year_jst === args.year);
  const ledger = ledgerFromEvents(yearEvents);

  // 反証の材料は全履歴側にしかない（yearEvents には前年の事情が現れない）
  const priorYear = new Set(
    collected.events.filter((e) => e.year_jst < args.year).map((e) => e.currency),
  );
  const ledgerCurrencies = new Set(ledger.entries.map((e) => e.currency));
  const opening = args.allZero ? zeroOpening(ledgerCurrencies, priorYear) : (args.opening ?? {});
  const carryoverZeroRejected = args.allZero
    ? [...ledgerCurrencies].filter((c) => priorYear.has(c))
    : [];
  const results = runEngine({ entries: ledger.entries, method: args.method, opening });

  const report = buildReport({
    year: args.year,
    method: args.method,
    taxation: args.taxation,
    attested: args.attested,
    // collected は全履歴のまま渡す。当年スコープは yearEvents / ledger で分けて渡し、
    // どちらの件数がレポートのどのフィールドになるかを引数名で追えるようにする
    collected,
    yearEvents,
    ledger,
    results,
    reconciliation: comparisons,
    carryoverZeroRejected,
  });
  return reconciled.partial
    ? { success: true, data: report, partial: true, meta: reconciled.meta }
    : { success: true, data: report };
}
