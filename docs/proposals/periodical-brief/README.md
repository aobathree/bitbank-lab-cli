# 提案: `periodical-brief` — 複数銘柄の商い状況ダイジェストを一発で出すコマンド

> これは新機能提案に添える**参考実装**です（本体は TypeScript のため、そのままのマージは想定していません）。
> 提案の経緯・実測データの全体は
> [aobathree/llm-interpreter-compiler-modes](https://github.com/aobathree/llm-interpreter-compiler-modes) を参照してください。

## 何を解決するか

LLM エージェントから `bitbank candles` で生ローソク足 JSON を取得して分析すると、
1回の日次分析で**数万トークン**を消費し、指標の手計算も遅く検算コストがかかります。
計算を CLI 側に寄せ、**1銘柄3行の圧縮ダイジェスト**だけを出力すれば、
LLM が読む量は数十行で済み、取得本数を増やしてもトークン消費は一定になります。
cron / CI から人間向けに使っても有用です。

```
## btc_jpy  px=9,897,365 (-0.0% intraday)  RSI36 MACD- trend:DOWN[<S20 <S50 <S200]  ※日足未確定
   vol today(JST,so far)=38.7 | wk=117 sat=49(42%) sun=54 30d=97
   Sat 08-01(確定): 9,920,000->9,897,393 (-0.2%)  ATR14=275,862
```

- 1行目: 現在値・当日始値比・RSI14・MACD符号・トレンド（SMA20/50/200 との位置関係）・当日足の確定状態
- 2行目: 本日ここまでの出来高と、平日・土・日・30日平均（週末の薄商いが一目で分かる）
- 3行目: 直近確定日の値動きと ATR14（ストップ幅の目安）

指標はすべて**確定足のみ**で計算します（当日足は除外し、値がブレない）。

## 参考実装（Rust）の使い方

```bash
cd rust
cargo build --release
./target/release/periodical_brief btc_jpy eth_jpy   # 銘柄指定
./target/release/periodical_brief --top 10          # 24h売買代金上位10銘柄
./target/release/periodical_brief --all             # 取扱い全銘柄（44・売買代金降順）
```

`--all` / `--top` の母集団は**公式取扱い44銘柄（すべてJPY建て）**です。
tickers API には旧ティッカー（matic_jpy / rndr_jpy / mkr_jpy）や BTC建てクロスペアも
載りますが、現行の取扱い銘柄ではないため除外しています。

public API のみ使用（APIキー不要）。取得は 1銘柄あたり4リクエスト
（日足=今年+昨年の年間ファイル / 時足=直近2日分）で、接続プーリング付き・並列実行です。

## 実測とレート制限の知見

Windows 11 / 同時16並列での実測:

| 銘柄数 | 実行時間（中央値） |
|---|---|
| 3 | 約0.1〜0.2秒 |
| 30 | 約0.3秒 |
| 全44 | **約1.2秒・ERRORゼロ** |

重要な知見として、**並列数無制限にすると30銘柄超で15〜26秒の失速が頻発**します
（エラーは返らず遅延する。トークンバケット型のレート制限と推定）。
そのため参考実装は同時リクエスト数の上限（既定16、`--concurrency` /
`BITBANK_BRIEF_CONCURRENCY` で変更可）をセマフォで持っています。
適正値はサーバー側の制限に依存するため、本家実装時に調整いただくのが最適です。

## 本家 CLI（TypeScript）への実装イメージ

- `bitbank periodical-brief [pairs...] [--top N | --all]` サブコマンドを追加
- 既存の public API クライアント（接続再利用）＋並列 fetch ＋同時数ガード
- 出力はテキスト（human/LLM 両読み）。`--format=json` は既存規約に合わせて任意
- 併せて Skill 1枚（例: 「daily brief 回して」→ 本コマンド実行、ダイジェストだけ読んで一言添える。
  生JSONは文脈に入れない）を追加すると、既存 Skill 群の責務分担と整合します
