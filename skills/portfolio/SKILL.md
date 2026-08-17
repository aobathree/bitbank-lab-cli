---
name: portfolio
description: |
  bitbank の保有資産と価格データから、ポートフォリオの現況
  （資産構成・JPY 建て評価額・入出金を調整した資産推移）を把握する。
  代表トリガー: 「ポートフォリオの状況を見せて」「今いくら持ってる？」
  「含み益ある？」「最近の損益は？」
  注意: 任意ペアの相関分析は correlation-analysis、単一銘柄のリスク
  特性は volatility-profile が担当。本 skill は保有資産の評価に特化。
  取得価額との差（含み損益）は計算できない。「含み益ある？」には評価額と
  推移で答え、取得価額が要る判定は tax-report へ案内する。
compatibility: |
  Requires the bitbank CLI on PATH (install separately: npm i -g bitbank-lab-cli).
  Plugin install alone does NOT bundle the CLI or its dependencies. Node.js 22+.
  Private API commands need credentials from a configured profile (recommended)
  or legacy environment variables; see _shared/references/cli-conventions.md.
  Read-only: private GETs (assets, balance-history — which internally reads
  trade-history / deposit-history / withdrawal-history) plus public market data
  (tickers-jpy, pairs, candles). It never POSTs.
metadata:
  author: bitbankinc
  version: "3.0"
  requires:
    bins:
      - bitbank
---

# ポートフォリオ Skill

## いつ使うか

代表トリガー以外にも以下のような発話で起動する:

- 「資産推移を見たい」「保有資産の比率を確認して」
- 「資産減ってない？」「JPYに換算するといくら？」
- 保有資産・残高・損益についての質問全般

### 「含み益ある？」への答え方

本 skill は**取得価額を持たない**ので、含み益・含み損（取得価額と時価の差）は
出せない。この発話では tax-report へ丸投げせず、以下の順で答える:

1. 現在の評価額と構成（出力項目 1）を出す
2. 希望があれば資産推移（出力項目 2）を出し、**入出金を除いた増減**を示す
3. そのうえで「含み益・含み損の判定には取得価額が必要で、それは tax-report
   （`tax pnl` の参考損益）の担当です」と案内する

**`調整後増減` を含み損益と呼ばない。** あれは入出金を除いた評価額の増減であって、
取得原価ベースの損益ではない（同じ評価額でも、いつ買ったかで含み損益は変わる）。

## 前提: Private API の認証設定

Private API コマンド（`assets` / `balance-history`）を使うには API キー /
シークレットを設定する。詳細は `_shared/references/cli-conventions.md` の「認証」を参照。

### 推奨: profile（profiles.json）

```bash
bitbank profile add main                    # 一度だけ登録（secret は対話 hidden 入力）
bitbank assets --format=json --machine      # default profile が使われる
bitbank --profile=sub assets --format=json --machine   # 別アカウントへ切替
```

### 後方互換: env vars

```bash
set -a; source .env; set +a
bitbank assets --format=json --machine
```

**API キー未設定の場合:** ユーザーに `bitbank profile add <name>` を案内し、Public API（ticker, candles）だけで可能な分析を行う。

## 分析フロー

### Step 1: 保有資産の取得

```bash
bitbank assets --format=json --machine   # profile 利用時はそのまま実行
# legacy: set -a; source .env; set +a; bitbank assets --format=json --machine
```

### Step 2: 現在価格の取得

全 JPY ペアの ticker を一括取得:

```bash
bitbank tickers-jpy --format=json --machine
```

### Step 3: 資産推移の取得（出力項目 2 を出すときだけ）

```bash
# 既定は直近 30 日・日次
bitbank balance-history --format=json --machine

# 期間と粒度を指定する（--days と --since は併用不可）
bitbank balance-history --days=365 --granularity=month --format=json --machine
bitbank balance-history --since=1735689600000 --granularity=day --format=json --machine
```

このコマンドが**復元・評価・入出金の調整までを全部やる**。現在の残高から約定・入出金を
逆算して各時点の保有を復元し、その日の 1day 足 open で評価した結果が返る。
**モデルは掛け算をしない**（本 skill は計算をしない）。返り値の `points` / `current` /
`flow` / `change` / `price_quality` / `completeness` / `warnings` / `note` /
`assumptions` を読んで提示するだけ。

### Step 4: 出力

出力項目 1 は Step 1 / 2 のデータからモデルが評価額と比率を出す。
出力項目 2 は Step 3 の確定値をそのまま提示する（再計算しない）。

## 出力項目

### 1. 現在の資産構成

保有資産・評価額・比率を一覧する。

```text
=== 資産構成 ===

総評価額: 2,500,000 JPY

資産  | 保有量   | 評価額      | 比率
JPY  | 500,000 | 500,000    | 20.0%
BTC  | 0.15    | 1,387,500  | 55.5%
ETH  | 2.0     | 612,500    | 24.5%
```

