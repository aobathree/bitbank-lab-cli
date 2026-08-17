// エンジンの境界挙動。ゴールデンケースは golden-nta.test.ts が持つので、
// ここは**前提が崩れたときに黙って数値を出さない**ことを固定する。
import { describe, expect, it } from "vitest";
import { checkI1, checkI2, checkI3 } from "../../../tax/engine/invariants.js";
import { movingAverage } from "../../../tax/engine/moving-average.js";
import { runEngine } from "../../../tax/engine/run.js";
import { bookFromDecimal, totalAverage, ZERO_BOOK } from "../../../tax/engine/total-average.js";
import { toExactDecimalString } from "../../../tax/ratio-decimal.js";
import type { LedgerEntry } from "../../../tax/schema/ledger.js";

const DAY = 86_400_000;
const base = {
  currency: "btc",
  year_jst: 2026,
  category: "x",
  policy_ids: [] as string[],
};

const acquire = (seq: number, qty: string, cost: string): LedgerEntry => ({
  ...base,
  event_id: `a${seq}`,
  seq: 0,
  kind: "ACQUIRE",
  ts_utc: seq * DAY,
  sort_key: `a${seq}:0`,
  qty,
  cost_jpy: cost,
});

const dispose = (seq: number, qty: string, proceeds: string): LedgerEntry => ({
  ...base,
  event_id: `d${seq}`,
  seq: 0,
  kind: "DISPOSE",
  ts_utc: seq * DAY,
  sort_key: `d${seq}:0`,
  qty,
  proceeds_jpy: proceeds,
});

const exact = (r: { n: bigint; d: bigint }) => toExactDecimalString(r);

describe("総平均法の境界", () => {
  it("前年繰越を単価計算に含める", () => {
    const opening = bookFromDecimal("1", "500000");
    expect(opening).not.toBeNull();
    const o = totalAverage("btc", [acquire(1, "1", "700000")], opening as never);
    expect(exact(o.unit as never)).toBe("600000");
    expect(exact(o.closing.cost)).toBe("1200000");
    expect(checkI1(o)).toEqual([]);
  });

  it("取得ゼロで処分があるときは違反として報告する（0 円原価にしない）", () => {
    const o = totalAverage("btc", [dispose(1, "1", "100000")], ZERO_BOOK);
    expect(o.unit).toBeNull();
    expect(o.violations.join()).toContain("取得が 1 件も無い");
    expect(checkI2(o)).not.toEqual([]);
  });

  it("数量ゼロで簿価だけ残る繰越は、簿価を譲渡原価に流さず違反として止める", () => {
    // 繰越の入力ミス（qty=0 なのに cost>0）。簿価を cogs へ流すと実際には処分して
    // いない額がまるごと参考損失になり、しかも I1 は成立するので検知できない
    const opening = bookFromDecimal("0", "1000");
    const o = totalAverage("btc", [], opening as never);
    expect(exact(o.cogs)).toBe("0");
    expect(exact(o.closing.cost)).toBe("1000"); // 簿価は期末に残す
    expect(o.violations.join()).toContain("数量ゼロなのに取得価額が残っています");
    expect(checkI2(o)).not.toEqual([]); // ガードが確実に止める
  });

  it("割り切れない単価でも I1 が厳密に成立する（丸めを挟まない）", () => {
    const entries = [acquire(1, "3", "100"), dispose(2, "1", "50")];
    const o = totalAverage("btc", entries, ZERO_BOOK);
    expect(exact(o.unit as never)).toBeNull(); // 100/3 は有限小数にならない
    expect(checkI1(o)).toEqual([]);
  });
});

describe("移動平均法の境界", () => {
  it("全量処分では簿価残を全額原価へ掃き出す（P-03）", () => {
    const entries = [acquire(1, "3", "100"), dispose(2, "3", "500")];
    const o = movingAverage("btc", entries, ZERO_BOOK);
    expect(exact(o.cogs)).toBe("100");
    expect(exact(o.closing.cost)).toBe("0");
    expect(exact(o.closing.qty)).toBe("0");
    expect(checkI2(o)).toEqual([]);
  });

  it("単価は処分では据置き、次の取得で更新される（FAQ 2-4 の年末単価の定義）", () => {
    const entries = [acquire(1, "2", "200"), dispose(2, "1", "500"), acquire(3, "1", "400")];
    const o = movingAverage("btc", entries, ZERO_BOOK);
    // 100 → (100 + 400) / 2 = 250
    expect(exact(o.unit as never)).toBe("250");
  });

  it("保有を超える処分は違反として報告し、簿価を壊さない", () => {
    const o = movingAverage("btc", [acquire(1, "1", "100"), dispose(2, "2", "500")], ZERO_BOOK);
    expect(o.violations.join()).toContain("処分数量が保有数量を超えています");
    expect(exact(o.closing.qty)).toBe("1");
  });

  it("数量ゼロの処分では簿価を掃き出さない（全量処分の分岐に吸い込ませない）", () => {
    // 数量ゼロの ACQUIRE（調整仕訳）で簿価だけ残った状態。P-03 の eq(qty, book.qty) は
    // **両方ゼロでも真**になるので、防御しないと残簿価が丸ごと cogs へ流れ、売却代金
    // ゼロの参考損失が立つ。しかも I1 は成立するのでそちらでは検知できない
    const entries = [acquire(1, "0", "1000"), dispose(2, "0", "0")];
    const o = movingAverage("btc", entries, ZERO_BOOK);
    expect(exact(o.cogs)).toBe("0");
    expect(exact(o.closing.cost)).toBe("1000"); // 簿価は期末に残す
    expect(o.unit).toBeNull(); // 数量ゼロでは単価を引けないので据置き
    expect(checkI1(o)).toEqual([]);
    expect(checkI2(o)).not.toEqual([]); // 年末に I2 違反として拾われ、ガードが閉じる
  });

  it("保有が負なら数量ゼロの処分でも違反として報告する（早期 return で検証を迂回しない）", () => {
    // 繰越 qty は decStr（`-?\d+`）なので負値が入り得る。数量ゼロ判定を数量超過の
    // 検証より先に置くと、cmp(0, 負) > 0 の唯一の検知点が消える。後続の取得で数量が
    // 正へ戻ると期末には痕跡が残らず、下の I1 / I2 が両方とも通ってしまう
    const opening = bookFromDecimal("-5", "0");
    expect(opening).not.toBeNull();
    const entries = [dispose(1, "0", "0"), acquire(2, "10", "100")];
    const o = movingAverage("btc", entries, opening as never);
    expect(o.violations.join()).toContain("処分数量が保有数量を超えています");
    expect(checkI1(o)).toEqual([]); // 期末だけを見ても異常は残らない
    expect(checkI2(o)).toEqual([]);
  });

  it("時系列が入れ替わっていても sort_key で安定に並べ直す", () => {
    const entries = [acquire(3, "1", "400"), acquire(1, "2", "200"), dispose(2, "1", "500")];
    const o = movingAverage("btc", entries, ZERO_BOOK);
    expect(exact(o.unit as never)).toBe("250");
  });
});

