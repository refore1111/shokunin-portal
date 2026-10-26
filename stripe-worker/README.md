# Stripe 自動化サーバー（Cloudflare Workers・無料枠）

全体公開の案件の先払いを、**Refore 運営の作業なし**で回すための小さなサーバーです。

- 工務店が「カードで払う」→ 金額ぴったりの Stripe 支払い画面が開く
- 払った瞬間に Stripe が自動で分ける：**工事代金 → 職人さんの Stripe**、**運営手数料 → Refore**
- Stripe から「支払い完了」が届くと、自動で発注が確定（職人さんに発注書・現場情報）
- 職人さんは「登録情報」から自分で Stripe の受け取り登録（本人確認・口座）

## 準備するもの
1. **Stripe**：Connect を有効にする（サンドボックスで試すときはサンドボックスで）
2. **Cloudflare のアカウント**（無料）
3. **ポータルの自動処理用アカウント**：ポータルに新しくアカウントを作り、Firebase の Firestore で `users/{uid}` の `role` を `"op"` にする（例：stripe-bot@refore.co.jp）

## 作り方
1. Cloudflare の管理画面 →「Workers & Pages」→「作成」→「Worker」で `genpuku-stripe` を作る
2. 「コードを編集」で、このフォルダの `worker.js` の中身を貼って「デプロイ」
3. 「設定」→「変数とシークレット」に入れる
   | 名前 | 値 |
   |---|---|
   | STRIPE_SECRET_KEY | Stripe の「開発者」→「API キー」のシークレットキー（テストは `sk_test_…`） |
   | STRIPE_WEBHOOK_SECRET | 下の 4 で出る `whsec_…` |
   | BOT_EMAIL / BOT_PASSWORD | 自動処理用アカウントのメール・パスワード |
   | FIREBASE_API_KEY | index.html の `FIREBASE_CONFIG.apiKey` |
   | FIREBASE_PROJECT_ID | `shokunin-portal` |
   | PORTAL_URL | `https://refore1111.github.io/shokunin-portal/` |
   | ALLOWED_ORIGIN | `https://refore1111.github.io` |
4. Stripe の「開発者」→「Webhook」→「エンドポイントを追加」
   - URL：`https://genpuku-stripe.<あなたのサブドメイン>.workers.dev/webhook`
   - イベント：`checkout.session.completed` と `checkout.session.async_payment_succeeded`
   - 作ったあとに出る「署名シークレット」（`whsec_…`）を 3 の STRIPE_WEBHOOK_SECRET に入れる
5. ポータルに運営で入り、「設定」→「Stripe」→「自動化サーバー」に Worker の URL（`https://genpuku-stripe.….workers.dev`）を入れて保存

## 安全のために
- シークレットキーは Cloudflare の中だけにあり、ポータル（公開されている画面）には入りません
- 金額はサーバーが Firestore の支払いデータから読みます（画面から金額を書き換えても通りません）
- Stripe からの通知は署名を確かめます。金額が合わない支払いは自動で確定せず、運営の画面に出ます
- 同じ通知が2回届いても、確定は1回だけです
