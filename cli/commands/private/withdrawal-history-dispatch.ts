// withdrawal-history の --all / --all-assets / --year を各フェッチャへ振り分ける。
// 依存方向: dispatch → all-assets → all → leaf（循環なし）
import { EXIT } from "../../exit-codes.js";
import type { PrivateHttpOptions } from "../../http-private.js";
import type { Result } from "../../types.js";
import { AssetSchema } from "../../validators.js";
import { formatZodError } from "./input-schemas.js";
import {
  type Withdrawal,
  type WithdrawalHistoryArgs,
  withdrawalHistory,
} from "./withdrawal-history.js";
import { withdrawalHistoryAll } from "./withdrawal-history-all.js";
import { withdrawalHistoryAllAssets } from "./withdrawal-history-all-assets.js";

// asset は leaf(WithdrawalHistoryArgs) 上は必須型だが、dispatch は --all-assets で
// asset 省略を正規の入力として受けるため、ここでは string | undefined に緩める。
type WithdrawalHistoryDispatchArgs = Omit<WithdrawalHistoryArgs, "asset"> & {
  asset?: string;
  all?: boolean;
  allAssets?: boolean;
  year?: string;
  maxPages?: string;
};

/** --all-assets は全 asset 横断、--year は年分の全件取得（--all を含意）、--all は単一 asset 全件。 */
export async function withdrawalHistoryDispatch(
  args: WithdrawalHistoryDispatchArgs,
  opts?: PrivateHttpOptions,
): Promise<Result<Withdrawal[]>> {
  if (args.allAssets) {
    // 空文字も「指定あり」として拒否する（truthy 判定だと --asset="" が未指定扱いに
    // なり全走査が始まる。trade-history-dispatch の --pair 判定と同じ !== undefined）。
    if (args.asset !== undefined) {
      return {
        success: false,
        error: "--all-assets cannot be combined with --asset (it spans every asset)",
        exitCode: EXIT.PARAM,
      };
    }
    return withdrawalHistoryAllAssets(
      { since: args.since, end: args.end, year: args.year, maxPages: args.maxPages },
      opts,
    );
  }
  if (args.year !== undefined) {
    // 単一 asset の年分取得。明示リストで all-assets の year 処理を再利用（pairs マスタは叩かない）
    const av = AssetSchema.safeParse(args.asset);
    if (!av.success)
      return { success: false, error: formatZodError(av.error), exitCode: EXIT.PARAM };
    return withdrawalHistoryAllAssets(
      {
        assets: [av.data],
        year: args.year,
        since: args.since,
        end: args.end,
        maxPages: args.maxPages,
      },
      opts,
    );
  }
  if (args.all) {
    return withdrawalHistoryAll(
      { asset: args.asset, since: args.since, end: args.end, maxPages: args.maxPages },
      opts,
    );
  }
  // asset が未指定でもここへは来得る（--all-assets も --year もない素通し呼び出し）。
  // 必須チェックは withdrawalHistory の RequestSchema.safeParse が実行時に担保する。
  return withdrawalHistory(args as WithdrawalHistoryArgs, opts);
}