- 評価額 = 保有量 × ticker の `last` 価格（JPY は 1）
- 比率 = 各資産の評価額 / 総評価額

### 2. JPY建て資産推移

Step 3（`balance-history`）の結果を提示する。以下の順序を守る。**前提を表の後ろに
回さない** — 順序そのものが仕様である（理由は下記「前提の提示位置」）。

1. **前提**（`note` / `assumptions`）
2. **警告**（`warnings` / `completeness` / `price_quality`）— あれば
3. **増減の内訳**（`change` / `flow`）
4. **推移テーブル**（`points` + 最終点 `current`）

```text
=== 資産推移（2025-08-01 〜 2026-08-11・月次） ===

前提（表より先に読む）:
- 各時点の保有は現在の残高から約定・入出金を逆算して復元した値で、
  当時の残高スナップショットではない
- 評価は各時点の 1day 足 open（UTC 日境界）。取れない資産は現在価格で代替
- 最終行「現在」だけは復元値ではなく実測（ticker last × 現在残高。
  出金申請中の資産を含むため、出力項目 1 の総評価額とは一致しないことがある）
- 販売所（即時売買）の取引は API に現れないため反映されない

増減の内訳:
  単純増減      : +150,000 JPY (+6.5%)   期首からの評価額の差
  うち純入出金  : +120,000 JPY           入金 − 出金（元本移動のみ）
  調整後増減    :  +30,000 JPY (+1.3%)   単純増減 − 純入出金
  出金手数料    :      770 JPY           上記の調整後増減に既に織り込み済み

日付         | 評価額(JPY) | 前点比
2025-08-01  |  2,300,000 | -
2025-09-01  |  2,180,000 | -5.2%
...
2026-08-01  |  2,420,000 | +1.7%
現在(実測)   |  2,450,000 | +1.2%
```

#### 提示の規律

- **単純増減だけを見出しにしない。** 「+150,000 円」だけを出すと、そのうち
  120,000 円が入金であることが伝わらない。**単純増減・純入出金・調整後増減は
  必ず 3 つ揃えて出す**（この 3 つを分けて見せることが本項目の目的そのもの）
- **`warnings` は握り潰さず全文を伝える。** 要約・省略・「軽微です」の添え書きを
  しない。とくに `completeness.complete` が `false`（履歴がページ上限で打ち切られた /
  グリッドを間引いた）のときは、**表より先に「復元値は信用できない」と明言**し、
  数値は参考値として扱う旨を添える
- **`flow.withdrawal_fee_jpy` は正数の手数料合計。** 符号を反転して「−770」のように
  出さない。コストとしての効果は `adjusted_change_jpy` 側に既に織り込まれているので、
  内訳で二重に引かない
- **`assumptions` も削らない。** 前提ブロックは出力の `note` / `assumptions` を
  そのまま引く。自分の言葉で短く言い換えて条件を落とさない
- `price_quality.level` が `complete` でないときは `fallback_assets` を名指しで挙げる
  （その資産の過去の評価は現在価格で代替されている）
- `partial: true` / `meta.truncated` が envelope に立っていたら、それも合わせて報告する

#### 前提の提示位置（テキストにも図と同じ義務がある）

**「復元値であること・最終点だけ実測であること」は表の前に置く。**
可視化節がチャートに課している注記義務と**同じ強度の義務**をテキスト側にも課す。
20 行の表の後ろに小さく添えるのは、注記が無いのと同じ扱いとする
（旧実装の誤読は、まさに注記が表の後ろにあったために起きた）。

## 自己チェック（Validation Loop）

**出力項目 1 用**の検証。金額の誤りはユーザーの投資判断に直接影響するため、検証なしでの出力は避ける。
出力項目 2 は CLI が計算した確定値なので、**再計算して突き合わせない**（数字を作り直した時点で
本 skill の「計算しない」原則から外れる）。

1. **各資産の評価額の合計 = 総評価額 か？** 不一致なら計算漏れ
2. **比率の合計が 100% になるか？** 丸め誤差（±0.1%）は許容するが、大きくずれていたら計算ミス
3. **JPY の評価額 = 保有量そのものか？** JPY に ticker 価格を掛けていたら誤り
4. **評価額が現実的な範囲か？** BTC 0.01 枚で数十億円など、桁が明らかにおかしければ数値変換ミスの可能性

不整合があれば原因を特定し、修正してから出力する。

## 可視化（オプション）

トリガー規律・実行環境の解決・出力先・スタイル・安全規律は
`_shared/references/visualization-guide.md` に従う。**デフォルトは off**
（ユーザーが明示的に求めたとき、または提案に同意したときだけ描く）。
チャートはテキスト出力（資産構成・資産推移のテーブル）の後に描き、
その置き換えにはしない。

本 skill の標準チャート:

