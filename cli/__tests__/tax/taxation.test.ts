// 課税方式は**年で法律上決まる**（v2 §12）。ここで固定するのは「テーブルが年を正しく
// 引くこと」と「`--taxation` が上書きではなく確認として働くこと」。
// 総合課税の前提で計算した数値に分離課税のラベルが付くと、損益通算の範囲・損失の繰越・
// 税率がすべて変わるため、ラベルの取り違えは数値の誤りと同じ重さになる。
import { describe, expect, it } from "vitest";
import { aggregationNote, disclaimers, futureRegime } from "../../tax/report/disclaimers.js";
import type { Taxation } from "../../tax/schema/taxation.js";
import { resolveTaxation, taxationFor } from "../../tax/taxation.js";

const determined = (year: number) => {
  const r = taxationFor(year);
  if (!r.determined) throw new Error(`expected determined for ${year}`);
  return r.taxation;
};

describe("taxationFor（年 → 課税方式）", () => {
  it("2026 年分は総合課税で確定（最速の施行でも適用開始は 2027-01-01）", () => {
    expect(determined(2026)).toMatchObject({ mode: "comprehensive", certainty: "settled" });
  });

  it("過去年も総合課税で確定", () => {
    expect(determined(2024)).toMatchObject({ mode: "comprehensive", certainty: "settled" });
  });

  it("2027 年分は総合課税の見込み止まり（施行日次第で分離課税があり得る）", () => {
    const t = determined(2027);
    expect(t).toMatchObject({ mode: "comprehensive", certainty: "projected" });
    expect(t.basis).toContain("施行日未確定");
  });

  it("2028 年分以降は決めない（推測せず determined: false を返す）", () => {
    const r = taxationFor(2028);
    expect(r.determined).toBe(false);
    if (!r.determined) expect(r.reason).toContain("確定できません");
  });
});

describe("resolveTaxation（--taxation は確認であって上書きではない）", () => {
  it("指定なしなら年から決まる", () => {
    const r = resolveTaxation(2026);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.mode).toBe("comprehensive");
  });

  it("年と一致する指定は通る", () => {
    expect(resolveTaxation(2026, "comprehensive").success).toBe(true);
  });

  it("年と食い違う指定はエラー（黙って年側を採らない）", () => {
    const r = resolveTaxation(2026, "separate");
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error).toContain("2026 年分に適用されるのは comprehensive");
  });

  it("未知の値は選択肢を示して弾く", () => {
    const r = resolveTaxation(2026, "bogus");
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error).toContain("comprehensive | separate");
  });

  it("方式が決まらない年は API を叩く前にエラー", () => {
    expect(resolveTaxation(2030).success).toBe(false);
  });
});

describe("免責の年埋め", () => {
  const of = (year: number): Taxation => determined(year);

  it("確定年は「適用されません」と言い切る", () => {
    const s = futureRegime(of(2026), 2026);
    expect(s).toContain("2026年分には適用されません");
  });

  it("見込み年は言い切らず、総合課税を前提にした旨を書く", () => {
    const s = futureRegime(of(2027), 2027);
    expect(s).toContain("2027年分に適用されるかは施行日により確定します");
    expect(s).toContain("総合課税を前提に計算しています");
  });

  it("対象年がそのまま免責に載る（旧実装は 2026 固定で他の年に嘘をついていた）", () => {
    expect(disclaimers(of(2027), 2027).join()).not.toContain("2026年分には適用されません");
  });

  it("雑所得の合算注記も対象年を埋める（同じ 2026 固定が別の注記にも残っていた）", () => {
    expect(aggregationNote(of(2026), 2026)).toContain("（2026年分・現行制度）");
    expect(aggregationNote(of(2027), 2027)).toContain("（2027年分・総合課税を前提）");
  });

  // シートへの入力を円に確定する話は移動平均法にしか無い。総平均法（既定）にまで
  // 常時載せると、無関係な注記でレポート末尾が伸びる
  it("シート入力の円確定は移動平均法のときだけ注記する", () => {
    expect(disclaimers(of(2026), 2026, "moving-average").join()).toContain("整数円入力");
    expect(disclaimers(of(2026), 2026, "total-average").join()).not.toContain("整数円入力");
    expect(disclaimers(of(2026), 2026).join()).not.toContain("整数円入力");
  });

  it("2027 年分の免責一式に 2026 年分の制度説明が混ざらない", () => {
    const all = disclaimers(of(2027), 2027).join();
    expect(all).not.toContain("2026年分");
    // 「2026年7月時点」は調査時点であって対象年ではないので残ってよい
    expect(all).toContain("2026年7月時点");
  });
});
