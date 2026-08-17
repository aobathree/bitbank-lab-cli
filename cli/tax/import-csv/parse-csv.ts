// UI CSV 共通のパーサ。責務は「バイト列 → 行 × セル」だけで、列の意味は持たない。
//
// bitbank の書き出しは **UTF-8 BOM 付き**。BOM を落とし損ねると先頭セルが
// "﻿通貨名" になり、列名によるヘッダ検出が静かに失敗する（位置指定なら
// 気づかないまま全列ずれる）ので、復号の段でだけ処理する。
// Excel を経由して Shift_JIS になったファイルも来得るため、UTF-8 として
// 復号できないバイトがあれば復号し直す。
import { readFileSync, statSync } from "node:fs";
import { EXIT } from "../../exit-codes.js";
import { fsErrorSuffix } from "../../fs-error.js";
import type { Result } from "../../types.js";

const BOM = "﻿";
/** 復号失敗のシグナル。UTF-8 として不正なバイト列はここに落ちる */
const REPLACEMENT = "�";

const fail = (error: string): Result<never> => ({ success: false, error, exitCode: EXIT.PARAM });

/**
 * 読み込み上限。年間取引報告書・売買履歴は実測で数百 KiB なので十分すぎる余裕がある。
 * V8 の最大文字列長（約 0.5 GiB）を超えるファイルは `TextDecoder.decode` が RangeError を
 * 投げ、Result の外へ throw が漏れる。読む前のサイズ判定で手前から閉じる。
 */
export const MAX_CSV_BYTES = 64 * 1024 * 1024;

/**
 * RFC 4180 相当。引用符内のカンマ・改行・`""` エスケープを扱う。
 * 行区切りは LF / CRLF のみ（CR 単独は区切りにしない。現行の書き出しに存在せず、
 * 「引用符内の CR がデータ」との区別を捨てる方が危ないため）。
 */
export function parseCsv(text: string): string[][] {
  const src = text.startsWith(BOM) ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c !== '"') cell += c;
      else if (src[i + 1] === '"') {
        cell += '"';
        i++;
      } else quoted = false;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n") {
      row.push(cell.endsWith("\r") ? cell.slice(0, -1) : cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/** UTF-8 側の decode も try で包む。サイズ上限をすり抜けても throw を外へ出さないため。 */
function decode(buf: Uint8Array, path: string): Result<string> {
  let text: string;
  try {
    text = new TextDecoder("utf-8").decode(buf);
  } catch {
    return fail(`Cannot decode CSV file: ${path}`);
  }
  if (!text.includes(REPLACEMENT)) return { success: true, data: text };
  try {
    return { success: true, data: new TextDecoder("shift_jis", { fatal: true }).decode(buf) };
  } catch {
    return fail(`CSV is neither UTF-8 nor Shift_JIS: ${path}`);
  }
}

/** ファイルから読む。読めない・大きすぎる・復号できないは Result のエラーにする（throw しない）。 */
export function readCsvFile(path: string, maxBytes: number = MAX_CSV_BYTES): Result<string[][]> {
  let buf: Uint8Array;
  try {
    const { size } = statSync(path);
    if (size > maxBytes) {
      return fail(
        `CSV file is too large: ${size} bytes exceeds the ${maxBytes} byte limit: ${path}`,
      );
    }
    buf = readFileSync(path);
  } catch (e) {
    // stat / read どちらで落ちても errno が理由を持つので try は分けない
    return fail(`Cannot read CSV file: ${path}${fsErrorSuffix(e)}`);
  }
  const decoded = decode(buf, path);
  if (!decoded.success) return decoded;
  return { success: true, data: parseCsv(decoded.data) };
}
