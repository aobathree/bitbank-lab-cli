// 有理数（ratio.ts）と十進文字列の境界。**丸めが起きる唯一の場所**（ADR-005）。
// 設計原則: 丸めは厳密値に対して 1 回だけ適用し、丸め済みの中間値に再度丸めを適用しない。
// エンジン内部は Ratio のまま非丸めで持ち回り、出力・互換モードでだけここを通す。
import { type Ratio, ratio } from "./ratio.js";

/** Excel 準拠の丸めモード。非負値では ROUNDDOWN=floor / ROUNDUP=ceil と一致するが、
 *  負値では挙動が異なるため（ゼロ方向 / ゼロから離れる方向）明示的に分ける。 */
export type RoundMode = "ROUNDDOWN" | "ROUNDUP" | "HALF_UP";

const DECIMAL_RE = /^-?\d+(\.\d+)?$/;

function pow10(scale: number): bigint {
  return 10n ** BigInt(scale);
}

/**
 * 十進文字列を厳密な有理数へ。**float を一切経由しない**（Number() を使わない）。
 * 不正形式は null（呼び出し側が Result へ変換する。ここでは throw しない）。
 */
export function fromDecimalString(s: string): Ratio | null {
  if (!DECIMAL_RE.test(s)) return null;
  const neg = s.startsWith("-");
  const body = neg ? s.slice(1) : s;
  const dot = body.indexOf(".");
  const digits = dot === -1 ? body : body.slice(0, dot) + body.slice(dot + 1);
  const fracLen = dot === -1 ? 0 : body.length - dot - 1;
  const n = BigInt(digits);
  return ratio(neg ? -n : n, pow10(fracLen));
}

/**
 * 厳密値 r を 10^scale 倍した整数へ、指定モードで**一度だけ**丸める。
 * 返り値は「scale 桁で表した整数」（例: r=1/3, scale=2, ROUNDUP → 34n）。
 * 丸め判定は分子・分母の整数演算のみで行うため、境界値でも誤らない
 * （例: (100/6)×3 は厳密に 50 なので ROUNDUP でも 50 のまま）。
 */
export function roundAtScale(r: Ratio, scale: number, mode: RoundMode): bigint {
  const num = r.n * pow10(scale);
  const den = r.d;
  const q = num / den; // BigInt 除算はゼロ方向切捨て
  const rem = num % den; // 符号は num に従う
  if (rem === 0n) return q;
  const sign = num < 0n ? -1n : 1n;
  if (mode === "ROUNDDOWN") return q; // ゼロ方向（切捨て）
  if (mode === "ROUNDUP") return q + sign; // ゼロから離れる方向（切上げ）
  // HALF_UP: |rem| * 2 >= |den| で絶対値を繰り上げる
  const absRem = rem < 0n ? -rem : rem;
  return absRem * 2n >= den ? q + sign : q;
}

/** roundAtScale の結果を十進文字列へ整形する。scale 桁を必ず出す（0 は整数表記）。 */
export function toDecimalString(r: Ratio, scale: number, mode: RoundMode): string {
  const scaled = roundAtScale(r, scale, mode);
  const neg = scaled < 0n;
  const abs = (neg ? -scaled : scaled).toString().padStart(scale + 1, "0");
  const sign = neg ? "-" : "";
  if (scale === 0) return sign + abs;
  const int = abs.slice(0, abs.length - scale);
  const frac = abs.slice(abs.length - scale);
  return `${sign}${int}.${frac}`;
}

/** 円未満を切り捨てた整数円（表示・集計の既定）。内部値は別途 Ratio で保持する。 */
export function toYen(r: Ratio, mode: RoundMode = "ROUNDDOWN"): bigint {
  return roundAtScale(r, 0, mode);
}

/**
 * 厳密に十進表現できるときだけ、**丸めずに**十進文字列へ。できなければ null。
 * 有限小数になるのは分母が 2^a·5^b のときに限る。約定代金（数量×価格）のように
 * 有限小数同士の積は必ずここを通るので、正規化イベントの金額欄は無損失で書ける。
 * 割り切れない値（平均単価など）は null が返るので、呼び出し側で丸め位置を明示する。
 */
export function toExactDecimalString(r: Ratio): string | null {
  let d = r.d;
  let twos = 0;
  let fives = 0;
  while (d % 2n === 0n) {
    d /= 2n;
    twos++;
  }
  while (d % 5n === 0n) {
    d /= 5n;
    fives++;
  }
  if (d !== 1n) return null;
  // この scale なら r × 10^scale が整数になるため roundAtScale は丸めを行わない
  return toDecimalString(r, Math.max(twos, fives), "ROUNDDOWN");
}
