// 100行超: 1 回の実行で採取した 4 ブロック（trade / deposit / withdrawal / margin）を
// **同一バッチとして 1 ファイルに保つ**ため。残高突合は「同時点のスナップショット」で
// あることが前提なので、ブロックを別ファイルに分けると別々に実行できてしまい、
// as-of 時刻のずれた組み合わせが生まれる。原型として保全する（BALANCE_RECONCILIATION 参照）。
//
// 生レスポンス採取: 参照系 GET のみ。envelope ごと fixtures/raw/ に保存する。
// レスポンスのキー・構造・値は一切変更しない（pretty-print のみ）。
import { rawGet, stamp } from "./raw-get.js";
import { rawRoot } from "./fixtures-root.js";
import { openRawDir, saveJson } from "./save-raw.js";

const OUT = openRawDir(rawRoot());

type Envelope = { success: number; data?: Record<string, unknown> & { code?: number } };

function save(name: string, body: unknown): string {
  return saveJson(OUT, `${name}_${stamp()}`, body);
}

// ---- 1. trade_history: 全ペア横断・全期間（asc 前方走査） ----
{
  const seen = new Set<number>();
  let since: string | undefined;
  let page = 0;
  const pairs = new Map<string, number>();
  const makerTaker = new Map<string, number>();
  let minTs = Infinity;
  let maxTs = -Infinity;
  let marginRows = 0;

  for (;;) {
    page++;
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
      if (seen.has(id)) continue;
      seen.add(id);
      added++;
      const pair = String(t.pair);
      pairs.set(pair, (pairs.get(pair) ?? 0) + 1);
      const mt = String(t.maker_taker);
      makerTaker.set(mt, (makerTaker.get(mt) ?? 0) + 1);
      const ts = t.executed_at as number;
      if (ts < minTs) minTs = ts;
      if (ts > maxTs) maxTs = ts;
      if (t.position_side !== undefined && t.position_side !== null) marginRows++;
    }
    console.log(`trade_history page${page}: rows=${trades.length} added=${added}`);
    if (trades.length < 1000 || added === 0) break;
    since = String(trades[trades.length - 1].executed_at);
    if (page >= 50) {
      console.log("trade_history: page cap reached");
      break;
    }
  }
  console.log(`trade_history TOTAL unique=${seen.size}`);
  console.log(`  pairs: ${[...pairs.entries()].map(([p, n]) => `${p}=${n}`).join(", ")}`);
  console.log(`  maker_taker: ${[...makerTaker.entries()].map(([k, n]) => `${k}=${n}`).join(", ")}`);
  console.log(`  executed_at range: ${minTs} .. ${maxTs}`);
  console.log(`  rows with position_side present: ${marginRows}`);
}

// ---- 2. deposit_history: asset 省略・全期間（desc 後方 end 走査） ----
{
  const seen = new Set<string>();
  let end: string | undefined;
  let page = 0;
  let minTs = Infinity;
  let maxTs = -Infinity;
  const assets = new Map<string, number>();

  for (;;) {
    page++;
    const params: Record<string, string> = { count: "1000" };
    if (end) params.end = end;
    const { body } = await rawGet("/user/deposit_history", params);
    const env = body as Envelope;
    if (env.success !== 1) throw new Error(`deposit_history error code=${env.data?.code}`);
    const deposits = (env.data?.deposits ?? []) as Array<Record<string, unknown>>;
    save(`user_deposit_history_page${page}`, body);

    let added = 0;
    for (const d of deposits) {
      const id = String(d.uuid);
      if (seen.has(id)) continue;
      seen.add(id);
      added++;
      assets.set(String(d.asset), (assets.get(String(d.asset)) ?? 0) + 1);
      const ts = d.found_at as number;
      if (ts < minTs) minTs = ts;
      if (ts > maxTs) maxTs = ts;
    }
    console.log(`deposit_history page${page}: rows=${deposits.length} added=${added}`);
    if (deposits.length < 1000 || added === 0) break;
    end = String(Math.min(...deposits.map((d) => d.found_at as number)));
    if (page >= 50) {
      // 黙って打ち切ると「全件採取した」と誤認する。税務用途では取りこぼしが致命的
      console.log("deposit_history: page cap reached");
      break;
    }
  }
  console.log(`deposit_history TOTAL unique=${seen.size}`);
  console.log(`  assets: ${[...assets.entries()].map(([a, n]) => `${a}=${n}`).join(", ")}`);
  console.log(`  found_at range: ${minTs} .. ${maxTs}`);
}

// ---- 3. withdrawal_history: asset 必須のため保有・取扱 48 資産を逐次巡回 ----
{
  const assetsRes = await rawGet("/user/assets");
  const assetsEnv = assetsRes.body as Envelope;
  // success を見ないと data?.assets が undefined のまま .map して不明瞭な TypeError になる
  if (assetsEnv.success !== 1) {
    throw new Error(`/user/assets failed: code=${assetsEnv.data?.code}`);
  }
  const assetCodes = ((assetsEnv.data?.assets ?? []) as Array<{ asset: string }>).map(
    (a) => a.asset,
  );

  let emptySaved = false;
  const summary: string[] = [];
  for (const asset of assetCodes) {
    const { body } = await rawGet("/user/withdrawal_history", { asset, count: "1000" });
    const env = body as Envelope;
    if (env.success !== 1) {
      console.log(`withdrawal_history ${asset}: error code=${env.data?.code}`);
      continue;
    }
    const rows = (env.data?.withdrawals ?? []) as Array<Record<string, unknown>>;
    if (rows.length > 0) {
      save(`user_withdrawal_history_${asset}`, body);
      summary.push(`${asset}=${rows.length}`);
      if (rows.length === 1000) console.log(`withdrawal_history ${asset}: PAGE FULL (要追加ページング)`);
    } else if (!emptySaved) {
      // 空レスポンスの構造例として 1 件だけ保存
      save(`user_withdrawal_history_${asset}_empty`, body);
      emptySaved = true;
    }
  }
  console.log(`withdrawal_history non-empty: ${summary.join(", ") || "(none)"}`);
}

// ---- 4. margin: status / positions（GET のみ） ----
for (const path of ["/user/margin/status", "/user/margin/positions"]) {
  const { body } = await rawGet(path);
  const env = body as Envelope;
  const name = path.slice(1).replace(/\//g, "_");
  save(name, body);
  console.log(`${path}: success=${env.success} code=${env.data?.code ?? "-"}`);
}

console.log("DONE");
