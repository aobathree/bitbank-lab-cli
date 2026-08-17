// 残高再構築実験: 全履歴から資産ごとの理論残高を再構築し /user/assets と突合する。
// 金額演算は BigInt の 10^18 スケール固定小数（float 不使用）。
// 仮説1: 出庫控除 = amount + fee / 仮説2: 出庫控除 = amount（fee 込み）
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { rawRoot } from "./fixtures-root.js";

const RAW_ROOT = rawRoot();
const batchDir = readdirSync(RAW_ROOT).filter((d) => d.startsWith("batch2-")).sort().at(-1);
if (!batchDir) throw new Error("batch2 dir not found");
const DIR = join(RAW_ROOT, batchDir);

// ---------- Decimal (BigInt, scale 18) ----------
const SCALE_DIGITS = 18;
const SCALE = 10n ** BigInt(SCALE_DIGITS);

function dec(s: string): bigint {
  if (!/^-?\d+(\.\d+)?$/.test(s)) throw new Error(`not a decimal string: ${JSON.stringify(s)}`);
  const neg = s.startsWith("-");
  const [i, f = ""] = (neg ? s.slice(1) : s).split(".");
  if (f.length > SCALE_DIGITS) throw new Error(`too many decimals: ${s}`);
  const v = BigInt(i) * SCALE + BigInt(f.padEnd(SCALE_DIGITS, "0"));
  return neg ? -v : v;
}

function mul(a: bigint, b: bigint): bigint {
  // 丸めずに正確な積を返せるか検査（履歴データでは amount×price は SCALE^2 内で正確）
  const p = a * b;
  if (p % SCALE !== 0n) {
    // 入力が 18 桁以内の有限小数同士なら積は 36 桁以内 → SCALE で割り切れないことはない
    // （割り切れない場合はスケール不足のバグ）
    throw new Error("mul overflow of scale");
  }
  return p / SCALE;
}

