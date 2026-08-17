import { describe, expect, it } from "vitest";
import { add, div, eq, mul, ratio, sub, ZERO } from "../../tax/ratio.js";
import {
  fromDecimalString,
  type RoundMode,
  roundAtScale,
  toDecimalString,
  toYen,
} from "../../tax/ratio-decimal.js";
import { ratioReference } from "../__fixtures__/tax/ratio-reference.js";

// 期待値は Python fractions.Fraction による独立リファレンス（ADR-005）。
// 生成: python3 scripts/dev/gen-ratio-reference.py

describe("fromDecimalString: float を経由しないパース", () => {
  it("整数・小数・負値を厳密に読む", () => {
    expect(fromDecimalString("0")).toEqual(ZERO);
    expect(fromDecimalString("100")).toEqual({ n: 100n, d: 1n });
    expect(fromDecimalString("0.1")).toEqual({ n: 1n, d: 10n });
    // 既約形で保持する（-1234567/1000000 は互いに素なのでそのまま）
    expect(fromDecimalString("-1.234567")).toEqual({ n: -1234567n, d: 1000000n });
    expect(toDecimalString(fromDecimalString("-1.234567") as never, 6, "ROUNDDOWN")).toBe(
      "-1.234567",
    );
  });

  it("有効桁を落とさない（number 経由なら丸まる桁数）", () => {
    const r = fromDecimalString("999999999.999999999999999999");
    expect(r).not.toBeNull();
    // 有効 27 桁（整数部 9 + 小数部 18）を保持（Number では 999999999.9999999 に丸まる）
    expect(toDecimalString(r as never, 18, "ROUNDDOWN")).toBe("999999999.999999999999999999");
  });

  it("不正形式は null を返す（throw しない）", () => {
    for (const s of ["", " 1", "1 ", "1e5", "0x10", ".5", "1.", "--1", "1.2.3", "abc", "+1"]) {
      expect(fromDecimalString(s), s).toBeNull();
    }
  });
});

describe("roundAtScale: リファレンス突合", () => {
  // フィクスチャは [n, d, scale, mode, expectedScaled, expectedRendered]。
  // 分岐（rem==0 / 符号 / タイちょうど / スケール）を決定論的に網羅している
  it.for(ratioReference.rounds)("%s/%s scale=%s %s", ([n, d, scale, mode, scaled, rendered]) => {
    const r = ratio(BigInt(n), BigInt(d));
    expect(roundAtScale(r, scale as number, mode as RoundMode).toString()).toBe(scaled);
    expect(toDecimalString(r, scale as number, mode as RoundMode)).toBe(rendered);
  });
});

describe("roundAtScale: Excel 準拠のモード意味論", () => {
  it("ROUNDDOWN はゼロ方向・ROUNDUP はゼロから離れる方向（負値で floor/ceil と異なる）", () => {
    const minus15 = ratio(-3n, 2n); // -1.5
    expect(roundAtScale(minus15, 0, "ROUNDDOWN")).toBe(-1n); // ゼロ方向（floor なら -2）
    expect(roundAtScale(minus15, 0, "ROUNDUP")).toBe(-2n); // 離れる方向（ceil なら -1）
    const plus15 = ratio(3n, 2n);
    expect(roundAtScale(plus15, 0, "ROUNDDOWN")).toBe(1n);
    expect(roundAtScale(plus15, 0, "ROUNDUP")).toBe(2n);
  });

  it("HALF_UP は絶対値の 0.5 を繰り上げる", () => {
    expect(roundAtScale(ratio(1n, 2n), 0, "HALF_UP")).toBe(1n);
    expect(roundAtScale(ratio(-1n, 2n), 0, "HALF_UP")).toBe(-1n);
    expect(roundAtScale(ratio(4999n, 10000n), 0, "HALF_UP")).toBe(0n);
  });

  it("厳密な整数は丸めで動かない", () => {
    expect(roundAtScale(ratio(300n, 6n), 0, "ROUNDUP")).toBe(50n);
    expect(roundAtScale(ratio(-300n, 6n), 0, "ROUNDUP")).toBe(-50n);
  });
});

describe("丸め境界: 単価が循環小数かつ 単価×数量 が整数（ADR-005 の核心）", () => {
  it.for(ratioReference.boundary.map((c) => [c] as const))("%o", ([c]) => {
    const cost = ratio(BigInt(c.cost));
    const qty = ratio(BigInt(c.qty));
    const remainQty = sub(qty, ratio(BigInt(c.sold)));
    // ceil(cost × R / Q) を「厳密値に対する単一操作」として評価する（単価を先に確定させない）
    const remainExact = mul(cost, div(remainQty, qty));
    expect(remainExact.n.toString()).toBe(c.remainN);
    expect(remainExact.d.toString()).toBe(c.remainD);
    expect(roundAtScale(remainExact, 0, "ROUNDUP").toString()).toBe(c.remainRoundup);
  });

  it("簿価100・数量6から3単位売却 → 残高価額は 50 ちょうどで ROUNDUP しても 50", () => {
    const remain = mul(ratio(100n), div(ratio(3n), ratio(6n)));
    expect(eq(remain, ratio(50n))).toBe(true);
    expect(roundAtScale(remain, 0, "ROUNDUP")).toBe(50n);
  });

  // 「精度を上げても解決しない」ことの回帰ガード:
  // 単価を有効桁で先に確定（decimal.js の既定 = HALF_UP 相当）してから乗算すると、
  // 何桁にしても厳密な 50 を 51 に切り上げてしまう。
  it.for([
    [2],
    [20],
    [34],
    [50],
    [100],
  ] as const)("中間値を %i 桁で丸めてから乗算すると ROUNDUP が 51 になる（厳密値なら 50）", ([
    prec,
  ]) => {
    const unitExact = div(ratio(100n), ratio(6n)); // 16.666…
    const unitRounded = ratio(roundAtScale(unitExact, prec, "HALF_UP"), 10n ** BigInt(prec));
    const remainViaRoundedUnit = mul(unitRounded, ratio(3n));
    expect(roundAtScale(remainViaRoundedUnit, 0, "ROUNDUP")).toBe(51n); // 誤り
    expect(roundAtScale(mul(unitExact, ratio(3n)), 0, "ROUNDUP")).toBe(50n); // 正しい
  });
});

