// 100行超: 信用イベントの組み立てヘルパー（margin()）を全ケースが共有する。
// 責務は「信用の突合」1 つで、分割しても helper を複製するだけになる。
// 年間取引報告書（信用）との突合。現物と決定的に違うのは
// **報告書の損益が手数料を控除していない**点（利息だけ控除）。API の profit_loss は
// 手数料も控除済みなので、足し戻さずに比べると差がまるごと手数料ぶん出る。
import { describe, expect, it } from "vitest";
import { parseMarginReport } from "../../../tax/import-csv/margin-report.js";
import { parseCsv } from "../../../tax/import-csv/parse-csv.js";
import type { TaxEvent } from "../../../tax/schema/event.js";
import type { VerifyRow } from "../../../tax/schema/verify.js";
import { aggregateMarginForReport } from "../../../tax/verify/margin-aggregate.js";
import { compareMarginReport } from "../../../tax/verify/margin-report.js";
import { buildMarginCsv, type MarginRow } from "./synthetic-report.js";

let seq = 0;
const margin = (
  role: "OPEN" | "CLOSE",
  over: { net?: string; charged?: string; occurred?: string; currency?: string } = {},
): TaxEvent =>
  ({
    event_id: `margin:${seq++}`,
    source_ref: String(seq),
    ts_utc: 1_767_225_600_000,
    ts_jst: "2026-01-01T09:00:00+09:00",
    year_jst: 2026,
    account_id: "bitbank:default",
    kind: role === "OPEN" ? "MARGIN_OPEN" : "MARGIN_CLOSE",
    market_type: "ORDERBOOK",
    source_system: "API",
    currency: over.currency ?? "btc",
    qty: "0.5",
    jpy_value: "5000000",
    pair_raw: `${over.currency ?? "btc"}_jpy`,
    recognition_policy: "DELIVERY_DATE",
    flags: ["FEE_API_ROUNDED"],
    margin: {
      position_side: "long",
      role,
      ...(role === "CLOSE" ? { realized_net: over.net ?? "1000" } : {}),
      fee_charged: over.charged ?? "0",
      fee_occurred: over.occurred ?? "0",
    },
  }) as TaxEvent;

function compare(rows: readonly MarginRow[], events: readonly TaxEvent[]) {
  const report = parseMarginReport(parseCsv(buildMarginCsv(rows)));
  if (!report.success) throw new Error(report.error);
  return compareMarginReport(report.data, aggregateMarginForReport(events));
}

const ok = (...args: Parameters<typeof compare>) => {
  const r = compare(...args);
  if (!r.success) throw new Error(r.error);
  return r.data;
};

const find = (rows: VerifyRow[], currency: string, field: string) =>
  rows.find((x) => x.currency === currency && x.field === field);