| チャート ID | 内容 | 主な構成要素 |
|---|---|---|
| `portfolio.allocation` | 資産構成 | 出力項目 1 の評価額比率のドーナツ（評価額の大きい順、JPY 現金を含む、中央に総評価額）。ラベルは凡例方式が既定・小口は Others に集約（いずれも下記）。ticker 取得時刻をフッターに。詳細比較用に横棒版への切替も可 |
| `portfolio.value-history` | JPY 建て資産推移 | 出力項目 2 の `points`（復元値）の折れ線 + 最終点 `current`（実測）を別マーカーで。`reconstructed from current balances; last point measured` と期間中の純入出金（`flow.net_flow_jpy`）を図中に明記し、入金による増加を値上がりと読ませない。`price_quality.level` が `complete` でなければ現在価格で代替評価した資産がある旨を、`warnings` があればその要約も添える |

チャート固有の注意:

- 図中の金額・比率は本文のテーブルと一致していること
  （Validation Loop と同じ整合性検証を図にも適用する）
- **`allocation` のラベル規律（凡例方式が既定）**:
  - 凡例に `BTC 79.8% (47,997 JPY)` 形式で銘柄・比率・金額を列挙する
  - スライス内の % 注記は大きいスライス（目安 10% 以上）のみ。
    小スライスは凡例で読む
  - **外周ラベル + 引き出し線は使わない**（小スライスが隣接すると
    ラベルが干渉するため。凡例は matplotlib が自動配置するので
    重なりが構造的に起きない）
- **`allocation` の小口集約ルール**（bitbank は 40 銘柄超に対応しており、
  多銘柄・ダスト保有で円が細切れになるのを防ぐ）:
  - 比率 **3% 未満**の銘柄は「Others」に集約する（閾値はユーザー指定で変更可）
  - 閾値以上でもスライスは**最大 6 枚 + Others** まで（超過分は小さい順に Others へ）
  - Others の**件数・合計比率・主な内訳**を凡例か脚注に書く
    （例: `Others = XRP, DOGE 他 5 銘柄（計 4.2%）`）
  - **JPY（現金）は比率に関わらず独立スライス**にする（現金余力は
    一級の判断材料のため Others に畳まない）
  - 全銘柄の完全な内訳はテキストのテーブル側に必ず残す（チャートは
    テキストを置き換えない）。ダスト精査には横棒版（全銘柄表示）を使う
- **口座情報（評価額・保有量）を含む**ため、画像の共有には注意。ユーザーが
  共有前提と明言している場合は、絶対額を伏せた比率のみの表示を提案する
  （`visualization-guide.md` の安全規律）
- `value-history` の過去点は**逆算による復元**であって当時の残高スナップショットでは
  なく、実測なのは最終点だけである。**この前提と期間中の純入出金を図中の注記から
  省略しない**（本文テキストに課しているのと同じ義務。図だけ見て「増えた」と
  読まれるのを防ぐ）。`completeness.complete` が `false` のときは、その旨も図中に書く

## Gotchas

- **金額は文字列で返る。** 数値変換を忘れると文字列連結になり、評価額が完全に壊れる。`assets` の各フィールド、ticker の価格はすべて文字列
- **locked_amount に注意。** オーダー中の資産は `locked_amount` に入る。表示には `onhand_amount`（総量）を使う。`free_amount` だけ見ると注文中の資産が消える
- **JPY は ticker がない。** JPY の「価格」は常に 1。ticker で取得しようとするとエラーになる
- **`balance-history` の値を作り直さない。** 保有量に過去価格を掛けて推移を組み立てるのは
  **旧実装のやり方で、積み立て口座では実残高から大きく乖離する**（誤読の原因）。
  推移が要るときは必ずこのコマンドを呼ぶ
- **`--days` と `--since` は併用不可**（同時指定はエラー）。既定は直近 30 日・日次。
  1 年を超える窓は `--granularity=month` にする（日次はグリッド上限で古い側が落ちる）
- **打ち切りは黙って通さない。** `completeness.complete: false` / `partial: true` が
  出たら `--max-pages` を上げるか窓を狭めて再実行する。直らないなら復元値は使わず、
  その旨をユーザーに伝える（履歴が 1 件欠けるだけで過去の点は静かにずれる）
- **信用取引・販売所は推移に反映されない。** 信用約定は現物残高を動かさないため
  巻き戻しから除外され、販売所（即時売買）の取引は API に現れない。
  どちらも `warnings` / `assumptions` に出るのでそのまま伝える
- **出力項目 1 の総評価額と `current.value_jpy` は完全一致しない場合がある。**
  `balance-history` は出金申請中（`withdrawing_amount`）を実残高に足し戻すため、
  申請中の資産があるとその分だけ大きくなる。差を「計算ミス」と報告しない
- **API エラー時は `_shared/references/bitbank-api-formats.md` を参照**
- **20001 エラー（認証失敗）** → `.env` の設定を確認するようユーザーに案内
