// シンボル名寄せ（付録E.5）。**名寄せは資産キー側だけで行い、ペア名は生値保持**する
// （約定履歴のペア名は改称後も旧名のまま返るため）。
//
// 1:1 の単純改称だけを対象にする。**mkr→sky は 1:24,000 の比率換算転換なので
// 名寄せしてはいけない**（P-18。数量がそのまま繋がらず、名寄せすると簿価が壊れる）。

/** 旧シンボル → 新シンボル。1:1 改称のみ。増やすときは換算比が 1 であることを確認する。 */
const ASSET_ALIAS: Record<string, string> = {
  matic: "pol",
  rndr: "render",
};

/** 資産キーを正規化する。未知のシンボルは小文字化のみ（勝手に潰さない）。 */
export function canonicalAsset(asset: string): string {
  const lower = asset.toLowerCase();
  // 素の Record 参照だと "__proto__" / "constructor" 等で継承プロパティ（関数）が返る。
  // 資産キーは CSV / API 由来なので、carryover.ts と同じく hasOwn で見る
  return Object.hasOwn(ASSET_ALIAS, lower) ? (ASSET_ALIAS[lower] ?? lower) : lower;
}

/** `btc_jpy` → `["btc", "jpy"]`（正規化後）。形式が違えば null。 */
export function splitPair(pair: string): { base: string; quote: string } | null {
  const parts = pair.toLowerCase().split("_");
  if (parts.length !== 2 || parts[0] === "" || parts[1] === "") return null;
  return { base: canonicalAsset(parts[0]), quote: canonicalAsset(parts[1]) };
}

/** 円建てクォートか。false なら TRADE_EXCHANGE 扱い（P0 はブロック。設計メモ §4-4）。 */
export function isJpyQuote(quote: string): boolean {
  return quote === "jpy";
}
