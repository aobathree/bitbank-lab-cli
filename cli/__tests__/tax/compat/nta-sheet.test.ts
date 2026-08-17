// 国税庁計算書（NTA_SHEET_2025_12）互換モード（検証アンカー 2）。
//
// 固定するのは 2 つ。**公式設例を再現すること**と、**既定と丸め位置が違うこと**。
// 後者が要る理由: FAQ の設例は値がすべて割り切れるので、互換モードを何も実装せず
// 既定値をそのまま返しても設例テストは通ってしまう。丸めが実際に効くケースを
// 別に置かないと「互換になっている」ことを担保できない。
import { describe, expect, it } from "vitest";
import { ntaCompat } from "../../../tax/compat/nta-sheet.js";
import { movingAverage } from "../../../tax/engine/moving-average.js";
import { totalAverage, ZERO_BOOK } from "../../../tax/engine/total-average.js";
import { add, type Ratio, sub, ZERO } from "../../../tax/ratio.js";
import {
  fromDecimalString,
  toDecimalString,
  toExactDecimalString,
} from "../../../tax/ratio-decimal.js";
import type { LedgerEntry } from "../../../tax/schema/ledger.js";

const dec = (s: string) => fromDecimalString(s) ?? ZERO;

const DAY = 86_400_000;
const base = (seq: number) => ({
  event_id: `trade:${seq}`,
  seq: 0,
  currency: "btc",
  year_jst: 2026,
  ts_utc: seq * DAY,
  sort_key: `${seq}:0`,
  policy_ids: [],
});
const acquire = (seq: number, qty: string, cost: string): LedgerEntry => ({
  ...base(seq),
  kind: "ACQUIRE",
  qty,
  cost_jpy: cost,
  category: "purchase",
});
const dispose = (seq: number, qty: string, proceeds: string): LedgerEntry => ({
  ...base(seq),
  kind: "DISPOSE",
  qty,
  proceeds_jpy: proceeds,
  category: "sale",
});

/** 付録D.4 の公式設例（FAQ 2-4 / 2-8）。 */
const FAQ: LedgerEntry[] = [
  acquire(1, "4", "1845000"),
  acquire(2, "2", "1650000"),
  dispose(3, "2", "2400000"),
  acquire(4, "0.5", "542800"),
  dispose(5, "3", "2895000"),
];

describe("公式設例の再現（付録D.4）", () => {
  it("総平均法: 譲渡原価 3,106,000 / 年末残高 931,800 / 所得 2,189,000", () => {
    const c = ntaCompat(totalAverage("btc", FAQ, ZERO_BOOK), FAQ);
    expect(c).toMatchObject({
      mode: "NTA_SHEET_2025_12",
      cogs_jpy: "3106000",
      closing_cost_jpy: "931800",
      income_total_jpy: "5295000",
      expense_total_jpy: "3106000",
      income_jpy: "2189000",
      carryover_cost_jpy: "931800",
    });
  });

  it("移動平均法: 譲渡原価 3,080,200 / 年末残高価額 957,600", () => {
    const c = ntaCompat(movingAverage("btc", FAQ, ZERO_BOOK), FAQ);
    expect(c).toMatchObject({ cogs_jpy: "3080200", closing_cost_jpy: "957600" });
  });
});

describe("既定と丸め位置が違う（互換モードが効いている証拠）", () => {
  // 収入 1000.4 / 必要経費 1000.3。丸め前の差は +0.1 だが、
  // 計算書は収入を切捨て・経費を切上げるので 1000 − 1001 = −1 になる
  it("総平均法: 収入は切捨て・必要経費は切上げ（所得は丸めた両者の差）", () => {
    const entries = [acquire(1, "3", "3000"), dispose(2, "1", "1000.4")];
    const outcome = totalAverage("btc", entries, ZERO_BOOK);
    outcome.expense = { n: 3n, d: 10n }; // 手数料等 0.3
    const c = ntaCompat(outcome, entries);
    expect(c).toMatchObject({
      income_total_jpy: "1000", // ROUNDDOWN(1000.4)
      expense_total_jpy: "1001", // ROUNDUP(1000.3)
      income_jpy: "-1",
    });
  });

  // 単価 1000/3 の状態で 1 単位売ると、残高は ceil(1000/3 × 2) = 667 へ切上がる。
  // 既定は残高 2000/3（≒666.67）なので、譲渡原価が 1 円ぶん軽くなる
  it("移動平均法: 売却の都度、残高価額を切上げる", () => {
    const entries = [acquire(1, "3", "1000"), dispose(2, "1", "500")];
    const c = ntaCompat(movingAverage("btc", entries, ZERO_BOOK), entries);
    expect(c.closing_cost_jpy).toBe("667");
    expect(c.cogs_jpy).toBe("333"); // (0 + 1000) − 667
  });

  it("全量処分なら残高はゼロ（切上げても増えない）", () => {
    const entries = [acquire(1, "3", "1000"), dispose(2, "3", "1200")];
    const c = ntaCompat(movingAverage("btc", entries, ZERO_BOOK), entries);
    expect(c.closing_cost_jpy).toBe("0");
    expect(c.cogs_jpy).toBe("1000");
  });
});

