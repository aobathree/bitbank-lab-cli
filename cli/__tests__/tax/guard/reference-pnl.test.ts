// 100行超: ガード (a)〜(d) と警告を条件ごとに 1 本ずつ固定するため。
// B案の核心なので「どれか 1 つでも欠けたら数値を出さない」を条件の数だけ列挙する。
//
// 参考損益の表示ガード（v2 §1.2 / 付録E.4）。B案の核心なので、
// **どれか 1 つでも欠ければ数値を出さない**ことを条件ごとに固定する。
import { describe, expect, it } from "vitest";
import { runEngine } from "../../../tax/engine/run.js";
import { ZERO_BOOK } from "../../../tax/engine/total-average.js";
import { evaluateGuard, type GuardInput } from "../../../tax/guard/reference-pnl.js";
import type { AssetComparison } from "../../../tax/reconcile/compare.js";
import type { TaxEvent } from "../../../tax/schema/event.js";
import type { LedgerEntry } from "../../../tax/schema/ledger.js";

const entry: LedgerEntry = {
  event_id: "trade:1",
  seq: 0,
  kind: "ACQUIRE",
  currency: "btc",
  year_jst: 2026,
  ts_utc: 1_767_225_600_000,
  sort_key: "1:0",
  qty: "1",
  cost_jpy: "1000000",
  category: "purchase",
  policy_ids: ["P-16"],
};

const event = (over: Partial<TaxEvent> = {}): TaxEvent =>
  ({
    event_id: "trade:1",
    source_ref: "1",
    ts_utc: 1_767_225_600_000,
    ts_jst: "2026-01-01T09:00:00+09:00",
    year_jst: 2026,
    account_id: "bitbank:default",
    kind: "TRADE_SPOT_BUY",
    market_type: "ORDERBOOK",
    source_system: "API",
    currency: "btc",
    qty: "1",
    jpy_value: "1000000",
    costbasis_provenance: "PURCHASE",
    recognition_policy: "DELIVERY_DATE",
    flags: [],
    ...over,
  }) as TaxEvent;

const match: AssetComparison = {
  currency: "btc",
  theoretical: "1",
  actual: "1",
  residual: "0",
  dust: "0.0001",
  withinDust: true,
  diagnosis: "MATCH",
  hint: "ダスト閾値内で一致",
};

function input(over: Partial<GuardInput> = {}): GuardInput {
  return {
    attested: true,
    truncated: false,
    events: [event()],
    results: runEngine({ entries: [entry], method: "total-average", opening: { btc: ZERO_BOOK } }),
    reconciliation: [match],
    deferred: [],
    carryoverZeroRejected: [],
    ...over,
  };
}

describe("evaluateGuard", () => {
  it("(a)〜(d) がすべて揃えば参考損益を許可する", () => {
    expect(evaluateGuard(input(), "btc")).toEqual({ allowed: true, blockedBy: [], warnings: [] });
  });

  it("履歴がページ上限で打ち切られていればブロックする", () => {
    const v = evaluateGuard(input({ truncated: true }), "btc");
    expect(v.allowed).toBe(false);
    expect(v.blockedBy.join()).toContain("打ち切られています");
    expect(v.blockedBy.join()).toContain("--max-pages");
  });

  // 欠けた買いと売りが偶然ネットゼロだと残高突合は MATCH のまま通る。
  // 打ち切りを独立したブロック条件にしていないと、その穴から数値が出る
  it("打ち切り時は残高突合が MATCH でもブロックする", () => {
    const v = evaluateGuard(input({ truncated: true }), "btc");
    expect(v.allowed).toBe(false);
    expect(v.blockedBy.join()).not.toContain("(d)");
  });

  it("打ち切りが無ければ従来どおり通る", () => {
    expect(evaluateGuard(input({ truncated: false }), "btc").allowed).toBe(true);
  });

  it("(a) アテステーションが無ければブロック", () => {
    const v = evaluateGuard(input({ attested: false }), "btc");
    expect(v.allowed).toBe(false);
    expect(v.blockedBy.join()).toContain("(a)");
  });

  it("(b) 未解決の入庫があればブロック", () => {
    const dep = event({ event_id: "dep:1", kind: "DEPOSIT", flags: ["UNRESOLVED_TRANSFER"] });
    const v = evaluateGuard(input({ events: [event(), dep] }), "btc");
    expect(v.allowed).toBe(false);
    expect(v.blockedBy.join()).toContain("未解決の入庫");
  });

  it("(b) 付与の疑い・非 JPY クォート・未観測形状もブロック要因", () => {
    for (const flag of ["GRANT_SUSPECT", "NON_JPY_QUOTE", "NO_RATE", "UNOBSERVED_SHAPE"] as const) {
      const v = evaluateGuard(input({ events: [event({ flags: [flag] })] }), "btc");
      expect(v.allowed, flag).toBe(false);
    }
  });

  it("(c) 前年繰越が未入力ならブロック", () => {
    const results = runEngine({ entries: [entry], method: "total-average", opening: {} });
    const v = evaluateGuard(input({ results }), "btc");
    expect(v.allowed).toBe(false);
    expect(v.blockedBy.join()).toContain("(c)");
  });

  // 反証された銘柄は opening が埋まらないので (c) 側で落ちる。文言だけが分かれる
  // （「書き忘れ」と「zero と書いたが初年度ではない」でユーザーの次の行動が違う）
  it("(c) --carryover=zero が反証されていれば、その旨を理由に載せる", () => {
    const results = runEngine({ entries: [entry], method: "total-average", opening: {} });
    const v = evaluateGuard(input({ results, carryoverZeroRejected: ["btc"] }), "btc");
    expect(v.allowed).toBe(false);
    expect(v.blockedBy.join()).toContain("--carryover=zero は使えません");
    expect(v.blockedBy.join()).not.toContain("前年末残高（数量・簿価）が未確定");
  });

  // 反証は銘柄ごと。1 銘柄が初年度でなくても、他の銘柄まで巻き込まない
  it("反証されていない銘柄は従来どおり通る", () => {
    expect(evaluateGuard(input({ carryoverZeroRejected: ["eth"] }), "btc").allowed).toBe(true);
  });

  it("(d) 残高突合が閾値外ならブロックし、残差を理由に載せる", () => {
    const mismatch: AssetComparison = {
      ...match,
      residual: "0.1",
      withinDust: false,
      diagnosis: "MISSING_ACQUISITION",
      hint: "実残高が多い",
    };
    const v = evaluateGuard(input({ reconciliation: [mismatch] }), "btc");
    expect(v.allowed).toBe(false);
    expect(v.blockedBy.join()).toContain("残差 0.1");
  });

  it("仕訳化できないイベントがあればブロック", () => {
    const deferred = [{ event_id: "trade:9", currency: "btc", reason: "TRADE_EXCHANGE は…" }];
    expect(evaluateGuard(input({ deferred }), "btc").allowed).toBe(false);
  });

  it("出庫はブロックせず警告だけ付ける（計算は続行できる）", () => {
    const wd = event({ event_id: "wd:1", kind: "WITHDRAWAL" });
    const v = evaluateGuard(input({ events: [event(), wd] }), "btc");
    expect(v.allowed).toBe(true);
    expect(v.warnings.join()).toContain("出庫先での売却");
  });
});
