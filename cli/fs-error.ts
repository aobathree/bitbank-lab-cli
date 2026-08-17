// ファイル読み取り失敗の errno を、ユーザー向けの「理由の別」へ変換する。
//
// メッセージからはパスがマスクで落ちる（error-sanitize.ts）ので、理由まで捨てると
// ユーザー側に切り分けの手掛かりが残らない。特に macOS の TCC（保護フォルダ）は
// stat を通して open だけ止めるため `ls` が成功してしまい、「ファイルが無い」のか
// 「権限で読めない」のかを外から見分けられない。errno はここで一元的に読む。

/** errno を持つ例外か。`e instanceof Error` では `code` が生えないので `in` で絞る。 */
function hasErrno(e: unknown): e is { code: string } {
  return typeof e === "object" && e !== null && "code" in e && typeof e.code === "string";
}

/**
 * 読み取り失敗メッセージへ添える理由。**マップしていない errno は推測で言い換えず空文字**を返し、
 * 「読めなかった」だけの現行文言に戻す（誤った理由を出す方が切り分けを狂わせる）。
 * パスは呼び側が組み立てるのでここでは扱わない。
 */
export function fsErrorSuffix(e: unknown): string {
  if (!hasErrno(e)) return "";
  switch (e.code) {
    case "ENOENT":
      return " (file not found)";
    case "EACCES":
    case "EPERM":
      return " (permission denied)";
    default:
      return "";
  }
}
