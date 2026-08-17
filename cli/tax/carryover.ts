// 前年繰越（(H)(I) の引継ぎ）の読み込み。ガード(c)「前年末残高が確定していること」の
// 入力そのもので、**未入力とゼロは別物**として扱う（未入力なら参考損益を出さない）。
//
// 形式: { "btc": { "qty": "1.5", "cost_jpy": "931800" }, ... }
// 資産キーの正規化は `canonicalAsset`（イベント・残高突合と同じ関数）を通す。ここだけ
// 小文字化で済ませると、旧シンボルで書いた繰越が当年のイベントと結び付かない。
import { readFileSync } from "node:fs";
import { z } from "zod";
import { EXIT } from "../exit-codes.js";
import { fsErrorSuffix } from "../fs-error.js";
import { decStr } from "../schema-helpers.js";
import type { Result } from "../types.js";
import type { OpeningBalances } from "./engine/types.js";
import { canonicalAsset } from "./import/symbol-alias.js";
import { fromDecimalString } from "./ratio-decimal.js";

export const CarryoverFile = z.record(z.string(), z.object({ qty: decStr, cost_jpy: decStr }));
export type CarryoverFile = z.infer<typeof CarryoverFile>;

/** 「当年が初年度で前年末残高はゼロ」を明示するための値。--carryover=zero で指定する。 */
export const CARRYOVER_ZERO = "zero";

export function parseCarryover(json: unknown): Result<OpeningBalances> {
  const parsed = CarryoverFile.safeParse(json);
  if (!parsed.success) {
    return {
      success: false,
      error: `Invalid carryover: ${parsed.error.message}`,
      exitCode: EXIT.PARAM,
    };
  }
  // プロトタイプ汚染を避けるため null プロトタイプで持つ（"__proto__" 等のキーが来ても安全）
  const opening = Object.create(null) as OpeningBalances;
  for (const [currency, v] of Object.entries(parsed.data)) {
    // 資産キーはイベント・突合と**同じ** `canonicalAsset` で正規化する（付録E.5）。
    // 小文字化だけだと旧シンボル（`matic`）で書かれた繰越が `pol` のイベントと結び付かず、
    // 実体のある `pol` は (c) 未確定でブロックされる一方、`matic` は突合行を持たないまま
    // 「取引ゼロ・期末＝繰越」の参考欄だけを出す（幽霊行）。
    //
    // **正規化後に衝突したら黙って上書きせずエラーにする** — `BTC` と `btc`、あるいは
    // `matic` と `pol` を両方書かれると後勝ちで繰越簿価が入れ替わり、参考損益が静かに狂う
    const key = canonicalAsset(currency);
    if (Object.hasOwn(opening, key)) {
      return {
        success: false,
        error: `Duplicate carryover currency after normalization: ${currency} (=> ${key})`,
        exitCode: EXIT.PARAM,
      };
    }
    const qty = fromDecimalString(v.qty);
    const cost = fromDecimalString(v.cost_jpy);
    if (qty === null || cost === null) {
      return {
        success: false,
        error: `Invalid carryover for ${currency}: qty / cost_jpy must be decimal strings`,
        exitCode: EXIT.PARAM,
      };
    }
    opening[key] = { qty, cost };
  }
  return { success: true, data: opening };
}

/** ファイルから読む。読めない・壊れているは Result のエラーにする（throw しない）。 */
export function loadCarryover(path: string): Result<OpeningBalances> {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (e) {
    return {
      success: false,
      error: `Cannot read carryover file: ${path}${fsErrorSuffix(e)}`,
      exitCode: EXIT.PARAM,
    };
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return {
      success: false,
      error: `Carryover file is not valid JSON: ${path}`,
      exitCode: EXIT.PARAM,
    };
  }
  return parseCarryover(json);
}
