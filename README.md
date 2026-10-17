# Refore 協力業者ポータル（プロトタイプ）

協力業者（職人）が登録し、Reforeが掲載した案件に応募、Reforeが発注先を選び、職人が完了報告を送るまでの流れが動くプロトタイプです。

完了報告は、職人が写真を添付したメールを info@refore.co.jp に送る方式です。ポータル上では「報告メールを作成する」ボタンで宛先・件名・案件情報入りのメールが開き、送信後に「報告済み」にすると管理画面に反映されます。写真はサイトに保存しないため、Firebase Storage と従量課金プランは不要です。

## ファイル

- `index.html` … アプリ本体（1ファイル）
- `firestore.rules` … Firestore のセキュリティルール

## まずはデモで触る

`index.html` をブラウザで開くだけで「デモモード」で動きます。データはそのブラウザの中だけに保存されます。画面上部の黄色い帯から、管理者・承認済みの職人・審査中の職人を切り替えて操作できます（パスワードはすべて `demo1234`）。

## 本番（Firebase）で動かす手順

1. **Firebaseプロジェクトを新しく作る**
   kouzimemo とは別のプロジェクトにしてください。外部の職人がログインするため、社内の見積・請求データと切り離します。

2. **Authentication** で「メール/パスワード」を有効にする。

3. **Firestore Database** を作成（ロケーションは `asia-northeast1`（東京）がおすすめ）。
   「ルール」タブに `firestore.rules` の中身を貼り付けて公開。

4. **設定値を貼る**
   プロジェクトの設定 → マイアプリ → ウェブアプリを追加 → 表示される `firebaseConfig` の値を、`index.html` 上部の `FIREBASE_CONFIG` に貼り付けます。`apiKey` が入ると自動で本番モードになります。

5. **公開する**
   GitHub Pages（kouzimemo と同じ方法）か Firebase Hosting に置きます。公開したドメインを Authentication → 設定 → 承認済みドメイン に追加してください。

6. **最初の管理者アカウントを作る**
   - Authentication → ユーザーを追加 で、Refore用のメールとパスワードを登録し、表示された UID をコピー。
   - Firestore で `users` コレクションに、ドキュメントID＝そのUIDで次のフィールドを持つドキュメントを作成：
     - `role`: `admin`
     - `status`: `approved`
     - `name`: `Refore 管理者`
     - `email`: 登録したメール
   - そのメールでログインすると管理画面が開きます。

職人さんには公開URLを伝え、「協力業者として登録する」から登録してもらいます。登録すると管理画面の「協力業者」に審査待ちとして表示されます。

## データ構造

```
users/{uid}                 role, status, name, tradeName, phone, trades[], prefs[], invoiceNumber, insurance, plan …
jobs/{jobId}                companyId, status, title, trades[], pref, city, startDate, endDate, price, description, photos[]（圧縮画像・4枚まで）, assignedTo
jobs/{jobId}/private/detail address, building, keyInfo, manager, contact   ← 発注先と管理者だけ閲覧可
applications/{jobId_uid}    jobId, craftsmanId, message, status
reports/{reportId}          jobId, craftsmanId, method("email"), status, reviewComment   ← 報告本体と写真はメールで届く
```

`companyId`（他社掲載用）と `plan`（サブスク用）は今は使っていませんが、後から機能を足すときに作り直さずに済むよう最初から入れてあります。

## 今回入っていないもの（次の候補）

- 新着案件・採用・差し戻しの通知（メール または LINE）
- 発注確定時に kouzimemo の発注書を作る連携
- 完了報告から請求までの流れ
- 報告メールの受信をポータルに自動で反映する仕組み
- サブスク課金（Stripe）
- 利用規約・プライバシーポリシーのページ

## Stripe と連携するとき（サブスクを始めるとき）

サブスク（プラン・オプション・投稿数の上限・追加枠）の仕組みはできています。今は `index.html` の `SUBSCRIPTION_ON = false` で止めていて、そのあいだは工務店は全部の機能を、上限なし・従業員も何人でも使えます。

始めるときにやること：

1. Stripe の管理画面で「商品」を作る（月額のサブスク）
   - ビギナー 980円／プロ 4,980円／マスター 14,800円（税別）
   - オプション：予定表カレンダー自動反映・収支閲覧・工事メモ/見積/請求書の作成・従業員追加（1人分）
   - 追加枠（1件・1回払い）
2. それぞれの商品で「支払いリンク（Payment Links）」を作る
3. 「カスタマーポータル」を有効にして、ログインリンクをコピーする
4. `index.html` の `const STRIPE = {...}` に、2 と 3 の URL を入れる
   - `links` の名前：`beginner` `pro` `master` `calendar` `money` `docs` `staff` `extra`
5. `SUBSCRIPTION_ON = true` にして公開する
6. Firebase のコンソールで `firestore.rules` を最新にする（工務店がプランを自分で書き換えられないようにするため）

動き方：

- 工務店が「契約・料金」でプランやオプションを選ぶと、Stripe の支払い画面が新しいタブで開きます。その工務店は「お支払いの確認待ち」になります。
  - 支払いリンクには `client_reference_id`（`会社ID__プラン名`）とメールアドレスを付けて開くので、Stripe の支払い一覧でどの会社か分かります。
- 運営は Stripe で入金を確かめてから、運営画面 →「工務店」→ その会社 →「入金を確認して反映」を押します。そこでプランが切り替わります。
- プランを下げる・オプションをやめる予約は、次回請求日に運営画面の「予約中の変更を反映」で反映します。Stripe 側の変更はカスタマーポータルで行います。
- カードの変更・領収書は、工務店の「カードを変更する」からカスタマーポータルが開きます。

自動にしたいとき：Stripe の Webhook を受けるサーバー（Cloud Functions など）を作り、`companies/{会社ID}` の `plan` `opts` `money` `extra` `card` `nextBill` を書き換えて `pendingPay` を消せば、運営の「反映」は要らなくなります。
