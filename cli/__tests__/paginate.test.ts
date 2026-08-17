// カーソルページャの停止条件。**完了扱いにしてよいのはどこまでか**が本体なので、
// 「短いページ」「同一タイムスタンプで進めない」の 2 系統を分けて固定する。
import { describe, expect, it } from "vitest";
import { paginate } from "../paginate.js";
import type { Result } from "../types.js";

type Row = { id: string; ts: number };

/** ページを順に返すだけのフェッチャ。尽きたら最後のページを繰り返す（実 API と同じで、
 *  カーソルが進まなければ同じ内容が返り続ける状況を再現する）。 */
function pager(pages: Row[][]) {
  let calls = 0;
  return {
    calls: () => calls,
    fetchPage: async (): Promise<Result<Row[]>> => {
      const page = pages[Math.min(calls, pages.length - 1)];
      calls++;
      return { success: true, data: page };
    },
  };
}

function spec(pages: Row[][], pageSize?: number) {
  const p = pager(pages);
  return {
    p,
    run: () =>
      paginate<Row>({
        fetchPage: p.fetchPage,
        keyOf: (r) => r.id,
        nextCursor: (rows) => String(rows[rows.length - 1].ts),
        maxPages: 10,
        ...(pageSize === undefined ? {} : { pageSize }),
      }),
  };
}

const rows = (n: number, ts: number, prefix = "r"): Row[] =>
  Array.from({ length: n }, (_, i) => ({ id: `${prefix}-${i}`, ts }));

describe("paginate の完了判定", () => {
  it("短いページでも完了扱いにせず、新規行ゼロで初めて止まる", async () => {
    // サーバが count=1000 を 3 件にクランプしても、次ページで新規が来る限り続ける
    const { p, run } = spec([rows(3, 1, "a"), rows(3, 2, "b"), rows(1, 3, "c")], 1000);
    const r = await run();
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.rows).toHaveLength(7);
    expect(r.data.truncated).toBe(false);
    // 4 回目で新規ゼロになって停止する（判定のための余分な 1 リクエスト）
    expect(p.calls()).toBe(4);
  });

  it("単一ページで全件のときも完了（誤って打ち切り扱いにしない）", async () => {
    const { run } = spec([rows(2, 1)], 1000);
    const r = await run();
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toMatchObject({ truncated: false, deduped: 2 });
  });

  it("同一タイムスタンプの行が全件でも、満杯でなければ完了扱い", async () => {
    // 1 ms に 2 件（部分約定など）。上限に達していないので続きは無いと言い切れる
    const { run } = spec([rows(2, 1)], 1000);
    const r = await run();
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.truncated).toBe(false);
  });

  it("同一タイムスタンプが 1 ページ上限を超えたら truncated（黙って完了にしない）", async () => {
    // 要求 count と同数の行がすべて同一 ts → カーソルが進まず同じページが返り続ける
    const { run } = spec([rows(5, 1)], 5);
    const r = await run();
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.rows).toHaveLength(5);
    expect(r.data.truncated).toBe(true);
  });

  it("クランプ後の上限は実測して満杯判定に使う", async () => {
    // 要求 1000 に対しサーバは 4 件で返す（= 実測上限 4）。その後 4 件すべて同一 ts の
    // ページで止まったら、上限に張り付いているので truncated
    const { run } = spec([rows(4, 1, "a"), rows(4, 2, "b")], 1000);
    const r = await run();
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.rows).toHaveLength(8);
    expect(r.data.truncated).toBe(true);
  });

  it("空ページは完了（初回から 0 件でも打ち切りにしない）", async () => {
    const { run } = spec([[]], 1000);
    const r = await run();
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toMatchObject({ rows: [], truncated: false });
  });

  it("maxPages に達したら truncated", async () => {
    const pages = Array.from({ length: 12 }, (_, i) => rows(2, i + 1, `p${i}`));
    const { run } = spec(pages, 1000);
    const r = await run();
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.truncated).toBe(true);
  });
});
