#!/usr/bin/env python3
"""cli/tax/ratio.ts のリファレンス期待値を生成する（ADR-005 の突合プロパティテスト）。

Python の fractions.Fraction を独立実装のリファレンスとして使い、期待値を
cli/__tests__/__fixtures__/tax/ratio-reference.ts（x15: cli/ 配下は .ts のみ）へ書き出す。
決定論的（固定 seed）なので再実行しても差分ゼロ。

  python3 scripts/dev/gen-ratio-reference.py

開発用スクリプト。ビルド・CI からは呼ばない（生成物のみをコミットする）。
"""
import json
import random
import subprocess
from fractions import Fraction
from pathlib import Path

OUT = Path("cli/__tests__/__fixtures__/tax/ratio-reference.ts")
RNG = random.Random(20260725)

# 「キリの良い数値」を避ける: gcd 約分が効きすぎると境界も分母肥大も再現しない。
# **実口座データは使わない**（公開リポジトリのため）。数学定数・素数・任意の 8 桁小数から
# 合成する。必要な性質は「約分が効きにくい互いに素な分子・8 桁の小数」だけで、
# 特定の実測値である必要はない。
UGLY = [
    "0.00013337", "123.456789012", "2.7182818", "3.14159265", "8675309.0",
    "1845000", "1650000", "542800", "0.12345678", "1.6180339", "0.57721566",
    "-1.234567", "97.531086421", "4.019", "65.537", "0.0000001", "7", "3",
    "100", "6", "0.1", "0.3", "1.0000001", "999999999.99999999",
]


def rnd_down(x: Fraction) -> int:  # Excel ROUNDDOWN: ゼロ方向
    return int(x)


def rnd_up(x: Fraction) -> int:  # Excel ROUNDUP: ゼロから離れる方向
    t = int(x)
    if x == t:
        return t
    return t + (1 if x > 0 else -1)


def half_up(x: Fraction) -> int:  # 絶対値の 0.5 を繰り上げ
    t = int(x)
    if x == t:
        return t
    frac = abs(x - t)
    if frac * 2 >= 1:
        return t + (1 if x > 0 else -1)
    return t


ROUNDERS = {"ROUNDDOWN": rnd_down, "ROUNDUP": rnd_up, "HALF_UP": half_up}


def render(x: Fraction, scale: int, mode: str) -> str:
    scaled = ROUNDERS[mode](x * 10**scale)
    neg = scaled < 0
    body = str(abs(scaled)).rjust(scale + 1, "0")
    sign = "-" if neg else ""
    if scale == 0:
        return sign + body
    return f"{sign}{body[:len(body)-scale]}.{body[len(body)-scale:]}"


# 四則は BigInt の整数演算で、値に依存する分岐は「符号」と「ゼロ」だけ。
# 乱択の件数を増やしても新しい経路は踏まないので、経路を突くエッジを決定論的に列挙し、
# 組み合わせ漏れの網として乱択を少量だけ足す。形式: [op, a, b, expectedN, expectedD]
EDGE_PAIRS = [
    ("0", "7"), ("7", "0"), ("0", "0"),                      # ゼロの正規化
    ("-3", "7"), ("3", "-7"), ("-3", "-7"),                  # 符号の全組合せ
    ("0.5", "0.5"), ("100", "6"), ("1", "3"),                # 約分・循環小数
    ("50", "100"), ("300", "6"),                             # gcd が大きく効く
    ("999999999.99999999", "0.00000001"),                    # 桁差が極端
    ("0.1", "0.3"), ("2", "0.5"), ("-0.1", "0.3"),
]
arith = []
for a, b in EDGE_PAIRS:
    for op in ("add", "sub", "mul", "div"):
        fa, fb = Fraction(a), Fraction(b)
        if op == "div" and fb == 0:
            continue
        r = {"add": fa + fb, "sub": fa - fb, "mul": fa * fb, "div": fa / fb if fb else None}[op]
        arith.append([op, a, b, str(r.numerator), str(r.denominator)])
for _ in range(60):
    a, b = RNG.choice(UGLY), RNG.choice(UGLY)
    op = RNG.choice(["add", "sub", "mul", "div"])
    fa, fb = Fraction(a), Fraction(b)
    if op == "div" and fb == 0:
        continue
    r = {"add": fa + fb, "sub": fa - fb, "mul": fa * fb, "div": fa / fb if fb else None}[op]
    arith.append([op, a, b, str(r.numerator), str(r.denominator)])

# 丸めの分岐は有限（rem==0 / 符号 / タイちょうど / スケール）なので、乱択で当てるのではなく
# 全組合せを決定論的に列挙する。x*10^scale の小数部を f に固定して各経路を必ず踏ませる。
# 形式: [n, d, scale, mode, expectedScaled, expectedRendered]
POSITIONS = [
    Fraction(0),          # rem == 0（丸めが起きない経路）
    Fraction(1, 3),       # 0 < f < 1/2
    Fraction(1, 2),       # ちょうど半分（HALF_UP のタイ）
    Fraction(2, 3),       # 1/2 < f < 1
    Fraction(999, 1000),  # 1 に極めて近い
]
rounds = []


