# エディター利用者役エージェントの操作記録

2026-09-12T08-29-48-529Z / http://127.0.0.1:5178

2 件中 0 件成功・2 件要確認。

実際の React / Monaco 画面をクリック・入力・キー操作で確認。バックエンドのみメモリ上の検証用データに置換。実サーバーの保存・検索実装や、自由探索による未知の問題の網羅を保証するものではありません。

## FAIL search-after-save

検索で見つけたファイルを編集した後、検索へ戻ると最新の結果が見える

1. apple を検索
2. notes.txt の検索結果を開く
3. 末尾に apple を追記して保存
4. ファイル一覧から検索へ戻る

不満・失敗: 検証環境の未対応API: GET /api/usage; GET /api/usage

[画面](search-after-save.png) / [画面の読み取り](search-after-save.yml) / [操作トレース](search-after-save.zip)

## FAIL loading-focus

ファイルの読込中に検索へ移ったら、読込完了後も検索を続けられる

1. ファイルの読込を1.5秒遅くする
2. Ctrl+P → notes.txt
3. 読込中に検索へ移動して入力
4. 読込完了後の入力先を確認

不満・失敗: 検証環境の未対応API: GET /api/usage; GET /api/usage

[画面](loading-focus.png) / [画面の読み取り](loading-focus.yml) / [操作トレース](loading-focus.zip)
