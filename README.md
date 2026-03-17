# TwitchLaunguage

Twitch配信のチャットコメントで語学学習ができるChrome拡張機能。

## セットアップ手順

### 1. Supabase
1. [supabase.com](https://supabase.com) でプロジェクト作成
2. `supabase/schema.sql` をSQL Editorで実行
3. Authentication → Providers → Google OAuth を有効化
4. 以下の値を控える：
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `SUPABASE_JWT_SECRET`（Project Settings → API → JWT Secret）

### 2. Cloudflare Workers
```bash
cd worker
npm install
# シークレットをセット（1つずつ実行）
wrangler secret put OPENAI_API_KEY
wrangler secret put SUPABASE_URL
wrangler secret put SUPABASE_SERVICE_ROLE_KEY
wrangler secret put SUPABASE_JWT_SECRET
wrangler secret put STRIPE_SECRET_KEY
wrangler secret put STRIPE_WEBHOOK_SECRET
# デプロイ
wrangler deploy
```

### 3. Stripe
1. [stripe.com](https://stripe.com) でアカウント作成
2. Payment Links を3つ作成（$1.99/30枚、$4.99/100枚、$9.99/250枚）
3. 各リンクのmetadataに `coin_amount` を設定（30, 100, 250）
4. Webhook エンドポイントに `https://YOUR_WORKER.workers.dev/webhook/stripe` を登録
5. Webhook Secret を `STRIPE_WEBHOOK_SECRET` としてセット

### 4. 拡張機能ファイルの更新
以下のプレースホルダーを実際の値に置き換える：

| ファイル | プレースホルダー | 値 |
|---|---|---|
| `extension/background/api-client.js` | `YOUR_SUBDOMAIN` | Workersのサブドメイン |
| `extension/popup/popup.js` | `YOUR_SUBDOMAIN` | 同上 |
| `extension/popup/popup.js` | `YOUR_GOOGLE_OAUTH_CLIENT_ID` | Google OAuthクライアントID |
| `extension/popup/popup.js` | `YOUR_LINK_*_COINS` | Stripe Payment LinkのURL |

### 5. Chrome拡張機能のインストール
1. Chrome → `chrome://extensions/` → デベロッパーモード ON
2. 「パッケージ化されていない拡張機能を読み込む」→ `extension/` フォルダを選択

## ファイル構成
```
TwitchLaunguage/
├── DESIGN.md                      # 設計仕様書
├── extension/
│   ├── manifest.json
│   ├── background/
│   │   ├── service-worker.js      # タイマー・先読みキャッシュ・コイン管理
│   │   ├── cache.js               # ローカルキャッシュ管理
│   │   └── api-client.js          # Cloudflare Worker APIクライアント
│   ├── content/
│   │   ├── content.js             # エントリポイント
│   │   ├── observer.js            # Twitchチャット監視
│   │   ├── ui.js                  # オーバーレイUI
│   │   └── overlay.css            # UIスタイル
│   └── popup/
│       ├── popup.html
│       ├── popup.js               # 設定・購入・認証
│       └── popup.css
├── worker/
│   ├── wrangler.toml
│   ├── package.json
│   └── src/
│       ├── index.js               # ルーティング・JWT認証
│       └── routes/
│           ├── auth.js            # 登録・コイン付与
│           ├── phrases.js         # GPT-4o-miniバッチ生成
│           ├── coins.js           # 残量照会・消費
│           └── webhook.js         # Stripe Webhook
└── supabase/
    └── schema.sql                 # テーブル・RLS・関数
```
