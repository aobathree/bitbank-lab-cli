// 突合行のヒント文言（現物 / 信用）。診断の向きごとに「次に何を疑うか」を書く。
//
// 現物と信用で置き方を揃えるためにここへ集約する。文言は突合の読み方そのもので、
// 集計側（aggregate / margin-aggregate）にも突合側（annual-report / margin-report）にも
// 属さない。行の組み立て（rows.ts）とも別で、あちらは許容幅と診断の判定だけを持つ。
import type { VerifyDiagnosis } from "../schema/verify.js";
import type { ComparedField } from "./aggregate.js";
import type { MarginField } from "./margin-aggregate.js";

const TRADE_FIELDS = new Set<ComparedField>(["buy_qty", "buy_jpy", "sell_qty", "sell_jpy"]);

/** 現物のヒント。差の向きごとに「次に何を疑うか」を書く。 */
export function spotHint(field: ComparedField): (d: VerifyDiagnosis) => string {
  return (diagnosis) => {
    if (diagnosis === "MATCH") return "許容幅内で一致";
    if (diagnosis === "FEE_ROUNDING") {
      return "API 手数料の 4 桁丸めで説明できる範囲の差（P-16。件数 × 半 ulp 以内）";
    }
    if (diagnosis === "REPORT_EXCESS") {
      return TRADE_FIELDS.has(field)
        ? "報告書が多い: 報告書の対象年と --year の取り違え、または販売所（即時売買。API に現れないので --brokerage-csv が要る）"
        : "報告書が多い: 報告書の対象年と --year の取り違え、取込の打ち切り（--max-pages）、API に現れない移転";
    }
    return TRADE_FIELDS.has(field)
      ? "API が多い: 報告書の対象年と --year の取り違え、報告書の対象外（信用は別様式）、年分判定・重複排除のズレ"
      : "API が多い: 報告書の対象年と --year の取り違え、年分判定（JST）のズレ、報告書の対象外の移転";
  };
}

// 信用の突合ヒント。現物と違い、差の第一候補は「販売所」ではない（信用に販売所は無い）。
// 疑うのは **損益の算出基準**（報告書は生約定から FIFO で再計算、API は取引所が付けた
// `profit_loss`）と、**手数料の合計基準**（精算ベース / 発生ベース）。
const MARGIN_HINTS: Record<MarginField, Partial<Record<VerifyDiagnosis, string>>> = {
  margin_pnl: {
    // 実機確認 #11: 実データで最初に踏んだのは丸めのほうで、FIFO は正しかった。
    // 差が margin_fee 行の差と一致するかを先に見れば、その場で切り分けられる
    REPORT_EXCESS:
      "報告書が多い: まず margin_fee 行の差と見比べる。一致するなら手数料の 4 桁丸めが損益に乗っているだけ（P-16）。一致しないなら、報告書が生約定から再計算する FIFO と API の profit_loss で建玉の対応付けが違う可能性",
    API_EXCESS:
      "API が多い: まず margin_fee 行の差と見比べる（符号も含めて一致するなら丸め由来）。一致しないなら年をまたぐ建玉の帰属年、または未取込の決済がある可能性（利息の控除位置も確認する）",
  },
  margin_fee: {
    REPORT_EXCESS:
      "報告書が多い: 発生ベース（各約定日）で合計されている可能性 → margin_fee_occurred 行を見る",
    API_EXCESS: "API が多い: 年をまたぐ建玉の手数料が決済年にまとめて精算されている可能性",
  },
  margin_fee_occurred: {
    REPORT_EXCESS:
      "報告書が多い: 精算ベース（決済時に一括）で合計されている可能性 → margin_fee 行を見る",
    API_EXCESS: "API が多い: 精算ベースの合計（margin_fee 行）と比べる",
  },
};

/**
 * 丸め差の説明は項目で分ける。`margin_pnl` は手数料そのものではないので、
 * 「なぜ損益に手数料の丸めが出るのか」を書かないと FIFO を疑わせてしまう
 * （実機確認 #11 で実際にそう誤誘導した）。
 */
function marginRoundingHint(field: MarginField): string {
  return field === "margin_pnl"
    ? "報告書の定義へ揃えるため profit_loss に手数料を足し戻しており、その手数料の 4 桁丸めがそのまま差になる（P-16）。損益の差が手数料の差と一致していれば FIFO のズレではない"
    : "API 手数料の 4 桁丸めで説明できる範囲の差（P-16）";
}

export function marginHint(field: MarginField): (d: VerifyDiagnosis) => string {
  return (diagnosis) => {
    if (diagnosis === "MATCH") return "許容幅内で一致";
    if (diagnosis === "FEE_ROUNDING") return marginRoundingHint(field);
    return MARGIN_HINTS[field][diagnosis] ?? "";
  };
}
