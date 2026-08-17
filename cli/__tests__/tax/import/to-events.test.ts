// 100行超: 現物 / 信用 / 入出庫の 3 経路を **toEvents オーケストレータ経由**で検証するため。
// 実装は to-events-{spot,margin,transfer}.ts に分かれているが、テストを同じ粒度で割ると
// 共有フィクスチャの組み立て helper を 3 重化することになり見通しが悪くなる。
// ここで見たいのは「振り分け + スキーマ検証まで通った結果」なので入口をひとつに保つ。
//
// 生レコード → 正規化イベントの変換。API 形状は共有フィクスチャ
// （__fixtures__/private/*）を土台にし、税務固有の条件だけを上書きして作る
// （インライン即席モックで実 API 形状から乖離させないため。X-18 と同じ理由）。
import { describe, expect, it } from "vitest";
import type { RawTrade } from "../../../tax/import/raw-trade.js";
import type { RawDeposit, RawWithdrawal } from "../../../tax/import/raw-transfer.js";
import { toEvents } from "../../../tax/import/to-events.js";
import { depositHistoryFixture } from "../../__fixtures__/private/deposit-history.js";
import { tradeHistoryFixture } from "../../__fixtures__/private/trade-history.js";
import { withdrawalHistoryFixture } from "../../__fixtures__/private/withdrawal-history.js";

const marginRow = tradeHistoryFixture.trades[0];
/** フィクスチャの margin 行から position_side を外して現物行を作る。 */
const { position_side: _ps, profit_loss: _pl, interest: _i, ...spotBase } = marginRow;

function spot(over: Partial<RawTrade> = {}): RawTrade {
  return { ...spotBase, ...over } as RawTrade;
}

function run(
  trades: RawTrade[] = [],
  deposits: RawDeposit[] = [],
  withdrawals: RawWithdrawal[] = [],
) {
  return toEvents({ trades, deposits, withdrawals });
}

describe("現物約定の正規化", () => {
  it("買いは TRADE_SPOT_BUY・約定代金を jpy_value に厳密に入れる", () => {
    const r = run([spot({ trade_id: 7, amount: "0.001", price: "15000000", side: "buy" })]);
    expect(r.pending).toEqual([]);
    const e = r.events[0];
    expect(e.kind).toBe("TRADE_SPOT_BUY");
    expect(e.currency).toBe("btc");
    expect(e.jpy_value).toBe("15000"); // 0.001 × 15,000,000
    expect(e.event_id).toBe("trade:7");
    expect(e.costbasis_provenance).toBe("PURCHASE");
    expect(e.market_type).toBe("ORDERBOOK");
    // P-16: API 手数料は 4 桁丸め値であることをフラグで明示する
    expect(e.flags).toContain("FEE_API_ROUNDED");
  });

  it("売りは TRADE_SPOT_SELL で costbasis_provenance を持たない", () => {
    const r = run([spot({ side: "sell" })]);
    expect(r.events[0].kind).toBe("TRADE_SPOT_SELL");
    expect(r.events[0].costbasis_provenance).toBeUndefined();
  });

  it("ペア名は生値保持し、資産キーだけ名寄せする（matic→pol）", () => {
    const r = run([spot({ pair: "matic_jpy", price: "100", amount: "3" })]);
    expect(r.events[0].currency).toBe("pol");
    expect(r.events[0].pair_raw).toBe("matic_jpy");
  });

  it("非 JPY クォートは TRADE_EXCHANGE に隔離し jpy_value を付けない", () => {
    const r = run([spot({ pair: "eth_btc", price: "0.05", amount: "2" })]);
    const e = r.events[0];
    expect(e.kind).toBe("TRADE_EXCHANGE");
    expect(e.jpy_value).toBeUndefined();
    expect(e.flags).toEqual(expect.arrayContaining(["NON_JPY_QUOTE", "NO_RATE"]));
  });

  it("暗号資産建て手数料（fee_amount_base 非ゼロ）は未観測形状として立てる", () => {
    const r = run([spot({ fee_amount_base: "0.0001" })]);
    expect(r.events[0].flags).toContain("UNOBSERVED_SHAPE");
  });

  it("未知の side は捨てずに保留リストへ回す", () => {
    const r = run([spot({ trade_id: 42, side: "short" })]);
    expect(r.events).toEqual([]);
    expect(r.pending).toEqual([{ source_ref: "42", reason: "未知の side: short" }]);
  });
});