def emit_round(x, scale, mode):
    rounds.append([str(x.numerator), str(x.denominator), scale, mode,
                   str(ROUNDERS[mode](x * 10**scale)), render(x, scale, mode)])


for sign in (1, -1):
    for scale in (0, 2, 8):
        for f in POSITIONS:
            x = sign * (Fraction(7) + f) / 10**scale
            for mode in ROUNDERS:
                emit_round(x, scale, mode)
# 整数部ゼロ（レンダリングのゼロ詰め経路）
for f in POSITIONS:
    emit_round(f / 10**8, 8, "ROUNDDOWN")
# 組合せ漏れの網として乱択を少量
for _ in range(30):
    num = RNG.randint(-10**9, 10**9)
    den = RNG.choice([3, 6, 7, 9, 11, 13, 21, 33, 60, 97, 1000003])
    emit_round(Fraction(num, den), RNG.choice([0, 0, 2, 4, 8]), RNG.choice(list(ROUNDERS)))

# 丸め境界: 単価が循環小数 かつ 単価×数量 がちょうど整数（ADR-005 の核心ケース）
boundary = []
for cost, qty, sold in [(100, 6, 3), (100, 3, 1), (1, 7, 7), (1000, 30, 9), (2, 6, 3), (5, 12, 4)]:
    unit = Fraction(cost, qty)
    remain_qty = qty - sold
    remain_cost = unit * remain_qty
    boundary.append({
        "cost": str(cost), "qty": str(qty), "sold": str(sold),
        "unitN": str(unit.numerator), "unitD": str(unit.denominator),
        "remainN": str(remain_cost.numerator), "remainD": str(remain_cost.denominator),
        "remainRoundup": str(rnd_up(remain_cost)),
        "isExactInteger": remain_cost.denominator == 1,
    })

# 移動平均法の合成: 購入/売却の列 → 各時点の (qty, cost) と年間 cogs
def movavg(seq, compat):
    qty, cost, cogs = Fraction(0), Fraction(0), Fraction(0)
    steps = []
    for kind, q, v in seq:
        q, v = Fraction(q), Fraction(v)
        if kind == "buy":
            qty += q
            cost += v
        else:
            unit = cost / qty
            if compat:  # NTA 互換: 売却の都度 残高価額を ROUNDUP（厳密値に 1 回）
                qty -= q
                new_cost = Fraction(rnd_up(unit * qty))
                cogs += cost - new_cost
                cost = new_cost
            else:
                c = cost if qty == q else unit * q
                cogs += c
                cost -= c
                qty -= q
        steps.append({"qtyN": str(qty.numerator), "qtyD": str(qty.denominator),
                      "costN": str(cost.numerator), "costD": str(cost.denominator)})
    return {"steps": steps, "cogsN": str(cogs.numerator), "cogsD": str(cogs.denominator)}


SEQ = [
    ("buy", "4", "1845000"), ("buy", "2", "1650000"), ("sell", "2", "2400000"),
    ("buy", "0.5", "542800"), ("sell", "3", "2895000"),
]
SEQ2 = [("buy", "6", "100"), ("sell", "3", "70"), ("buy", "0.00013337", "1433.7"),
        ("sell", "1.5", "55.5"), ("sell", "1.50013337", "60")]

payload = {
    "arith": arith, "rounds": rounds, "boundary": boundary,
    "movavg": {"faq": movavg(SEQ, False), "faqCompat": movavg(SEQ, True),
               "ugly": movavg(SEQ2, False), "uglyCompat": movavg(SEQ2, True)},
}

OUT.parent.mkdir(parents=True, exist_ok=True)
header = (
    "// 生成物（手書き禁止）: scripts/dev/gen-ratio-reference.py が Python の\n"
    "// fractions.Fraction を独立リファレンスとして期待値を出力する（ADR-005）。\n"
    "// 再生成: python3 scripts/dev/gen-ratio-reference.py\n"
)
def rows(items):
    """1 ケース 1 行で出力する（3,823 行 → 数百行に圧縮）。"""
    return "[\n" + "".join(f"    {json.dumps(i, ensure_ascii=False)},\n" for i in items) + "  ]"


body = (
    "export const ratioReference = {\n"
    f"  // [op, a, b, expectedN, expectedD]\n  arith: {rows(arith)},\n"
    f"  // [n, d, scale, mode, expectedScaled, expectedRendered]\n  rounds: {rows(rounds)},\n"
    f"  boundary: {json.dumps(boundary, indent=2, ensure_ascii=False)},\n"
    f"  movavg: {json.dumps(payload['movavg'], indent=2, ensure_ascii=False)},\n"
    "} as const;\n"
)
OUT.write_text(header + body)

# biome の整形規約（引用符なしキー・末尾カンマ）に合わせる。
# これを通さないと再生成のたびに lint が落ち、生成物の差分ゼロも保てない。
subprocess.run(["npx", "biome", "check", "--write", str(OUT)], check=True,
               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
print(f"{OUT}: arith={len(arith)} rounds={len(rounds)} boundary={len(boundary)} (biome formatted)")
