// 生レコード → 正規化イベント列の入口。約定は margin-tracker で新規 / 決済を確定して
// から現物 / 信用へ振り分け、入出庫と合わせて時系列に並べる。
//
// 組み立てたイベントは**必ず TaxEvent スキーマで検証する**。条件付き必須は
// superRefine が単一ソース（schema/event.ts）なので、ここで独自に条件を書き直すと
// 契約が二重定義になる。検証に落ちた行は捨てずに保留リストへ回す。
import type { BrokerageRow } from "../import-csv/brokerage-columns.js";
import { brokerageEvent } from "../import-csv/to-events-brokerage.js";
import { TaxEvent } from "../schema/event.js";
import { byEventOrder } from "../sort-order.js";
import { isPending, type Normalized, type Pending } from "./event-base.js";
import { trackMargin } from "./margin-tracker.js";
import type { RawTrade } from "./raw-trade.js";
import type { RawDeposit, RawWithdrawal } from "./raw-transfer.js";
import { marginEvent } from "./to-events-margin.js";
import { spotEvent } from "./to-events-spot.js";
import { depositEvent, withdrawalEvent } from "./to-events-transfer.js";

export type RawInput = {
  trades: readonly RawTrade[];
  deposits: readonly RawDeposit[];
  withdrawals: readonly RawWithdrawal[];
  /** 販売所「売買履歴」CSV の行（API には現れない経路。要求仕様 §2.2） */
  brokerage?: readonly BrokerageRow[];
};

export type NormalizeResult = Normalized & {
  /** 建玉の整合違反など、取込は出来たが要確認の事象 */
  warnings: string[];
};

/**
 * 販売所行のうち取り込んでよいものを返す。**注文ID の重複と、取引所約定の order_id との
 * 交差を弾く**（要求仕様 §2.4: ID 空間は交差しない想定だが防御的に検査する）。
 * 交差していれば同じ約定を 2 回計上する恐れがあるので、黙って通さず保留へ回す。
 */
function brokerageRows(input: RawInput, pending: Pending[]): BrokerageRow[] {
  const apiOrderIds = new Set(input.trades.map((t) => String(t.order_id)));
  const seen = new Set<string>();
  const out: BrokerageRow[] = [];
  for (const b of input.brokerage ?? []) {
    if (seen.has(b.order_id)) {
      pending.push({ source_ref: b.order_id, reason: "販売所 CSV 内で注文ID が重複しています" });
    } else if (apiOrderIds.has(b.order_id)) {
      pending.push({
        source_ref: b.order_id,
        reason: "注文ID が API の約定と一致します（二重計上の恐れ。取込元を確認してください）",
      });
    } else {
      seen.add(b.order_id);
      out.push(b);
    }
  }
  return out;
}

export function toEvents(input: RawInput): NormalizeResult {
  const events: TaxEvent[] = [];
  const pending: Pending[] = [];
  const collect = (v: TaxEvent | Pending): void => {
    if (isPending(v)) pending.push(v);
    else events.push(v);
  };

  const margin = trackMargin(input.trades);
  for (const t of input.trades) {
    collect(
      t.position_side === undefined ? spotEvent(t) : marginEvent(t, margin.roles.get(t.trade_id)),
    );
  }
  for (const d of input.deposits) collect(depositEvent(d));
  for (const w of input.withdrawals) collect(withdrawalEvent(w));
  for (const b of brokerageRows(input, pending)) collect(brokerageEvent(b));

  const validated: TaxEvent[] = [];
  for (const e of events) {
    const parsed = TaxEvent.safeParse(e);
    if (parsed.success) validated.push(parsed.data);
    else
      pending.push({ source_ref: e.source_ref, reason: `スキーマ違反: ${parsed.error.message}` });
  }

  // 決定論性 NFR: 同一タイムスタンプは約定ID の数値順（`sort-order.ts` が単一ソース）
  validated.sort(byEventOrder);

  const warnings = margin.anomalies.map((a) => `trade_id=${a.trade_id}: ${a.reason}`);
  if (margin.outstanding.length > 0) {
    const list = margin.outstanding.map((o) => `${o.key}=${o.qty}`).join(", ");
    // 未決済建玉は当年損益に含めない（v2 §5）。含めないこと自体を明示する
    warnings.push(`未決済建玉が残っています（当年損益には含めません）: ${list}`);
  }
  return { events: validated, pending, warnings };
}
