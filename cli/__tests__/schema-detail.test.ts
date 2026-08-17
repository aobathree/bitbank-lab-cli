// 100行超: `schema <cmd>` の契約を 1 本にまとめる。detail の中身・キー解決
// （グループ形式 / 素の名前 / 曖昧 / 未知）・exit code は同じ解決ロジックの
// 表裏なので、分割すると片方だけ直して壊す事故が起きる。
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PAPER_COMMANDS } from "../commands/registry.js";
import { buildSchemaHandler } from "../commands/schema/handler.js";
import { EXIT } from "../exit-codes.js";
import { captureStdout } from "./test-helpers.js";

const DESC: Record<string, string> = {
  ticker: "Get ticker for a pair",
  candles: "Get candlestick OHLCV data",
  "trade create-order": "Create a spot order (dry-run default)",
  "paper create-order": "Place a paper order (market or limit)",
};

/** stderr を捕まえる（失敗レスポンスは output() が stderr に出す）。 */
function captureStderr() {
  const orig = process.stderr.write.bind(process.stderr);
  let buf = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    buf += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  return { read: () => buf, restore: () => (process.stderr.write = orig) };
}

describe("schema detail", () => {
  it("returns detail for ticker", async () => {
    const c = captureStdout();
    try {
      await buildSchemaHandler(DESC)(["ticker"], {}, "json");
      const { data } = JSON.parse(c.read());
      expect(data.command).toBe("ticker");
      expect(data.category).toBe("public");
      expect(data.params.type).toBe("object");
      expect(data.params.properties.pair).toBeDefined();
      expect(data.output.type).toBe("object");
      expect(data.output.properties.sell).toBeDefined();
    } finally {
      c.restore();
    }
  });

  it("returns candles schema with enum and default", async () => {
    const c = captureStdout();
    try {
      await buildSchemaHandler(DESC)(["candles"], {}, "json");
      const { data } = JSON.parse(c.read());
      expect(data.params.properties.type.enum).toContain("1hour");
      expect(data.params.properties.limit.default).toBe(1000);
    } finally {
      c.restore();
    }
  });

  it("returns error for unknown command", async () => {
    const c = captureStdout();
    const e = captureStderr();
    try {
      await buildSchemaHandler(DESC)(["nonexistent"], {}, "json");
      expect(e.read()).toContain("Unknown command");
    } finally {
      c.restore();
      e.restore();
    }
  });

  it("includes trade command execute param and side enum", async () => {
    const c = captureStdout();
    try {
      await buildSchemaHandler(DESC)(["trade", "create-order"], {}, "json");
      const { data } = JSON.parse(c.read());
      expect(data.category).toBe("trade");
      expect(data.command).toBe("trade create-order");
      expect(data.params.properties.execute).toBeDefined();
      expect(data.params.properties.side.enum).toContain("buy");
    } finally {
      c.restore();
    }
  });

  it("accepts 'trade <name>' two-arg form", async () => {
    const c = captureStdout();
    try {
      await buildSchemaHandler(DESC)(["trade", "create-order"], {}, "json");
      const { data } = JSON.parse(c.read());
      expect(data.command).toBe("trade create-order");
      expect(data.category).toBe("trade");
    } finally {
      c.restore();
    }
  });

  it("'paper <name>' は trade ではなく paper の定義を返す", async () => {
    const c = captureStdout();
    try {
      await buildSchemaHandler(DESC)(["paper", "create-order"], {}, "json");
      const { data } = JSON.parse(c.read());
      expect(data.command).toBe("paper create-order");
      expect(data.category).toBe("paper");
      expect(data.description).toBe(DESC["paper create-order"]);
      // paper は実 API を叩かないので二段ロックのフラグは存在しない。
      expect(data.params.properties.execute).toBeUndefined();
      expect(data.params.properties.type.enum).toEqual(["market", "limit"]);
    } finally {
      c.restore();
    }
  });

  it("素の名前が一意なら引ける（tick は paper のみ）", async () => {
    const c = captureStdout();
    try {
      await buildSchemaHandler(DESC)(["tick"], {}, "json");
      const { data } = JSON.parse(c.read());
      expect(data.command).toBe("paper tick");
    } finally {
      c.restore();
    }
  });

  it("素の名前が曖昧なら候補を挙げてエラーにする（黙って片方を返さない）", async () => {
    const c = captureStdout();
    const e = captureStderr();
    try {
      await buildSchemaHandler(DESC)(["create-order"], {}, "json");
      const err = e.read();
      expect(err).toContain("Ambiguous command");
      expect(err).toContain("trade create-order");
      expect(err).toContain("paper create-order");
    } finally {
      c.restore();
      e.restore();
    }
  });

  it("素の名前がトップレベルにあればそれを優先する（private assets）", async () => {
    const c = captureStdout();
    try {
      await buildSchemaHandler(DESC)(["assets"], {}, "json");
      const { data } = JSON.parse(c.read());
      expect(data.command).toBe("assets");
      expect(data.category).toBe("private");
    } finally {
      c.restore();
    }
  });

  it("profile の name は positional として出る", async () => {
    const c = captureStdout();
    try {
      await buildSchemaHandler(DESC)(["profile", "show"], {}, "json");
      const { data } = JSON.parse(c.read());
      expect(data.command).toBe("profile show");
      expect(data.params.properties.name.positional).toBe(true);
    } finally {
      c.restore();
    }
  });

  it("グループ名だけ渡すとグループ内の一覧を返す", async () => {
    const c = captureStdout();
    try {
      await buildSchemaHandler(DESC)(["paper"], {}, "json");
      const { success, data } = JSON.parse(c.read());
      expect(success).toBe(true);
      expect(data).toHaveLength(Object.keys(PAPER_COMMANDS).length);
      expect(data.every((d: { category: string }) => d.category === "paper")).toBe(true);
      expect(data.map((d: { command: string }) => d.command)).toContain("paper create-order");
    } finally {
      c.restore();
    }
  });
});

describe("schema の解決エラー", () => {
  beforeEach(() => {
    process.exitCode = undefined;
  });
  afterEach(() => {
    process.exitCode = undefined;
  });

  // exitCode を省くと output.ts の `?? 1` で GENERAL(1) に落ち、bot が
  // 入力ミスを内部エラーと誤認してリトライする（chaos x16 と同じ趣旨）。
  it.each([
    ["未知のコマンド", ["nonexistent"], "Unknown command"],
    ["曖昧なコマンド", ["create-order"], "Ambiguous command"],
    ["グループ内の未知（実在しない paper buy）", ["paper", "buy"], 'Unknown command: "paper buy"'],
  ])("%s は EXIT.PARAM で落ちる", async (_label, args, expected) => {
    const c = captureStdout();
    const e = captureStderr();
    try {
      await buildSchemaHandler(DESC)(args, {}, "json");
      expect(e.read()).toContain(expected);
      expect(process.exitCode).toBe(EXIT.PARAM);
    } finally {
      c.restore();
      e.restore();
    }
  });
});
