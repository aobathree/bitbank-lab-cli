// 100行超: collect.ts と同じ理由（同一バッチのスナップショット性を保つため分割しない）。
// 残高突合は履歴と /user/assets が同時点であることを前提にする。
//
// 第2バッチ採取: 残高再構築実験用。参照系 GET のみ・逐次 400ms・指数バックオフ。
// 追加: /user/assets, /v1/spot/pairs(公開), deposit_history?asset=jpy 明示クエリ。
import { join } from "node:path";
import { rawGet, stamp } from "./raw-get.js";
import { rawRoot } from "./fixtures-root.js";
import { openRawDir, saveJson } from "./save-raw.js";

const batchStamp = stamp();
const OUT = openRawDir(join(rawRoot(), `batch2-${batchStamp}`));

type Envelope = { success: number; data?: Record<string, unknown> & { code?: number } };

function save(name: string, body: unknown): void {
  saveJson(OUT, `${name}_${stamp()}`, body);
}

// ---- assets（残高突合の基準。個人識別子は含まれない） ----
const assetsRes = await rawGet("/user/assets");
const assetsEnv = assetsRes.body as Envelope;
if (assetsEnv.success !== 1) throw new Error(`assets error code=${assetsEnv.data?.code}`);
save("user_assets", assetsRes.body);
const assetCodes = (assetsEnv.data?.assets as Array<{ asset: string }>).map((a) => a.asset);
console.log(`assets: ${assetCodes.length} codes`);

// ---- trade_history 全ページ（asc 前方走査・pair 省略） ----
{
  const seen = new Set<number>();
  let since: string | undefined;
  for (let page = 1; page <= 50; page++) {
    const params: Record<string, string> = { count: "1000", order: "asc" };
    if (since) params.since = since;
    const { body } = await rawGet("/user/spot/trade_history", params);
    const env = body as Envelope;
    if (env.success !== 1) throw new Error(`trade_history error code=${env.data?.code}`);
    const trades = (env.data?.trades ?? []) as Array<Record<string, unknown>>;
    save(`user_spot_trade_history_page${page}`, body);
    let added = 0;
    for (const t of trades) {
      const id = t.trade_id as number;
      if (!seen.has(id)) {
        seen.add(id);
        added++;
      }
    }
    console.log(`trade_history page${page}: rows=${trades.length} added=${added}`);
    if (trades.length < 1000 || added === 0) break;
    // 黙って打ち切ると「全件採取した」と誤認する。税務用途では取りこぼしが致命的
    if (page === 50) console.log("trade_history: page cap reached（fixture が不完全な可能性）");
    since = String(trades[trades.length - 1].executed_at);
  }
  console.log(`trade_history unique=${seen.size}`);
}

// ---- deposit_history（asset 省略・後方 end 走査） + asset=jpy 明示 ----
{
  let end: string | undefined;
  const seen = new Set<string>();
  for (let page = 1; page <= 50; page++) {
    const params: Record<string, string> = { count: "1000" };
    if (end) params.end = end;
    const { body } = await rawGet("/user/deposit_history", params);
    const env = body as Envelope;
    if (env.success !== 1) throw new Error(`deposit_history error code=${env.data?.code}`);
    const rows = (env.data?.deposits ?? []) as Array<Record<string, unknown>>;
    save(`user_deposit_history_page${page}`, body);
    let added = 0;
    for (const d of rows) if (!seen.has(String(d.uuid))) { seen.add(String(d.uuid)); added++; }
    console.log(`deposit_history page${page}: rows=${rows.length} added=${added}`);
    if (rows.length < 1000 || added === 0) break;
    if (page === 50) console.log("deposit_history: page cap reached（fixture が不完全な可能性）");
    end = String(Math.min(...rows.map((d) => d.found_at as number)));
  }
  const jpy = await rawGet("/user/deposit_history", { asset: "jpy", count: "1000" });
  const jenv = jpy.body as Envelope;
  const jrows = (jenv.data?.deposits ?? []) as unknown[];
  save("user_deposit_history_jpy", jpy.body);
  console.log(`deposit_history?asset=jpy: success=${jenv.success} rows=${jrows.length}`);
}

// ---- withdrawal_history（asset 必須・全資産巡回） ----
{
  const summary: string[] = [];
  for (const asset of assetCodes) {
    const { body } = await rawGet("/user/withdrawal_history", { asset, count: "1000" });
    const env = body as Envelope;
    if (env.success !== 1) {
      console.log(`withdrawal_history ${asset}: error code=${env.data?.code}`);
      continue;
    }
    const rows = (env.data?.withdrawals ?? []) as unknown[];
    if (rows.length > 0) {
      save(`user_withdrawal_history_${asset}`, body);
      summary.push(`${asset}=${rows.length}`);
      if (rows.length === 1000) console.log(`withdrawal_history ${asset}: PAGE FULL`);
    }
  }
  console.log(`withdrawal_history non-empty: ${summary.join(", ")}`);
}

// ---- margin（現在値） ----
for (const path of ["/user/margin/status", "/user/margin/positions"]) {
  const { body } = await rawGet(path);
  save(path.slice(1).replace(/\//g, "_"), body);
}

// ---- 公開: /v1/spot/pairs（認証不要） ----
{
  const res = await fetch("https://api.bitbank.cc/v1/spot/pairs");
  const body = await res.json();
  save("spot_pairs", body);
  const env = body as Envelope;
  const pairs = (env.data?.pairs ?? []) as unknown[];
  console.log(`spot/pairs: success=${env.success} pairs=${pairs.length}`);
}

console.log(`DONE batch dir: ${OUT}`);