// 計算書は繰越価額・購入価額が**整数円入力**である前提で組まれている（D.5 / D.3）。
// 販売所（即時売買）は約定代金の列が無く `数量 × 指値価格` で出すため小数円になり、
// そのまま漸化式へ入れると「シートに書いたらこうなる」値でなくなる。
describe("移動平均法: シートへ入れる金額は円に確定してから回す（D.5）", () => {
  it("小数円の購入価額は四捨五入してから漸化式に入る", () => {
    // 999.9090426 → 1000。確定しないと残高 = ceil(999.9090426 / 3 × 2) = 667 のまま
    // 差引原価が 999.9090426 − 667 = 332.909… となり、シートには書けない値になる
    const entries = [acquire(1, "3", "999.9090426"), dispose(2, "1", "500")];
    const c = ntaCompat(movingAverage("btc", entries, ZERO_BOOK), entries);
    expect(c.closing_cost_jpy).toBe("667"); // ceil(1000 / 3 × 2)
    expect(c.cogs_jpy).toBe("333"); // (0 + 1000) − 667。整数のまま閉じる
  });

  // 繰越価額の確定は **3 値で挟む**。1 つでは丸めモードも実装も特定できない:
  // - 1000.6 … 確定なし（表示は切捨てで "1000"）と ROUNDDOWN を弾く。ROUNDUP は弾けない
  // - 1000.4 … ROUNDUP（"1001"）を弾く。確定なしは弾けない（表示が同じ "1000"）
  // - 1000.5 … 同値境界。`roundAtScale` の HALF_UP は `absRem * 2n >= den` の 1 行で
  //            決まっていて、`>=` が `>` に滑ると切捨て側へ倒れる。上の 2 値はどちらも
  //            `absRem * 2n !== den` なのでその取り違えを検知できない
  // すぐ下の売却時残高が ROUNDUP なので、モードの取り違えも現実的な間違え方
  it.each([
    ["1000.6", "1001"],
    ["1000.4", "1000"],
    ["1000.5", "1001"],
  ])("繰越価額も同じく円に確定する（%s → %s・HALF_UP を特定する）", (cost, expected) => {
    const opening = { qty: dec("1"), cost: dec(cost) };
    const entries = [dispose(2, "1", "500")];
    const c = ntaCompat(movingAverage("btc", entries, opening), entries);
    expect(c.closing_cost_jpy).toBe("0"); // 全量処分なので残高ゼロ
    expect(c.cogs_jpy).toBe(expected);
  });

  it("整数円の入力では挙動が変わらない（取引所だけの口座は無影響）", () => {
    const c = ntaCompat(movingAverage("btc", FAQ, ZERO_BOOK), FAQ);
    expect(c.cogs_jpy).toBe("3080200"); // 公式設例と同値のまま
    expect(c.closing_cost_jpy).toBe("957600");
  });

  // 既定エンジン（ADR-005: 非丸め）は確定を行わない。互換欄だけの話であること
  it("既定の計算は小数円のまま（互換欄だけが確定する）", () => {
    const entries = [acquire(1, "3", "999.9090426"), dispose(2, "1", "500")];
    const o = movingAverage("btc", entries, ZERO_BOOK);
    expect(toExactDecimalString(o.acquired.cost)).toBe("999.9090426");
  });
});

