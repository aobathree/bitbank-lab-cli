// 販売所 CSV が **4 コマンドのエントリポイントを通って出力へ届く**ことを固定する。
//
// パース（import-csv/brokerage.test.ts）とイベント化は個別に covered だが、
// `--brokerage-csv` の配線が外れても両者は緑のままになる。販売所は API に一切
// 現れない唯一の取得経路なので、配線が切れると**取込漏れが黙って起きる**。
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { taxEvents } from "../../commands/tax/events.js";
import { taxPnl } from "../../commands/tax/pnl.js";
import { taxReconcile } from "../../commands/tax/reconcile.js";
import { taxVerifyReport } from "../../commands/tax/verify-report.js";
import { TEST_CREDS } from "../test-helpers.js";

/** 実口座の CSV は置かない（公開フォーク）。列名・列順だけ実物に合わせた合成データ。 */
const BROKERAGE_CSV = [
  "注文ID,通貨,売/買,数量,指値価格,売買日時",
  "10000000001,btc,買,0.5,1000000,2026/07/13 16:43:12",
].join("\r\n");

let dir: string;
let csvPath: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "tax-brokerage-"));
  csvPath = join(dir, "dealer_history.csv");
  writeFileSync(csvPath, BROKERAGE_CSV);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** API 側は空。差分が出たら販売所 CSV 由来だと一意に言える。 */
function emptyApiFetch(): typeof globalThis.fetch {
  return async (input) => {
    const url = typeof input === "string" ? input : input.toString();
    const body = (data: unknown) => new Response(JSON.stringify({ success: 1, data }));
    if (url.includes("/spot/pairs")) {
      return body({
        pairs: [
          {
            name: "btc_jpy",
            base_asset: "btc",
            quote_asset: "jpy",
            maker_fee_rate_base: "0",
            taker_fee_rate_base: "0",
            maker_fee_rate_quote: "0",
            taker_fee_rate_quote: "0",
            unit_amount: "0.0001",
            limit_max_amount: "1000",
            market_max_amount: "10",
            price_digits: 0,
            amount_digits: 4,
            is_enabled: true,
            stop_order: false,
            stop_order_and_cancel: false,
          },
        ],
      });
    }
    if (url.includes("/user/spot/trade_history")) return body({ trades: [] });
    if (url.includes("/user/deposit_history")) return body({ deposits: [] });
    if (url.includes("/user/withdrawal_history")) return body({ withdrawals: [] });
    if (url.includes("/user/assets")) return body({ assets: [] });
    throw new Error(`unexpected endpoint: ${url}`);
  };
}

const OPTS = () => ({
  fetch: emptyApiFetch(),
  retries: 0,
  credentials: TEST_CREDS,
  nonce: "1",
});

describe("--brokerage-csv がエントリポイントを通って出力へ届く", () => {
  it("tax events: CSV 行がイベントになる（API は空）", async () => {
    const withCsv = await taxEvents({ year: "2026", brokerageCsv: csvPath }, OPTS());
    const without = await taxEvents({ year: "2026" }, OPTS());

    expect(withCsv.success).toBe(true);
    expect(without.success).toBe(true);
    if (!withCsv.success || !without.success) return;
    expect(without.data.events).toHaveLength(0);
    expect(withCsv.data.events).toHaveLength(1);
    expect(withCsv.data.events[0]).toMatchObject({ currency: "btc" });
  });

  it("tax reconcile: 販売所の取得が理論残高に載る", async () => {
    const withCsv = await taxReconcile({ brokerageCsv: csvPath }, OPTS());
    const without = await taxReconcile({}, OPTS());

    expect(withCsv.success).toBe(true);
    expect(without.success).toBe(true);
    if (!withCsv.success || !without.success) return;
    // API が空なので btc 行が現れること自体が CSV 由来である証拠
    expect(without.data.rows.some((r) => r.currency === "btc")).toBe(false);
    expect(withCsv.data.rows.some((r) => r.currency === "btc")).toBe(true);
  });

  it("tax pnl: 販売所の取得が取引集計に載る", async () => {
    const args = { year: "2026", carryover: "zero" };
    const withCsv = await taxPnl({ ...args, brokerageCsv: csvPath }, OPTS());
    const without = await taxPnl(args, OPTS());

    expect(withCsv.success).toBe(true);
    expect(without.success).toBe(true);
    if (!withCsv.success || !without.success) return;
    expect(without.data.currencies.some((c) => c.currency === "btc")).toBe(false);
    expect(withCsv.data.currencies.some((c) => c.currency === "btc")).toBe(true);
  });

  it("tax verify-report: 販売所ぶんが API 側の集計に入る", async () => {
    // 報告書側は CSV の値と一致させる。渡さなければ REPORT_EXCESS になるはず
    // 列名は annual-report-columns.ts の COLUMNS が単一ソース（位置ではなく名前で引かれる）
    const report = [
      [
        "通貨名",
        "年始数量",
        "JPY建て年中購入数量",
        "JPY建て年中購入金額",
        "BTC建て年中購入数量",
        "BTC建て年中購入金額",
        "JPY建て年中売却数量",
        "JPY建て年中売却金額",
        "BTC建て年中売却数量",
        "BTC建て年中売却金額",
        "移入数量",
        "移出数量",
        "支払手数料",
        "貸出数量",
        "返却数量",
        "貸出損益",
        "年末数量",
      ].join(","),
      [
        "btc",
        "0",
        "0.5",
        "500000",
        "0",
        "0",
        "0",
        "0",
        "0",
        "0",
        "0",
        "0",
        "0",
        "0",
        "0",
        "0",
        "0.5",
      ].join(","),
    ].join("\r\n");
    const reportPath = join(dir, "annual.csv");
    writeFileSync(reportPath, report);

    const withCsv = await taxVerifyReport(
      { year: "2026", csv: reportPath, brokerageCsv: csvPath },
      OPTS(),
    );
    const without = await taxVerifyReport({ year: "2026", csv: reportPath }, OPTS());

    expect(withCsv.success).toBe(true);
    expect(without.success).toBe(true);
    if (!withCsv.success || !without.success) return;

    const buyOf = (rows: typeof withCsv.data.rows) =>
      rows.find((r) => r.currency === "btc" && r.field.includes("buy"));
    // 渡さないと報告書だけに購入があり REPORT_EXCESS、渡せば一致する
    expect(buyOf(without.data.rows)?.diagnosis).toBe("REPORT_EXCESS");
    expect(buyOf(withCsv.data.rows)?.diagnosis).toBe("MATCH");
  });
});
