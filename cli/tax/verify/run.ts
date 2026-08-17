// 100行超: 収集 → 突合 → 組み立ての 1 本道。組み立てを別関数に切り出すと、呼び出し元が
// すでに持っている値を 7 フィールドの引数オブジェクトで渡し直すだけになり、合計行数も増えた。
//
// 年間取引報告書突合の実行（当年イベント収集 → 集計 → 突合）。
// 残高突合（reconcile）と違って**全履歴を必要としない**。報告書は年単位で閉じており、
// 比較対象も当年フローだけなので、収集は年ウィンドウで済む。
//
// CSV は**コマンド層で読んでから**渡す。壊れた CSV で API を叩いてから落ちると、
// 認証・レート制限だけ消費して何も得られない。
import type { PrivateHttpOptions } from "../../http-private.js";
import type { Result } from "../../types.js";
import { collectEvents, TRUNCATED_WARNING } from "../import/collect.js";
import type { ParsedAnnualReport } from "../import-csv/annual-report.js";
import type { BrokerageRow } from "../import-csv/brokerage-columns.js";
import type { ParsedMarginReport } from "../import-csv/margin-report.js";
import type { Market } from "../reconcile/run.js";
import { verifyDisclaimers } from "../report/disclaimers.js";
import type { VerifyReport } from "../schema/verify.js";
import { aggregateForReport } from "./aggregate.js";
import { compareAnnualReport } from "./annual-report.js";
import { aggregateMarginForReport } from "./margin-aggregate.js";
import { compareMarginReport } from "./margin-report.js";

export type VerifyArgs = {
  year: number;
  /** 現物の年間取引報告書。信用だけ突合したいときは省略できる */
  report?: ParsedAnnualReport;
  /** 信用の年間取引報告書（別様式・別ファイル） */
  marginReport?: ParsedMarginReport;
  /** 販売所「売買履歴」CSV の行。入れると差が販売所ぶん縮む */
  brokerage?: readonly BrokerageRow[];
  since?: string;
  end?: string;
  maxPages?: number;
};

export async function runVerifyReport(
  args: VerifyArgs,
  market: Market,
  opts?: PrivateHttpOptions,
): Promise<Result<VerifyReport>> {
  const collected = await collectEvents(
    {
      pairs: market.pairs,
      assets: market.assets,
      since: args.since,
      end: args.end,
      maxPages: args.maxPages,
      brokerage: args.brokerage,
    },
    opts,
  );
  if (!collected.success) return collected;

  // 範囲クエリの境界ではなく year_jst で年分を確定させる（ADR-004 の税務例外）
  const events = collected.data.events.filter((e) => e.year_jst === args.year);

  const spot =
    args.report === undefined
      ? undefined
      : compareAnnualReport(args.report, aggregateForReport(events));
  if (spot !== undefined && !spot.success) return spot;
  const margin =
    args.marginReport === undefined
      ? undefined
      : compareMarginReport(args.marginReport, aggregateMarginForReport(events));
  if (margin !== undefined && !margin.success) return margin;

  const spotData = spot?.success === true ? spot.data : undefined;
  const marginData = margin?.success === true ? margin.data : undefined;
  const warnings = [
    ...(spotData?.warnings ?? []),
    ...(marginData?.warnings ?? []),
    ...collected.data.warnings,
  ];
  // 報告書 CSV は年度をどこにも持たない（メタ行は氏名と発行者だけ）。別年度の CSV を
  // 渡されても検出できないので、差を論じる前に取り違えを疑えるよう明示する
  warnings.push(
    `CSV には年度情報が無いため --year=${args.year} との一致は検証できません。対象年の報告書か確認してください`,
  );
  // 年分を取り違えると**ほぼ全項目**が両方向に外れる。個別の原因を追う前に気づけるよう、
  // 不一致の割合が高いときは真っ先にそれを疑わせる（実運用で 1 回目に踏んだ）
  const rows = [...(spotData?.rows ?? []), ...(marginData?.rows ?? [])];
  const mismatched = rows.filter((r) => !r.within_tolerance).length;
  if (rows.length >= 5 && mismatched * 5 >= rows.length * 4) {
    warnings.push(
      `${rows.length} 項目中 ${mismatched} 項目が一致していません。個別の原因を追う前に、報告書の対象年が --year=${args.year} と食い違っていないか確認してください`,
    );
  }
  if (collected.data.truncated) {
    // 打ち切られていれば API 側が一様に少なくなる。その差を販売所ぶんと読んではいけない
    warnings.push(TRUNCATED_WARNING);
  }

  const data: VerifyReport = {
    year_jst: args.year,
    source: {
      csv_rows: args.report?.rows.length ?? 0,
      margin_csv_rows: args.marginReport?.rows.length ?? 0,
      events: events.length,
      pending: collected.data.pending.length,
      truncated: collected.data.truncated,
    },
    rows,
    report_checks: spotData?.checks ?? [],
    unsupported: [...(spotData?.unsupported ?? []), ...(marginData?.unsupported ?? [])],
    unknown_columns: [
      ...(args.report?.unknownColumns ?? []),
      ...(args.marginReport?.unknownColumns ?? []),
    ],
    warnings,
    disclaimers: verifyDisclaimers(),
  };
  return collected.partial
    ? { success: true, data, partial: true, meta: collected.meta }
    : { success: true, data };
}
