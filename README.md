# 🍽️ 世界食べ歩き地図

**世界、すべての国の料理を食べる**企画の記録サイト。
食べた国が世界地図に色づいていき、Discord に写真を投稿すると自動で反映されます。

- 世界地図（choropleth）で「制覇した国」を可視化
- 写真 + コメントのフィード & 国別モーダル
- **Discord チャンネルに投稿 → GitHub Action が自動取り込み → 地図が更新**
- サーバー・DB 不要 / 完全無料（GitHub Pages + GitHub Actions）

---

## 仕組み

```
Discord の投稿用チャンネル（＝投稿箱）
   └─ 写真を添付し、1行目に国名・2行目以降にコメント
        │
        ▼  GitHub Actions（15分ごと + 手動）  ★常駐サーバー不要
   scripts/sync-discord.mjs
   ├─ Discord REST API でチャンネル履歴を取得（未処理分のみ）
   ├─ 画像を images/ に再ホスト（Discord CDN の URL は失効するため）
   └─ data/posts.json を更新して commit & push
        │
        ▼
   GitHub Pages が自動リビルド → 地図の国が色づく
```

**チャンネルが真実の源**です。Action が停止していた間の投稿も、次回実行時に履歴から拾うので取りこぼしません。

---

## セットアップ

### 1. リポジトリを作って公開

```bash
cd world-food-map
git init
git add .
git commit -m "init: 世界食べ歩き地図"
# GitHub で空リポジトリを作成してから:
git branch -M main
git remote add origin https://github.com/<あなた>/world-food-map.git
git push -u origin main
```

### 2. GitHub Pages を有効化

リポジトリの **Settings → Pages** で:

- **Source**: `Deploy from a branch`
- **Branch**: `main` / `/ (root)` → Save

数十秒後、`https://<あなた>.github.io/world-food-map/` で公開されます。
（この時点でサンプル3件が地図に表示されます。動作確認できたら `data/posts.json` の `"source": "seed"` エントリと `images/sample-*.svg` を削除してください）

### 3. Discord Bot を用意

1. https://discord.com/developers/applications → **New Application**
2. 左メニュー **Bot** → **Reset Token** でトークンを取得（後で使う）
3. 同じ Bot 画面で **Message Content Intent** を **ON**（これが無いと本文が読めません）
4. 左メニュー **OAuth2 → URL Generator**:
   - SCOPES: `bot`
   - BOT PERMISSIONS: `View Channels` / `Read Message History`
   - 生成された URL を開いて、自分のサーバーに Bot を招待
5. 投稿用チャンネルの ID を取得
   - Discord の **設定 → 詳細設定 → 開発者モード** を ON
   - チャンネルを右クリック → **チャンネルIDをコピー**

### 4. GitHub にシークレットを登録

リポジトリの **Settings → Secrets and variables → Actions → New repository secret** で2つ登録:

| Name | Value |
|---|---|
| `DISCORD_BOT_TOKEN` | 手順3で取得した Bot トークン |
| `DISCORD_CHANNEL_ID` | 手順3で取得したチャンネルID |

### 5. 動かす

- **Settings → Actions → General** で Actions が有効になっていることを確認
- **Actions タブ → 「Sync from Discord」→ Run workflow** で初回を手動実行
  （初回はチャンネル履歴を最大 `MAX_HISTORY`=800 件まで遡って取り込みます）
- 以降は15分ごとに自動実行されます

> ⚠️ GitHub の仕様で、スケジュール実行はリポジトリに60日間活動が無いと自動停止します。時々 push するか手動実行すれば維持されます。

---

## 投稿のしかた

投稿用チャンネルに**写真を添付**して、キャプションをこう書くだけ:

```
イタリア
ローマ下町のトラットリアで本場カルボナーラ。黒胡椒が効いてる。
```

- **1行目 = 国名**：日本語（`イタリア`）・英語（`Italy`）・2文字コード（`IT`）のいずれでもOK
- **2行目以降 = コメント**（省略可）
- 写真は最初の1枚を使用します

国名が辞書に無い場合は `code: null` で保存され、地図には出ませんが投稿自体は失われません。
`data/countries.json` に別名を足すか、2文字コードで投稿すれば解決します。

---

## カスタマイズ

| やりたいこと | 場所 |
|---|---|
| 世界の分母（既定195カ国）を変える | `assets/app.js` の `WORLD_COUNT` |
| 配色・見た目 | `assets/styles.css`（CSS変数 `--brand` など） |
| 塗りの濃さの段階 | `assets/app.js` の `fillFor()` |
| 遡る履歴の上限 | Action の環境変数 `MAX_HISTORY` |
| 実行間隔 | `.github/workflows/sync.yml` の `cron` |
| 口語の国名エイリアス | `scripts/sync-discord.mjs` の `MANUAL_ALIASES` |

---

## ローカルで確認

相対パスで `fetch` するので、ファイルを直接開くのではなく簡易サーバー経由で:

```bash
npm run serve      # → http://localhost:3000 など
```

Discord 同期をローカルで試すには:

```bash
DISCORD_BOT_TOKEN=xxx DISCORD_CHANNEL_ID=yyy npm run sync
```

---

## ファイル構成

```
index.html              サイト本体
assets/styles.css       スタイル
assets/app.js           地図描画・UI ロジック
data/countries.json     ISO2→{英名, 和名, 別名} 辞書（250カ国・地域）
data/posts.json         投稿データ（Action が更新）
data/.sync-state.json   最後に取り込んだメッセージID（Action が管理）
images/                 投稿写真（Action が再ホスト）
scripts/sync-discord.mjs  Discord 取り込みスクリプト
.github/workflows/sync.yml  定期実行ワークフロー
```

## データ出典

国名辞書は [mledoze/countries](https://github.com/mledoze/countries)（ODbL）を整形して生成。
世界地図は [jsVectorMap](https://github.com/themustafaomar/jsvectormap)（MIT）。
