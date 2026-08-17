// レポート組み立て。**ガード不成立なら `reference` 欄そのものを出さない**ことが要点
// （0 や null を入れると「損益ゼロ」と読めてしまう。v2 §1.2）。
import { describe, expect, it } from "vitest";
import { runEngine } from "../../../tax/engine/run.js";
import { ZERO_BOOK } from "../../../tax/engine/total-average.js";
import type { Collected } from "../../../tax/import/collect.js";
import type { LedgerResult } from "../../../tax/ledger/from-events.js";
import type { AssetComparison } from "../../../tax/reconcile/compare.js";
import { buildReport } from "../../../tax/report/build.js";
import type { TaxEvent } from "../../../tax/schema/event.js";
import type { LedgerEntry } from "../../../tax/schema/ledger.js";
import { TaxReport } from "../../../tax/schema/report.js";

const DAY = 86_400_000;
const entry = (
  kind: "ACQUIRE" | "DISPOSE",
  qty: string,
  jpy: string,
  seq: number,
): LedgerEntry => ({
  event_id: `e${seq}`,
  seq: 0,
  kind,
  currency: "btc",
  year_jst: 2026,
  ts_utc: seq * DAY,
  sort_key: `e${seq}:0`,
  qty,
  ...(kind === "ACQUIRE" ? { cost_jpy: jpy } : { proceeds_jpy: jpy }),
  category: kind === "ACQUIRE" ? "purchase" : "sale",
  policy_ids: kind === "ACQUIRE" ? ["P-16"] : [],
});

const ledger: LedgerResult = {
  entries: [entry("ACQUIRE", "3", "1000", 1), entry("DISPOSE", "1", "500", 2)],
  deferred: [],
};

const event: TaxEvent = {
  event_id: "e1",
  source_ref: "1",
  ts_utc: DAY,
  ts_jst: "1970-01-02T09:00:00+09:00",
  year_jst: 2026,
  account_id: "bitbank:default",
  kind: "TRADE_SPOT_BUY",
  market_type: "ORDERBOOK",
  source_system: "API",
  currency: "btc",
  qty: "3",
  jpy_value: "1000",
  costbasis_provenance: "PURCHASE",
  recognition_policy: "DELIVERY_DATE",
  flags: [],
};

const collected: Collected = {
  events: [event],
  pending: [],
  warnings: [],
  counts: { trades: 1, deposits: 0, withdrawals: 0, deduped: 0 },
  truncated: false,
  truncatedPairs: [],
  truncatedAssets: [],
};

const match: AssetComparison = {
  currency: "btc",
  theoretical: "3",
  actual: "3",
  residual: "0",
  dust: "0.0001",
  withinDust: true,
  diagnosis: "MATCH",
  hint: "ダスト閾値内で一致",
};

function build(attested: boolean, over: Partial<Collected> = {}) {
  const full: Collected = { ...collected, ...over };
  return buildReport({
    year: 2026,
    method: "total-average",
    taxation: { mode: "comprehensive", certainty: "settled", basis: "2026 年分は総合課税" },
    attested,
    // 全履歴（collected）と当年（yearEvents）は別スコープで渡す
    collected: full,
    yearEvents: full.events.filter((e) => e.year_jst === 2026),
    ledger,
    results: runEngine({
      entries: ledger.entries,
      method: "total-average",
      opening: { btc: ZERO_BOOK },
    }),
    reconciliation: [match],
    carryoverZeroRejected: [],
  });
}

