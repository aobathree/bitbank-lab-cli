// 税務経路の生レスポンススキーマ（入出庫）。raw-trade.ts と同じ理由で decStr 保持。
// fiat と crypto でキーの有無が変わるため、欠落・null の双方を許容する安全側に倒す
// （NFR 堅牢性: 未観測の形状で黙って落ちない）。
import { z } from "zod";
import { decStr } from "../../schema-helpers.js";

export const RawDeposit = z.object({
  uuid: z.string(),
  asset: z.string(),
  amount: decStr,
  network: z.string().optional(),
  address: z.string().optional(),
  // crypto は文字列 or null、fiat はキーごと欠落。txid == null が付与の痕跡（付録E.3）
  txid: z.string().nullable().optional(),
  status: z.string(),
  found_at: z.number().int(),
  // docs: "exists only for confirmed one"。P-19 で採用時刻は confirmed_at
  confirmed_at: z.number().int().nullable().optional(),
});
export type RawDeposit = z.infer<typeof RawDeposit>;

export const RawDepositHistory = z.object({ deposits: z.array(RawDeposit) });

export const RawWithdrawal = z.object({
  uuid: z.string(),
  asset: z.string(),
  amount: decStr,
  // 付録E.3: 出庫の資産減少 = amount + fee（独立再実装で実証済み）
  fee: decStr,
  status: z.string(),
  // 完了時刻フィールドが存在しないため P-19 で requested_at を採用
  requested_at: z.number().int(),
});
export type RawWithdrawal = z.infer<typeof RawWithdrawal>;

export const RawWithdrawalHistory = z.object({ withdrawals: z.array(RawWithdrawal) });

/** DONE 以外（CANCELED / 未確定）は残高にも税務にも載せない。除外は件数で報告する。 */
export const STATUS_DONE = "DONE";
