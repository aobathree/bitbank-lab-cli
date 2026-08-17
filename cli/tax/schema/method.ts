// 評価方法。**暗号資産の種類（名称）ごと**に選定する（所令119の2、FAQ 2-5）ため、
// 全体既定 + 銘柄別上書きという形で使う。個人の法定評価方法は総平均法（届出がない場合）。
import { z } from "zod";

export const Method = z.enum(["total-average", "moving-average"]);
export type Method = z.infer<typeof Method>;

export const DEFAULT_METHOD: Method = "total-average";
