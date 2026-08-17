// 年間取引報告書（現物）CSV の列定義。**列名で引く**（位置では引かない）。
// 位置で引くと列が 1 本増えただけで以降が全部ずれ、しかも数字は読めてしまうため
// 気づかないまま突合結果だけが狂う。
//
// 金額・数量は decStr（十進文字列のまま）。報告書の値は API より桁数が多い列があり
// （付録E.1 / P-16）、number 化すると比較そのものが無意味になる。
import { z } from "zod";
import { decStr } from "../../schema-helpers.js";
import type { UnsupportedField } from "../schema/verify.js";

export const AnnualReportRow = z.object({
  currency: z.string(),
  opening_qty: decStr,
  buy_qty: decStr,
  buy_jpy: decStr,
  buy_qty_btc: decStr,
  buy_btc: decStr,
  sell_qty: decStr,
  sell_jpy: decStr,
  sell_qty_btc: decStr,
  sell_btc: decStr,
  deposit_qty: decStr,
  withdrawal_qty: decStr,
  fee: decStr,
  lend_qty: decStr,
  return_qty: decStr,
  lend_pnl: decStr,
  closing_qty: decStr,
});
export type AnnualReportRow = z.infer<typeof AnnualReportRow>;

/** 列見出し → フィールド。見出しの表記ゆれは実物が出るまで増やさない（推測で広げない）。 */
export const COLUMNS = {
  通貨名: "currency",
  年始数量: "opening_qty",
  JPY建て年中購入数量: "buy_qty",
  JPY建て年中購入金額: "buy_jpy",
  BTC建て年中購入数量: "buy_qty_btc",
  BTC建て年中購入金額: "buy_btc",
  JPY建て年中売却数量: "sell_qty",
  JPY建て年中売却金額: "sell_jpy",
  BTC建て年中売却数量: "sell_qty_btc",
  BTC建て年中売却金額: "sell_btc",
  移入数量: "deposit_qty",
  移出数量: "withdrawal_qty",
  支払手数料: "fee",
  貸出数量: "lend_qty",
  返却数量: "return_qty",
  貸出損益: "lend_pnl",
  年末数量: "closing_qty",
} as const satisfies Record<string, keyof AnnualReportRow>;

/** ヘッダ行の目印。1 行目は氏名・発行者のメタ行なので、この列名で行を探す。 */
export const HEADER_MARKER = "通貨名";

/** 当 CLI が API から再現できない列。非ゼロなら突合の前提が崩れる（黙って無視しない）。 */
export const UNSUPPORTED_FIELDS = [
  "buy_qty_btc",
  "buy_btc",
  "sell_qty_btc",
  "sell_btc",
  "lend_qty",
  "return_qty",
  "lend_pnl",
] as const satisfies readonly (keyof AnnualReportRow & UnsupportedField)[];
