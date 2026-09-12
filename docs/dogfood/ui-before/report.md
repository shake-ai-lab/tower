# エディター利用者役エージェントの操作記録

2026-09-12T04-06-01-409Z / http://127.0.0.1:5173

8 件中 2 件成功・6 件要確認。

実際の React / Monaco 画面をクリック・入力・キー操作で確認。バックエンドのみメモリ上の検証用データに置換。実サーバーの保存・検索実装や、自由探索による未知の問題の網羅を保証するものではありません。

## FAIL search-return

ファイルを確認して検索へ戻っても、探していた内容を失わない

1. Ctrl+Shift+F → apple を検索
2. 大文字と小文字を区別するをオン
3. ファイルへ移動
4. 検索へ戻る

不満・失敗: 検索へ戻ると入力した apple が消えた

[画面](search-return.png) / [画面の読み取り](search-return.yml) / [操作トレース](search-return.zip)

## FAIL search-error

検索に失敗したとき、前の検索結果を現在の結果と取り違えない

1. apple を検索
2. 次の検索通信を失敗させる
3. banana を検索
4. エラーと結果一覧を読む

不満・失敗: banana の検索失敗後に apple の古い結果が残る

[画面](search-error.png) / [画面の読み取り](search-error.yml) / [操作トレース](search-error.zip)

## FAIL search-pending

通信待ちの間も、いま検索している条件を誤解しない

1. apple を検索
2. 検索通信を1秒遅くする
3. banana を検索
4. 待機中の表示と最終結果を確認

不満・失敗: banana を探している間に apple の結果をクリックできてしまう

[画面](search-pending.png) / [画面の読み取り](search-pending.yml) / [操作トレース](search-pending.zip)

## FAIL quick-open-type

名前でファイルを開き、そのままキーボードで編集する

1. Ctrl+P → notes.txt → Enter
2. マウスで本文を押さずに typing-check と入力
3. 未保存表示を確認

不満・失敗: 名前で開いた直後の文字入力がエディタに届かない

[画面](quick-open-type.png) / [画面の読み取り](quick-open-type.yml) / [操作トレース](quick-open-type.zip)

## FAIL quick-open-reopen

すでに開いているファイルも名前で選び直して入力できる

1. notes.txt を開く
2. もう一度 Ctrl+P → notes.txt → Enter
3. マウスを使わず再入力

不満・失敗: 開いていたファイルを再選択しても入力先が戻らない

[画面](quick-open-reopen.png) / [画面の読み取り](quick-open-reopen.yml) / [操作トレース](quick-open-reopen.zip)

## FAIL quick-open-loading

ファイル一覧の読込中に矢印を押しても Enter で開ける

1. 一覧の読込を1秒遅くする
2. Ctrl+P → 読込中に↓
3. 候補の読込完了後 Enter

不満・失敗: 読込中に↓を押すと候補が選択されず Enter で開けない

[画面](quick-open-loading.png) / [画面の読み取り](quick-open-loading.yml) / [操作トレース](quick-open-loading.zip)

## PASS edit-save

編集を保存し、閉じて開き直したときも内容が残る

1. notes.txt を開く
2. 本文をクリックして編集
3. Ctrl+S
4. 閉じて開き直す

期待した操作が完了しました。

[画面](edit-save.png) / [画面の読み取り](edit-save.yml) / [操作トレース](edit-save.zip)

## PASS dirty-close

未保存ファイルを閉じるのを取り消して、編集を続ける

1. notes.txt を編集
2. Ctrl+W
3. 破棄確認をキャンセル
4. 未保存表示を確認

期待した操作が完了しました。

[画面](dirty-close.png) / [画面の読み取り](dirty-close.yml) / [操作トレース](dirty-close.zip)
