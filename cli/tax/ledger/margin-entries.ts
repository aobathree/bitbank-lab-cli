// 信用の決済 → 仕訳。**手数料の置き場所が API と報告書で違う**ので独立ファイルに分ける。
//
// bitbank API の `profit_loss` は `値幅損益 − Σ手数料 − 利息` の**ネット値**（実機確認 #2 で検算済み）。
// 一方、年間取引報告書（信用）の「年中信用取引損益」は**利息だけを控除**した値で、
// 取引手数料は「支払手数料」列に分けて載る（社内設計資料 2024-11。国税庁への照会で
// 個別法・約定ベースが確認された際の様式）。国税庁計算書でも「信用・証拠金（差益/差損）」欄と
// 「手数料等」欄は別で、ユーザーは現物の手数料と信用の手数料を足して手数料欄へ入れる。
//
//     差益 / 差損 = realized_net + fee_charged   （= 値幅損益 − 利息）
//     必要経費（手数料） = fee_charged
//
// 所得の合計は分け方を変えても変わらないが、**報告書・計算書との行の対応が変わる**。
// realized_net をそのまま差益に置くと報告書と手数料ぶんずれ、しかも手数料が
// どの欄にも現れなくなる（現物の手数料と足せない）。
//
// なお「再控除しない」規律は維持している。ここでやっているのは控除の**取り消し**であって、
// 二重控除ではない。
import { add, cmp, neg, ZERO } from "../ratio.js";
import { fromDecimalString, toExactDecimalString } from "../ratio-decimal.js";
import type { TaxEvent } from "../schema/event.js";
import type { LedgerEntry } from "../schema/ledger.js";
import { makeEntry } from "./entry-parts.js";

export function marginEntries(e: TaxEvent): LedgerEntry[] | string {
  const net = e.margin?.realized_net;
  // 呼び出し元（from-events.ts）は MARGIN_CLOSE でしかここへ来ない。新規建ては手前の
  // `continue` で落ちる。つまり realized_net が無いのは「新規建てだから」ではなく、
  // **決済行なのに実現損益が取れていない**という異常。空配列で黙って捨てると、その
  // 決済の差益・差損・手数料が income / expense / reference_pnl から消える
  // （verify-report は同じ欠落を `warnings` に出しているので、pnl 側だけが沈黙していた）
  if (net === undefined) return "信用の決済に realized_net がありません";
  const value = fromDecimalString(net);
  if (value === null) return "realized_net を十進文字列として読めません";

  const chargedStr = e.margin?.fee_charged;
  // 手数料が無いと報告書の定義へ揃えられない。黙って realized_net をそのまま使うと
  // 手数料ぶんずれた差益を出すので、保留に回す
  if (chargedStr === undefined) return "信用の決済に fee_charged がありません";
  const charged = fromDecimalString(chargedStr);
  if (charged === null) return "信用の手数料を十進文字列として読めません";

  // 金額は JPY だが、帰属先は**建玉の銘柄**（国税庁の計算書は銘柄別で、
  // 信用・証拠金の差益 / 差損欄も銘柄シート内にある）
  const gross = add(value, charged);
  const gain = cmp(gross, ZERO) >= 0;
  const amount = toExactDecimalString(gain ? gross : neg(gross));
  if (amount === null) return "信用損益を厳密な十進で表現できません";

  const entries: LedgerEntry[] = [
    makeEntry(
      e,
      0,
      gain ? "INCOME" : "EXPENSE",
      { qty: "0", amount_jpy: amount },
      gain ? "margin_gain" : "margin_loss",
      ["P-05", "P-06"],
    ),
  ];

  if (cmp(charged, ZERO) > 0) {
    const fee = toExactDecimalString(charged);
    if (fee === null) return "信用の手数料を厳密な十進で表現できません";
    entries.push(
      makeEntry(e, 1, "EXPENSE", { qty: "0", amount_jpy: fee }, "margin_fee", ["P-06", "P-16"]),
    );
  } else if (cmp(charged, ZERO) < 0) {
    // P-04: 負手数料（メイカーリベート）は受取時に収入計上する（現物と同じ扱い）
    const rebate = toExactDecimalString(neg(charged));
    if (rebate === null) return "信用のリベート額を厳密な十進で表現できません";
    entries.push(
      makeEntry(e, 2, "INCOME", { qty: "0", amount_jpy: rebate }, "margin_rebate_income", ["P-04"]),
    );
  }
  return entries;
}
