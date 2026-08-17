#!/bin/sh
# 実口座データが追跡されていないか検査する（docs/dev/tax-fixtures-plan.md）。
# **検出パターンの単一ソース**。pre-commit（lefthook）と CI の両方がこれを呼ぶ。
# 片方だけ更新されて検出がすり抜けるのを防ぐため、正規表現をここ以外に書かない。
#
#   staged : ステージ済みの追加/変更ファイルだけを見る（手元での早期検出）
#   tracked: 追跡ファイル全体を見る（フック迂回・過去分の混入も落とす。CI 用）
set -eu

PATTERN='(^|/)fixtures/([^/]+/)*raw/|user_spot_trades_archived-.*\.csv$|\.private\.json$'

case "${1:-tracked}" in
  staged) FILES=$(git diff --cached --name-only --diff-filter=ACMR) ;;
  tracked) FILES=$(git ls-files) ;;
  *)
    echo "usage: $0 [staged|tracked]" >&2
    exit 2
    ;;
esac

BAD=$(printf '%s\n' "$FILES" | grep -E "$PATTERN" || true)
[ -z "$BAD" ] && exit 0

echo '❌ 実口座データはコミットしない（docs/dev/tax-fixtures-plan.md）:' >&2
echo "$BAD" >&2
exit 1
