// 100行超: 取得〜組み立ての通し検証。「復元が効いていること」「打ち切りを黙って通さない
// こと」「candle 欠落でスケールが崩れないこと」を 1 本の実行経路で押さえるため、
// セットアップ（保有・価格・足）を共有したケース群になる。
import { describe, expect, it } from "vitest";
import { MAX_POINTS } from "../../portfolio/grid.js";
import { runBalanceHistory } from "../../portfolio/run.js";
import { BalanceHistorySchema } from "../../portfolio/schema.js";
import { TRUNCATED_WARNING } from "../../portfolio/warnings.js";
import { TEST_CREDS } from "../test-helpers.js";
import { mockMarket, rawDeposit, rawTrade, rawWithdrawal } from "./mock-market.js";

const DAY = 86_400_000;
const D1 = Date.UTC(2026, 7, 1);
const D2 = Date.UTC(2026, 7, 2);
const D3 = Date.UTC(2026, 7, 3);
const NOW = D3 + 12 * 3_600_000;

const OPTS = { retries: 0, credentials: TEST_CREDS, nonce: "1" } as const;
const ARGS = {
  sinceMs: D1,
  nowMs: NOW,
  granularity: "day" as const,
  maxPages: 10,
  noCache: true,
};

const BTC_CANDLES: [number, string][] = [
  [D1, "10000000"],
  [D2, "11000000"],
  [D3, "12000000"],
];

