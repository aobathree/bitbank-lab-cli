import { describe, expect, it } from "vitest";
import { buildSchemaHandler } from "../commands/schema/handler.js";
import { captureStdout } from "./test-helpers.js";

const DESC: Record<string, string> = {
  ticker: "Get ticker for a pair",
  candles: "Get candlestick OHLCV data",
  assets: "Get your asset balances",
  "create-order": "Create a spot order (dry-run default)",
  stream: "Subscribe to real-time stream",
};

describe("schema list", () => {
  it("lists all commands in json format", async () => {
    const c = captureStdout();
    try {
      await buildSchemaHandler(DESC)([], {}, "json");
      const { data } = JSON.parse(c.read());
      expect(Array.isArray(data)).toBe(true);
      expect(data.length).toBeGreaterThan(0);
      const ticker = data.find((d: { command: string }) => d.command === "ticker");
      expect(ticker).toBeDefined();
      expect(ticker.category).toBe("public");
      expect(ticker.params).toContain("pair");
      const createOrder = data.find((d: { command: string }) => d.command === "trade create-order");
      expect(createOrder).toBeDefined();
      expect(createOrder.category).toBe("trade");
      // paper / profile も一覧に載る（載っていないとモデルが存在しない
      // `bitbank paper buy` を推測する — 実機確認 #14）。
      const paperCreate = data.find((d: { command: string }) => d.command === "paper create-order");
      expect(paperCreate).toBeDefined();
      expect(paperCreate.category).toBe("paper");
      const profileAdd = data.find((d: { command: string }) => d.command === "profile add");
      expect(profileAdd).toBeDefined();
      expect(profileAdd.category).toBe("profile");
      // 素の名前で衝突していた private assets が生き残っている。
      const assets = data.find((d: { command: string }) => d.command === "assets");
      expect(assets.category).toBe("private");
    } finally {
      c.restore();
    }
  });

  it("supports table format", async () => {
    const c = captureStdout();
    try {
      await buildSchemaHandler(DESC)([], {}, "table");
      const out = c.read();
      expect(out).toContain("command");
      expect(out).toContain("ticker");
    } finally {
      c.restore();
    }
  });
});
