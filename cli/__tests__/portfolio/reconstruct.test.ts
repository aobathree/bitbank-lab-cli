// 100行超: 逆算の細部（手数料・status・時刻カーソル・非 JPY クォート）を 1 ケース 1 事実で
// 固定する。ここが移植の要で、1 つ落とすと静かに値がずれるのでケースを間引かない。
import { describe, expect, it } from "vitest";
import { reconstructHoldingsAtDate } from "../../portfolio/reconstruct.js";
import { deposit, NO_TRANSFERS, PAIR_ASSETS, trade, withdrawal } from "./factories.js";

const SINCE = 500;

describe("reconstructHoldingsAtDate — 約定の巻き戻し", () => {
  it("買いは qty ではなく (qty - feeBase) を戻す（base 建て手数料）", () => {
    // 1.0 BTC の買いで base 手数料 0.01 → 実際に増えたのは 0.99。
    // 現在 1.0 BTC なら約定前は 0.01 BTC。素朴に qty を戻すと 0（保有が消える）。
    const holdings = reconstructHoldingsAtDate(
      [{ asset: "btc", amount: 1 }],
      [trade({ side: "buy", amount: 1, price: 1_000_000, fee_amount_base: 0.01 })],
      SINCE,
      NO_TRANSFERS,
      PAIR_ASSETS,
    );
    expect(holdings.get("btc")).toBeCloseTo(0.01, 12);
    // 素朴な qty 巻き戻しなら 0 になり、DUST 判定で削除される
    expect(holdings.has("btc")).toBe(true);
  });

  it("買いは JPY 側に (qty × price + feeQuote) を戻す", () => {
    const holdings = reconstructHoldingsAtDate(
      [
        { asset: "btc", amount: 1 },
        { asset: "jpy", amount: 0 },
      ],
      [trade({ side: "buy", amount: 1, price: 1_000_000, fee_amount_quote: 1_200 })],
      SINCE,
      NO_TRANSFERS,
      PAIR_ASSETS,
    );
    expect(holdings.get("jpy")).toBe(1_001_200);
  });

  it("売りは base を戻し、受取 JPY（qty × price − feeQuote）を除く", () => {
    const holdings = reconstructHoldingsAtDate(
      [{ asset: "jpy", amount: 1_000_000 }],
      [trade({ side: "sell", amount: 1, price: 1_000_000, fee_amount_quote: 1_200 })],
      SINCE,
      NO_TRANSFERS,
      PAIR_ASSETS,
    );
    expect(holdings.get("btc")).toBe(1);
    expect(holdings.get("jpy")).toBe(1_200);
  });

  it("売りでも feeBase を戻す（base 建て手数料はどちら向きでも base から引かれる）", () => {
    // 移植元（MCP）は売りで qty しか戻さない。cli/tax/reconcile/rebuild.ts は買い・売りの
    // 両方で base 手数料を base から引いており、そちらに揃えてある
    const holdings = reconstructHoldingsAtDate(
      [],
      [trade({ side: "sell", amount: 1, price: 1_000_000, fee_amount_base: 0.002 })],
      SINCE,
      NO_TRANSFERS,
      PAIR_ASSETS,
    );
    expect(holdings.get("btc")).toBeCloseTo(1.002, 12);
    expect(holdings.get("btc")).not.toBe(1);
  });

  it("since より前の約定は巻き戻さない", () => {
    const holdings = reconstructHoldingsAtDate(
      [{ asset: "btc", amount: 1 }],
      [trade({ side: "buy", amount: 1, price: 1_000_000, executed_at: SINCE - 1 })],
      SINCE,
      NO_TRANSFERS,
      PAIR_ASSETS,
    );
    expect(holdings.get("btc")).toBe(1);
  });

  it("新しい約定から順に巻き戻す（複数件の合成）", () => {
    const trades = [
      trade({ side: "buy", amount: 1, price: 1_000_000, executed_at: 1_000 }),
      trade({ side: "buy", amount: 2, price: 2_000_000, executed_at: 2_000 }),
    ];
    const holdings = reconstructHoldingsAtDate(
      [
        { asset: "btc", amount: 3 },
        { asset: "jpy", amount: 0 },
      ],
      trades,
      SINCE,
      NO_TRANSFERS,
      PAIR_ASSETS,
    );
    expect(holdings.has("btc")).toBe(false); // 3 - 1 - 2 = 0
    expect(holdings.get("jpy")).toBe(5_000_000);
  });

  it("非 JPY クォート買い: base(xrp) と quote(btc) を数量で巻き戻し、feeQuote は btc", () => {
    // 現在: xrp 1000 / btc 0.5。期間内に xrp_btc で 1000 XRP を 0.00002 BTC で買い、
    // quote 手数料 0.000001 BTC → 実際に減った btc は 0.02 + 0.000001。
    // 巻き戻し後: xrp 0、btc 0.5 + 0.02 + 0.000001。
    const holdings = reconstructHoldingsAtDate(
      [
        { asset: "xrp", amount: 1000 },
        { asset: "btc", amount: 0.5 },
      ],
      [
        trade({
          pair: "xrp_btc",
          side: "buy",
          amount: 1000,
          price: 0.00002,
          fee_amount_quote: 0.000001,
        }),
      ],
      SINCE,
      NO_TRANSFERS,
      PAIR_ASSETS,
    );
    expect(holdings.has("xrp")).toBe(false);
    expect(holdings.get("btc")).toBeCloseTo(0.520001, 12);
    expect(holdings.has("jpy")).toBe(false);
  });
});

