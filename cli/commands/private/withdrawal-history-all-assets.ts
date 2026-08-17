// withdrawal-history の全 asset 横断取得（税務用途: 過去履歴の網羅）。asset 一覧は
// pairs マスタ（delist 込み）の base_asset ∪ quote_asset を使う。trade-history の
// --all-pairs と同じ判断（実機確認 #4: delist 済みペアにも履歴が残存し得るため
// is_enabled では絞らない。jpy は quote_asset 側から拾える）。逐次実行なので全
// リクエストが http-core の throttle（waitForSlot）と 429 リトライに乗る。
import { jstYear } from "../../date-utils.js";
import type { PrivateHttpOptions } from "../../http-private.js";
import type { Result } from "../../types.js";
import { pairs } from "../public/pairs.js";
import { parseMaxPages, resolveYearWindow } from "./input-schemas.js";
import type { Withdrawal } from "./withdrawal-history.js";
import { MAX_PAGES_DEFAULT, withdrawalHistoryAll } from "./withdrawal-history-all.js";

export type WithdrawalHistoryAllAssetsArgs = {
  /** 明示 asset リスト（単一 asset の --year 経路）。省略時は pairs マスタの base/quote 集合 */
  assets?: string[];
  since?: string;
  end?: string;
  year?: string;
  /** asset ごとのページ上限（withdrawalHistoryAll に伝播） */
  maxPages?: string;
};

export async function withdrawalHistoryAllAssets(
  args: WithdrawalHistoryAllAssetsArgs,
  opts?: PrivateHttpOptions,
): Promise<Result<Withdrawal[]>> {
  // ループに入る前に fail-fast（asset ごとの再検証は withdrawalHistoryAll 側でも走る）
  const mp = parseMaxPages(args.maxPages, MAX_PAGES_DEFAULT);
  if (!mp.success) return mp;

  // --year（JST 年分）: 範囲クエリ + 取得後の厳密フィルタ（deposit/withdrawal-history-all と同仕様）
  const win = resolveYearWindow(args);
  if (!win.success) return win;
  const { since, end, filterYear } = win.data;

  let names = args.assets;
  if (names === undefined) {
    const pr = await pairs(opts);
    if (!pr.success) return pr;
    const set = new Set<string>();
    for (const p of pr.data) {
      set.add(p.base_asset);
      set.add(p.quote_asset);
    }
    names = [...set];
  }

  const all: Withdrawal[] = [];
  const seen = new Set<string>();
  const truncatedAssets: string[] = [];
  for (const name of names) {
    const result = await withdrawalHistoryAll(
      { asset: name, since, end, maxPages: args.maxPages },
      opts,
    );
    if (!result.success) {
      // どの asset で失敗したかを残す（全 asset 走査の途中失敗は原因 asset の特定が要る）
      return { success: false, error: `${name}: ${result.error}`, exitCode: result.exitCode };
    }
    for (const w of result.data) {
      // asset は元より一覧内でユニークだが、pair:trade_id と同型の複合キーで揃える（安全弁）
      const key = `${w.asset}:${w.uuid}`;
      if (!seen.has(key)) {
        seen.add(key);
        all.push(w);
      }
    }
    if (result.partial) truncatedAssets.push(name);
  }

  all.sort((a, b) => a.requested_at - b.requested_at); // 時系列（税務台帳向け）
  const data =
    filterYear === undefined ? all : all.filter((w) => jstYear(w.requested_at) === filterYear);

  if (truncatedAssets.length > 0) {
    return {
      success: true,
      data,
      partial: true,
      meta: { truncated: true, reason: "MAX_PAGES", returnedRows: data.length, truncatedAssets },
    };
  }
  return { success: true, data };
}
