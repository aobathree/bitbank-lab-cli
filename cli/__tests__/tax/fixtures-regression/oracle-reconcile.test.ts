// 100行超: 原型オラクル（scripts/dev/tax/reconcile.ts）と製品コードの結果一致検証。
// 生ファイルの読み込み・原型の起動・出力表のパース・突合を 1 本の流れで持つ。
//
// なぜ subprocess で回すのか: 原型は **独立実装のオラクル**（要求仕様 §10-2）であり、
// 製品の数値核（ratio.ts）で書き直すと比較の意味が消える。原型は BigInt の
// 10^18 固定小数という別実装のままにして、外から出力だけを突き合わせる。
//
// **一度きりの確認にしない**（恒久テスト）。fixtures が無い環境では skip、
// あれば毎回走る。
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RawTrade } from "../../../tax/import/raw-trade.js";
import { RawDeposit, RawWithdrawal } from "../../../tax/import/raw-transfer.js";
import { canonicalAsset } from "../../../tax/import/symbol-alias.js";
import { toEvents } from "../../../tax/import/to-events.js";
import { eq, type Ratio, ZERO } from "../../../tax/ratio.js";
import { fromDecimalString } from "../../../tax/ratio-decimal.js";
import { rebuildBalances } from "../../../tax/reconcile/rebuild.js";
import { checkFixtures, formatMismatch } from "./guard.js";

const state = checkFixtures();
if (state.kind === "skip") console.info(`[oracle-reconcile] skip: ${state.reason}`);

/** 原型と同じバッチ選択規則（raw/ 直下の最新 batch2-*）。 */
function batchDir(root: string): string {
  const raw = join(root, "raw");
  const dir = readdirSync(raw)
    .filter((d) => d.startsWith("batch2-"))
    .sort()
    .at(-1);
  if (!dir) throw new Error("batch2 ディレクトリが見つかりません");
  return join(raw, dir);
}

function loadAll(dir: string, prefix: string): unknown[] {
  return readdirSync(dir)
    .filter((f) => f.startsWith(prefix))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")));
}

/** 原型と同じ収集規則（deposit は 2 系統、withdrawal は資産別ファイル全部）。 */
function collectRaw(dir: string) {
  const rows = <T>(bodies: unknown[], key: string): T[] =>
    bodies.flatMap((b) => ((b as Record<string, Record<string, T[]>>).data[key] ?? []) as T[]);
  return {
    trades: RawTrade.array().parse(rows(loadAll(dir, "user_spot_trade_history_page"), "trades")),
    deposits: RawDeposit.array().parse([
      ...rows(loadAll(dir, "user_deposit_history_page"), "deposits"),
      ...rows(loadAll(dir, "user_deposit_history_jpy"), "deposits"),
    ]),
    withdrawals: RawWithdrawal.array().parse(
      rows(loadAll(dir, "user_withdrawal_history_"), "withdrawals"),
    ),
  };
}

/** 原型の Markdown 表から asset → 理論H1 を読む（列: asset=1 / 理論H1=7）。 */
function parseOracle(stdout: string): Map<string, Ratio> {
  const out = new Map<string, Ratio>();
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("|") || line.includes("---") || line.includes("| asset |")) continue;
    const cells = line.split("|").map((c) => c.trim());
    const h1 = fromDecimalString(cells[7] ?? "");
    if (cells[1] === undefined || h1 === null) continue;
    out.set(canonicalAsset(cells[1]), h1);
  }
  return out;
}

describe("残高突合: 原型オラクルと製品コードの一致", () => {
  it.skipIf(state.kind === "skip")("資産ごとの理論残高(H1)が完全一致する", () => {
    if (state.kind === "mismatch") expect.fail(formatMismatch(state));
    if (state.kind !== "ready") return;

    const dir = batchDir(state.root);
    expect(existsSync(dir), `batch ディレクトリが見つかりません: ${dir}`).toBe(true);

    // 製品側: 生レコード → 正規化イベント → 理論残高
    const raw = collectRaw(dir);
    const normalized = toEvents(raw);
    const rebuilt = rebuildBalances(normalized.events);

    // 原型側: 別実装（BigInt 10^18 固定小数）を subprocess で実行して出力を読む
    const stdout = execFileSync("npx", ["tsx", "scripts/dev/tax/reconcile.ts"], {
      encoding: "utf8",
      env: { ...process.env, BITBANK_TAX_FIXTURES: state.root },
    });
    const oracle = parseOracle(stdout);
    expect(oracle.size, `原型の出力表を読めませんでした:\n${stdout.slice(0, 500)}`).toBeGreaterThan(
      0,
    );

    // 非 JPY クォートは原型に扱いが無い（製品は突合不能として外す）ので比較対象外
    const skipped = [...rebuilt.unreconcilable].sort();
    const assets = [...new Set([...oracle.keys(), ...rebuilt.balances.keys()])]
      .filter((a) => !rebuilt.unreconcilable.has(a))
      .sort();
    expect(assets.length).toBeGreaterThan(0);

    const diffs = assets.filter((a) => {
      const mine = rebuilt.balances.get(a) ?? ZERO;
      const theirs = oracle.get(a) ?? ZERO;
      return !eq(mine, theirs);
    });
    expect(
      diffs,
      `原型と製品で理論残高が一致しない資産があります: ${diffs.join(", ")}` +
        (skipped.length > 0 ? `（比較対象外: ${skipped.join(", ")}）` : ""),
    ).toEqual([]);

    // 取り込めなかった行があれば、一致していても見えるようにしておく
    if (normalized.pending.length > 0) {
      console.info(`[oracle-reconcile] pending ${normalized.pending.length} 件（保留リスト）`);
    }
  });
});
