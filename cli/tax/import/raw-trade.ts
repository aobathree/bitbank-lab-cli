// 税務経路の生レスポンススキーマ（約定履歴）。既存の private コマンドの `Trade` は
// numStr で **JS number 化**するため有効桁が落ちる。税務では「厳密値を保持し丸めは
// 境界で 1 回だけ」（v2 付録F・ADR-005）なので、ここでは decStr で十進文字列のまま受ける。
//
// enum で締めずに z.string() のまま受けるのは意図的（NFR 堅牢性）。未知の side や
// position_side でパース全体を落とすと 1 行のために全件が取り込めなくなるため、
// 値の妥当性は to-events 側で判定し、判定不能な行だけ保留リストへ送る。
import { z } from "zod";
import { decStr, safeId } from "../../schema-helpers.js";

export const RawTrade = z.object({
  trade_id: safeId,
  pair: z.string(),
  order_id: safeId,
  side: z.string(),
  type: z.string(),
  amount: decStr,
  price: decStr,
  maker_taker: z.string(),
  // 実口座では全行ゼロ。非ゼロなら暗号資産建て手数料（P-11 厳密処理）が必要になる
  fee_amount_base: decStr,
  // 負値 = メイカーリベート（P-04）。信用決済行は建て分込みの請求累計
  fee_amount_quote: decStr,
  fee_occurred_amount_quote: decStr,
  executed_at: z.number().int(),
  // **キーの有無**で現物 / 信用を判定する（null 判定ではない。要求仕様 §3.1）
  position_side: z.string().optional(),
  // 手数料・利息控除後のネット値。再減算は二重計上（要求仕様 §3.1）
  profit_loss: decStr.nullable().optional(),
  interest: decStr.nullable().optional(),
});
export type RawTrade = z.infer<typeof RawTrade>;

export const RawTradeHistory = z.object({ trades: z.array(RawTrade) });
