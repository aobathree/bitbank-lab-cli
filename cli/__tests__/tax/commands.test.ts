// tax コマンドの表層（登録・入力検証・繰越の読み込み）。
// 実 API は叩かず、入力検証で止まる経路だけを検査する（fetch が呼ばれないことも確認）。
import { describe, expect, it } from "vitest";
import { commandDescriptions, TAX_COMMANDS } from "../../commands/registry.js";
import { ALL_SCHEMAS } from "../../commands/schema/registry.js";
import { taxPnl } from "../../commands/tax/pnl.js";
import { taxVerifyReport } from "../../commands/tax/verify-report.js";
import { EXIT } from "../../exit-codes.js";
import { resolveCommand } from "../../router.js";
import { parseCarryover } from "../../tax/carryover.js";
import { toExactDecimalString } from "../../tax/ratio-decimal.js";

const failFetch = (() => {
  throw new Error("fetch should not be called");
}) as unknown as typeof fetch;

const noCall = { fetch: failFetch, retries: 0 as const };

describe("tax コマンドの登録", () => {
  it("router が tax グループを解決する", () => {
    expect(resolveCommand(["tax"]).group).toBe("tax");
    expect(resolveCommand(["tax", "pnl"]).entry).toBe(TAX_COMMANDS.pnl);
    expect(resolveCommand(["tax", "nope"]).entry).toBeUndefined();
  });

  it("schema カタログに tax カテゴリで載る", () => {
    for (const name of ["events", "reconcile", "pnl", "verify-report"]) {
      expect(ALL_SCHEMAS[`tax ${name}`]?.category).toBe("tax");
    }
  });

  it("description は `tax <name>` キーで引ける", () => {
    expect(commandDescriptions()["tax pnl"]).toBe(TAX_COMMANDS.pnl.description);
  });
});

describe("tax pnl の入力検証", () => {
  it("--year が無ければ PARAM エラー（API は叩かない）", async () => {
    const r = await taxPnl({}, noCall);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.exitCode).toBe(EXIT.PARAM);
  });

  it("不正な --year は PARAM エラー", async () => {
    const r = await taxPnl({ year: "26" }, noCall);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.exitCode).toBe(EXIT.PARAM);
  });

  it("未知の --method は PARAM エラー", async () => {
    const r = await taxPnl({ year: "2026", method: "fifo" }, noCall);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.exitCode).toBe(EXIT.PARAM);
  });

  it("読めない --carryover は PARAM エラー", async () => {
    const r = await taxPnl({ year: "2026", carryover: "/nonexistent/carryover.json" }, noCall);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.exitCode).toBe(EXIT.PARAM);
  });
});

describe("tax verify-report の入力検証", () => {
  it("--csv が無ければ PARAM エラー（API は叩かない）", async () => {
    const r = await taxVerifyReport({ year: "2026" }, noCall);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.exitCode).toBe(EXIT.PARAM);
  });

  it("--year が無ければ PARAM エラー", async () => {
    const r = await taxVerifyReport({ csv: "/nonexistent/report.csv" }, noCall);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.exitCode).toBe(EXIT.PARAM);
  });

  it("読めない CSV は API を叩く前に PARAM エラー（認証・レート制限を消費しない）", async () => {
    const r = await taxVerifyReport({ year: "2026", csv: "/nonexistent/report.csv" }, noCall);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error).toContain("Cannot read CSV file");
  });

  it("--margin-csv だけでも実行できる（現物と信用は別様式・別ファイル）", async () => {
    // CSV 必須ゲートを通過して読み込みまで進むこと（存在しないので読み込みで落ちる）
    const r = await taxVerifyReport({ year: "2026", marginCsv: "/nonexistent/margin.csv" }, noCall);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error).toContain("Cannot read CSV file");
  });
});

describe("繰越の読み込み", () => {
  it("十進文字列のまま厳密に読む", () => {
    const r = parseCarryover({ BTC: { qty: "1.5", cost_jpy: "931800" } });
    expect(r.success).toBe(true);
    if (r.success) {
      // 資産キーは小文字へ寄せる（"BTC" でも引ける）
      expect(toExactDecimalString(r.data.btc.qty)).toBe("1.5");
      expect(toExactDecimalString(r.data.btc.cost)).toBe("931800");
    }
  });

  it("正規化後に衝突する通貨キーは明示エラー（黙って上書きしない）", () => {
    // BTC / btc を両方書かれると後勝ちで繰越簿価が入れ替わり、参考損益が静かに狂う
    const r = parseCarryover({
      BTC: { qty: "1", cost_jpy: "100" },
      btc: { qty: "2", cost_jpy: "999" },
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.exitCode).toBe(EXIT.PARAM);
      expect(r.error).toContain("Duplicate carryover currency");
    }
  });

  // 小文字化だけだと、旧シンボルで書いた繰越が新シンボルのイベントと結び付かない。
  // 実体のある pol は (c) 未確定でブロックされ、matic は突合行を持たないまま
  // 「取引ゼロ・期末＝繰越」の参考欄だけを出す（幽霊行）
  it("旧シンボルの繰越は新シンボルへ名寄せする（イベント・突合と同じ canonicalAsset）", () => {
    const r = parseCarryover({ MATIC: { qty: "10", cost_jpy: "5000" } });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(Object.keys(r.data)).toEqual(["pol"]);
      // 名寄せはキーだけを付け替える。数量・簿価は素通りさせる（同ファイル冒頭の
      // 「十進文字列のまま厳密に読む」と同じく両方見る）
      expect(toExactDecimalString(r.data.pol.qty)).toBe("10");
      expect(toExactDecimalString(r.data.pol.cost)).toBe("5000");
    }
  });

  it("名寄せ後に衝突する旧新シンボルの併記も明示エラー", () => {
    const r = parseCarryover({
      matic: { qty: "1", cost_jpy: "100" },
      pol: { qty: "2", cost_jpy: "999" },
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.exitCode).toBe(EXIT.PARAM);
      expect(r.error).toContain("Duplicate carryover currency");
    }
  });

  // mkr→sky は 1:24,000 の換算転換で名寄せ禁止（P-18）。繰越でも潰さない
  it("換算比が 1 でない改称は名寄せしない（mkr と sky は別キーのまま）", () => {
    const r = parseCarryover({
      mkr: { qty: "1", cost_jpy: "100" },
      sky: { qty: "24000", cost_jpy: "100" },
    });
    expect(r.success).toBe(true);
    if (r.success) expect(Object.keys(r.data).sort()).toEqual(["mkr", "sky"]);
  });

  it("十進文字列でない値は PARAM エラー（黙って 0 にしない）", () => {
    const r = parseCarryover({ btc: { qty: "1.5e3", cost_jpy: "1" } });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.exitCode).toBe(EXIT.PARAM);
  });
});
