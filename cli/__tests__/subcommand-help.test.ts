import { describe, expect, it } from "vitest";
import { buildHelp } from "../commands/schema/help.js";

describe("subcommand help", () => {
  it("shows usage, description, and category", () => {
    const text = buildHelp("candles", "Get candlestick OHLCV data");
    expect(text).toContain("Usage: bitbank candles");
    expect(text).toContain("Get candlestick OHLCV data");
    expect(text).toContain("Category: public");
  });

  it("lists parameters with type and description", () => {
    const text = buildHelp("candles", "Get candlestick OHLCV data");
    expect(text).toContain("--pair");
    expect(text).toContain("Trading pair");
    expect(text).toContain("--type");
    expect(text).toContain("Type: string");
  });

  it("shows enum values", () => {
    const text = buildHelp("candles", "Get candlestick OHLCV data");
    expect(text).toContain("Values: 1min,");
    expect(text).toContain("1hour");
  });

  it("shows default values", () => {
    const text = buildHelp("candles", "Get candlestick OHLCV data");
    expect(text).toContain("Default: 100");
  });

  it("shows examples", () => {
    const text = buildHelp("candles", "Get candlestick OHLCV data");
    expect(text).toContain("Examples:");
    expect(text).toContain("bitbank candles --pair=btc_jpy");
    expect(text).toContain("--format=table");
  });

  it("shows (none) for commands without parameters", () => {
    const text = buildHelp("status", "Get exchange status");
    expect(text).toContain("Parameters: (none)");
  });

  it("returns null for unknown commands", () => {
    expect(buildHelp("nonexistent", "desc")).toBeNull();
  });

  it("works for trade commands with execute flag", () => {
    // buildHelp は ALL_SCHEMAS のキー（= 呼び出しパス）を受け取る。素の
    // "create-order" は paper と衝突するのでグループ付きで引く。
    const text = buildHelp("trade create-order", "Create a spot order");
    expect(text).toContain("Usage: bitbank trade create-order");
    expect(text).toContain("--side");
    expect(text).toContain("Values: buy, sell");
    expect(text).toContain("--execute");
    expect(text).toContain("Category: trade");
    expect(text).toContain("bitbank trade create-order --pair=btc_jpy");
  });

  it("works for private commands", () => {
    const text = buildHelp("assets", "Get your asset balances");
    expect(text).toContain("Category: private");
    expect(text).toContain("--all");
  });

  it("同名の paper サブコマンドは private と別の help を返す", () => {
    const text = buildHelp("paper assets", "Show paper trading balances");
    expect(text).toContain("Usage: bitbank paper assets");
    expect(text).toContain("Category: paper");
    expect(text).not.toContain("--all");
  });

  it("paper reset は必須の --confirm を例にも出す", () => {
    const text = buildHelp("paper reset", "Reset paper trading state");
    expect(text).toContain("Usage: bitbank paper reset");
    expect(text).toContain("Required.");
    expect(text).toContain("bitbank paper reset --confirm");
  });

  it("profile の name は位置引数として表示する（--name ではない）", () => {
    const text = buildHelp("profile show", "Show a profile") ?? "";
    // Usage 行にも出す。Examples だけだと必須の位置引数を見落とす。
    expect(text).toContain("Usage: bitbank profile show <name> [options]");
    expect(text).not.toContain("--name");
    expect(text).toContain("bitbank profile show <name>");
  });
  it("watch は 2 つの位置引数を Usage に並べ、例は具体値で出す", () => {
    const text = buildHelp("watch", "Watch a real-time public channel") ?? "";
    expect(text).toContain("Usage: bitbank watch <channel> <pair> [options]");
    expect(text).toContain("Category: stream");
    expect(text).toContain("--duration");
    // 位置引数に具体値が引けるなら例はそのまま実行できる形にする。
    expect(text).toContain("bitbank watch ticker btc_jpy");
  });
});
