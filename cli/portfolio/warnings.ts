// 復元を疑うべき理由を文言にする層。
//
// **移植ではない**（姉妹リポ `bitbankinc/bitbank-lab-mcp` に対応するモジュールは無い）。
// 移植元は打ち切りを `DepositWithdrawalData.isComplete` / `complete` で持つだけで、
// 文言としては出さない。CLI は「黙って通さない」を出力契約に含めるため本ファイルを足した
// （ADR-007「不完全データの扱い」）。
//
// **黙って通さない**ための出口なので、
// Result の partial / meta.truncated と重複してでもレポート本体（data.warnings）に残す
// （meta を読まない経路からは partial が見えない。cli/tax/import/collect.ts と同じ判断）。

export const TRUNCATED_WARNING =
  "履歴がページ上限で打ち切られています。1 件でも欠けると復元値が静かにずれます（--max-pages を上げて再実行してください）";

export type WarningInput = {
  /** 約定・入庫・出庫のいずれかがページ上限に当たった */
  historyTruncated: boolean;
  /** 評価時点が MAX_POINTS を超え、古い側を落とした */
  gridTruncated: boolean;
  /** 復元から除外した信用約定のペア。実現損益は JPY 残高を動かすので値は不正確になる */
  marginPairs: readonly string[];
  /** 価格が一切引けず評価・純入出金から落ちた資産（0 円で積んだのと同じ） */
  unpricedAssets: readonly string[];
};

export function buildWarnings(i: WarningInput): string[] {
  const warnings: string[] = [];
  if (i.historyTruncated) warnings.push(TRUNCATED_WARNING);
  if (i.gridTruncated) {
    warnings.push(
      "評価時点が上限に達したため、古い側の点を落としました（--since を狭めてください）",
    );
  }
  if (i.marginPairs.length > 0) {
    warnings.push(
      `信用約定を復元から除外しました（現物残高を動かさないため）: ${i.marginPairs.join(", ")}。` +
        "実現損益は JPY 残高を動かすので、期間内に信用決済があると過去の点がずれます",
    );
  }
  if (i.unpricedAssets.length > 0) {
    warnings.push(
      `価格が引けず評価・純入出金から落ちた資産があります（値は過小です）: ${i.unpricedAssets.join(", ")}`,
    );
  }
  return warnings;
}
