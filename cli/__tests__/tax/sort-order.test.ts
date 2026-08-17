// 100行超: 比較関数そのものと、それが移動平均法・互換モード・仕訳化の 3 経路で
// 実際に効くことを 1 ファイルで固定するため。比較関数だけを見ても「順序が結果を変える」
// ことが伝わらず、経路側だけを見ても比較の境界（桁数・非数値）が抜ける。
//
// 同一タイムスタンプの安定順序（要求仕様 §3【方針】「約定ID で安定ソート」）。
// 素の辞書順は "10" < "9" になり、`fetch-trades` の数値順（trade_id 昇順）と食い違う。
import { describe, expect, it } from "vitest";
import { ntaCompat } from "../../tax/compat/nta-sheet.js";
import { movingAverage } from "../../tax/engine/moving-average.js";
import { ledgerFromEvents } from "../../tax/ledger/from-events.js";
import { ZERO } from "../../tax/ratio.js";
import { fromDecimalString, toExactDecimalString } from "../../tax/ratio-decimal.js";
import type { TaxEvent } from "../../tax/schema/event.js";
import type { LedgerEntry } from "../../tax/schema/ledger.js";
import { compareSortKeys } from "../../tax/sort-order.js";

describe("compareSortKeys", () => {
  it("数字だけのセグメントは数値順（辞書順では 10 < 9 になる）", () => {
    expect(compareSortKeys("9:0", "10:0")).toBeLessThan(0);
    expect(compareSortKeys("10:0", "9:0")).toBeGreaterThan(0);
    expect(compareSortKeys("trade:9", "trade:10")).toBeLessThan(0);
  });

  it("2^53 を超える ID でも桁数で決めるので順序を誤らない", () => {
    // Number 化すると両方 9007199254740992 に潰れて「等しい」になる（2^53 = ...992）
    const a = "9007199254740992";
    const b = "9007199254740993";
    expect(Number(a) === Number(b)).toBe(true);
    expect(compareSortKeys(a, b)).toBeLessThan(0);
  });

  it("数字でないセグメントは辞書順にフォールバックする（販売所の注文ID 等）", () => {
    expect(compareSortKeys("brk:A-10", "brk:A-9")).toBeLessThan(0);
    expect(compareSortKeys("dep:x", "trade:1")).toBeLessThan(0);
  });

  it("セグメント数が違えば少ない方が先（前方一致は前方が優先）", () => {
    expect(compareSortKeys("1", "1:0")).toBeLessThan(0);
    expect(compareSortKeys("1:2", "1:10")).toBeLessThan(0);
  });

  it("同一キーは 0（比較が全順序として壊れていないこと）", () => {
    expect(compareSortKeys("trade:7:1", "trade:7:1")).toBe(0);
  });
});

// 同一ミリ秒に売却（trade_id=9）と購入（trade_id=10）が混ざるケース。
// 取得順は 9 → 10（売却が先）。辞書順だと "10:0" < "9:0" で購入が先になり、
// 譲渡原価が 1,000,000 → 1,500,000 へ入れ替わる（差 500,000 円）。
const SAME_MS = 1_767_225_600_000;
const base = { currency: "btc", year_jst: 2026, ts_utc: SAME_MS, policy_ids: [] as string[] };

const sell: LedgerEntry = {
  ...base,
  event_id: "trade:9",
  seq: 0,
  kind: "DISPOSE",
  sort_key: "9:0",
  qty: "1",
  proceeds_jpy: "3000000",
  category: "sale",
};

const buy: LedgerEntry = {
  ...base,
  event_id: "trade:10",
  seq: 0,
  kind: "ACQUIRE",
  sort_key: "10:0",
  qty: "1",
  cost_jpy: "2000000",
  category: "purchase",
};

describe("同一ミリ秒で取得と処分が混ざる場合の移動平均法", () => {
  const dec = (s: string) => fromDecimalString(s) ?? ZERO;
  const opening = { qty: dec("1"), cost: dec("1000000") };
  // 入力の並び順に依存しないこと（ソートが効いていること）も同時に見る
  const outcomes = [
    movingAverage("btc", [sell, buy], opening),
    movingAverage("btc", [buy, sell], opening),
  ];

  it("約定ID の数値順（売却が先）で譲渡原価を出す", () => {
    for (const o of outcomes) {
      expect(toExactDecimalString(o.cogs)).toBe("1000000");
      expect(o.violations).toEqual([]);
    }
  });

  it("期末簿価は購入分だけが残る", () => {
    for (const o of outcomes) {
      expect(toExactDecimalString(o.closing.qty)).toBe("1");
      expect(toExactDecimalString(o.closing.cost)).toBe("2000000");
    }
  });

  // 互換モードは別の漸化式で回すが、**同じ順序**を見ていなければ差が丸め由来か
  // 順序由来か判別できなくなる
  it("国税庁計算書互換モードも同じ順序で回す", () => {
    const compat = ntaCompat(outcomes[0], [buy, sell]);
    expect(compat.cogs_jpy).toBe("1000000");
    expect(compat.closing_cost_jpy).toBe("2000000");
  });
});

describe("仕訳化の並び", () => {
  const event = (sourceRef: string, kind: TaxEvent["kind"], jpy: string): TaxEvent =>
    ({
      event_id: `trade:${sourceRef}`,
      source_ref: sourceRef,
      ts_utc: SAME_MS,
      ts_jst: "2026-01-01T09:00:00+09:00",
      year_jst: 2026,
      account_id: "bitbank:default",
      kind,
      market_type: "ORDERBOOK",
      source_system: "API",
      currency: "btc",
      qty: "1",
      jpy_value: jpy,
      costbasis_provenance: kind === "TRADE_SPOT_BUY" ? "PURCHASE" : undefined,
      recognition_policy: "DELIVERY_DATE",
      flags: [],
    }) as TaxEvent;

  it("同一ミリ秒のイベントは約定ID の数値順に仕訳化される", () => {
    const events = [
      event("10", "TRADE_SPOT_BUY", "2000000"),
      event("9", "TRADE_SPOT_SELL", "3000000"),
    ];
    const { entries } = ledgerFromEvents(events);
    expect(entries.map((e) => e.sort_key)).toEqual(["9:0", "10:0"]);
  });
});
