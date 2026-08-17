// trade-history の全ペア横断取得（税務用途: 過去履歴の網羅）。pairs マスタは
// delist 済みを含む全ペア定義（実機確認 #4: matic_jpy 等の delist 済みペアにも
// 履歴が残存し得るため is_enabled では絞らない）。逐次実行なので全リクエストが
// http-core の throttle（waitForSlot）と 429 リトライに乗る。
import { jstYear } from "../../date-utils.js";
import type { PrivateHttpOptions } from "../../http-private.js";
import type { Result } from "../../types.js";
import { pairs } from "../public/pairs.js";
import { parseMaxPages, resolveYearWindow } from "./input-schemas.js";
import type { Trade } from "./trade-history.js";
import { MAX_PAGES_DEFAULT, tradeHistoryAll } from "./trade-history-all.js";

export type TradeHistoryAllPairsArgs = {
  /** 明示ペアリスト（単一 pair の --year 経路）。省略時は pairs マスタの全 name */
  pairs?: string[];
  since?: string;
  end?: string;
  year?: string;
  /** pair ごとのページ上限（tradeHistoryAll に伝播） */
  maxPages?: string;
};

export async function tradeHistoryAllPairs(
  args: TradeHistoryAllPairsArgs,
  opts?: PrivateHttpOptions,
): Promise<Result<Trade[]>> {
  // ループに入る前に fail-fast（pair ごとの再検証は tradeHistoryAll 側でも走る）
  const mp = parseMaxPages(args.maxPages, MAX_PAGES_DEFAULT);
  if (!mp.success) return mp;

  // --year（JST 年分）: 範囲クエリ + 取得後の厳密フィルタ（deposit/withdrawal-history-all と同仕様）
  const win = resolveYearWindow(args);
  if (!win.success) return win;
  const { since, end, filterYear } = win.data;

  let names = args.pairs;
  if (names === undefined) {
    const pr = await pairs(opts);
    if (!pr.success) return pr;
    names = pr.data.map((p) => p.name);
  }

  const all: Trade[] = [];
  const seen = new Set<string>();
  const truncatedPairs: string[] = [];
  for (const name of names) {
    const result = await tradeHistoryAll({ pair: name, since, end, maxPages: args.maxPages }, opts);
    if (!result.success) {
      // どの pair で失敗したかを残す（全ペア走査の途中失敗は原因 pair の特定が要る）
      return { success: false, error: `${name}: ${result.error}`, exitCode: result.exitCode };
    }
    for (const t of result.data) {
      // trade_id の pair 横断一意性は未確認のため複合キーで dedup
      //（同一 pair 内の重複は tradeHistoryAll が除去済み。ここは安全弁）
      const key = `${t.pair}:${t.trade_id}`;
      if (!seen.has(key)) {
        seen.add(key);
        all.push(t);
      }
    }
    if (result.partial) truncatedPairs.push(name);
  }

  all.sort((a, b) => a.executed_at - b.executed_at); // 時系列（税務台帳向け）
  const data =
    filterYear === undefined ? all : all.filter((t) => jstYear(t.executed_at) === filterYear);

  if (truncatedPairs.length > 0) {
    return {
      success: true,
      data,
      partial: true,
      meta: { truncated: true, reason: "MAX_PAGES", returnedRows: data.length, truncatedPairs },
    };
  }
  return { success: true, data };
}
