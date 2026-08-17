// 100行超: コマンドルーティングの分岐を網羅
import { describe, expect, it, vi } from "vitest";
import { COMMANDS, PROFILE_COMMANDS, TRADE_COMMANDS } from "../commands/registry.js";
import { EXIT } from "../exit-codes.js";
import { handleSpecialCommand, resolveCommand, runCommandHelp } from "../router.js";

describe("resolveCommand", () => {
  it("既知の public コマンドを正しく振り分ける", () => {
    const r = resolveCommand(["ticker"]);
    expect(r.group).toBeUndefined();
    expect(r.command).toBe("ticker");
    expect(r.entry).toBe(COMMANDS.ticker);
  });

  it("既知のハイフン付きコマンドを正しく振り分ける", () => {
    const r = resolveCommand(["tickers-jpy"]);
    expect(r.group).toBeUndefined();
    expect(r.entry).toBe(COMMANDS["tickers-jpy"]);
  });

  it("不明な public コマンドは entry が undefined", () => {
    const r = resolveCommand(["nonexistent"]);
    expect(r.group).toBeUndefined();
    expect(r.command).toBe("nonexistent");
    expect(r.entry).toBeUndefined();
  });

  it("引数なし（空配列）は entry が undefined", () => {
    const r = resolveCommand([]);
    expect(r.group).toBeUndefined();
    expect(r.command).toBeUndefined();
    expect(r.entry).toBeUndefined();
  });

  it("trade 単独は group=trade で entry undefined", () => {
    const r = resolveCommand(["trade"]);
    expect(r.group).toBe("trade");
    expect(r.command).toBeUndefined();
    expect(r.entry).toBeUndefined();
  });

  it("trade <unknown> は entry が undefined", () => {
    const r = resolveCommand(["trade", "nonexistent"]);
    expect(r.group).toBe("trade");
    expect(r.command).toBe("nonexistent");
    expect(r.entry).toBeUndefined();
  });

  it("trade <known> は TRADE_COMMANDS の entry を返す", () => {
    const r = resolveCommand(["trade", "create-order"]);
    expect(r.group).toBe("trade");
    expect(r.command).toBe("create-order");
    expect(r.entry).toBe(TRADE_COMMANDS["create-order"]);
  });

  it("trade と同名の public コマンドは存在せず干渉しない", () => {
    expect(COMMANDS["create-order"]).toBeUndefined();
    const r = resolveCommand(["create-order"]);
    expect(r.group).toBeUndefined();
    expect(r.entry).toBeUndefined();
  });

  it("追加の positionals があっても先頭2要素のみ参照", () => {
    const r = resolveCommand(["trade", "create-order", "extra", "args"]);
    expect(r.group).toBe("trade");
    expect(r.command).toBe("create-order");
    expect(r.entry).toBe(TRADE_COMMANDS["create-order"]);
  });

  it("profile 単独は group=profile で entry undefined", () => {
    const r = resolveCommand(["profile"]);
    expect(r.group).toBe("profile");
    expect(r.command).toBeUndefined();
    expect(r.entry).toBeUndefined();
  });

  it("profile <unknown> は entry が undefined", () => {
    const r = resolveCommand(["profile", "nonexistent"]);
    expect(r.group).toBe("profile");
    expect(r.command).toBe("nonexistent");
    expect(r.entry).toBeUndefined();
  });

  it("profile <known> は PROFILE_COMMANDS の entry を返す", () => {
    const r = resolveCommand(["profile", "list"]);
    expect(r.group).toBe("profile");
    expect(r.command).toBe("list");
    expect(r.entry).toBe(PROFILE_COMMANDS.list);
  });

  it("profile add に追加 positionals があっても先頭2要素のみ参照", () => {
    const r = resolveCommand(["profile", "add", "main", "extra"]);
    expect(r.group).toBe("profile");
    expect(r.command).toBe("add");
    expect(r.entry).toBe(PROFILE_COMMANDS.add);
  });
});

describe("handleSpecialCommand", () => {
  it("'profiles' は true を返し profilesHandler を実行する", async () => {
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const handled = await handleSpecialCommand("profiles", [], {}, "json");
    writeSpy.mockRestore();
    expect(handled).toBe(true);
  });

  it("'schema' は true を返し schemaHandler を実行する", async () => {
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const handled = await handleSpecialCommand("schema", [], {}, "json");
    writeSpy.mockRestore();
    expect(handled).toBe(true);
  });

  it("不明なコマンドは false を返す", async () => {
    const handled = await handleSpecialCommand("ticker", [], {}, "json");
    expect(handled).toBe(false);
  });

  it("空文字列は false を返す", async () => {
    const handled = await handleSpecialCommand("", [], {}, "json");
    expect(handled).toBe(false);
  });
});

describe("runCommandHelp", () => {
  it("既知コマンドは成功を返しヘルプを出力する", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const r = await runCommandHelp("ticker", "Get ticker for a pair");
    logSpy.mockRestore();
    expect(r.success).toBe(true);
  });

  it("group 付きは `<group> <name>` キーで引く", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const r = await runCommandHelp("assets", "Show paper balances", "paper");
    const printed = String(logSpy.mock.calls[0]?.[0] ?? "");
    logSpy.mockRestore();
    expect(r.success).toBe(true);
    // group を渡さないと private の assets を引いてしまう（キーは呼び出しパス）。
    expect(printed).toContain("Usage: bitbank paper assets");
  });

  // false を返すだけだと index.ts が本体実行へ落ちる。`--help` が実行に化けないよう
  // 失敗として返し、PARAM で終わらせる。
  it("未登録コマンドは EXIT.PARAM の失敗を返す", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const r = await runCommandHelp("nonexistent-xyz", "desc");
    logSpy.mockRestore();
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.exitCode).toBe(EXIT.PARAM);
      expect(r.error).toContain("No help available");
    }
  });
});
