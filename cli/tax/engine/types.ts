// 平均法エンジンの共有型。内部はすべて Ratio（厳密値）で持ち回り、**丸めは一切しない**。
// 十進化するのは出力層（report）と互換モードだけ（ADR-005 / v2 付録F）。
import type { Ratio } from "../ratio.js";
import type { Method } from "../schema/method.js";

export type { Method };

/** 銘柄ごとの簿価。qty は数量、cost は取得価額の残高。 */
export type Book = { qty: Ratio; cost: Ratio };

export type AverageOutcome = {
  currency: string;
  method: Method;
  opening: Book;
  acquired: { qty: Ratio; cost: Ratio };
  disposed: { qty: Ratio; proceeds: Ratio };
  /** 総平均単価 / 年末単価。数量ゼロなど算出不能なら null（計算書は 0 を出す） */
  unit: Ratio | null;
  /** 譲渡原価 */
  cogs: Ratio;
  closing: Book;
  /** 付録A の INCOME / EXPENSE 集計（いずれも JPY・銘柄別） */
  income: Ratio;
  expense: Ratio;
  /**
   * 計算の前提が崩れた事象（数量が負・簿価不明の処分など）。
   * **空でないときは数値を表示してはいけない**。ガードがブロックする根拠になる。
   */
  violations: string[];
};

/** 前年繰越（(H)(I) の引継ぎ）。未入力と「ゼロで確定」は区別する（ガード(c)）。 */
export type OpeningBalances = Record<string, Book>;
