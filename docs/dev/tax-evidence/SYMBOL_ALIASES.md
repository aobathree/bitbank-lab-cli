# シンボル改称の対応表（判定根拠付き）

> **本書は実口座での検証記録**（[tax-fixtures-plan.md](../tax-fixtures-plan.md)）。
> 生データ（`raw/`）は**本リポジトリには置かない**（`BITBANK_TAX_FIXTURES` が指す別環境）。
> 口座規模が分かる絶対件数・実測金額・実日時は**丸めるか関係式に置換**してある。

- 判定材料: `raw/<batch>/` の `/user/assets`・`/v1/spot/pairs`（62 ペア。公開 API）・全約定履歴
- 「併存」= assets に旧・新シンボルが**別資産として両方存在**すること

## 確定アライアス（1:1 リブランド。インポータで同一資産として名寄せする）

| 旧 | 新 | 換算比 | 根拠 |
|---|---|---|---|
| matic | pol | 1:1 | assets に matic / pol が併存。matic は stop_deposit=true, stop_withdrawal=true（入出金停止）、pol はアクティブ。pairs には matic_jpy / pol_jpy 両方が is_enabled=true で現存。**約定履歴は matic_jpy のみ**（pol_jpy は 0 件）→ 過去約定は旧シンボルのまま残る |
| rndr | render | 1:1 | assets に rndr / render が併存。rndr は stop_deposit=true, stop_withdrawal=true かつ collateral_ratio="0"、render はアクティブ（network_list は solana のみ = Solana 移行後）。pairs には rndr_jpy / render_jpy 両方現存。**約定履歴は rndr_jpy のみ** |

## 要注意（1:1 ではない換言。単純な名寄せ禁止）

| 旧 | 新 | 換算比 | 根拠と注意 |
|---|---|---|---|
| mkr | sky | **1:24,000（外部情報。API からは取得不能）** | assets に mkr / sky が併存。mkr は stop_deposit=true, stop_withdrawal=true かつ collateral_ratio="0"、sky はアクティブ。pairs には mkr_jpy / mkr_btc / sky_jpy が現存。MakerDAO→Sky の移行は 1 MKR = 24,000 SKY の**換算を伴う**ため、matic→pol のような同一視は不可。保有者が自動転換された場合、転換イベントは本 API のどの履歴にも現れない（この口座は mkr 残高 0 のため影響なし） |

## アライアスではないもの（誤名寄せ防止）

| シンボル | 説明 |
|---|---|
| klay | Klaytn→Kaia のリブランドは**bitbank API に未反映**。assets/pairs とも klay / klay_jpy のみで kaia は存在しない → 名寄せ不要（API 内では一貫して klay） |
| bcc | bitbank 固有の Bitcoin Cash 表記（一般的な BCH と同一資産）。改称イベントではなく**恒常的な表記差**。外部データと突合する場合のみ bcc↔BCH のマッピングが必要 |
| omg / boba | 別資産（BOBA は OMG 保有者へのエアドロップ起源だが独立トークン）。名寄せしない |
| sol / sui / sky 等の新規上場 | 改称ではなく新規追加。対応不要 |

## インポータ実装への指針

1. 名寄せテーブルは `{matic→pol, rndr→render}` の 2 件のみ（2026-07-25 時点）
2. 約定履歴のペア名は**改称後も旧名のまま返り続ける**（改称後も matic_jpy の約定が現存することを実測）。名寄せは資産キー側で行い、ペア名は生値のまま保持する
3. mkr→sky のような比率換算を伴う転換は、転換日・比率を手動マスタで持つ（API から取得不能）
4. 検出の自動化: assets で `stop_deposit && stop_withdrawal && collateral_ratio=="0"` の資産と、同名 base の新資産の併存は改称・移行のシグナルになる（rndr が該当。matic は collateral_ratio="0.5" のまま停止中なので、このヒューリスティクスは補助程度）
