// 100行超: カーソルページャ本体は 40 行弱で、残りは 2 つの停止条件（「短いページを
// 最終ページと見なさない」「同一タイムスタンプで進めなくなったら完了扱いにしない」）が
// なぜそう書かれているかの説明。どちらも消すと履歴が黙って欠けるので、根拠を同居させる。
//
// カーソルページャ。private の履歴系エンドポイントで違うのは「1 ページの取得」
// 「重複排除キー」「次カーソルの作り方」の 3 点だけなので、それだけを注入する。
//
// ページ境界はタイムスタンプカーソルのため**同一ミリ秒で重複が返る**（要求仕様 §2.1、
// 実測で確認済み）。重複排除は取りこぼしではなく仕様なので、除去件数を必ず返す。
//
// 元は cli/tax/import/paginate.ts にあった（税務インポータ専用）。停止条件は
// 「履歴が 1 件欠けたら集計が静かに狂う」用途すべてに必要なので、tax（ADR-004 の例外
// カテゴリ）配下から cli/ 直下へ移した。balance-history（portfolio 再構築）も同じ
// 停止条件に依存する。
import type { Result } from "./types.js";

export type PageSpec<T> = {
  /** cursor は since（前方走査）か end（後方走査）。エンドポイント側が解釈する */
  fetchPage: (cursor: string | undefined) => Promise<Result<T[]>>;
  /** 重複排除キー（trade_id / uuid）。冪等性 NFR の単位でもある */
  keyOf: (row: T) => string;
  /** このページから次カーソルを作る。undefined で打ち切り */
  nextCursor: (rows: T[]) => string | undefined;
  maxPages: number;
  initialCursor?: string;
  /** 1 ページで要求した件数（`count`）。**満杯ページの検出にだけ使う**（下記 (2)）。
   *  完了判定には使わない — サーバがクランプすると初回ページで成立してしまうため。 */
  pageSize?: number;
};

export type Paged<T> = { rows: T[]; deduped: number; truncated: boolean };

/** 満杯ページ = これ以上返せなかったページ。要求 count か、実測した上限のどちらかに
 *  達していれば満杯とみなす。`capEvidence` は「後続ページで新規行が来た = そのページは
 *  最終ページではなかった」ことから逆算した実測上限で、サーバが count をクランプする
 *  ケースを拾う。どちらの根拠も無ければ満杯ではない（= 誤検知しない側）。 */
function isFullPage(len: number, pageSize: number | undefined, capEvidence: number): boolean {
  if (pageSize !== undefined && len >= pageSize) return true;
  return capEvidence > 0 && len >= capEvidence;
}

export async function paginate<T>(spec: PageSpec<T>): Promise<Result<Paged<T>>> {
  const rows: T[] = [];
  const seen = new Set<string>();
  let deduped = 0;
  let cursor = spec.initialCursor;
  // 直前ページの長さと、そこから確定した「サーバが 1 ページで返せる上限」の実測値
  let prevLen: number | undefined;
  let capEvidence = 0;

  for (let page = 0; page < spec.maxPages; page++) {
    const r = await spec.fetchPage(cursor);
    if (!r.success) return r;

    let added = 0;
    for (const row of r.data) {
      const key = spec.keyOf(row);
      if (seen.has(key)) {
        deduped++;
        continue;
      }
      seen.add(key);
      rows.push(row);
      added++;
    }
    // このページで新規行が来た = 直前ページは最終ページではなかった。つまり直前ページの
    // 長さはサーバが 1 回で返せる上限そのもの（クランプ後の実測値）。
    if (added > 0 && prevLen !== undefined) capEvidence = Math.max(capEvidence, prevLen);

    // (1) 完了判定は「新規行がゼロ」だけにする。**「要求 count より短いページ = 最終
    //     ページ」とは判定しない** — サーバが count をエンドポイント固有の上限に
    //     クランプすると、その仮定は初回ページで成立してしまい、残りを取らないまま
    //     truncated:false を返す（= 黙って欠損する）。カーソルは境界行を必ず含むので、
    //     続きが無いときだけ added が 0 になる。代償は判定のための余分な 1 リクエスト。
    // (2) ただし**同一タイムスタンプの行が 1 ページ上限を超える**と、カーソルが進まず
    //     同じ満杯ページが返り続けて added が 0 になる。これは「取り切った」ではなく
    //     「これ以上進めない」なので、完了扱いにせず truncated で返す。
    //     満杯でないページなら上限に達していない = 続きは無いと言い切れる（誤検知なし）。
    if (added === 0) {
      const stuck = rows.length > 0 && isFullPage(r.data.length, spec.pageSize, capEvidence);
      return { success: true, data: { rows, deduped, truncated: stuck } };
    }
    const next = spec.nextCursor(r.data);
    if (next === undefined) return { success: true, data: { rows, deduped, truncated: false } };
    cursor = next;
    prevLen = r.data.length;
  }

  // 打ち切り。呼び出し側が partial として上げる（欠損したまま黙って集計しない）
  return { success: true, data: { rows, deduped, truncated: true } };
}