describe("信用約定の正規化", () => {
  const open = { ...marginRow, trade_id: 1, side: "buy", position_side: "long", profit_loss: "0" };
  const close = {
    ...marginRow,
    trade_id: 2,
    side: "sell",
    position_side: "long",
    profit_loss: "1000",
    executed_at: marginRow.executed_at + 1000,
  };

  it("position_side と side の組で新規 / 決済を決める", () => {
    const r = run([open, close] as RawTrade[]);
    const kinds = r.events.map((e) => e.kind);
    expect(kinds).toEqual(["MARGIN_OPEN", "MARGIN_CLOSE"]);
  });

  it("realized_net は決済行にだけ載る（profit_loss はネット値・再控除しない）", () => {
    const r = run([open, close] as RawTrade[]);
    expect(r.events[0].margin?.realized_net).toBeUndefined();
    expect(r.events[1].margin?.realized_net).toBe("1000");
    // 分解明細のため fee / interest は併記する（損益からは引かない）
    expect(r.events[1].margin?.fee_charged).toBe("0");
    expect(r.events[1].margin?.interest).toBe("-5");
  });

  it("暗号資産建て手数料は信用でも未観測形状として立てる（現物と同じガード）", () => {
    const r = run([{ ...close, fee_amount_base: "0.0001" }] as RawTrade[]);
    expect(r.events[0].flags).toContain("UNOBSERVED_SHAPE");
  });

  // 観測形状では open 行の profit_loss は "0"（FIELDS.md §1 / ANSWERS.md Q4）。
  // 非ゼロなら新規 / 決済の判定か API の形状が想定と違う。realized_net は CLOSE に
  // しか載せないので、ここで拾わないとその損益はどこにも計上されずに消える
  it("建玉 open 行に実現損益が乗っていたら未観測形状として立てる", () => {
    const r = run([{ ...open, profit_loss: "1000" }] as RawTrade[]);
    expect(r.events[0].kind).toBe("MARGIN_OPEN");
    expect(r.events[0].flags).toContain("UNOBSERVED_SHAPE");
  });

  it("十進として読めない profit_loss も同じ扱い（ゼロと確認できない側に倒す）", () => {
    const r = run([{ ...open, profit_loss: "1e3" }] as RawTrade[]);
    expect(r.events[0].flags).toContain("UNOBSERVED_SHAPE");
  });

  it("観測どおり open の profit_loss が 0 / null なら立てない（誤検知しない）", () => {
    for (const pl of ["0", "0.0000", null, undefined]) {
      const r = run([{ ...open, profit_loss: pl }] as RawTrade[]);
      expect(r.events[0].flags, String(pl)).not.toContain("UNOBSERVED_SHAPE");
    }
  });

  // 決済行は realized_net として正規に載る経路なので、非ゼロでも異常ではない
  it("決済行の profit_loss が非ゼロでも未観測形状にはしない", () => {
    const r = run([close] as RawTrade[]);
    expect(r.events[0].flags).not.toContain("UNOBSERVED_SHAPE");
  });

  it("決済されずに残った建玉は警告として報告する", () => {
    const r = run([open] as RawTrade[]);
    expect(r.warnings.join()).toContain("未決済建玉");
  });

  it("前年に建てた玉の決済だけが入ると、取込漏れの疑いを警告に出す（年またぎ建玉）", () => {
    // verify-report は年ウィンドウでしか取得しない（`tax/verify/run.ts` は year_jst で
    // 絞る前に年範囲で collect する）ため、年をまたぐ建玉は「OPEN の無い CLOSE」として
    // 現れる。tracker の anomaly が **warnings まで届く**ことがここでの検出手段になる。
    // 年末建玉（`unsupported` 行き）とは経路が違うので分けて固定する。
    const r = run([close] as RawTrade[]);
    expect(r.warnings.join()).toContain("建玉残");
    expect(r.warnings.join()).toContain("過年度");
    // ADR-006: 信用損益はガード対象外なので、警告は出しても数値は止めない
    expect(r.events).toHaveLength(1);
  });
});

describe("入出庫の正規化", () => {
  const [confirmed, found, jpy] = depositHistoryFixture.deposits as RawDeposit[];

  it("DONE 以外の入庫は残高に載せず、種別と「異常ではない」ことを添えて保留へ", () => {
    // 実口座で CANCELED を観測（未確定事項#8）。正常な除外なので、異常と読まれる文言に
    // しない。入庫か出庫かも書かないと利用者が追えない
    const r = run([], [found]);
    expect(r.events).toEqual([]);
    expect(r.pending[0].reason).toContain("入庫 status=FOUND");
    expect(r.pending[0].reason).toContain("異常ではありません");
  });

  it("暗号資産の入庫は UNRESOLVED_TRANSFER でブロック対象になる", () => {
    const r = run([], [confirmed]);
    expect(r.events[0].kind).toBe("DEPOSIT");
    expect(r.events[0].flags).toContain("UNRESOLVED_TRANSFER");
    // P-19: 採用時刻は confirmed_at
    expect(r.events[0].ts_utc).toBe(confirmed.confirmed_at);
  });

  it("txid=null の暗号資産入庫は付与の疑い（GRANT_SUSPECT）", () => {
    const r = run([], [{ ...confirmed, txid: null }]);
    expect(r.events[0].flags).toEqual(
      expect.arrayContaining(["GRANT_SUSPECT", "POSSIBLE_ICHIJI_SHOTOKU"]),
    );
  });

  it("円入庫は UNRESOLVED_TRANSFER を立てない（暗号資産の取得ではない）", () => {
    const r = run([], [jpy]);
    expect(r.events[0].currency).toBe("jpy");
    expect(r.events[0].flags).not.toContain("UNRESOLVED_TRANSFER");
  });

  it("円入庫は 3 条件すべて（円未満端数・found==confirmed・分境界）で付与の疑い", () => {
    const at = 1_767_225_600_000; // 秒以下 00.000
    const grant = { ...jpy, amount: "10000.5", found_at: at, confirmed_at: at };
    expect(run([], [grant]).events[0].flags).toContain("GRANT_SUSPECT");
    // 1 条件でも欠ければ立てない
    expect(run([], [{ ...grant, amount: "10000" }]).events[0].flags).not.toContain("GRANT_SUSPECT");
    expect(run([], [{ ...grant, confirmed_at: at + 1 }]).events[0].flags).not.toContain(
      "GRANT_SUSPECT",
    );
    expect(
      run([], [{ ...grant, found_at: at + 1, confirmed_at: at + 1 }]).events[0].flags,
    ).not.toContain("GRANT_SUSPECT");
  });

  it("出庫は fee を transfer.fee_qty に保持する（資産減少 = amount + fee）", () => {
    const w = withdrawalHistoryFixture.withdrawals[0] as RawWithdrawal;
    const r = run([], [], [w]);
    expect(r.events[0].kind).toBe("WITHDRAWAL");
    expect(r.events[0].transfer?.fee_qty).toBe(w.fee);
    expect(r.events[0].ts_utc).toBe(w.requested_at); // P-19: 出庫は requested_at
  });
});
