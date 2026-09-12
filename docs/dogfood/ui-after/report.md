# エディター利用者役エージェントの操作記録

2026-09-12T08-30-28-760Z / http://127.0.0.1:5178

13 件中 13 件成功・0 件要確認。

実際の React / Monaco 画面をクリック・入力・キー操作で確認。バックエンドのみメモリ上の検証用データに置換。実サーバーの保存・検索実装や、自由探索による未知の問題の網羅を保証するものではありません。

## PASS search-return

ファイルを確認して検索へ戻っても、探していた内容を失わない

1. Ctrl+Shift+F → apple を検索
2. 大文字と小文字を区別するをオン
3. ファイルへ移動
4. 検索へ戻る

期待した操作が完了しました。

[画面](search-return.png) / [画面の読み取り](search-return.yml) / [操作トレース](search-return.zip)

## PASS search-error

検索に失敗したとき、前の検索結果を現在の結果と取り違えない

1. apple を検索
2. 次の検索通信を失敗させる
3. banana を検索
4. エラーと結果一覧を読む

期待した操作が完了しました。

[画面](search-error.png) / [画面の読み取り](search-error.yml) / [操作トレース](search-error.zip)

## PASS search-pending

通信待ちの間も、いま検索している条件を誤解しない

1. apple を検索
2. 検索通信を1秒遅くする
3. banana を検索
4. 待機中の表示と最終結果を確認

期待した操作が完了しました。

[画面](search-pending.png) / [画面の読み取り](search-pending.yml) / [操作トレース](search-pending.zip)

## PASS quick-open-type

名前でファイルを開き、そのままキーボードで編集する

1. Ctrl+P → notes.txt → Enter
2. マウスで本文を押さずに typing-check と入力
3. 未保存表示を確認

期待した操作が完了しました。

[画面](quick-open-type.png) / [画面の読み取り](quick-open-type.yml) / [操作トレース](quick-open-type.zip)

## PASS search-after-save

検索で見つけたファイルを編集した後、検索へ戻ると最新の結果が見える

1. apple を検索
2. notes.txt の検索結果を開く
3. 末尾に apple を追記して保存
4. ファイル一覧から検索へ戻る

期待した操作が完了しました。

[画面](search-after-save.png) / [画面の読み取り](search-after-save.yml) / [操作トレース](search-after-save.zip)

## PASS loading-focus

ファイルの読込中に検索へ移ったら、読込完了後も検索を続けられる

1. ファイルの読込を1.5秒遅くする
2. Ctrl+P → notes.txt
3. 読込中に検索へ移動して入力
4. 読込完了後の入力先を確認

期待した操作が完了しました。

[画面](loading-focus.png) / [画面の読み取り](loading-focus.yml) / [操作トレース](loading-focus.zip)

## PASS quick-open-reopen

すでに開いているファイルも名前で選び直して入力できる

1. notes.txt を開く
2. もう一度 Ctrl+P → notes.txt → Enter
3. マウスを使わず再入力

期待した操作が完了しました。

[画面](quick-open-reopen.png) / [画面の読み取り](quick-open-reopen.yml) / [操作トレース](quick-open-reopen.zip)

## PASS quick-open-loading

ファイル一覧の読込中に矢印を押しても Enter で開ける

1. 一覧の読込を1秒遅くする
2. Ctrl+P → 読込中に↓
3. 候補の読込完了後 Enter

期待した操作が完了しました。

[画面](quick-open-loading.png) / [画面の読み取り](quick-open-loading.yml) / [操作トレース](quick-open-loading.zip)

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

## PASS quick-open-keyboard

Ctrl+Pの直後、入力欄をクリックせずファイル名を打てる

1. notes.txt の本文へフォーカス
2. Ctrl+P
3. そのまま notes と入力

期待した操作が完了しました。

[画面](quick-open-keyboard.png) / [画面の読み取り](quick-open-keyboard.yml) / [操作トレース](quick-open-keyboard.zip)

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