// I4（要求仕様 §3）: 丸め起因の乖離を**違反ではなく開示**として出す。
// 向きは既定 − 互換。既定側は report/currency.ts の `reference` の 4 欄に対応する。
describe("I4: 丸め起因の乖離額", () => {
  /** `report/format.ts` の `yen()` と同じ式。ここがずれたら乖離額の意味が変わる */
  const defaultYen = (r: Ratio) => toDecimalString(r, 0, "ROUNDDOWN");

  // 実口座の検証（tax-roadmap.md）は総平均法で「所得は一致・必要経費計だけ互換が
  // 1 円大きい」という出方だった。income_jpy だけを出すと、この 1 円が消える
  it("総平均法: 必要経費計に差が出て、譲渡原価・収入計は 0 のまま", () => {
    const entries = [acquire(1, "3", "3000"), dispose(2, "1", "1000.4")];
    const outcome = totalAverage("btc", entries, ZERO_BOOK);
    outcome.expense = { n: 3n, d: 10n }; // 手数料等 0.3
    const c = ntaCompat(outcome, entries);
    expect(c.delta).toEqual({
      cogs_jpy: "0", // 総平均の互換は原価を丸めない
      income_total_jpy: "0", // 収入は既定も互換も切捨て
      expense_total_jpy: "-1", // 既定 1000（切捨て）− 互換 1001（切上げ）
      income_jpy: "1", // 既定 0（= floor(1000.4 − 1000.3)）− 互換 (−1)
    });
  });

  // **売却 1 回では譲渡原価に差が出ない。** 簿価 C が整数のとき互換は
  // `C − ceil(C − Cq/Q) = floor(Cq/Q)` で、既定の表示（切捨て）と代数的に一致する。
  // それでも所得には差が出る — 互換の原価は既に整数なので、既定が持っている端数が
  // 収入との差引で 1 円ぶん残る
  it("移動平均法: 売却 1 回では譲渡原価は一致し、所得にだけ差が出る", () => {
    const entries = [acquire(1, "3", "1000"), dispose(2, "1", "500")];
    const outcome = movingAverage("btc", entries, ZERO_BOOK);
    const c = ntaCompat(outcome, entries);
    expect(c.cogs_jpy).toBe("333"); // 互換 = 1000 − 667
    expect(defaultYen(outcome.cogs)).toBe("333"); // 既定 = floor(1000/3)
    expect(c.delta.cogs_jpy).toBe("0");
    // 既定 floor(500 − 333.33…) = 166 に対し互換は 500 − 333 = 167
    expect(c.delta.income_jpy).toBe("-1");
  });

  // 差が原価に現れるのは**切上げた残高が次の単価に入ってから**。2 回目の売却が要る
  // （D.3「切上げ分が次の購入時に AS/AO で将来単価へ取り込まれる」）
  it("移動平均法: 2 回目の売却で譲渡原価に差が出る（切上げが残高へ繰り延べられる）", () => {
    const entries = [
      acquire(1, "3", "1000"),
      dispose(2, "1", "500"),
      acquire(3, "2", "1000"),
      dispose(4, "1", "500"),
    ];
    const outcome = movingAverage("btc", entries, ZERO_BOOK);
    const c = ntaCompat(outcome, entries);
    // 既定は 1000/3 + 5000/12 = 750 ちょうど。互換は 2000 − ceil(1667/4 × 3) = 749
    expect(defaultYen(outcome.cogs)).toBe("750");
    expect(c.cogs_jpy).toBe("749");
    expect(c.delta).toEqual({
      cogs_jpy: "1", // 互換の原価が 1 円軽い（D.3 の「翌年以降へ繰り延べ」）
      income_total_jpy: "0",
      expense_total_jpy: "1",
      income_jpy: "-1", // 原価が軽い分だけ互換の所得が大きい
    });
  });

  // 差が 0 の欄も落とさない（「差なし」を確認できることが開示の目的）
  it("公式設例（割り切れる）は全欄が 0", () => {
    const c = ntaCompat(totalAverage("btc", FAQ, ZERO_BOOK), FAQ);
    expect(c.delta).toEqual({
      cogs_jpy: "0",
      income_total_jpy: "0",
      expense_total_jpy: "0",
      income_jpy: "0",
    });
  });

  it("乖離額は既定 − 互換で、既定側の式は reference と同じ", () => {
    const entries = [acquire(1, "3", "1000"), dispose(2, "1", "500")];
    const outcome = movingAverage("btc", entries, ZERO_BOOK);
    const c = ntaCompat(outcome, entries);
    const revenue = add(outcome.disposed.proceeds, outcome.income);
    const expense = add(outcome.cogs, outcome.expense);
    // 4 欄それぞれ「既定の表示値 − 互換の表示値」に一致する
    expect(c.delta.cogs_jpy).toBe(String(BigInt(defaultYen(outcome.cogs)) - BigInt(c.cogs_jpy)));
    expect(c.delta.income_total_jpy).toBe(
      String(BigInt(defaultYen(revenue)) - BigInt(c.income_total_jpy)),
    );
    expect(c.delta.expense_total_jpy).toBe(
      String(BigInt(defaultYen(expense)) - BigInt(c.expense_total_jpy)),
    );
    expect(c.delta.income_jpy).toBe(
      String(BigInt(defaultYen(sub(revenue, expense))) - BigInt(c.income_jpy)),
    );
  });
});
