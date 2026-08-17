// シンボル名寄せ（付録E.5）。名寄せ表は **CSV / API 由来のキーで引かれる**ので、
// 改称の扱いと合わせて「継承プロパティを拾わない」ことを固定する。
import { describe, expect, it } from "vitest";
import { canonicalAsset, splitPair } from "../../../tax/import/symbol-alias.js";

describe("canonicalAsset", () => {
  it("1:1 改称は新シンボルへ寄せる", () => {
    expect(canonicalAsset("MATIC")).toBe("pol");
    expect(canonicalAsset("rndr")).toBe("render");
  });

  it("未知のシンボルは小文字化のみ（勝手に潰さない）", () => {
    expect(canonicalAsset("BTC")).toBe("btc");
  });

  it("mkr は sky へ寄せない（1:24,000 の比率換算転換。P-18）", () => {
    expect(canonicalAsset("mkr")).toBe("mkr");
  });

  it("プロトタイプ由来のキーでも文字列のフォールバックを返す", () => {
    // 素の Record 参照だと Object.prototype 側の値（関数等）が返り、資産キーが
    // 文字列でなくなる。下流の safeParse で弾かれる fail-closed だが手前で閉じる
    expect(canonicalAsset("__proto__")).toBe("__proto__");
    expect(canonicalAsset("constructor")).toBe("constructor");
    expect(canonicalAsset("toString")).toBe("tostring");
  });
});

describe("splitPair", () => {
  it("名寄せ後の base / quote を返す", () => {
    expect(splitPair("MATIC_JPY")).toEqual({ base: "pol", quote: "jpy" });
  });

  it("形式が違えば null（黙って片側だけ採用しない）", () => {
    expect(splitPair("btcjpy")).toBeNull();
    expect(splitPair("btc_")).toBeNull();
  });

  it("プロトタイプ由来のキーを含むペアでも文字列を返す", () => {
    expect(splitPair("constructor_jpy")).toEqual({ base: "constructor", quote: "jpy" });
  });
});
