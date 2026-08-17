// 税務計算の内部数値表現（ADR-005）。厳密有理数 { n, d }（常に既約・d > 0）。
// **このモジュールは一切丸めない**。丸めは ratio-decimal.ts の roundAtScale だけが行う
// （設計原則: 丸めは厳密値に対して 1 回だけ。丸め済みの中間値に再度丸めない）。
// 汎用の数値タワーは作らない — 税務エンジンが必要とする演算だけを置く。

export type Ratio = { readonly n: bigint; readonly d: bigint };

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x;
}

/** 既約形に正規化する。d の符号は n 側へ寄せ、d > 0 を保つ。 */
export function ratio(n: bigint, d: bigint = 1n): Ratio {
  if (d === 0n) throw new RangeError("ratio: denominator must not be zero");
  let nn = n;
  let dd = d;
  if (dd < 0n) {
    nn = -nn;
    dd = -dd;
  }
  if (nn === 0n) return { n: 0n, d: 1n };
  const g = gcd(nn, dd);
  return { n: nn / g, d: dd / g };
}

export const ZERO: Ratio = { n: 0n, d: 1n };

export function fromBigint(n: bigint): Ratio {
  return { n, d: 1n };
}

export function add(a: Ratio, b: Ratio): Ratio {
  return ratio(a.n * b.d + b.n * a.d, a.d * b.d);
}

export function sub(a: Ratio, b: Ratio): Ratio {
  return ratio(a.n * b.d - b.n * a.d, a.d * b.d);
}

export function mul(a: Ratio, b: Ratio): Ratio {
  return ratio(a.n * b.n, a.d * b.d);
}

/** b == 0 は呼び出し側で除外する（数量ゼロ時の単価計算は engine 側が分岐する）。 */
export function div(a: Ratio, b: Ratio): Ratio {
  if (b.n === 0n) throw new RangeError("div: division by zero");
  return ratio(a.n * b.d, a.d * b.n);
}

export function neg(a: Ratio): Ratio {
  return { n: -a.n, d: a.d };
}

/** 絶対値。残高突合・報告書突合が差の大きさを閾値と比べるのに使う（丸めは伴わない）。 */
export function abs(a: Ratio): Ratio {
  return isNegative(a) ? sub(ZERO, a) : a;
}

export function cmp(a: Ratio, b: Ratio): -1 | 0 | 1 {
  const l = a.n * b.d;
  const r = b.n * a.d;
  return l < r ? -1 : l > r ? 1 : 0;
}

export function eq(a: Ratio, b: Ratio): boolean {
  // 既約・d > 0 が保証されているので成分比較で足りる
  return a.n === b.n && a.d === b.d;
}

export function isZero(a: Ratio): boolean {
  return a.n === 0n;
}

export function isNegative(a: Ratio): boolean {
  return a.n < 0n;
}

export function isInteger(a: Ratio): boolean {
  return a.d === 1n;
}

/** 集計（Σ取得価額・Σ譲渡原価 等）で頻出するため専用に置く。 */
export function sum(xs: readonly Ratio[]): Ratio {
  let acc = ZERO;
  for (const x of xs) acc = add(acc, x);
  return acc;
}

/** 分母の bit 長。ベンチマークで肥大を監視するために公開する（ADR-005 の性能条件）。 */
export function denominatorBits(a: Ratio): number {
  return a.d === 1n ? 1 : a.d.toString(2).length;
}
