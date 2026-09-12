# エディター利用者役エージェントの操作記録

2026-09-12T04-15-49-718Z / http://127.0.0.1:5178

1 件中 0 件成功・1 件要確認。

実際の React / Monaco 画面をクリック・入力・キー操作で確認。バックエンドのみメモリ上の検証用データに置換。実サーバーの保存・検索実装や、自由探索による未知の問題の網羅を保証するものではありません。

## FAIL quick-open-keyboard

Ctrl+Pの直後、入力欄をクリックせずファイル名を打てる

1. notes.txt の本文へフォーカス
2. Ctrl+P
3. そのまま notes と入力

不満・失敗: Ctrl+P直後の文字がファイル名入力欄に届かない

[画面](quick-open-keyboard.png) / [画面の読み取り](quick-open-keyboard.yml) / [操作トレース](quick-open-keyboard.zip)
