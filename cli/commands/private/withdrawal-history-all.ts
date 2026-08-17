// withdrawal-history.ts を自動ページングで全件取得するラッパー（単一 asset、後方
// end 走査）。CLI の --all/--all-assets/--year 振り分けは withdrawal-history-dispatch.ts、
// 全 asset 横断は withdrawal-history-all-assets.ts が担う。--year は JST 年分
//（ADR-004 の税務例外）。deposit-history-all.ts のミラー（差分: tsKey は requested_at、
// asset は必須）
import { jstYear } from "../../date-utils.js";
import { EXIT } from "../../exit-codes.js";
import type { PrivateHttpOptions } from "../../http-private.js";
import type { Result } from "../../types.js";
import { AssetSchema } from "../../validators.js";
import { formatZodError, parseMaxPages, resolveYearWindow } from "./input-schemas.js";
import { type Withdrawal, withdrawalHistory } from "./withdrawal-history.js";

const PAGE_SIZE = 1000;
export const MAX_PAGES_DEFAULT = 1000;

type WithdrawalHistoryAllArgs = {
  asset: string | undefined;
  since?: string;
  end?: string;
  year?: string;
  maxPages?: string;
};

export async function withdrawalHistoryAll(
  args: WithdrawalHistoryAllArgs,
  opts?: PrivateHttpOptions,
): Promise<Result<Withdrawal[]>> {
  // withdrawal_history は asset 必須（deposit との差分）。ページングに入る前に検証する
  const av = AssetSchema.safeParse(args.asset);
  if (!av.success) return { success: false, error: formatZodError(av.error), exitCode: EXIT.PARAM };

  const mp = parseMaxPages(args.maxPages, MAX_PAGES_DEFAULT);
  if (!mp.success) return mp;
  const maxPages = mp.data;

  // --year（JST 年分）: 範囲クエリ + 取得後の厳密フィルタ。bitbank の end 境界の
  // 含む/排他に依存せず、jstYear で年分を確定させる（ADR-004 の税務例外）。
  const win = resolveYearWindow(args);
  if (!win.success) return win;
  const { since, filterYear } = win.data;
  let end = win.data.end;

  const all: Withdrawal[] = [];
  const seen = new Set<string>();
  let truncated = true;
  for (let page = 0; page < maxPages; page++) {
    const result = await withdrawalHistory(
      { asset: av.data, count: String(PAGE_SIZE), since, end },
      opts,
    );
    if (!result.success) return result;
    let added = 0;
    for (const r of result.data) {
      if (!seen.has(r.uuid)) {
        seen.add(r.uuid);
        all.push(r);
        added++;
      }
    }
    if (result.data.length < PAGE_SIZE || added === 0) {
      truncated = false;
      break;
    }
    // 後方 end 走査: このページ最古の requested_at より前へ。dedup が境界重複を吸収する。
    end = String(Math.min(...result.data.map((r) => r.requested_at)));
  }

  all.sort((a, b) => a.requested_at - b.requested_at); // 時系列（税務台帳向け）
  const data =
    filterYear === undefined ? all : all.filter((r) => jstYear(r.requested_at) === filterYear);

  if (truncated) {
    return {
      success: true,
      data,
      partial: true,
      meta: { truncated: true, reason: "MAX_PAGES", returnedRows: data.length },
    };
  }
  return { success: true, data };
}
