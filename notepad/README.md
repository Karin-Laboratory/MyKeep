# Karin Notepad

Windows のメモ帳風の軽量 Web エディター。 https://notepad.karin-lab.com 

機能: 複数タブ、ファイル読み込み、UTF-8 テキストのダウンロード保存、検索・置換、折り返し、ズーム、ライト・ダーク、ショートカット、ブラウザ内の自動復元。

文章はブラウザの localStorage のみに保存され、サーバーへ送信しません。データ消去に備え、重要な内容はローカルファイルに保存してください。

Worker ソース: notepad/worker.js

Cloudflare Workers デプロイ例: wrangler deploy notepad/worker.js --name karin-notepad --compatibility-date 2026-10-11

Microsoft の公式ソフトではない独立実装です。保存はブラウザからのダウンロード方式です。

専用リポジトリ作成の API が接続にないため、独立ブランチ notepad-web に置いています。main は変更していません。
