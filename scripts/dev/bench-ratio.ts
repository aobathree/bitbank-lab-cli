// 有理数エンジンの性能・分母肥大の計測（ADR-005 の性能条件）。開発用スクリプト。
//   npx tsx scripts/dev/bench-ratio.ts [件数]
// 移動平均法で計測する（売却のたびに分母が数量を取り込むため総平均法より重い）。
// 注意: 実データ（fixtures/）が無いため合成データ。丸い数値は gcd 約分が効きすぎて
// 楽観的になるので、worst-case（8 桁のバラバラな数量）と realistic（実取引に近い
// 定型ロット）の 2 変種で挟む。実データでの確定値は fixtures 投入後に再計測する。
import { add, denominatorBits, div, eq, mul, ratio, sub, ZERO } from "../../cli/tax/ratio.js";
import { roundAtScale } from "../../cli/tax/ratio-decimal.js";

type Ev = { buy: boolean; q: ReturnType<typeof ratio>; v: ReturnType<typeof ratio> };

// 決定論的な擬似乱数（xorshift32）。Math.random は使わない
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 0x100000000;
  };
}

/** worst-case: 数量が 8 桁バラバラ（約分が効かない）。realistic: 定型ロットの反復 */
function gen(n: number, kind: "worst" | "realistic"): Ev[] {
  const r = rng(20260725);
  const LOTS = [1000n, 10000n, 100000n, 50000n]; // 1e-8 単位: 0.00001〜0.001
  const out: Ev[] = [];
  let held = 0n; // 保有数量（1e-8 単位）。保有を超える売却は実際には起き得ない
  for (let i = 0; i < n; i++) {
    let buy = i === 0 || r() < 0.6;
    let qUnits =
      kind === "worst"
        ? BigInt(Math.floor(r() * 9_000_000) + 1_000_000) // 0.01〜0.1 の 8 桁バラバラ
        : LOTS[Math.floor(r() * LOTS.length)];
    const price = BigInt(Math.floor(r() * 4_000_000) + 8_000_000); // 800万〜1200万円
    // 台帳として成立しない系列（残高が負）を計測すると分母肥大の測定値が実態から外れる
    if (!buy && held === 0n) buy = true;
    if (!buy && qUnits > held) qUnits = held;
    held = buy ? held + qUnits : held - qUnits;
    out.push({
      buy,
      q: ratio(qUnits, 100_000_000n),
      v: ratio(qUnits * price, 100_000_000n),
    });
  }
  return out;
}

/** 移動平均法。compat=true は売却の都度 残高価額を厳密値に 1 回 ROUNDUP（付録D.3） */
function run(evs: Ev[], compat: boolean, budgetMs: number) {
  let qty = ZERO;
  let cost = ZERO;
  let cogs = ZERO;
  let maxBits = 1;
  let disposals = 0;
  const t0 = performance.now();
  const marks: { i: number; ms: number; bits: number }[] = [];
  for (let i = 0; i < evs.length; i++) {
    const e = evs[i];
    if (e.buy) {
      qty = add(qty, e.q);
      cost = add(cost, e.v);
    } else {
      if (eq(qty, ZERO)) continue; // 数量ゼロ時は engine 側が保留に回す（ここでは発生しない）
      const q = e.q;
      disposals++;
      if (compat) {
        qty = sub(qty, q);
        const next = ratio(roundAtScale(mul(cost, div(qty, add(qty, q))), 0, "ROUNDUP"));
        cogs = add(cogs, sub(cost, next));
        cost = next;
      } else {
        const c = eq(qty, q) ? cost : mul(cost, div(q, qty));
        cogs = add(cogs, c);
        cost = sub(cost, c);
        qty = sub(qty, q);
      }
    }
    const bits = Math.max(denominatorBits(cost), denominatorBits(qty));
    if (bits > maxBits) maxBits = bits;
    if (i === 999 || i === 9_999 || i === 49_999 || i === evs.length - 1) {
      marks.push({ i: i + 1, ms: Math.round(performance.now() - t0), bits });
    }
    if (performance.now() - t0 > budgetMs) {
      marks.push({ i: i + 1, ms: Math.round(performance.now() - t0), bits });
      return { aborted: true, disposals, maxBits, marks, finalBits: bits };
    }
  }
  return {
    aborted: false,
    disposals,
    maxBits,
    marks,
    finalBits: Math.max(denominatorBits(cost), denominatorBits(qty)),
  };
}

const N = Number(process.argv[2] ?? 100_000);
if (!Number.isInteger(N) || N <= 0) {
  // 不正値で「ok 0ms」と出ると計測できたと誤解するため、ここで止める
  console.error(`件数は正の整数で指定してください（received: ${process.argv[2]}）`);
  process.exit(1);
}
const BUDGET_MS = 60_000;
for (const kind of ["realistic", "worst"] as const) {
  const evs = gen(N, kind);
  for (const compat of [false, true]) {
    const label = `${kind.padEnd(9)} / ${compat ? "compat  " : "default "}`;
    const t = performance.now();
    const r = run(evs, compat, BUDGET_MS);
    const ms = Math.round(performance.now() - t);
    const status = r.aborted ? `ABORTED@${r.marks.at(-1)?.i}` : "ok";
    console.log(
      `${label} n=${N} ${status} ${ms}ms disposals=${r.disposals} maxDenBits=${r.maxBits} finalDenBits=${r.finalBits}`,
    );
    console.log(`  marks: ${r.marks.map((m) => `${m.i}:${m.ms}ms/${m.bits}bit`).join("  ")}`);
  }
}
