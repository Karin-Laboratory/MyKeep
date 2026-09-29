# MyKeep

自分用のシンプルなメモアプリです。メモの作成・編集・一覧、チェックリスト、ラベル、URL、ピン留め、アーカイブ、複数画像の添付・表示・削除、検索、色、ゴミ箱・復元・完全削除に対応します。PWAとしてホーム画面からも起動できます。Chrome 拡張から現在のページも保存できます。Google Keep Takeout のインポートにも対応します。

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

チェックリストは編集画面で項目の追加・削除・チェック切替ができます。項目の並び順は保存されます。ラベルは編集画面で1行に1件ずつ入力し、一覧上部でラベルによる絞り込みができます。1メモあたりチェック項目は500件、ラベルは50件までです。

## ホーム画面に追加

デプロイ後の HTTPS の URL にアクセスし、Cloudflare Access にログインしてから追加します。PCでは通常のブラウザで利用できます。

- iPhone: Safari の共有メニューから「ホーム画面に追加」を選び、「Webアプリとして開く」を有効にして追加します。
- Android: Chrome のメニューから「インストールとショートカットを作成」→「インストール」を選びます。

Service Worker は画面遷移をネットワークから取得するだけです。メモや画像を端末にキャッシュしないため、利用には通信が必要です。

## Chrome 拡張

Chrome で `chrome://extensions` を開き、デベロッパーモードを有効にして「パッケージ化されていない拡張機能を読み込む」から `extension/` を選びます。拡張の設定画面で `API URL` に `https://<MyKeepのホスト>/api/capture`、`API KEY` に Worker の Secret と同じ値を入力して保存します。保存時に、そのホストへの接続許可を求められます。

ツールバーのアイコンを押すと現在ページのタイトルと URL が入ります。メモは任意です。画像は1枚まで、Ctrl+V またはファイル選択で追加して「保存」を押します。対応形式と20MB制限はWeb本体と同じです。

ローカルで試す場合は、Git管理外の `.dev.vars` に `CAPTURE_API_KEY` を設定し、API URL に `http://127.0.0.1:8787/api/capture` を指定します。APIキーをソースコードや D1 に保存しないでください。

## Google Keep Import（Phase 6A・6B-1・6B-2）

画面の「Google Keep Import」を開き、Google Takeout の ZIP を選びます。ZIP と Keep JSON はブラウザで読み取り、Worker へはメモと添付ファイルを1件ずつ送ります。メモと添付それぞれの進捗、成功・失敗・スキップ件数を表示します。タイトル、本文、ピン、アーカイブ、作成日時、更新日時を取り込みます。本文全体がURLの場合はURL欄にも保存します。

Keep JSON の `listContent` から項目のテキスト・チェック状態・配列順を、`labels[].name` からラベルを取り込みます。チェックリストだけのメモも対象です。形式が不正な個別項目・ラベルは読み飛ばし、1メモの上限を超える場合はそのメモを失敗件数に含めます。

Keep JSON の `attachments[].filePath` を、同じ Keep フォルダ内の ZIP エントリへ照合します。画像は既存の表示・R2保存を使い、それ以外の添付はダウンロードできます。添付が見つからない場合や20MBを超える場合は、その添付だけスキップします。ゴミ箱内のメモと、添付もチェックリストもない空のメモはスキップします。再実行時の重複判定はありません。

## 全データのエクスポート（Phase 7）

「全データをエクスポート」を押すと、メモ・アーカイブ・ゴミ箱を50件ずつ取得し、添付ファイルを1件ずつ読み込んでブラウザでZIPを作ります。ZIPには `notes.json`、`markdown/note-000001.md` などの読みやすいメモ、`attachments/` 内の画像・PDF等が入ります。同名の添付はID付きの一意なファイル名にします。添付取得に失敗した場合も続行し、`notes.json` の該当添付の `zip_path` は `null` になります。

保存先を直接選べるブラウザではZIPをファイルへ順次書き込みます。それ以外のブラウザでは完成したZIPをメモリ上のBlobとしてダウンロードするため、大きなバックアップでは端末の空きメモリが必要です。エクスポート中は他の端末・タブでメモを変更しないでください。

## Cloudflare へのデプロイ準備

1. Cloudflare アカウントで `npx wrangler login` を実行します。
2. `npx wrangler d1 create mykeep` で D1 を作ります。
3. 表示された `database_id` を `wrangler.jsonc` の仮 ID と置き換えます。
4. `npx wrangler d1 migrations apply mykeep --remote` を実行します。
5. `npx wrangler r2 bucket create mykeep-images` で画像用の非公開 R2 バケットを作ります。公開アクセスは有効にしません。
6. `npm run deploy` で Worker と Web をデプロイします。
7. Cloudflare ダッシュボードの **Workers & Pages → mykeep → Access** で **Protect this Worker behind Access** を選び、**All traffic** と自分のメールアドレスだけを許可するポリシーを設定します。ログイン方法はメールのワンタイム PIN を使用します。
8. 32バイト以上のランダムな API KEY を用意し、`npx wrangler secret put CAPTURE_API_KEY` で Worker Secret に登録します。同じ値をChrome拡張の設定画面に入力します。
9. 拡張の API URL に使うホストの **`/api/capture` だけ** を対象に、Cloudflare Access のパス別アプリと Bypass ポリシーを設定します。それ以外のパスはメールOTPの保護を維持します。この例外パスは Worker 内の Bearer API KEY で認証します。

**Access の保護と `/api/capture` のAPIキー認証を確認するまで個人データを保存しないでください。** 通常のWeb APIと画像はWebと同じWorker経由で提供し、Accessで保護します。`/api/capture` はAccessの例外パスになるため、APIキーが必須です。

## 継続デプロイ

既存の `mykeep` Worker は Cloudflare Workers Builds で GitHub の `kishi27/MyKeep` に接続しています。`main` への push で自動的に `npm run build` と `npx wrangler deploy` が実行されます。ルートディレクトリは `/`、プレビュービルドは無効です。結果は Cloudflare の **Workers & Pages → mykeep → デプロイ** で確認します。手動で再デプロイする場合は `npm run deploy` を使用します。

## 構成

- `src/`: React の画面
- `worker/`: Worker API
- `extension/`: Chrome Manifest V3 拡張
- `public/`: Manifest、アイコン、Service Worker
- `migrations/`: D1 のスキーマ
- `wrangler.jsonc`: Workers・D1・R2 の設定

メモ一覧は 50 件ずつ読み込みます。画像本体は一覧の JSON に含めず、`loading="lazy"` で必要になった時だけ取得します。
