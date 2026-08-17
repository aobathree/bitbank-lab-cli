// compare.ts の部品（突合結果の型・診断文言・行の組み立て）。
import type { RawAsset } from "../import/fetch-assets.js";
import { canonicalAsset } from "../import/symbol-alias.js";
import { add, type Ratio, ZERO } from "../ratio.js";
import { fromDecimalString, toExactDecimalString } from "../ratio-decimal.js";
import type { Diagnosis as ReportDiagnosis } from "../schema/report.js";

/** 既定のダスト閾値 1e-4（付録E.4）。資産別に上書きできる。 */
export const DUST_THRESHOLD = "0.0001";

/**
 * 法定通貨は桁の意味が暗号資産と違う。**JPY の 1e-4 は「100 分の 1 銭」**で、
 * 約定代金の丸め由来の残差を毎回「未取込の処分」と誤診する（実口座で確認）。
 * 取込漏れは円単位で現れるので、円未満に材料性はない。
 */
const DUST_BY_CURRENCY: Record<string, string> = { jpy: "1" };

/** 資産に適用するダスト閾値。呼び出し側の上書き > 通貨別既定 > 全体既定。 */
export function dustFor(currency: string, override: Record<string, string> = {}): string {
  // 通貨キーは CSV / API 由来。素の Record 参照だと "__proto__" 等で継承プロパティが
  // 返るので hasOwn で見る（carryover.ts と同じ防御）
  const own = (r: Record<string, string>): string | undefined =>
    Object.hasOwn(r, currency) ? r[currency] : undefined;
  return own(override) ?? own(DUST_BY_CURRENCY) ?? DUST_THRESHOLD;
}

// 診断の値は schema/report.ts の Zod enum が単一ソース（出力バリデーションと型がずれないように）
export type Diagnosis = ReportDiagnosis;

export type AssetComparison = {
  currency: string;
  theoretical: string;
  actual: string;
  /** 実残高 − 理論残高 */
  residual: string;
  /** この資産に適用したダスト閾値（通貨で違うので行に載せる） */
  dust: string;
  withinDust: boolean;
  diagnosis: Diagnosis;
  hint: string;
};

/** 残差の符号から原因候補を分ける（付録E.4）。断定はしない。 */
const HINTS: Record<Diagnosis, string> = {
  MATCH: "ダスト閾値内で一致",
  MISSING_ACQUISITION: "実残高が多い: 未取込の取得（販売所買付・付与・他所からの移転）の可能性",
  MISSING_DISPOSAL: "実残高が少ない: 未取込の処分（販売所売却・ダスト処分）の可能性",
  UNRECONCILABLE: "非 JPY クォートの約定を含むため、この帳簿では突合できません",
  UNREADABLE: "残高を十進文字列として読めませんでした",
};

/**
 * 実残高を正規化キーで合算する。改称後は新旧シンボルが両方返り得るため
 * （履歴側は旧名のまま）、canonicalAsset で寄せてから足す。
 * 読めない値が 1 つでもあれば、その資産は null（= 突合不能）として持ち上げる。
 */
export function actualByCurrency(assets: readonly RawAsset[]): Map<string, Ratio | null> {
  const out = new Map<string, Ratio | null>();
  for (const a of assets) {
    const key = canonicalAsset(a.asset);
    const onhand = fromDecimalString(a.onhand_amount);
    const withdrawing = fromDecimalString(a.withdrawing_amount);
    const prev = out.get(key);
    if (onhand === null || withdrawing === null || prev === null) {
      out.set(key, null);
      continue;
    }
    out.set(key, add(prev ?? ZERO, add(onhand, withdrawing)));
  }
  return out;
}

export function row(
  currency: string,
  theo: Ratio,
  act: Ratio,
  residual: Ratio,
  withinDust: boolean,
  diagnosis: Diagnosis,
  dust: string = DUST_THRESHOLD,
): AssetComparison {
  // 残高は有限小数の和なので厳密な十進表現になる（丸めない）
  const dec = (r: Ratio): string => toExactDecimalString(r) ?? "";
  return {
    currency,
    theoretical: dec(theo),
    actual: dec(act),
    residual: dec(residual),
    dust,
    withinDust,
    diagnosis,
    hint: HINTS[diagnosis],
  };
}
