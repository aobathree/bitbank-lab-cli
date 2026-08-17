// 生レスポンスの保存（collect.ts / collect2.ts 共通）。
// **実口座データをディスクに置く処理なので権限を絞る**: ディレクトリ 0o700・ファイル 0o600。
// 既定の 0o755 / 0o644 だと同一ホストの他ユーザーから読める。
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** 保存先を作る。既存ディレクトリにも権限を効かせるため chmod も行う。 */
export function openRawDir(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return dir;
}

/** JSON を 0o600 で保存し、書いたパスを返す。構造・値は一切変更しない（pretty-print のみ）。 */
export function saveJson(dir: string, name: string, body: unknown): string {
  const file = join(dir, `${name}.json`);
  writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
  return file;
}
