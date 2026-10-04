# 3段ピン留めのロールバック

改造前のソース: `backup/before-pin-tiers-20261004`（commit f0ed5e7b7ef53c66600d7b6df86cf954dff9695e）。
改造前のCloudflare Workerバージョン: `5f55952b-44c1-444e-87fe-767ff4581466`。

CloudflareのWorker `mykeep` で、このバージョンへ100%ロールバックすればWebとAPIを元に戻せます。メール認証、独自ドメイン、R2、Cronは変更しません。

D1の0007は列を追加するだけなので、ロールバック時は削除・逆マイグレーションをしないでください。従来の pinned（0/1）も維持しており、旧版からメモを利用できます。2・3段目のメモは旧版では通常のピン留めとして表示されます。

今後ソースから旧版を再配置する場合も、workers_dev=false、preview_urls=false、mykeep.karin-lab.comの独自ドメイン設定とCAPTURE_API_KEYを保持してください。
