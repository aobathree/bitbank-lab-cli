// レポート組み立て（v2 §1.2）。取引集計は常に出し、参考損益はガード成立時だけ付ける。
import type { CurrencyResult } from "../engine/run.js";
import type { GuardInput } from "../guard/reference-pnl.js";
import { type Collected, TRUNCATED_WARNING } from "../import/collect.js";
import type { LedgerResult } from "../ledger/from-events.js";
import type { AssetComparison } from "../reconcile/compare.js";
import type { TaxEvent } from "../schema/event.js";
import type { Method } from "../schema/method.js";
import type { ReconciliationRow, TaxReport } from "../schema/report.js";
import type { Taxation } from "../schema/taxation.js";
import { currencyReport } from "./currency.js";
import { disclaimers } from "./disclaimers.js";

export type BuildArgs = {
  year: number;
  method: Method;
  taxation: Taxation;
  attested: boolean;
  /** **全履歴**の取込結果。保留行・警告と `source.full_history` の出所 */
  collected: Collected;
  /**
   * **当年（`year_jst`）**のイベント。ガード入力と `source.year` の出所。
   * `collected.events` を年で絞った部分集合だが、両者は別スコープなので独立に受ける
   * （`collected` を当年イベントで作り替えて渡すと `source` のスコープが混ざる）。
   */
  yearEvents: readonly TaxEvent[];
  ledger: LedgerResult;
  results: Map<string, CurrencyResult>;
  reconciliation: readonly AssetComparison[];
  /** `--carryover=zero` を全履歴で反証した銘柄（**全履歴**スコープ。`run.ts` が組む） */
  carryoverZeroRejected: readonly string[];
};

/**
 * 打ち切りは partial envelope と stderr にしか出ないと、レポート本体だけを読む
 * 経路（LLM / --format=json の保存物）から落ちる。verify-report と同じ一言を足す。
 */
function reportWarnings(collected: Collected): string[] {
  return collected.truncated ? [...collected.warnings, TRUNCATED_WARNING] : collected.warnings;
}

function toRow(c: AssetComparison): ReconciliationRow {
  return {
    currency: c.currency,
    theoretical: c.theoretical,
    actual: c.actual,
    residual: c.residual,
    dust: c.dust,
    within_dust: c.withinDust,
    diagnosis: c.diagnosis,
    hint: c.hint,
  };
}

export function buildReport(args: BuildArgs): TaxReport {
  const guardInput: GuardInput = {
    attested: args.attested,
    truncated: args.collected.truncated,
    // ガードは当年のイベントだけを見る（過年度の未解決入庫まで当年をブロックしない）
    events: args.yearEvents,
    results: args.results,
    reconciliation: args.reconciliation,
    deferred: args.ledger.deferred,
    carryoverZeroRejected: args.carryoverZeroRejected,
  };
  const currencies = [...args.results.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, result]) => currencyReport(currency, result, args.ledger, guardInput));

  return {
    year_jst: args.year,
    method: args.method,
    taxation: args.taxation,
    attested: args.attested,
    source: {
      year: { events: args.yearEvents.length, deferred: args.ledger.deferred.length },
      full_history: {
        pending: args.collected.pending.length,
        deduped: args.collected.counts.deduped,
        truncated: args.collected.truncated,
      },
    },
    currencies,
    reconciliation: args.reconciliation.map(toRow),
    pending: args.collected.pending,
    warnings: reportWarnings(args.collected),
    disclaimers: disclaimers(args.taxation, args.year, args.method),
  };
}
