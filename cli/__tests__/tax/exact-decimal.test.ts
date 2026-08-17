// toExactDecimalString: **丸めずに**十進へ落とせるときだけ文字列を返す。
// 約定代金（数量×価格）はここを通るので、丸めが混入しないことを固定する。
import { describe, expect, it } from "vitest";
import { div, mul, ratio } from "../../tax/ratio.js";
import { fromDecimalString, toExactDecimalString } from "../../tax/ratio-decimal.js";

const dec = (s: string) =>
  fromDecimalString(s) as NonNullable<ReturnType<typeof fromDecimalString>>;

describe("toExactDecimalString", () => {
  it("有限小数はそのまま返す", () => {
    expect(toExactDecimalString(dec("0"))).toBe("0");
    expect(toExactDecimalString(dec("-1.0005"))).toBe("-1.0005");
    expect(toExactDecimalString(dec("15000000"))).toBe("15000000");
  });

  it("有限小数同士の積は必ず厳密に表せる（約定代金の経路）", () => {
    expect(toExactDecimalString(mul(dec("0.00000001"), dec("15000000")))).toBe("0.15");
    // 12345678 × 12345678 = 152415765279684、小数は 8 桁 + 4 桁 = 12 桁
    expect(toExactDecimalString(mul(dec("0.12345678"), dec("1234.5678")))).toBe("152.415765279684");
  });

  it("分母に 2・5 以外の素因数が残る値は null（丸め位置を呼び出し側に強制する）", () => {
    expect(toExactDecimalString(div(dec("100"), dec("3")))).toBeNull();
    expect(toExactDecimalString(ratio(1n, 7n))).toBeNull();
  });

  it("約分後に 2^a·5^b になる値は厳密に表せる", () => {
    // 3/6 = 1/2
    expect(toExactDecimalString(div(dec("3"), dec("6")))).toBe("0.5");
  });

  it("float を経由しない（IEEE754 では表せない桁も保持する）", () => {
    const s = "0.1234567890123456789";
    expect(toExactDecimalString(dec(s))).toBe(s);
    expect(Number(s).toString()).not.toBe(s); // float なら落ちる桁
  });
});