describe("reconstructHoldingsAtDate — 入出金の巻き戻し", () => {
  it("出金は amount + fee を足し戻す（当時は手数料も口座にあった）", () => {
    const holdings = reconstructHoldingsAtDate(
      [],
      [],
      SINCE,
      {
        deposits: [],
        withdrawals: [withdrawal({ asset: "xrp", amount: 100, fee: 0.15 })],
      },
      PAIR_ASSETS,
    );
    expect(holdings.get("xrp")).toBeCloseTo(100.15, 12);
    expect(holdings.get("xrp")).not.toBe(100);
  });

  it("入金は amount を引く", () => {
    const holdings = reconstructHoldingsAtDate(
      [{ asset: "jpy", amount: 30_000 }],
      [],
      SINCE,
      {
        deposits: [deposit({ asset: "jpy", amount: 10_000 })],
        withdrawals: [],
      },
      PAIR_ASSETS,
    );
    expect(holdings.get("jpy")).toBe(20_000);
  });

  it("status !== DONE の入出金は反映しない", () => {
    const holdings = reconstructHoldingsAtDate(
      [{ asset: "jpy", amount: 30_000 }],
      [],
      SINCE,
      {
        deposits: [deposit({ asset: "jpy", amount: 10_000, status: "FOUND" })],
        withdrawals: [withdrawal({ asset: "jpy", amount: 5_000, fee: 550, status: "PENDING" })],
      },
      PAIR_ASSETS,
    );
    expect(holdings.get("jpy")).toBe(30_000);
  });

  it("confirmed_at が欠けた DONE 入金は found_at を時刻に使う（黙って落とさない）", () => {
    const inWindow = deposit({
      asset: "jpy",
      amount: 10_000,
      confirmed_at: undefined,
      found_at: SINCE + 1,
    });
    const beforeWindow = deposit({
      asset: "jpy",
      amount: 7_000,
      uuid: "old",
      confirmed_at: undefined,
      found_at: SINCE - 1,
    });
    const holdings = reconstructHoldingsAtDate(
      [{ asset: "jpy", amount: 30_000 }],
      [],
      SINCE,
      {
        deposits: [inWindow, beforeWindow],
        withdrawals: [],
      },
      PAIR_ASSETS,
    );
    expect(holdings.get("jpy")).toBe(20_000);
  });

  it("巻き戻しの途中で負になっても消さない（相の順序に依存しない）", () => {
    // 2 BTC 買い → 1 BTC 出庫 → 現在 1 BTC。期初は 0。約定相の中間値 (1 - 2 = -1) を
    // 削除してしまうと、出庫相が 0 から積み直して 1 BTC になる（過大計上）
    const holdings = reconstructHoldingsAtDate(
      [{ asset: "btc", amount: 1 }],
      [trade({ side: "buy", amount: 2, price: 1_000_000 })],
      SINCE,
      { deposits: [], withdrawals: [withdrawal({ asset: "btc", amount: 1, fee: 0 })] },
      PAIR_ASSETS,
    );
    expect(holdings.has("btc")).toBe(false);
  });

  it("入庫の巻き戻しが負に振れても、後続の出庫が正しく打ち消す", () => {
    // 1 BTC 入庫 → 0.4 BTC 出庫 → 現在 0.6 BTC。期初は 0
    const holdings = reconstructHoldingsAtDate(
      [{ asset: "btc", amount: 0.6 }],
      [],
      SINCE,
      {
        deposits: [deposit({ asset: "btc", amount: 1 })],
        withdrawals: [withdrawal({ asset: "btc", amount: 0.4, fee: 0 })],
      },
      PAIR_ASSETS,
    );
    expect(holdings.has("btc")).toBe(false);
  });

  it("since より前の入出金は巻き戻さない", () => {
    const holdings = reconstructHoldingsAtDate(
      [{ asset: "jpy", amount: 30_000 }],
      [],
      SINCE,
      {
        deposits: [deposit({ asset: "jpy", amount: 10_000, confirmed_at: SINCE - 1 })],
        withdrawals: [
          withdrawal({ asset: "jpy", amount: 5_000, fee: 550, requested_at: SINCE - 1 }),
        ],
      },
      PAIR_ASSETS,
    );
    expect(holdings.get("jpy")).toBe(30_000);
  });
});
