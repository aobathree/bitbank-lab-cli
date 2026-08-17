// 課税年度 → 課税方式のマッピング（v2 §12 が「将来対応フック」として求めているもの）。
//
// **ユーザーが選ぶ値ではない**。どの課税方式が適用されるかは譲渡の年で法律上決まる。
// そこでこのテーブルを単一ソースにし、`--taxation` は
// **テーブルと食い違っていないかの確認**にしか使わせない。自由に選ばせると、
// 総合課税の前提で計算した数値に分離課税のラベルが付く事故が起き得る。
// 課税方式が変われば損益通算の範囲・損失の繰越・税率がすべて変わるので、
// ラベルの取り違えは数値そのものの誤りと同じ重さになる。
import { EXIT } from "../exit-codes.js";
import type { Result } from "../types.js";
import { type Taxation, TaxationMode } from "./schema/taxation.js";

/**
 * 分離課税が適用され得る最初の年。適用開始は「金商法等改正法の**施行日の属する年の
 * 翌年** 1/1 以後の譲渡」で、同法は 2026-07-15 成立・公布から 1 年以内施行。
 * 最速（2026 年中施行）でも適用開始は 2027-01-01 なので、**2026 年分以前は
 * どう転んでも総合課税**（v2 §12）。
 */
const EARLIEST_SEPARATE_YEAR = 2027;

/** 施行日が未確定なため、この年以降は方式を機械的に決められない。 */
const UNDETERMINED_FROM = 2028;

export type TaxationResolution =
  | { determined: true; taxation: Taxation }
  | { determined: false; reason: string };

/** 年だけから課税方式を引く。判断材料が無い年は「決まらない」を返す（推測しない）。 */
export function taxationFor(year: number): TaxationResolution {
  if (year < EARLIEST_SEPARATE_YEAR) {
    return {
      determined: true,
      taxation: {
        mode: "comprehensive",
        certainty: "settled",
        basis: `${year} 年分は総合課税（原則その他雑所得）。分離課税の適用は最速でも ${EARLIEST_SEPARATE_YEAR} 年分以降（v2 §12）`,
      },
    };
  }
  if (year < UNDETERMINED_FROM) {
    return {
      determined: true,
      taxation: {
        mode: "comprehensive",
        certainty: "projected",
        basis: `${year} 年分は総合課税の見込み。金商法等改正法の施行が ${year - 1} 年中だった場合は分離課税が適用され得る（施行日未確定・v2 §12）`,
      },
    };
  }
  return {
    determined: false,
    reason: `${year} 年分の課税方式は確定できません。分離課税の適用開始は金商法等改正法の施行日に、対象範囲は「特定暗号資産」の定義に依存し、いずれも未確定です（v2 §12）。確定後に対応します`,
  };
}

/**
 * 年から方式を決め、`--taxation` が指定されていれば一致するかを検査する。
 * 指定は**上書きではなく確認**。食い違ったらユーザーの認識かデータのどちらかが
 * 間違っているので、黙って年側を採らずに止める。
 */
export function resolveTaxation(year: number, requested?: string): Result<Taxation> {
  const resolved = taxationFor(year);
  if (!resolved.determined) {
    return { success: false, error: resolved.reason, exitCode: EXIT.PARAM };
  }
  const { taxation } = resolved;

  if (requested !== undefined) {
    const parsed = TaxationMode.safeParse(requested);
    if (!parsed.success) {
      return {
        success: false,
        error: `--taxation must be one of: ${TaxationMode.options.join(" | ")}`,
        exitCode: EXIT.PARAM,
      };
    }
    if (parsed.data !== taxation.mode) {
      return {
        success: false,
        error: `--taxation=${parsed.data} が指定されましたが、${year} 年分に適用されるのは ${taxation.mode} です。${taxation.basis}`,
        exitCode: EXIT.PARAM,
      };
    }
  }

  // 現時点でテーブルは separate を返さないので到達しない。**テーブルに separate を
  // 足した瞬間に効く安全網**として先に置く（ロジック未実装のまま数値が出るのを防ぐ）
  if (taxation.mode !== "comprehensive") {
    return {
      success: false,
      error:
        "申告分離課税の計算ロジックは未実装です。制度詳細（特定暗号資産の定義等）の確定後に着手します（ADR-004）",
      exitCode: EXIT.PARAM,
    };
  }
  return { success: true, data: taxation };
}
