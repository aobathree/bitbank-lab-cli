// fixtures のテスト資産化: 実行は `node --test tests/`（依存なし・node:test）
// (1) dedup 件数一致 (2) 現物 fee 同値 (3) 信用 profit_loss 検算 (4) 型スナップショット照合
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { absBig, batchDirs, buildSnapshot, dec, filesIn, loadBatch, mul, SCALE } from "./lib.mjs";

const SNAPSHOT_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../cli/__tests__/tax/fixtures-regression/SCHEMA_SNAPSHOT.json",
);
const TOLERANCE = dec("0.001"); // 検算許容誤差（円）

// 件数の「固定」は SCHEMA_SNAPSHOT の絶対件数ではなく **fixture の SHA-256**（manifest）が担う。
// 絶対件数は口座規模の情報になるため成果物に置かない（docs/dev/tax-fixtures-plan.md）。
// ここでは件数に依存しない構造的不変条件だけを検査する。
test("(1) ページ内に重複がなく、ページ間の重複は隣接ページの境界にのみ現れる", () => {
  for (const batch of batchDirs()) {
    for (const { name, body } of filesIn(batch, "user_spot_trade_history_page")) {
      const ids = body.data.trades.map((t) => t.trade_id);
      assert.equal(new Set(ids).size, ids.length, `${batch}/${name}: page 内に trade_id 重複`);
    }
    for (const { name, body } of filesIn(batch, "user_deposit_history_")) {
      const ids = body.data.deposits.map((d) => d.uuid);
      assert.equal(new Set(ids).size, ids.length, `${batch}/${name}: page 内に uuid 重複`);
    }
    // ページ間: 重複は「隣接ページ間」にしか出ないこと（タイムスタンプカーソル由来の境界重複）
    const pages = filesIn(batch, "user_spot_trade_history_page").map(
      ({ body }) => new Set(body.data.trades.map((t) => t.trade_id)),
    );
    for (let i = 0; i < pages.length; i++) {
      for (let j = i + 2; j < pages.length; j++) {
        const overlap = [...pages[i]].filter((id) => pages[j].has(id));
        assert.equal(overlap.length, 0, `${batch}: 非隣接ページ ${i}/${j} が重複 ${overlap.slice(0, 3)}`);
      }
    }
    // dedup が冪等（同じ入力を 2 回読んでも同じ集合）
    const a = loadBatch(batch);
    const b2 = loadBatch(batch);
    assert.equal(a.trades.size, b2.trades.size, `${batch}: dedup が非決定的`);
  }
});

test("(2) 現物全行で fee_amount_quote == fee_occurred_amount_quote（数値同値）", () => {
  for (const batch of batchDirs()) {
    const { trades } = loadBatch(batch);
    for (const t of trades.values()) {
      if (t.position_side !== undefined && t.position_side !== null) continue; // 信用行は対象外
      assert.equal(
        dec(t.fee_amount_quote),
        dec(t.fee_occurred_amount_quote),
        `${batch} trade_id=${t.trade_id}: 現物で fee_amount_quote != fee_occurred_amount_quote`,
      );
    }
  }
});

test("(3) 信用決済行の profit_loss 検算（全量決済のみ、許容誤差 0.001 円）", () => {
  let closesChecked = 0;
  for (const batch of batchDirs()) {
    const { trades } = loadBatch(batch);
    const margin = [...trades.values()]
      .filter((t) => t.position_side !== undefined && t.position_side !== null)
      .sort((a, b) => a.executed_at - b.executed_at);
    // (pair, position_side) ごとに建て→決済を積み上げ
    const open = new Map(); // key -> {amount, notional}
    for (const t of margin) {
      const key = `${t.pair}:${t.position_side}`;
      const amount = dec(t.amount);
      const notional = mul(amount, dec(t.price));
      const isOpen =
        (t.position_side === "long" && t.side === "buy") ||
        (t.position_side === "short" && t.side === "sell");
      if (isOpen) {
        const o = open.get(key) ?? { amount: 0n, notional: 0n };
        o.amount += amount;
        o.notional += notional;
        open.set(key, o);
        continue;
      }
      const o = open.get(key);
      assert.ok(o, `${batch} trade_id=${t.trade_id}: 建て行なしで決済行が出現`);
      if (o.amount !== amount) continue; // 部分決済は平均取得単価の按分が必要なためスキップ（現データは全量のみ）
      const gross =
        t.position_side === "long" ? notional - o.notional : o.notional - notional;
      const expected = gross - dec(t.fee_amount_quote) - dec(t.interest ?? "0");
      const diff = absBig(expected - dec(t.profit_loss ?? "0"));
      assert.ok(
        diff <= TOLERANCE,
        `${batch} trade_id=${t.trade_id}: |検算-profit_loss| = ${diff} / ${SCALE} 円 > 0.001 円`,
      );
      open.delete(key);
      closesChecked++;
    }
  }
  assert.ok(closesChecked >= 1, "決済行が 1 件も検算されていない");
});

test("(4) 全フィールドの型スナップショットが SCHEMA_SNAPSHOT.json と一致する", () => {
  const stored = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8"));
  const rebuilt = buildSnapshot();
  assert.deepEqual(
    rebuilt,
    stored,
    "型スナップショット不一致: API 仕様変更か fixture 変更。意図的なら gen-schema-snapshot.mjs で更新",
  );
});
