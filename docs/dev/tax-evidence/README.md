# 税務ツール向け API 調査エビデンス

実口座での API 調査・検証の記録。**生データ（`raw/`）は本リポジトリに置かない**
（[tax-fixtures-plan.md](../tax-fixtures-plan.md)）。ここにあるのは**観測事実の文書のみ**で、
口座規模が分かる絶対件数・実測金額・実日時は丸めるか関係式に置換してある。

## 本ディレクトリの内容

| ファイル | 内容 |
|---|---|
| [FIELDS.md](FIELDS.md) | エンドポイント別フィールド一覧（生名・型・単位・符号）。「実例値」列は形状を示す合成値 |
| [ANSWERS.md](ANSWERS.md) | 確認事項 7 点への回答（JSON の形状付き） |
| [BALANCE_RECONCILIATION.md](BALANCE_RECONCILIATION.md) | 残高再構築実験（出庫控除 = amount + fee の確定・未追跡フロー 4 種の検出） |
| [ENDPOINTS.md](ENDPOINTS.md) | プライベート API 全 21 エンドポイントの棚卸し（レンディング系が存在しない根拠） |
| [SYMBOL_ALIASES.md](SYMBOL_ALIASES.md) | シンボル改称対応表（matic→pol, rndr→render / mkr→sky は要注意） |

関連（本ディレクトリ外）:

- **ペアマスタ**: `cli/__tests__/__fixtures__/tax/pairs-master.json`（公開 API `/v1/spot/pairs` の出力。無加工）
- **採取・突合ツール**: `scripts/dev/tax/`（原型を保全。`collect` / `collect2` / `mask` / `raw-get` / `reconcile`）
- **回帰テスト**: `cli/__tests__/tax/fixtures-regression/`（実データがあればフル実行・無ければ skip）

## 生データの置き場所と実行方法

実データは環境変数で指す。リポジトリには**同一性の記録（SHA-256）だけ**が入る。

```bash
export BITBANK_TAX_FIXTURES=/path/to/fixtures   # raw/ を含むディレクトリ

# 原型テスト（node:test・依存なし）
node --test scripts/dev/tax/tests/

# 型スナップショットの再生成（fixture 追加時）
node scripts/dev/tax/tests/gen-schema-snapshot.mjs

# 残高再構築の実行
npx tsx scripts/dev/tax/reconcile.ts

# 同一性マニフェストの再生成（fixture 再採取時）
npx tsx scripts/dev/tax/gen-fixtures-manifest.ts
```

`BITBANK_TAX_FIXTURES` が未設定なら、repo 標準の回帰テスト
（`cli/__tests__/tax/fixtures-regression/`）は **skip** される（fail にはしない）。
データがあるのに manifest と**内容が食い違う**場合だけ fail し、どのファイルが
一致しなかったかを列挙する。

## 生データ側の注意（別環境に置いてあるもの）

- マスキングにより withdrawal の `destination_tag` は生の number が string トークンに
  変わっている（生の型は [FIELDS.md](FIELDS.md) 参照）
- deposit の `address` が `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` の行は bitbank 側の
  プレースホルダー定数（マスクではない。チェーン外付与とみられる行）
- バッチ間でマスクトークンの採番空間は独立（バッチ間の突合には使わない）
- `SCHEMA_SNAPSHOT.json` は生成物。`present` は `always` / `partial` の区分のみを持ち、
  **絶対件数は記録しない**（口座規模の情報になるため）。件数の固定は manifest の SHA-256 が担う
