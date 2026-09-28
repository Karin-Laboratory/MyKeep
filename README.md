# MyKeep

自分用のシンプルなメモアプリです。メモの作成・編集・一覧、URL、ピン留め、アーカイブ、複数画像の添付・表示・削除、検索、色、ゴミ箱・復元・完全削除に対応します。PWA、Chrome 拡張、インポート、エクスポートは未実装です。

## ローカルで起動

Node.js 20.19 以上を用意し、このフォルダで実行します。

```sh
npm install
npm run db:local
npm run dev
```

表示されたローカル URL を開きます。`npm run dev` は Vite でビルドしてから Wrangler で Web と API を同じポートに公開します。D1 と R2 はローカルで動作します。コード変更後は再起動してください。

画像はメモを保存してから編集画面で追加します。JPEG・PNG・WebP・GIF・AVIF に対応し、1枚20MBまでです。

検索は現在の表示（メモ・アーカイブ・ゴミ箱）のタイトル・本文・URLをD1で部分一致検索します。削除したメモはゴミ箱に入り、添付画像も保持されます。復元すると元のメモまたはアーカイブに戻ります。ゴミ箱で完全削除すると、メモと添付画像を削除します。

## Cloudflare へのデプロイ準備

1. Cloudflare アカウントで `npx wrangler login` を実行します。
2. `npx wrangler d1 create mykeep` で D1 を作ります。
3. 表示された `database_id` を `wrangler.jsonc` の仮 ID と置き換えます。
4. `npx wrangler d1 migrations apply mykeep --remote` を実行します。
5. `npx wrangler r2 bucket create mykeep-images` で画像用の非公開 R2 バケットを作ります。公開アクセスは有効にしません。
6. `npm run deploy` で Worker と Web をデプロイします。
7. Cloudflare ダッシュボードの **Workers & Pages → mykeep → Access** で **Protect this Worker behind Access** を選び、**All traffic** と自分のメールアドレスだけを許可するポリシーを設定します。ログイン方法はメールのワンタイム PIN を使用します。

**Access の All traffic 保護が有効になるまで個人データを保存しないでください。** Worker 単位の保護は `workers.dev`、カスタムドメイン、プレビューをまとめて対象にできます。API と画像はアプリ内認証を持たず、Web と同じ Worker 経由で提供します。

## 構成

- `src/`: React の画面
- `worker/`: Worker API
- `migrations/`: D1 のスキーマ
- `wrangler.jsonc`: Workers・D1・R2 の設定

メモ一覧は 50 件ずつ読み込みます。画像本体は一覧の JSON に含めず、`loading="lazy"` で必要になった時だけ取得します。次の Phase 4 は PWA 化です。
