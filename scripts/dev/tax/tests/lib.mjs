// fixtures 読み込み・Decimal・スナップショット構築の共有ロジック（依存なし）
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// 実データは repo に置かない（docs/dev/tax-fixtures-plan.md）。場所は環境変数で与える。
export const ENV_VAR = "BITBANK_TAX_FIXTURES";
export const FIXTURES_ROOT = process.env[ENV_VAR];
export const RAW_ROOT = FIXTURES_ROOT ? join(FIXTURES_ROOT, "raw") : null;

export function requireRawRoot() {
  if (!RAW_ROOT) {
    throw new Error(`${ENV_VAR} が未設定です（raw/ を含む fixtures ディレクトリを指定）`);
  }
  return RAW_ROOT;
}

export function batchDirs() {
  return readdirSync(requireRawRoot())
    .filter((d) => d.startsWith("batch"))
    .sort();
}

export function filesIn(batch, prefix) {
  const dir = join(requireRawRoot(), batch);
  return readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith(".json"))
    .sort()
    .map((f) => ({ name: f, body: JSON.parse(readFileSync(join(dir, f), "utf8")) }));
}

// ---- Decimal（BigInt scale 18。float 不使用） ----
export const SCALE_DIGITS = 18;
export const SCALE = 10n ** BigInt(SCALE_DIGITS);

export function dec(s) {
  if (typeof s !== "string" || !/^-?\d+(\.\d+)?$/.test(s)) {
    throw new Error(`not a decimal string: ${JSON.stringify(s)}`);
  }
  const neg = s.startsWith("-");
  const [i, f = ""] = (neg ? s.slice(1) : s).split(".");
  const v = BigInt(i) * SCALE + BigInt(f.padEnd(SCALE_DIGITS, "0").slice(0, SCALE_DIGITS));
  return neg ? -v : v;
}

export function mul(a, b) {
  return (a * b) / SCALE;
}

export function absBig(v) {
  return v < 0n ? -v : v;
}

// ---- endpoint ごとの行ロード（batch 内で dedup） ----
export function loadBatch(batch) {
  const trades = new Map();
  for (const { body } of filesIn(batch, "user_spot_trade_history_page")) {
    for (const t of body.data.trades) trades.set(t.trade_id, t);
  }
  const deposits = new Map();
  for (const { body } of filesIn(batch, "user_deposit_history_")) {
    for (const d of body.data.deposits) deposits.set(d.uuid, d);
  }
  const withdrawals = new Map();
  for (const { body } of filesIn(batch, "user_withdrawal_history_")) {
    for (const w of body.data.withdrawals) withdrawals.set(w.uuid, w);
  }
  const single = {};
  for (const prefix of ["user_margin_status", "user_margin_positions", "user_assets", "spot_pairs"]) {
    const fs = filesIn(batch, prefix);
    if (fs.length > 0) single[prefix] = fs[0].body.data;
  }
  return { trades, deposits, withdrawals, single };
}

// ---- 型スナップショット: dot-path → 観測型集合 + 出現数 ----
function typeOf(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v; // string / number / boolean / object
}

export function walkTypes(rows, fields = new Map(), prefix = "") {
  for (const row of rows) {
    for (const [k, v] of Object.entries(row)) {
      const path = prefix ? `${prefix}.${k}` : k;
      let e = fields.get(path);
      if (!e) {
        e = { types: new Set(), present: 0 };
        fields.set(path, e);
      }
      e.types.add(typeOf(v));
      e.present++;
      if (Array.isArray(v)) {
        walkTypes(
          v.filter((x) => x !== null && typeof x === "object" && !Array.isArray(x)),
          fields,
          `${path}[]`,
        );
      } else if (v !== null && typeof v === "object") {
        walkTypes([v], fields, path);
      }
    }
  }
  return fields;
}

export function fieldsToObject(fields, totalRows) {
  const out = {};
  for (const path of [...fields.keys()].sort()) {
    const e = fields.get(path);
    // 絶対件数は出さない（口座規模の情報になるため。docs/dev/tax-fixtures-plan.md）。
    // スキーマ検出の目的は「そのフィールドが常に存在するか」なので区分で足りる。
    // 分母: ネストしたパスは親の出現数、トップレベルは行総数。
    const dot = path.lastIndexOf(".");
    const parent = dot === -1 ? null : path.slice(0, dot);
    const denom = parent !== null && fields.has(parent) ? fields.get(parent).present : totalRows;
    out[path] = {
      types: [...e.types].sort(),
      present: denom !== undefined && e.present < denom ? "partial" : "always",
    };
  }
  return out;
}

// ---- スナップショット本体（決定的に生成: 時刻は最新バッチ名から取る） ----
export function buildSnapshot() {
  const batches = batchDirs();
  const fieldMaps = {
    "user_spot_trade_history.trades[]": new Map(),
    "user_deposit_history.deposits[]": new Map(),
    "user_withdrawal_history.withdrawals[]": new Map(),
    "user_margin_status": new Map(),
    "user_margin_positions": new Map(),
    "user_assets.assets[]": new Map(),
    "spot_pairs.pairs[]": new Map(),
  };
  const rowTotals = {};
  for (const batch of batches) {
    const { trades, deposits, withdrawals, single } = loadBatch(batch);
    walkTypes([...trades.values()], fieldMaps["user_spot_trade_history.trades[]"]);
    walkTypes([...deposits.values()], fieldMaps["user_deposit_history.deposits[]"]);
    walkTypes([...withdrawals.values()], fieldMaps["user_withdrawal_history.withdrawals[]"]);
    rowTotals["user_spot_trade_history.trades[]"] =
      (rowTotals["user_spot_trade_history.trades[]"] ?? 0) + trades.size;
    rowTotals["user_deposit_history.deposits[]"] =
      (rowTotals["user_deposit_history.deposits[]"] ?? 0) + deposits.size;
    rowTotals["user_withdrawal_history.withdrawals[]"] =
      (rowTotals["user_withdrawal_history.withdrawals[]"] ?? 0) + withdrawals.size;
    if (single.user_margin_status) {
      walkTypes([single.user_margin_status], fieldMaps.user_margin_status);
      rowTotals.user_margin_status = (rowTotals.user_margin_status ?? 0) + 1;
    }
    if (single.user_margin_positions) {
      walkTypes([single.user_margin_positions], fieldMaps.user_margin_positions);
      rowTotals.user_margin_positions = (rowTotals.user_margin_positions ?? 0) + 1;
    }
    if (single.user_assets) {
      walkTypes(single.user_assets.assets, fieldMaps["user_assets.assets[]"]);
      rowTotals["user_assets.assets[]"] =
        (rowTotals["user_assets.assets[]"] ?? 0) + single.user_assets.assets.length;
    }
    if (single.spot_pairs) {
      walkTypes(single.spot_pairs.pairs, fieldMaps["spot_pairs.pairs[]"]);
      rowTotals["spot_pairs.pairs[]"] =
        (rowTotals["spot_pairs.pairs[]"] ?? 0) + single.spot_pairs.pairs.length;
    }
  }
  const endpoints = {};
  for (const [name, m] of Object.entries(fieldMaps)) {
    endpoints[name] = fieldsToObject(m, rowTotals[name]);
  }
  return {
    note:
      "raw/ フィクスチャの型スナップショット（API 仕様変更の検出用）。" +
      "present は always / partial の区分のみ（絶対件数は口座規模の情報になるため出さない）。" +
      "識別子はマスク済みのため destination_tag は生の number がマスキングで string 化されている。" +
      "types はマスク後フィクスチャの観測値。",
    generated_from_batches: batches,
    endpoints,
  };
}
