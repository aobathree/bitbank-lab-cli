import { describe, expect, it } from "vitest";
import {
  add,
  cmp,
  denominatorBits,
  div,
  eq,
  isInteger,
  isNegative,
  isZero,
  mul,
  neg,
  ratio,
  sub,
  sum,
  ZERO,
} from "../../tax/ratio.js";
import { fromDecimalString } from "../../tax/ratio-decimal.js";
import { ratioReference } from "../__fixtures__/tax/ratio-reference.js";

// 期待値は Python fractions.Fraction による独立リファレンス（ADR-005）。
// 生成: python3 scripts/dev/gen-ratio-reference.py
const OPS = { add, sub, mul, div } as const;

function parse(s: string) {
  const r = fromDecimalString(s);
  if (r === null) throw new Error(`fixture has invalid decimal: ${s}`);
  return r;
}

describe("Ratio: 正規化", () => {
  it("既約形に約分する", () => {
    expect(ratio(50n, 100n)).toEqual({ n: 1n, d: 2n });
    expect(ratio(300n, 6n)).toEqual({ n: 50n, d: 1n });
  });

  it("符号を分子へ寄せ d > 0 を保つ", () => {
    expect(ratio(1n, -3n)).toEqual({ n: -1n, d: 3n });
    expect(ratio(-1n, -3n)).toEqual({ n: 1n, d: 3n });
  });

  it("ゼロは 0/1 に正規化する", () => {
    expect(ratio(0n, 7n)).toEqual(ZERO);
  });

  it("分母ゼロは不変条件違反として拒否する（ユーザー入力経路では到達しない）", () => {
    expect(() => ratio(1n, 0n)).toThrow(RangeError);
    expect(() => div(ratio(1n), ZERO)).toThrow(RangeError);
  });
});

describe("Ratio: リファレンス突合（四則）", () => {
  // フィクスチャは [op, a, b, expectedN, expectedD]
  it.for(ratioReference.arith)("%s(%s, %s)", ([op, a, b, expN, expD]) => {
    const got = OPS[op as keyof typeof OPS](parse(a), parse(b));
    expect(got.n.toString()).toBe(expN);
    expect(got.d.toString()).toBe(expD);
  });
});

describe("Ratio: 代数的性質（厳密性の確認）", () => {
  const xs = ["0.00013337", "123.456789012", "-1.234567", "999999999.99999999", "0.1", "3"];

  it("(a + b) - b == a が厳密に成立する（float なら崩れる）", () => {
    for (const a of xs) {
      for (const b of xs) {
        const ra = parse(a);
        const rb = parse(b);
        expect(eq(sub(add(ra, rb), rb), ra)).toBe(true);
      }
    }
  });

  it("(a / b) * b == a が厳密に成立する", () => {
    for (const a of xs) {
      for (const b of xs) {
        const ra = parse(a);
        const rb = parse(b);
        if (isZero(rb)) continue;
        expect(eq(mul(div(ra, rb), rb), ra)).toBe(true);
      }
    }
  });

  it("0.1 + 0.2 == 0.3（IEEE754 では成立しない）", () => {
    expect(eq(add(parse("0.1"), parse("0.2")), parse("0.3"))).toBe(true);
    expect(0.1 + 0.2 === 0.3).toBe(false); // 対比: JS number では偽
  });

  it("sum は加算の畳み込みと一致する", () => {
    const rs = xs.map(parse);
    expect(eq(sum(rs), rs.reduce(add, ZERO))).toBe(true);
    expect(eq(sum([]), ZERO)).toBe(true);
  });
});

describe("Ratio: 述語・比較", () => {
  it("cmp は大小を返す", () => {
    expect(cmp(parse("1"), parse("2"))).toBe(-1);
    expect(cmp(parse("2"), parse("1"))).toBe(1);
    expect(cmp(parse("2"), parse("2.0"))).toBe(0);
    // 分母が異なる循環小数同士（1/3 < 1/2）
    expect(cmp(ratio(1n, 3n), ratio(1n, 2n))).toBe(-1);
  });

  it("isZero / isNegative / isInteger", () => {
    expect(isZero(ZERO)).toBe(true);
    expect(isNegative(parse("-0.0001"))).toBe(true);
    expect(isNegative(ZERO)).toBe(false);
    expect(isInteger(ratio(300n, 6n))).toBe(true);
    expect(isInteger(ratio(1n, 3n))).toBe(false);
  });

  it("neg は符号を反転する", () => {
    expect(eq(neg(parse("1.5")), parse("-1.5"))).toBe(true);
  });

  it("denominatorBits は分母の bit 長を返す（分母肥大の監視用）", () => {
    expect(denominatorBits(ratio(1n, 1n))).toBe(1);
    expect(denominatorBits(ratio(1n, 8n))).toBe(4); // 0b1000
  });
});