describe("信用の報告書突合", () => {
  it("報告書の損益（手数料控除前）と API の profit_loss + 手数料 が一致する", () => {
    // 報告書: 値幅 − 利息 = 1100。API: profit_loss = 1000（= 1100 − 手数料 100）
    const data = ok(
      [{ 通貨名: "btc", 年中信用取引損益: "1100", 支払手数料: "100" }],
      [margin("OPEN"), margin("CLOSE", { net: "1000", charged: "100", occurred: "60" })],
    );
    expect(find(data.rows, "btc", "margin_pnl")).toMatchObject({
      diagnosis: "MATCH",
      report_kind: "margin",
    });
    expect(find(data.rows, "btc", "margin_fee")).toMatchObject({ diagnosis: "MATCH" });
  });

  it("手数料を足し戻さない実装なら手数料ぶんの差が立つ（回帰の見張り）", () => {
    // 報告書が手数料控除**後**の値だと仮定して置くと、足し戻す実装では差が出る。
    // ここが MATCH に変わったら足し戻しが消えている
    const data = ok(
      [{ 通貨名: "btc", 年中信用取引損益: "1000", 支払手数料: "100" }],
      [margin("CLOSE", { net: "1000", charged: "100" })],
    );
    expect(find(data.rows, "btc", "margin_pnl")).toMatchObject({
      diff: "-100",
      diagnosis: "API_EXCESS",
    });
  });

  it("手数料は精算ベースと発生ベースの両方を出す（報告書の合計基準を判別するため）", () => {
    const data = ok(
      [{ 通貨名: "btc", 年中信用取引損益: "1100", 支払手数料: "60" }],
      [margin("OPEN", { occurred: "60" }), margin("CLOSE", { net: "1000", charged: "100" })],
    );
    // 精算ベース（決済時に建て分と合算）は 100、発生ベース（各約定日）は 60
    expect(find(data.rows, "btc", "margin_fee")?.diagnosis).toBe("API_EXCESS");
    expect(find(data.rows, "btc", "margin_fee_occurred")?.diagnosis).toBe("MATCH");
  });

  // 実機確認 #11（2025 年分の実データ）: 報告書とAPIの**損益の差が手数料の差と厳密に一致**した。
  // margin_pnl は profit_loss（原精度）に 4 桁丸めの手数料を足し戻して作るので、
  // 手数料の丸め誤差をそのまま継承する。ダスト固定の許容幅だと件数が増えたぶんを
  // 「FIFO の対応付けのズレ」と誤診する（実際に btc で誤診した）
  describe("損益は手数料の丸め誤差を継承する（実機確認 #11）", () => {
    /**
     * 決済 9 件。API 側は 4 桁丸め済みの値を、報告書側は丸め前合計を持つ。
     * **期待値は十進のまま手計算して固定する**。丸め境界を見るテストで浮動小数点の
     * 乗算や `toFixed` を使うと、フィクスチャ自体が二進誤差でずれ得る（ADR-005）。
     *
     *   API    手数料 = 100.0001     × 9 = 900.0009
     *          損益   = (900 + 100.0001) × 9 = 9000.0009
     *   報告書 手数料 = 100.00012345 × 9 = 900.00111105
     *          損益   = (900 + 100.00012345) × 9 = 9000.00111105
     *   差     どちらも 0.00021105（許容幅 9 × 半 ulp = 0.00045 の内側）
     */
    const CLOSES = 9;
    const withRounding = () =>
      ok(
        [{ 通貨名: "btc", 年中信用取引損益: "9000.00111105", 支払手数料: "900.00111105" }],
        Array.from({ length: CLOSES }, () =>
          margin("CLOSE", { net: "900", charged: "100.0001", occurred: "100.0001" }),
        ),
      );

    it("損益の差と手数料の差が一致する（両者が同じ丸めから来ている証拠）", () => {
      const rows = withRounding().rows;
      const pnl = find(rows, "btc", "margin_pnl");
      expect(pnl?.diff).toBe(find(rows, "btc", "margin_fee")?.diff);
      // 値そのものも固定する。一致するだけなら両方 0 でも通ってしまう
      expect(pnl?.diff).toBe("0.00021105");
    });

    it("丸めで説明できる損益差は FEE_ROUNDING（REPORT_EXCESS にしない）", () => {
      const row = find(withRounding().rows, "btc", "margin_pnl");
      expect(row?.diagnosis).toBe("FEE_ROUNDING");
      // 許容幅は件数比例。ダスト固定（0.0001）のままなら 9 件で外れる
      expect(row?.tolerance).toBe("0.00045");
    });

    it("丸めで説明できない差は REPORT_EXCESS のまま残す", () => {
      const data = ok(
        [{ 通貨名: "btc", 年中信用取引損益: "1200", 支払手数料: "100" }],
        [margin("CLOSE", { net: "1000", charged: "100", occurred: "100" })],
      );
      expect(find(data.rows, "btc", "margin_pnl")?.diagnosis).toBe("REPORT_EXCESS");
    });
  });

  // 精算は決済レコードで 1 回だけ丸めるが、発生は建てと決済で別々に丸められる。
  // 件数が違うので許容幅も違う
  it("発生ベースの許容幅は建玉の件数も数える", () => {
    // 建て 3 + 決済 3。精算は決済レコードでしか丸めが起きないので 3 件、
    // 発生は建てと決済で別々に丸められるので 6 件。ダスト下限（2 件相当）を
    // 超える件数にしないと両者の差が出ないので、意図的に 3 往復にしてある
    const events = Array.from({ length: 3 }, () => [
      margin("OPEN", { charged: "0", occurred: "40" }),
      margin("CLOSE", { net: "1000", charged: "100", occurred: "60" }),
    ]).flat();
    const data = ok([{ 通貨名: "btc", 年中信用取引損益: "3300", 支払手数料: "300" }], events);
    expect(find(data.rows, "btc", "margin_fee")?.tolerance).toBe("0.00015"); // 3 件
    expect(find(data.rows, "btc", "margin_fee_occurred")?.tolerance).toBe("0.0003"); // 6 件
  });

  it("年末建玉は突合せず unsupported として報告する（全履歴が必要）", () => {
    const data = ok([{ 通貨名: "eth", 年末保有中買建玉: "2.5", 年中信用取引損益: "0" }], []);
    expect(data.unsupported).toEqual([
      { currency: "eth", field: "end_long_position", value: "2.5" },
    ]);
    expect(data.warnings.join()).toContain("年末建玉");
  });

  it("fee_charged を欠く決済は損益集計から外して警告する（0 として足さない）", () => {
    // 手数料が不明なら「手数料を足し戻した損益」は算出できない。0 扱いで足すと
    // 手数料ぶん少ない損益が出て、しかも差の原因が分からなくなる
    const e = margin("CLOSE", { net: "1000" });
    const broken = {
      ...e,
      margin: { position_side: "long", role: "CLOSE", realized_net: "1000" },
    } as TaxEvent;
    const a = aggregateMarginForReport([broken]);
    expect(a.byCurrency.get("btc")?.margin_pnl).toEqual({ n: 0n, d: 1n });
    expect(a.warnings.join()).toContain("損益集計から除外");
  });

  it("現物イベントは信用の集計に混ぜない", () => {
    const spot = {
      ...margin("CLOSE"),
      kind: "TRADE_SPOT_SELL",
      margin: undefined,
    } as unknown as TaxEvent;
    expect(aggregateMarginForReport([spot]).byCurrency.size).toBe(0);
  });

  it("名寄せ後に衝突する行は明示エラー", () => {
    const r = compare(
      [
        { 通貨名: "matic", 年中信用取引損益: "1" },
        { 通貨名: "pol", 年中信用取引損益: "2" },
      ],
      [],
    );
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error).toContain("Duplicate margin report currency");
  });
});

describe("信用の報告書パース", () => {
  it("現物の CSV を渡したら「様式が違う」と分かるエラーになる", () => {
    const r = parseMarginReport(parseCsv("通貨名,年始数量,年末数量\nbtc,0,1"));
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error).toContain("header not found");
  });
});
