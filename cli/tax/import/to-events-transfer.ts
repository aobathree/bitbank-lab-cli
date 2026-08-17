// 入出庫 → TaxEvent。入出庫それ自体は課税イベントではない（付録A）が、
// 残高突合（ガード(d)）と取得価額の由来解決に必須なのでイベント列には必ず載せる。
//
// 採用時刻は P-19: 入庫 = `confirmed_at`（無ければ found_at）／ 出庫 = `requested_at`。
// DONE 以外（CANCELED・未確定）は残高にも税務にも載せないので保留リストへ回す。
import type { TaxEvent } from "../schema/event.js";
import type { EventFlag } from "../schema/primitives.js";
import { baseEvent, ID_PREFIX, type Pending } from "./event-base.js";
import { isGrantSuspect } from "./grant-suspect.js";
import { type RawDeposit, type RawWithdrawal, STATUS_DONE } from "./raw-transfer.js";
import { canonicalAsset } from "./symbol-alias.js";

export function depositEvent(d: RawDeposit): TaxEvent | Pending {
  if (d.status !== STATUS_DONE) {
    // 「取り込めなかった」ではなく「成立していないので載せない」。異常と読まれないよう
    // 種別と意図を書く（実口座で CANCELED を観測。要求仕様 §9 未確定事項#8 の 1 つ）
    return {
      source_ref: d.uuid,
      reason: `入庫 status=${d.status}: 成立していないので残高・税務に載せません（異常ではありません）`,
    };
  }
  const currency = canonicalAsset(d.asset);
  const flags: EventFlag[] = [];
  // v2 §13.3: 入庫理由と取得価額の由来が解決するまで当該銘柄の参考損益をブロックする。
  // 円入金は暗号資産の取得ではないので対象外（ブロックしても意味がない）
  if (currency !== "jpy") flags.push("UNRESOLVED_TRANSFER");
  if (isGrantSuspect(d)) flags.push("GRANT_SUSPECT", "POSSIBLE_ICHIJI_SHOTOKU");

  const event = baseEvent({
    prefix: ID_PREFIX.deposit,
    sourceRef: d.uuid,
    tsUtc: d.confirmed_at ?? d.found_at,
    kind: "DEPOSIT",
    currency,
    qty: d.amount,
    flags,
  });
  // 由来が未解決なので reason は UNKNOWN。手動調整（P1）で解決させる
  return { ...event, transfer: { reason: "UNKNOWN" } };
}

export function withdrawalEvent(w: RawWithdrawal): TaxEvent | Pending {
  if (w.status !== STATUS_DONE) {
    return {
      source_ref: w.uuid,
      reason: `出庫 status=${w.status}: 成立していないので残高・税務に載せません（異常ではありません）`,
    };
  }
  const event = baseEvent({
    prefix: ID_PREFIX.withdrawal,
    sourceRef: w.uuid,
    tsUtc: w.requested_at,
    kind: "WITHDRAWAL",
    currency: canonicalAsset(w.asset),
    qty: w.amount,
  });
  return {
    ...event,
    // 付録E.3: 資産減少 = amount + fee。fee を落とすと残高突合が必ずずれる（P-14）
    transfer: { reason: "UNKNOWN", fee_qty: w.fee },
  };
}