describe("不変条件", () => {
  it("I3: 同一イベント由来の取得と処分の金額が食い違えば検出する", () => {
    const swap = (cost: string, proceeds: string): LedgerEntry[] => [
      { ...acquire(1, "1", cost), event_id: "ex:1" },
      { ...dispose(1, "1", proceeds), event_id: "ex:1" },
    ];
    expect(checkI3(swap("1000", "1000"))).toEqual([]);
    expect(checkI3(swap("1000", "999"))[0].id).toBe("I3");
  });
});

describe("runEngine: 通貨をまたぐ I3", () => {
  // 交換取引は支払側と受取側が別通貨。通貨で分割した仕訳だけを見ると片側しか
  // 入らないので、I3 を通貨別に評価すると常に素通りしてしまう
  const exchange = (cost: string, proceeds: string): LedgerEntry[] => [
    { ...acquire(1, "1", cost), event_id: "ex:1", currency: "eth" },
    { ...dispose(1, "1", proceeds), event_id: "ex:1", currency: "btc" },
  ];

  it("金額が食い違えば関与した両通貨に I3 違反が付く", () => {
    const r = runEngine({
      entries: exchange("1000", "999"),
      method: "total-average",
      opening: { btc: ZERO_BOOK, eth: ZERO_BOOK },
    });
    expect(r.get("btc")?.invariants.map((v) => v.id)).toContain("I3");
    expect(r.get("eth")?.invariants.map((v) => v.id)).toContain("I3");
  });

  it("金額が一致していれば I3 違反は出ない", () => {
    const r = runEngine({
      entries: exchange("1000", "1000"),
      method: "total-average",
      opening: { btc: ZERO_BOOK, eth: ZERO_BOOK },
    });
    expect(r.get("btc")?.invariants.filter((v) => v.id === "I3")).toEqual([]);
    expect(r.get("eth")?.invariants.filter((v) => v.id === "I3")).toEqual([]);
  });

  it("交換に関与していない通貨には配賦しない", () => {
    // 第三の通貨（交換イベントに現れない xrp）を置く。ここを空で固定しないと、
    // 「全通貨へ配る」誤実装でも関与通貨側の期待値は通ってしまい判別できない
    const r = runEngine({
      entries: [...exchange("1000", "999"), { ...acquire(2, "1", "100"), currency: "xrp" }],
      method: "total-average",
      opening: { btc: ZERO_BOOK, eth: ZERO_BOOK, xrp: ZERO_BOOK },
    });
    const i3 = (c: string) => r.get(c)?.invariants.filter((v) => v.id === "I3");
    expect(i3("btc")).toHaveLength(1);
    expect(i3("eth")).toHaveLength(1);
    expect(i3("xrp")).toEqual([]);
  });
});

describe("runEngine", () => {
  it("JPY は評価対象の暗号資産ではないので銘柄集計から外す", () => {
    const jpy = { ...acquire(1, "1", "1"), currency: "jpy" };
    const r = runEngine({ entries: [jpy], method: "total-average", opening: {} });
    expect(r.size).toBe(0);
  });

  it("繰越だけあって当年の動きが無い銘柄も集計対象に残す", () => {
    const opening = { eth: ZERO_BOOK };
    const r = runEngine({ entries: [], method: "total-average", opening });
    expect(r.get("eth")?.openingKnown).toBe(true);
  });

  it("銘柄別に評価方法を上書きできる（種類ごとに選定する制度に合わせる）", () => {
    const entries = [acquire(1, "3", "100"), dispose(2, "3", "500")];
    const r = runEngine({
      entries,
      method: "total-average",
      methodByCurrency: { btc: "moving-average" },
      opening: { btc: ZERO_BOOK },
    });
    expect(r.get("btc")?.outcome.method).toBe("moving-average");
  });
});
