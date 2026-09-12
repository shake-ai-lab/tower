# エディター利用者役エージェントの操作記録

2026-09-12T04-10-36-015Z / http://127.0.0.1:5173

2 件中 2 件成功・0 件要確認。

実際の React / Monaco 画面をクリック・入力・キー操作で確認。バックエンドのみメモリ上の検証用データに置換。実サーバーの保存・検索実装や、自由探索による未知の問題の網羅を保証するものではありません。

## PASS quick-open-cancel

名前で開くのを取り消したら、直前の本文で編集を続ける

1. notes.txt の本文をクリック
2. Ctrl+P → Esc
3. そのまま文字を入力

期待した操作が完了しました。

[画面](quick-open-cancel.png) / [画面の読み取り](quick-open-cancel.yml) / [操作トレース](quick-open-cancel.zip)

## PASS quick-open-tab

ファイル選択中のTab操作で背面の画面に迷い込まない

1. Ctrl+P
2. Tab と Shift+Tab
3. ファイル名入力のフォーカスを確認

期待した操作が完了しました。

[画面](quick-open-tab.png) / [画面の読み取り](quick-open-tab.yml) / [操作トレース](quick-open-tab.zip)
