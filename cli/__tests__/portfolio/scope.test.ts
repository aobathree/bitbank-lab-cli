import { describe, expect, it } from "vitest";
import { candlePairsFor, marketScope, pairAssetsOf } from "../../portfolio/scope.js";
import { trade } from "./factories.js";

const MASTER = [
  { name: "btc_jpy", base_asset: "btc", quote_asset: "jpy" },
  { name: "xrp_jpy", base_asset: "xrp", quote_asset: "jpy" },
  { name: "xrp_btc", base_asset: "xrp", quote_asset: "btc" },
] as const;

describe("marketScope", () => {
  it("約定取得は全ペア、candle 用は JPY ペアに分ける", () => {
    const s = marketScope(MASTER);
    expect(s.allPairs).toEqual(["btc_jpy", "xrp_btc", "xrp_jpy"]);
    expect(s.jpyPairs).toEqual(["btc_jpy", "xrp_jpy"]);
    expect(s.allAssets).toEqual(["btc", "jpy", "xrp"]);
  });
});

describe("candlePairsFor", () => {
  it("非 JPY 約定の base/quote をマスタから拾い、JPY 建て candle を選ぶ", () => {
    const pairs = candlePairsFor(
      ["btc_jpy", "xrp_jpy"],
      [],
      {
        trades: [trade({ pair: "xrp_btc", side: "buy", amount: 1, price: 0.00002 })],
        deposits: [],
        withdrawals: [],
      },
      pairAssetsOf(MASTER),
    );
    expect(pairs).toEqual(["btc_jpy", "xrp_jpy"]);
  });

  it("ペア名と base_asset が一致しなくてもマスタの base で選ぶ", () => {
    // 名前を `_jpy` 除去すると "wrapped_btc" になるが、マスタの base は "btc"
    const master = [{ name: "wrapped_btc_jpy", base_asset: "btc", quote_asset: "jpy" }];
    const pairs = candlePairsFor(
      ["wrapped_btc_jpy"],
      [{ asset: "btc", amount: 1 }],
      { trades: [], deposits: [], withdrawals: [] },
      pairAssetsOf(master),
    );
    expect(pairs).toEqual(["wrapped_btc_jpy"]);
  });

  it("pairAssets に無い JPY ペア名は candle 対象にしない", () => {
    const pairs = candlePairsFor(
      ["btc_jpy", "ghost_jpy"],
      [{ asset: "btc", amount: 1 }],
      { trades: [], deposits: [], withdrawals: [] },
      pairAssetsOf(MASTER),
    );
    expect(pairs).toEqual(["btc_jpy"]);
  });
});