describe("toDecimalString / toYen: 境界のレンダリング規則（ADR-005）", () => {
  it("数量は scale 8・ROUNDDOWN", () => {
    expect(toDecimalString(ratio(1n, 3n), 8, "ROUNDDOWN")).toBe("0.33333333");
    expect(toDecimalString(ratio(13337n, 100000000n), 8, "ROUNDDOWN")).toBe("0.00013337");
  });

  it("手数料は scale 4（API の丸め桁・P-16）", () => {
    expect(toDecimalString(fromDecimalString("2.7182818") as never, 4, "HALF_UP")).toBe("2.7183");
    expect(toDecimalString(fromDecimalString("3.14159265") as never, 4, "HALF_UP")).toBe("3.1416");
  });

  it("金額は既定 scale 0・ROUNDDOWN（円未満切捨て）", () => {
    expect(toYen(ratio(1000n, 3n))).toBe(333n);
    expect(toDecimalString(ratio(1000n, 3n), 0, "ROUNDDOWN")).toBe("333");
  });

  it("負の参考損益は符号を保ったまま出す（v2 §9）", () => {
    expect(toDecimalString(fromDecimalString("-1.234567") as never, 0, "ROUNDDOWN")).toBe("-1");
    expect(toYen(fromDecimalString("-1.234567") as never)).toBe(-1n);
  });

  it("scale が値の桁数を上回ってもゼロ詰めで壊れない", () => {
    expect(toDecimalString(ratio(1n, 1000n), 8, "ROUNDDOWN")).toBe("0.00100000");
    expect(toDecimalString(ZERO, 4, "ROUNDUP")).toBe("0.0000");
  });
});

describe("移動平均法の合成: リファレンス突合（primitives の組み合わせ検証）", () => {
  const SEQ_FAQ = [
    ["buy", "4", "1845000"],
    ["buy", "2", "1650000"],
    ["sell", "2", "2400000"],
    ["buy", "0.5", "542800"],
    ["sell", "3", "2895000"],
  ] as const;
  const SEQ_UGLY = [
    ["buy", "6", "100"],
    ["sell", "3", "70"],
    ["buy", "0.00013337", "1433.7"],
    ["sell", "1.5", "55.5"],
    ["sell", "1.50013337", "60"],
  ] as const;

  function replay(seq: readonly (readonly [string, string, string])[], compat: boolean) {
    let qty = ZERO;
    let cost = ZERO;
    let cogs = ZERO;
    const steps: { qty: typeof ZERO; cost: typeof ZERO }[] = [];
    for (const [kind, q, v] of seq) {
      const rq = fromDecimalString(q) as never;
      const rv = fromDecimalString(v) as never;
      if (kind === "buy") {
        qty = add(qty, rq);
        cost = add(cost, rv);
      } else if (compat) {
        // NTA 互換: 売却の都度、残高価額を厳密値に対して 1 回 ROUNDUP（付録D.3）
        qty = sub(qty, rq);
        const next = ratio(roundAtScale(mul(cost, div(qty, add(qty, rq))), 0, "ROUNDUP"));
        cogs = add(cogs, sub(cost, next));
        cost = next;
      } else {
        const c = eq(qty, rq) ? cost : mul(cost, div(rq, qty)); // 全量処分は簿価を掃き出す（P-03）
        cogs = add(cogs, c);
        cost = sub(cost, c);
        qty = sub(qty, rq);
      }
      steps.push({ qty, cost });
    }
    return { steps, cogs };
  }

  it.for([
    ["faq", SEQ_FAQ, false],
    ["faqCompat", SEQ_FAQ, true],
    ["ugly", SEQ_UGLY, false],
    ["uglyCompat", SEQ_UGLY, true],
  ] as const)("%s の各ステップと年間 cogs が一致する", ([key, seq, compat]) => {
    const ref = ratioReference.movavg[key as keyof typeof ratioReference.movavg];
    const got = replay(seq, compat);
    got.steps.forEach((s, i) => {
      expect([s.qty.n.toString(), s.qty.d.toString()], `step ${i} qty`).toEqual([
        ref.steps[i].qtyN,
        ref.steps[i].qtyD,
      ]);
      expect([s.cost.n.toString(), s.cost.d.toString()], `step ${i} cost`).toEqual([
        ref.steps[i].costN,
        ref.steps[i].costD,
      ]);
    });
    expect([got.cogs.n.toString(), got.cogs.d.toString()]).toEqual([ref.cogsN, ref.cogsD]);
  });

  it("FAQ 2-4 の公式値（移動平均法 譲渡原価 3,080,200）を再現する", () => {
    expect(eq(replay(SEQ_FAQ, false).cogs, ratio(3080200n))).toBe(true);
    expect(eq(replay(SEQ_FAQ, true).cogs, ratio(3080200n))).toBe(true);
  });
});