describe("runBalanceHistory", () => {
  it("約定を巻き戻して各時点の保有を復元する", async () => {
    // D2 に 1 BTC を手数料 0.001 BTC 付きで購入 → D1 時点の保有は 2 - (1 - 0.001) = 1.001
    const { fetch } = mockMarket({
      assets: { btc: "2", jpy: "1000000" },
      prices: { btc: "13000000" },
      candles: { btc: BTC_CANDLES },
      trades: {
        btc_jpy: [
          rawTrade({
            trade_id: 7,
            side: "buy",
            amount: "1",
            price: "11000000",
            fee_amount_base: "0.001",
            fee_amount_quote: "0",
            executed_at: D2 + 3_600_000,
          }),
        ],
      },
    });
    const r = await runBalanceHistory(ARGS, { fetch, ...OPTS });
    expect(r.success).toBe(true);
    if (!r.success) return;

    const [p1, p2, p3] = r.data.points;
    // D1: 1.001 BTC × 10,000,000 + (1,000,000 + 11,000,000) JPY
    expect(p1.value_jpy).toBe(Math.round(1.001 * 10_000_000) + 12_000_000);
    expect(p2.value_jpy).toBe(Math.round(1.001 * 11_000_000) + 12_000_000);
    // D3 は約定後なので 2 BTC・JPY 100 万
    expect(p3.value_jpy).toBe(2 * 12_000_000 + 1_000_000);
    expect(r.data.current.value_jpy).toBe(2 * 13_000_000 + 1_000_000);
    expect(r.data.completeness.complete).toBe(true);
    expect(r.data.price_quality.level).toBe("complete");
  });

  it("入出金を元本として分離し、調整後増減から除く", async () => {
    const { fetch } = mockMarket({
      assets: { jpy: "1500000" },
      prices: { btc: "13000000" },
      candles: { btc: BTC_CANDLES },
      deposits: {
        crypto: undefined,
        jpy: [
          rawDeposit({
            uuid: "dep-1",
            asset: "jpy",
            amount: "500000",
            found_at: D2,
            confirmed_at: D2,
          }),
        ],
      },
      withdrawals: {
        jpy: [
          rawWithdrawal({
            uuid: "wd-1",
            asset: "jpy",
            amount: "100000",
            fee: "550",
            requested_at: D2,
          }),
        ],
      },
    });
    const r = await runBalanceHistory(ARGS, { fetch, ...OPTS });
    expect(r.success).toBe(true);
    if (!r.success) return;

    // D1 の JPY = 1,500,000 - 500,000 + (100,000 + 550) = 1,100,550
    expect(r.data.points[0].value_jpy).toBe(1_100_550);
    expect(r.data.flow).toEqual({ net_flow_jpy: 400_000, withdrawal_fee_jpy: 550 });
    expect(r.data.change.change_jpy).toBe(1_500_000 - 1_100_550);
    // 調整後 = 単純増減 − 純入出金 → 出金手数料ぶんのマイナスだけが残る
    expect(r.data.change.adjusted_change_jpy).toBe(-550);
  });

  it("candle が取れない資産は現在価格へ落ち、最終点とスケールが揃う", async () => {
    const { fetch } = mockMarket({
      assets: { btc: "2" },
      prices: { btc: "13000000" },
      candles: {}, // 全 candle 取得失敗
    });
    const r = await runBalanceHistory(ARGS, { fetch, ...OPTS });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.price_quality).toEqual({ level: "fallback_only", fallback_assets: ["btc"] });
    expect(new Set(r.data.points.map((p) => p.value_jpy))).toEqual(new Set([26_000_000]));
    expect(r.data.current.value_jpy).toBe(26_000_000);
  });

  it("入出金履歴がページ上限に達したら partial + warning で申告する", async () => {
    const { fetch } = mockMarket({
      assets: { jpy: "1000000" },
      prices: { btc: "13000000" },
      candles: { btc: BTC_CANDLES },
      depositsNeverEnd: NOW,
    });
    const r = await runBalanceHistory({ ...ARGS, maxPages: 2 }, { fetch, ...OPTS });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.partial).toBe(true);
    expect(r.meta?.truncated).toBe(true);
    expect(r.data.completeness).toMatchObject({ complete: false, deposits_truncated: true });
    expect(r.data.warnings).toContain(TRUNCATED_WARNING);
  });

  it("出金申請中（withdrawing）の数量を現在残高に足し戻す", async () => {
    // onhand からは既に引かれているが status はまだ DONE ではないので巻き戻しでも
    // 戻らない。足し戻さないと申請中の 100,000 円が過去の全時点から消える
    const { fetch } = mockMarket({
      assets: { jpy: ["900000", "100000"] },
      prices: {},
      candles: {},
      withdrawals: {
        jpy: [
          rawWithdrawal({
            uuid: "wd-pending",
            asset: "jpy",
            amount: "100000",
            fee: "550",
            status: "PENDING",
            requested_at: D2,
          }),
        ],
      },
    });
    const r = await runBalanceHistory(ARGS, { fetch, ...OPTS });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.current.value_jpy).toBe(1_000_000);
    expect(r.data.points.every((p) => p.value_jpy === 1_000_000)).toBe(true);
    // 未確定の出金は純入出金にも計上しない
    expect(r.data.flow).toEqual({ net_flow_jpy: 0, withdrawal_fee_jpy: 0 });
  });

  it("前提の注記を必ず出力に含め、出力契約（Zod）に適合する", async () => {
    const { fetch } = mockMarket({ assets: { jpy: "1000" }, prices: {}, candles: {} });
    const r = await runBalanceHistory(ARGS, { fetch, ...OPTS });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.note).toContain("逆算");
    expect(r.data.assumptions.length).toBeGreaterThan(0);
    expect(r.data.price_quality.level).toBe("jpy_only");
    expect(BalanceHistorySchema.safeParse(r.data).success).toBe(true);
  });

  it("価格が一切引けない保有は 0 円で黙って積まず、warning に出す", async () => {
    // ticker にも candle にも無い銘柄（delist 直後・シンボル rename 等）
    const { fetch } = mockMarket({ assets: { btc: "1" }, prices: {}, candles: {} });
    const r = await runBalanceHistory(ARGS, { fetch, ...OPTS });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.warnings.some((w) => w.includes("btc"))).toBe(true);
  });

  it("グリッド間引きも 4 経路（partial / meta / completeness / warnings）で申告する", async () => {
    const { fetch } = mockMarket({ assets: { jpy: "1000" }, prices: {}, candles: {} });
    const r = await runBalanceHistory(
      { ...ARGS, sinceMs: NOW - (MAX_POINTS + 50) * DAY },
      { fetch, ...OPTS },
    );
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.points).toHaveLength(MAX_POINTS);
    expect(r.partial).toBe(true);
    // 履歴は完全なのでページ上限とは区別して報告する
    expect(r.meta).toMatchObject({ truncated: true, reason: "MAX_POINTS" });
    expect(r.data.completeness).toMatchObject({ complete: false, grid_truncated: true });
    expect(r.data.warnings.some((w) => w.includes("評価時点"))).toBe(true);
  });

  it("暗号資産の入庫（asset 省略の系統）も巻き戻す", async () => {
    // 入庫は crypto / jpy の 2 系統に分かれる。crypto 側だけの入金が落ちないことを見る
    const { fetch } = mockMarket({
      assets: { btc: "2" },
      prices: { btc: "13000000" },
      candles: { btc: BTC_CANDLES },
      deposits: {
        jpy: undefined,
        crypto: [
          rawDeposit({
            uuid: "dep-btc",
            asset: "btc",
            amount: "0.5",
            found_at: D2,
            confirmed_at: D2,
          }),
        ],
      },
    });
    const r = await runBalanceHistory(ARGS, { fetch, ...OPTS });
    expect(r.success).toBe(true);
    if (!r.success) return;
    // D1 時点は入庫前なので 1.5 BTC
    expect(r.data.points[0].value_jpy).toBe(1.5 * 10_000_000);
    expect(r.data.points[2].value_jpy).toBe(2 * 12_000_000);
    // 暗号資産の入庫は現在価格で仮評価される
    expect(r.data.flow.net_flow_jpy).toBe(0.5 * 13_000_000);
  });

  it("信用約定は復元から除外し、warning で申告する", async () => {
    // 信用約定は現物残高を建玉数量ぶん動かさない。現物と同じ式で巻き戻すと base も
    // JPY も狂うので、除外したうえで「値がずれ得る」ことを出力に残す
    const { fetch } = mockMarket({
      assets: { btc: "2", jpy: "1000000" },
      prices: { btc: "13000000" },
      candles: { btc: BTC_CANDLES },
      trades: {
        btc_jpy: [
          rawTrade({
            trade_id: 9,
            side: "buy",
            amount: "1",
            price: "11000000",
            position_side: "long",
            executed_at: D2 + 3_600_000,
          }),
        ],
      },
    });
    const r = await runBalanceHistory(ARGS, { fetch, ...OPTS });
    expect(r.success).toBe(true);
    if (!r.success) return;
    // 巻き戻していないので、どの点も現在の 2 BTC + 100 万円のまま
    expect(r.data.points[0].value_jpy).toBe(2 * 10_000_000 + 1_000_000);
    expect(r.data.warnings.some((w) => w.includes("信用約定"))).toBe(true);
  });

  it("非 JPY クォート約定も取得し、数量ベースで巻き戻す（死にガードの修正）", async () => {
    // 修正前は jpyPairs だけ fetch していたため xrp_btc が history に入らず、
    // run.ts の endsWith("_jpy") フィルタも warning も永遠に発火しなかった。
    // 修正後は全ペア取得 + quote=btc で巻き戻し、D1 の評価に反映される。
    const { fetch, urls } = mockMarket({
      assets: { xrp: "1000", btc: "0.5", jpy: "0" },
      prices: { btc: "13000000", xrp: "100" },
      candles: {
        btc: BTC_CANDLES,
        xrp: [
          [D1, "80"],
          [D2, "90"],
          [D3, "100"],
        ],
      },
      trades: {
        xrp_btc: [
          rawTrade({
            trade_id: 11,
            pair: "xrp_btc",
            side: "buy",
            amount: "1000",
            price: "0.00002",
            fee_amount_base: "0",
            fee_amount_quote: "0.000001",
            executed_at: D2 + 3_600_000,
          }),
        ],
      },
    });
    const r = await runBalanceHistory(ARGS, { fetch, ...OPTS });
    expect(r.success).toBe(true);
    if (!r.success) return;

    expect(urls.some((u) => u.includes("trade_history") && u.includes("pair=xrp_btc"))).toBe(true);
    // D1: xrp なし、btc = 0.5 + 0.02 + 0.000001 = 0.520001 → × 10,000,000
    expect(r.data.points[0].value_jpy).toBe(Math.round(0.520001 * 10_000_000));
    // D3: 現在保有 xrp 1000 × 100 + btc 0.5 × 12,000,000
    expect(r.data.points[2].value_jpy).toBe(1000 * 100 + Math.round(0.5 * 12_000_000));
    expect(r.data.warnings.some((w) => w.includes("非 JPY"))).toBe(false);
    expect(r.data.assumptions.some((a) => a.includes("非 JPY"))).toBe(true);
  });

  it("月次グリッドでは UTC 月初だけを評価する", async () => {
    const { fetch } = mockMarket({
      assets: { jpy: "1000" },
      prices: {},
      candles: {},
    });
    const r = await runBalanceHistory(
      { ...ARGS, sinceMs: D1 - 40 * DAY, granularity: "month" },
      { fetch, ...OPTS },
    );
    expect(r.success).toBe(true);
    if (r.success)
      expect(r.data.points.map((p) => p.date)).toEqual(["2026-06-01", "2026-07-01", "2026-08-01"]);
  });
});