function fmt(v: bigint): string {
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const i = abs / SCALE;
  const f = (abs % SCALE).toString().padStart(SCALE_DIGITS, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${i}${f ? `.${f}` : ""}`;
}

// ---------- load ----------
function loadJson(name: string): any {
  const file = readdirSync(DIR).find((f) => f.startsWith(name));
  if (!file) throw new Error(`file not found: ${name}`);
  return JSON.parse(readFileSync(join(DIR, file), "utf8"));
}

function loadAll(prefix: string): any[] {
  return readdirSync(DIR)
    .filter((f) => f.startsWith(prefix))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(DIR, f), "utf8")));
}

// trades（全ページ、trade_id 重複排除）
const trades = new Map<number, any>();
for (const page of loadAll("user_spot_trade_history_page")) {
  for (const t of page.data.trades) trades.set(t.trade_id, t);
}

// deposits: asset 省略分（crypto）+ asset=jpy 明示分。uuid 重複排除
const deposits = new Map<string, any>();
for (const page of loadAll("user_deposit_history_page")) {
  for (const d of page.data.deposits) deposits.set(d.uuid, d);
}
for (const d of loadJson("user_deposit_history_jpy").data.deposits) deposits.set(d.uuid, d);

// withdrawals: 資産別ファイル全部。uuid 重複排除
const withdrawals = new Map<string, any>();
for (const f of readdirSync(DIR).filter((f) => f.startsWith("user_withdrawal_history_"))) {
  const body = JSON.parse(readFileSync(join(DIR, f), "utf8"));
  for (const w of body.data.withdrawals) withdrawals.set(w.uuid, w);
}

const assets: any[] = loadJson("user_assets").data.assets;
const marginStatus = loadJson("user_margin_status").data;

// ---------- reconstruct ----------
type Acc = {
  tradeFlow: bigint; // 現物約定による増減（fee 込み）
  depositSum: bigint;
  wdAmountSum: bigint; // DONE のみ
  wdFeeSum: bigint; // DONE のみ
  marginPl: bigint; // 信用 profit_loss（quote のみ）
  marginFee: bigint; // 参考: 信用行の fee_amount_quote 合計
  marginInterest: bigint; // 参考: 信用行の interest 合計
};
const acc = new Map<string, Acc>();
const get = (asset: string): Acc => {
  let a = acc.get(asset);
  if (!a) {
    a = {
      tradeFlow: 0n,
      depositSum: 0n,
      wdAmountSum: 0n,
      wdFeeSum: 0n,
      marginPl: 0n,
      marginFee: 0n,
      marginInterest: 0n,
    };
    acc.set(asset, a);
  }
  return a;
};

let spotRows = 0;
let marginRows = 0;
for (const t of trades.values()) {
  const [base, quote] = (t.pair as string).split("_");
  const amount = dec(t.amount);
  const price = dec(t.price);
  const notional = mul(amount, price);
  if (t.position_side !== undefined && t.position_side !== null) {
    // 信用: 資産残高（base）には触れない。JPY へは profit_loss のみ（fee/interest は
    // profit_loss にネット済み — batch1 検算より。二重計上しない）
    marginRows++;
    const q = get(quote);
    q.marginPl += dec(t.profit_loss ?? "0");
    q.marginFee += dec(t.fee_amount_quote);
    q.marginInterest += dec(t.interest ?? "0");
    continue;
  }
  spotRows++;
  const b = get(base);
  const q = get(quote);
  if (t.side === "buy") {
    b.tradeFlow += amount;
    q.tradeFlow -= notional;
  } else if (t.side === "sell") {
    b.tradeFlow -= amount;
    q.tradeFlow += notional;
  } else {
    throw new Error(`unknown side: ${t.side}`);
  }
  // 手数料: 負値（メイカーリベート）は符号そのままで自然に加算
  b.tradeFlow -= dec(t.fee_amount_base);
  q.tradeFlow -= dec(t.fee_amount_quote);
}

for (const d of deposits.values()) {
  if (d.status !== "DONE") continue;
  get(d.asset).depositSum += dec(d.amount);
}

let canceledWd = 0;
for (const w of withdrawals.values()) {
  if (w.status !== "DONE") {
    canceledWd++;
    continue;
  }
  const a = get(w.asset);
  a.wdAmountSum += dec(w.amount);
  a.wdFeeSum += dec(w.fee);
}

// ---------- reconcile vs assets ----------
// シンボル改称: 実残高は旧+新の合算と比較（履歴は旧シンボルのみのため）
const ALIAS: Record<string, string> = { pol: "matic", render: "rndr" };
const actual = new Map<string, bigint>();
const precision = new Map<string, number>();
for (const a of assets) {
  const canon = ALIAS[a.asset] ?? a.asset;
  actual.set(canon, (actual.get(canon) ?? 0n) + dec(a.onhand_amount) + dec(a.withdrawing_amount));
  const p = Math.min(precision.get(canon) ?? 99, a.amount_precision);
  precision.set(canon, p === 99 ? a.amount_precision : p);
}

console.log(`rows: spot=${spotRows} margin=${marginRows} deposits=${deposits.size} withdrawals=${withdrawals.size} (canceled=${canceledWd})`);
console.log("");

const lines: string[] = [];
lines.push(
  "| asset | 現物取引フロー | 入庫計 | 出庫amount計 | 出庫fee計 | 信用PL | 理論H1(amount+fee) | 理論H2(amountのみ) | assets実残高 | 残差H1(実-H1) | 残差H2(実-H2) |",
);
lines.push("|---|---|---|---|---|---|---|---|---|---|---|");

const names = new Set<string>([...acc.keys(), ...actual.keys()]);
for (const name of [...names].sort()) {
  const a = acc.get(name) ?? get(`__zero_${name}`);
  const act = actual.get(name) ?? 0n;
  const common = a.tradeFlow + a.depositSum + a.marginPl - a.wdAmountSum;
  const h1 = common - a.wdFeeSum;
  const h2 = common;
  const r1 = act - h1;
  const r2 = act - h2;
  const hasActivity =
    a.tradeFlow !== 0n || a.depositSum !== 0n || a.wdAmountSum !== 0n || a.marginPl !== 0n || act !== 0n;
  if (!hasActivity) continue;
  lines.push(
    `| ${name} | ${fmt(a.tradeFlow)} | ${fmt(a.depositSum)} | ${fmt(a.wdAmountSum)} | ${fmt(a.wdFeeSum)} | ${fmt(a.marginPl)} | ${fmt(h1)} | ${fmt(h2)} | ${fmt(act)} | ${fmt(r1)} | ${fmt(r2)} |`,
  );
}
console.log(lines.join("\n"));
console.log("");
console.log(`margin ref: total_margin_balance=${marginStatus.total_margin_balance} marginPl(jpy)=${fmt(get("jpy").marginPl)} marginFee=${fmt(get("jpy").marginFee)} marginInterest=${fmt(get("jpy").marginInterest)}`);
console.log(`batch dir: ${batchDir}`);
