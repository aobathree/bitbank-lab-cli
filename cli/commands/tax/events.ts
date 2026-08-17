// `bitbank tax events` — API 3 エンドポイントを取り込み、正規化イベント列を返す。
// private GET のみ。POST は絶対に呼ばない（要求仕様 §2.1）。
import type { PrivateHttpOptions } from "../../http-private.js";
import { collectEvents } from "../../tax/import/collect.js";
import { readBrokerage } from "../../tax/import-csv/brokerage.js";
import type { TaxEvent } from "../../tax/schema/event.js";
import type { Result } from "../../types.js";
import { parseMaxPages, resolveYearWindow } from "../private/input-schemas.js";
import { resolveMarket } from "./market.js";

const MAX_PAGES_DEFAULT = 1000;

export type TaxEventsArgs = { year?: string; maxPages?: string; brokerageCsv?: string };

export type TaxEventsData = {
  events: TaxEvent[];
  /** 取り込めなかった行。件数ゼロでも欄は残す（黙って落ちていないことの証跡） */
  pending: { source_ref: string; reason: string }[];
  warnings: string[];
  counts: { trades: number; deposits: number; withdrawals: number; deduped: number };
};

export async function taxEvents(
  args: TaxEventsArgs,
  opts?: PrivateHttpOptions,
): Promise<Result<TaxEventsData>> {
  const mp = parseMaxPages(args.maxPages, MAX_PAGES_DEFAULT);
  if (!mp.success) return mp;
  const win = resolveYearWindow({ year: args.year });
  if (!win.success) return win;

  // 販売所 CSV は API を叩く前に読む（壊れていれば認証・レート制限を消費せずに落ちる）
  const brokerage = args.brokerageCsv === undefined ? undefined : readBrokerage(args.brokerageCsv);
  if (brokerage !== undefined && !brokerage.success) return brokerage;

  const market = await resolveMarket(opts);
  if (!market.success) return market;

  const collected = await collectEvents(
    {
      pairs: market.data.pairs,
      assets: market.data.assets,
      since: win.data.since,
      end: win.data.end,
      maxPages: mp.data,
      brokerage: brokerage?.success === true ? brokerage.data.rows : undefined,
    },
    opts,
  );
  if (!collected.success) return collected;

  // 範囲クエリの境界に依存せず、年分は jstYear で確定させる（ADR-004 の税務例外）
  const filterYear = win.data.filterYear;
  const events =
    filterYear === undefined
      ? collected.data.events
      : collected.data.events.filter((e) => e.year_jst === filterYear);

  const data: TaxEventsData = {
    events,
    pending: collected.data.pending,
    warnings: collected.data.warnings,
    counts: collected.data.counts,
  };
  return collected.partial
    ? { success: true, data, partial: true, meta: collected.meta }
    : { success: true, data };
}
