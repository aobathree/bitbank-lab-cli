// 実データ fixtures の場所は環境変数で与える（**リポジトリに実データを置かない**方針。
// docs/dev/tax-fixtures-plan.md）。原型ツールにあったローカル絶対パスの直書きを置換したもの。
import { join } from "node:path";

export const ENV_VAR = "BITBANK_TAX_FIXTURES";

export function fixturesRoot(): string {
  const root = process.env[ENV_VAR];
  if (!root) {
    throw new Error(
      `${ENV_VAR} が未設定です。raw/ を含む fixtures ディレクトリを指定してください。\n` +
        `例: ${ENV_VAR}=/path/to/fixtures npx tsx scripts/dev/tax/reconcile.ts`,
    );
  }
  return root;
}

/** 生レスポンスの置き場（<root>/raw）。 */
export function rawRoot(): string {
  return join(fixturesRoot(), "raw");
}