describe("buildReport", () => {
  it("出力はスキーマを満たす", () => {
    expect(TaxReport.safeParse(build(true)).success).toBe(true);
  });

  it("ガード成立時は参考損益を出す（表示は円未満切捨て）", () => {
    const c = build(true).currencies[0];
    expect(c.reference).toBeDefined();
    // 単価 1000/3 = 333.33…、譲渡原価 = 333.33…、収入 500 → 参考損益 166
    expect(c.reference?.unit_price_jpy).toBe("333.33333333");
    expect(c.reference?.cogs_jpy).toBe("333");
    expect(c.reference?.reference_pnl_jpy).toBe("166");
  });

  it("ガード不成立なら reference 欄を出さず理由を並べる", () => {
    const c = build(false).currencies[0];
    expect(c.reference).toBeUndefined();
    expect(c.blocked_by.join()).toContain("(a)");
    // 取引集計はガードに関係なく常に出す
    expect(c.summary.acquired_qty).toBe("3");
    expect(c.summary.proceeds_jpy).toBe("500");
  });

  // 打ち切りは残高突合が MATCH でも通してはいけない（欠けた買いと売りが偶然
  // ネットゼロなら突合は成立してしまう）
  it("履歴が打ち切られていれば reference 欄を出さない", () => {
    const r = build(true, { truncated: true });
    expect(r.currencies[0].reference).toBeUndefined();
    expect(r.currencies[0].blocked_by.join()).toContain("打ち切られています");
    // レポート本体だけを読む経路（LLM / 保存した JSON）にも打ち切りを残す
    expect(r.warnings.join()).toContain("打ち切られています");
  });

  // source のフィールドはスコープが混ざっていた（当年の件数と全履歴の件数が同じ
  // オブジェクトに並び、差を「取込漏れ」と誤読させた）。名前でスコープが分かること
  describe("source のスコープ", () => {
    // 収集は全履歴（残高突合のため）。前年イベントと、年に紐づかない取込結果を混ぜる
    const priorYear: TaxEvent = {
      ...event,
      event_id: "e0",
      source_ref: "0",
      year_jst: 2025,
      kind: "DEPOSIT",
      market_type: undefined,
      costbasis_provenance: undefined,
      flags: ["UNRESOLVED_TRANSFER"],
    };
    const mixed = build(true, {
      events: [priorYear, event],
      pending: [{ source_ref: "9", reason: "未知の形状" }],
      counts: { trades: 2, deposits: 1, withdrawals: 0, deduped: 3 },
    });

    it("source.year は当年（year_jst）だけを数える", () => {
      expect(mixed.source.year.events).toBe(1);
      expect(mixed.source.year.deferred).toBe(0);
    });

    it("source.full_history は年で絞る前の全履歴を数える", () => {
      expect(mixed.source.full_history.pending).toBe(1);
      expect(mixed.source.full_history.deduped).toBe(3);
      expect(mixed.source.full_history.truncated).toBe(false);
    });

    // ガードに渡すのは当年イベントだけ。前年の未解決入庫で当年をブロックしない
    it("前年イベントのブロックフラグは当年の参考損益を止めない", () => {
      expect(mixed.currencies[0].reference).toBeDefined();
      expect(mixed.currencies[0].blocked_by).toEqual([]);
    });

    it("保留行そのものは全履歴のまま出す（件数と本体を食い違わせない）", () => {
      expect(mixed.pending).toHaveLength(mixed.source.full_history.pending);
    });
  });

  // 出力側は同じ分岐で両方付けているが、**契約としても**片方だけを許さない。
  // ガードが止めた銘柄に互換値だけ出ると「本体は出せないがこちらは出せる」と読める
  describe("reference と nta_compat は同時に出るか同時に出ないか", () => {
    it("ガード成立時は両方出る", () => {
      const c = build(true).currencies[0];
      expect(c.reference).toBeDefined();
      expect(c.nta_compat?.mode).toBe("NTA_SHEET_2025_12");
    });

    it("ガード不成立なら両方出ない", () => {
      const c = build(false).currencies[0];
      expect(c.reference).toBeUndefined();
      expect(c.nta_compat).toBeUndefined();
    });

    it("片方だけの出力はスキーマが弾く", () => {
      const r = build(true);
      const broken = {
        ...r,
        currencies: [{ ...r.currencies[0], nta_compat: undefined }],
      };
      expect(TaxReport.safeParse(broken).success).toBe(false);
    });
  });

  it("適用した【方針】ID をレポートに露出する", () => {
    expect(build(true).currencies[0].policy_ids).toEqual(["P-16"]);
  });

  it("免責文言を常時付け、「所得金額」とは呼ばない", () => {
    const r = build(true);
    expect(r.disclaimers.length).toBeGreaterThan(0);
    expect(r.disclaimers[0]).toContain("税計算用参考データ");
    expect(r.disclaimers[0]).toContain("税務上の所得金額ではありません");
    // 「単一取引所だから計算できない」とは言い切らない。限界は口座外に同一銘柄が
    // あるときの話で、そこを条件付きで述べているか
    expect(r.disclaimers[0]).toContain("bitbank 口座だけで完結している");
    expect(r.disclaimers.join()).toContain("20万円以下であっても");
  });
});
