# リリース手順

`bitbank-lab-cli` の npm publish フロー。`bitbank-lab-mcp` と同じ
tag 駆動 + GitHub Actions 多段階パイプライン。

## ワークフロー概要

`.github/workflows/release.yml` は 3 job で構成される:

1. `ci` — tag 上のコードで lint / typecheck / test を再実行し、
   **plugin manifest の version が tag と一致するか照合**する（不一致なら publish 前に停止）
2. `npm-publish` — tag から `package.json` へ version を注入し agents カタログを
   再生成してから `npm publish --provenance`
3. `github-release` — GitHub Release を自動作成（リリースノート自動生成）

トリガー:

- `v*` tag の push（通常ルート）
- `workflow_dispatch`（手動起動、tag 名を入力）

## バージョン同期

**版数の置き場所は 2 系統あり、同期のタイミングが違う。** 配布経路が別なので
片方のやり方をもう片方に適用すると、ローカルもテストも green のまま配布物だけ壊れる。

### 1. npm 経路 — publish 時に CI が注入する（事前作業なし）

`package.json` は git 上では **`0.0.0-dev` のプレースホルダ**で固定する。
実バージョンは publish 直前に release workflow が入れる:

1. `npm version <tag-version> --no-git-tag-version` — tag から `package.json` へ注入
2. `scripts/gen-agents-catalog.ts` — `agents/tool-catalog.json` /
   `agents/error-catalog.json` / `agents/chart-catalog.json` を再生成
   （`package.json` から `cli_version` を埋め込む）

> **`package.json` の version を手で上げてはいけない。** tag と一致すると
> `npm version` が "Version not changed" で落ちて publish が失敗する
> （前科: 姉妹リポ `bitbank-lab-mcp` の v0.4.0 →
> [#30](https://github.com/bitbankinc/bitbank-lab-mcp/pull/30)）。
> chaos `x23` がプレースホルダであることを検査する。

### 2. plugin 経路 — tag を切る**前**にローカルで書いてコミットする

plugin manifest 5 種は **npm tarball に入らない**（`package.json` の `files`
対象外。`npm pack --dry-run` で確認できる）。marketplace / plugin client が読むのは
**git tag のツリー**で、release workflow は tag が push された後に走るため、
CI 側からは tagged tree を直せない。したがって版上げはリリース準備コミットに含める:

```bash
npx tsx scripts/sync-version.ts 0.3.1   # 5 種の manifest を書き換える
```

対象（`scripts/sync-version.ts` の `TARGETS` が単一ソース）:

- `.claude-plugin/plugin.json` / `.cursor-plugin/plugin.json` /
  `.codex-plugin/plugin.json` / `gemini-extension.json` / `plugin.json`

release workflow の `ci` job が `sync-version.ts --check <tag>` で tag との一致を
照合し、ズレていれば **publish 前に落とす**。落ちたら manifest を直してコミットし、
tag を切り直す。

ルートの `plugin.json` は Antigravity CLI（旧 Gemini CLI）のネイティブ
plugin manifest。旧 CLI 互換の `gemini-extension.json` と両置きすることで
新旧どちらの CLI からもリモート install できる。

`.claude-plugin/marketplace.json` は marketplace カタログで version を持たないため
同期対象外（`TARGETS` に入れない）。

## 手順

```bash
# 1. CHANGELOG の [Unreleased] を更新し、plugin manifest の版数を上げて main にマージ
#    （package.json は 0.0.0-dev のまま触らない）
npx tsx scripts/sync-version.ts 0.2.1
git commit -am "chore: v0.2.1 リリース準備"

# 2. tag を作成して push
git tag v0.2.1
git push origin v0.2.1

# tag push で release.yml が起動し、OIDC trusted publishing 経由で
# npm publish + GitHub Release が実行される。

# 3. 完了後に /tmp で動作確認 (鉄則)
cd /tmp && npx -y bitbank-lab-cli@0.2.1 ticker btc_jpy
```

### prerelease

`-alpha` / `-beta` / `-rc` を含む tag は npm dist-tag `beta` で公開され、
GitHub Release は prerelease として作成される:

```bash
git tag v0.3.0-beta.1
git push origin v0.3.0-beta.1
```

### 手動起動（workflow_dispatch）

GitHub Actions の Release workflow から手動実行し、tag 名（例: `v0.2.1`）を
指定できる。通常は tag push で十分。

### 手動 publish（フォールバック）

OIDC が使えない / workflow が失敗した場合の緊急用:

```bash
VERSION=0.2.1
npx tsx scripts/sync-version.ts --check "$VERSION"   # manifest が tag と揃っているか確認
npm version "$VERSION" --no-git-tag-version
npx tsx scripts/gen-agents-catalog.ts
npm publish --otp=<OTP>

# publish 後は必ずプレースホルダへ戻す（コミットしない運用でも可）。
# `npm version` は package-lock.json の version も書き換えるので一緒に戻す
git checkout package.json package-lock.json agents/
```

`--provenance` は OIDC 経由でしか付かないため、手動 publish したバージョンは
provenance 表示が無くなる点に注意。

## OIDC trusted publishing 設定（初回のみ）

1. https://www.npmjs.com/package/bitbank-lab-cli/access で
   "Trusted Publisher" を追加
2. GitHub repo: `bitbankinc/bitbank-lab-cli`、workflow: `release.yml`、
   environment: `production`
3. GitHub repo に `production` environment を作成（Settings → Environments）
4. アカウント側で 2FA を `auth-and-writes` に設定（手動 publish 時の保険）

その他のリポジトリ側初回設定（branch protection / private vulnerability
reporting 等）は [`repo-security.md`](repo-security.md) を参照。

`patch` / `minor` / `major` は SemVer に従う。0.x は SemVer 上 minor で
breaking 可なので初期改修は patch 相当の tag を増やしていく。

## publish 後の検証

publish 直後に必ず別環境（`/tmp` 等）で動作確認する。npm registry の
反映には数秒〜数十秒かかるので少し待ってから:

```bash
npx -y bitbank-lab-cli@<新 version> --help
npx -y bitbank-lab-cli@<新 version> ticker btc_jpy
```

unpublish は publish 後 24 時間以内のみ可能。それ以降は deprecate しか
できないので、publish 前の `npm pack --dry-run` 確認 + `/tmp` 検証は
省略しないこと。

## owner 移管（将来）

公式 org への移管は npm 上で連続的に引き継げる:

```bash
npm owner add bitbankinc bitbank-lab-cli
npm owner rm tjackiet bitbank-lab-cli
```

GitHub repo の transfer も並行してやる。
