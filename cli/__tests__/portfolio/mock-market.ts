// 100行超: balance-history が辿る 7 エンドポイント（pairs / assets / 約定 / 入庫 2 系統 /
// 出庫 / tickers / 1day 足）のレスポンス形状を 1 箇所に集約するため。分割すると
// 「どの順で何が返るか」が読めなくなり、モックの取り違えを誘発する。
//
// balance-history の e2e 用モック。**実 API のエンドポイント構成をそのまま辿る**
// （pairs → assets → 約定 → 入庫 2 系統 → 出庫/資産 → tickers → 1day 足）ので、
// 呼び出し順や停止条件の回帰もここで拾える。
//
// 生レコードの形状は共有フィクスチャ（__fixtures__/private/）を土台にし、テストごとに
// 必要な値だけ差し替える（x18 の趣旨: 即席インラインモックで形状を自己完結させない）。
import { depositHistoryFixture } from "../__fixtures__/private/deposit-history.js";
import { tradeHistoryFixture } from "../__fixtures__/private/trade-history.js";
import { withdrawalHistoryFixture } from "../__fixtures__/private/withdrawal-history.js";

const BASE_TRADE = { ...tradeHistoryFixture.trades[0], position_side: undefined };
const BASE_DEPOSIT = depositHistoryFixture.deposits[0];
const BASE_WITHDRAWAL = withdrawalHistoryFixture.withdrawals[0];

export type RawRows = {
  /** pair → 約定行 */
  trades?: Record<string, Record<string, unknown>[]>;
  /** 入庫の系統（`crypto` = asset 省略 / `jpy` = asset=jpy）→ 入庫行。
   *  2 系統は実 API でも排他なので、モックでも系統ごとに分けて置く */
  deposits?: Record<"crypto" | "jpy", Record<string, unknown>[] | undefined>;
  /** asset → 出庫行 */
  withdrawals?: Record<string, Record<string, unknown>[]>;
  /** asset → 現在残高。`[onhand, withdrawing]` で出金申請中を分けて置ける */
  assets?: Record<string, string | [string, string]>;
  /** asset → 現在価格 */
  prices?: Record<string, string>;
  /** asset → (epoch ms → open) */
  candles?: Record<string, [number, string][]>;
  /** 入庫を毎ページ新しい uuid で返し続けてページ上限に当てる。値は先頭ページの
   *  found_at（since 以降にしないと API 側の since ≤ end 検証で落ちる） */
  depositsNeverEnd?: number;
};

export function rawTrade(o: Record<string, unknown>): Record<string, unknown> {
  return { ...BASE_TRADE, ...o };
}
export function rawDeposit(o: Record<string, unknown>): Record<string, unknown> {
  return { ...BASE_DEPOSIT, ...o };
}
export function rawWithdrawal(o: Record<string, unknown>): Record<string, unknown> {
  return { ...BASE_WITHDRAWAL, ...o };
}

function ticker(pair: string, last: string): Record<string, unknown> {
  return {
    pair,
    sell: last,
    buy: last,
    high: last,
    low: last,
    open: last,
    last,
    vol: "1",
    timestamp: 1,
  };
}

function ohlcv(rows: [number, string][]): unknown {
  return {
    candlestick: [
      { type: "1day", ohlcv: rows.map(([ts, open]) => [open, open, open, open, "1", ts]) },
    ],
  };
}

function pairRow(
  name: string,
  base: string,
  quote: string,
  enabled = true,
): Record<string, unknown> {
  return {
    name,
    base_asset: base,
    quote_asset: quote,
    maker_fee_rate_base: "0",
    taker_fee_rate_base: "0",
    maker_fee_rate_quote: "0",
    taker_fee_rate_quote: "0.0012",
    unit_amount: "0.0001",
    limit_max_amount: "1000",
    market_max_amount: "100",
    price_digits: 0,
    amount_digits: 4,
    is_enabled: enabled,
    stop_order: false,
    stop_order_and_cancel: false,
  };
}

// delist 済み BTC 建て（xrp_btc）を含める。取得スコープが JPY だけだと死にガードになる。
const PAIRS = [
  pairRow("btc_jpy", "btc", "jpy"),
  pairRow("xrp_jpy", "xrp", "jpy"),
  pairRow("xrp_btc", "xrp", "btc", false),
];

/** URL で分岐する mockFetch。1 経路につき最初の 1 回だけ行を返し、以降は空
 *  （paginate の停止条件「新規行ゼロ」に素直に当てる）。 */
export function mockMarket(rows: RawRows): { fetch: typeof globalThis.fetch; urls: string[] } {
  const urls: string[] = [];
  const served = new Set<string>();
  let depositPage = 0;

  const fetch: typeof globalThis.fetch = async (input) => {
    const url = typeof input === "string" ? input : input.toString();
    urls.push(url);
    const json = (data: unknown) => new Response(JSON.stringify({ success: 1, data }));
    const once = (key: string, value: unknown[]) => {
      if (served.has(key)) return [];
      served.add(key);
      return value;
    };

    if (url.includes("/v1/spot/pairs")) return json({ pairs: PAIRS });
    if (url.includes("/v1/user/assets")) {
      return json({
        assets: Object.entries(rows.assets ?? {}).map(([asset, amounts]) => {
          const [onhand, withdrawing] = typeof amounts === "string" ? [amounts, "0"] : amounts;
          return {
            asset,
            free_amount: onhand,
            locked_amount: "0",
            onhand_amount: onhand,
            withdrawing_amount: withdrawing,
          };
        }),
      });
    }
    if (url.includes("/user/spot/trade_history")) {
      const pair = new URL(url).searchParams.get("pair") ?? "";
      return json({ trades: once(`t:${pair}`, rows.trades?.[pair] ?? []) });
    }
    if (url.includes("/user/deposit_history")) {
      const leg = new URL(url).searchParams.get("asset") ?? "crypto";
      if (rows.depositsNeverEnd !== undefined) {
        depositPage += 1;
        // 毎ページ新しい uuid を返し続けて paginate をページ上限に当てる。found_at は
        // since 以降に保つ（since > end になると API 側の入力検証で落ちてしまう）
        return json({
          deposits: [
            rawDeposit({
              uuid: `d-${depositPage}`,
              amount: "0",
              found_at: rows.depositsNeverEnd - depositPage,
              confirmed_at: rows.depositsNeverEnd - depositPage,
            }),
          ],
        });
      }
      return json({ deposits: once(`d:${leg}`, rows.deposits?.[leg as "crypto" | "jpy"] ?? []) });
    }
    if (url.includes("/user/withdrawal_history")) {
      const asset = new URL(url).searchParams.get("asset") ?? "";
      return json({ withdrawals: once(`w:${asset}`, rows.withdrawals?.[asset] ?? []) });
    }
    if (url.includes("/tickers_jpy")) {
      return json(Object.entries(rows.prices ?? {}).map(([a, last]) => ticker(`${a}_jpy`, last)));
    }
    if (url.includes("/candlestick/1day/")) {
      const asset = url.split("/candlestick/")[0].split("/").pop()?.replace("_jpy", "") ?? "";
      const series = rows.candles?.[asset];
      if (series === undefined) return new Response(JSON.stringify({ success: 0, data: {} }));
      return json(ohlcv(series));
    }
    return new Response(JSON.stringify({ success: 0, data: { code: 10000 } }));
  };

  return { fetch, urls };
}
