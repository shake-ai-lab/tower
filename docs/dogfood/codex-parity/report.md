# Tower Codex の追加互換性検証

2026-09-13。利用者の「完全に同等といえるところまで」という追加依頼に対し、前回残った入力フォーム・Windows出力などを実装し、実モデル、実API、実React画面で検証した。mangaをTowerのCodexから改善した経緯と497件成功・1件既存skipは[前回の記録](../codex-manga-live/report.md)にある。今回mangaの既存変更を取り消していない。

## 実機で確認した経路

独立したTowerサーバー4818、Vite5188、架空のプロジェクトとローカルMCPを使用した。モデルは実Codex 0.154.0-alpha.6.2のgpt-6-astra、高い推論設定。HTTP、WebSocket、モデル応答は置き換えていない。フォームの入力はPlaywrightで実画面を操作した。ローカルMCPの要求と入力だけが試験用データであり、外部アカウントの操作は行っていない。

| 確認事項 | 結果・証拠 |
| --- | --- |
| 通常のMCPフォーム | 文字列・0・false・配列・任意項目の省略が保持された。[結果](form-result.json) |
| 拡張フォーム | 入れ子objectも型を保って返却。秘密値は確認表示とTower履歴に残さない。[結果](form-extended-result.json)、[画面](form-extended-review.png) |
| modern拡張フォーム | 接続時のextension宣言後、実MCPの新しい入口も同じ会話で成功。[結果](form-modern-result.json) |
| 画像・ファイル・フォルダー選択 | 画像ID、プレビュー選択、既存URI、添付のバイト列、実フォルダーURIを確認。[結果](rich-form-result.json)、[画面](rich-form-filled.png) |
| 非同期質問への作業中の回答 | 同文2問を別IDで区別。独立Python処理と回答受理を確認。[結果](questions-async-active-result.json) |
| 応答終了後の非同期回答 | 質問を保持して同じ会話へ続け、モデルが両回答を受信。[結果](questions-async-after-turn-result.json) |
| 停止前の書きかけ回答 | 入力して停止しても内容を保持。再開ボタンで同じ会話へ送信。[結果](questions-async-stop-resume-result.json) |
| 辞退・取消・URL手続き | 前2つはそれぞれdecline/cancel。URLを開いただけでは完了とせず、別の完了操作でaccept。[結果](form-actions-result.json) |
| URL要求が2件同時に届く場合 | 1件目の完了後も次のボタンを操作でき、両方acceptを返した。[結果](url-pair-result.json) |
| 計画モードの同期質問 | 画面で計画モードに切替。実request_user_inputへID別に回答。[結果](questions-sync-result.json) |
| モデル・推論設定と日本語 | 新規画面で選んだ値と実行値が一致。制限付きPowerShell/Pythonの出力がUTF-8で正常。[結果](model-environment-result.json) |
| スキル・MCP・プラグイン一覧 | Codexの読取APIを利用。接続状態未確認を成功と表示しない。[MCP画面](model-environment-inventory.png) |
| サブエージェント | 実子エージェントの完了とレビュー結果を保存。親の独立Python計算も成功。[結果](capability-native-subagent-assertions.json) |
| 画像生成 | 実ImageGenの保存先と画像APIの200、PNGを確認。[結果](capability-native-image-assertions.json) |

サブエージェントの完了結果と生成画像は実画面でも展開して確認した。[UI結果](capability-native-ui-result.json)、[子の画面](capability-native-subagent-ui.png)、[画像の画面](capability-native-image-ui.png)。

画像生成は256×256を希望したが、モデルの実出力は1254×1254だった。画像の生成成功と寸法指定の遵守は分けて記録した。同期質問の秘密入力フラグはモデルが利用するツール定義から指定できなかったため、実モデル試験は公開回答で行い、秘密入力とID衝突の防止はプロトコル回帰・画面描画試験で確認した。秘密値を実際に入力・送信するUI経路はMCPフォームで検証した。

## 再現した不具合と修正

- フルアクセスの`approvalPolicy: never`がMCPフォームも自動辞退した。実行制限を外したまま、`granular.mcp_elicitations: true`で人の入力を受け付けるようにした。値の自動入力は行わない。
- 新しい形式のMCP入力はlegacyのbooleanだけでは機能が宣言されず、-32601になった。接続時にmodernのextensionも宣言するようにした。
- Windowsでは専用の非表示UTF-8コンソールからCodexを起動する。親のコードページ・プロファイル・既存ファイルの文字コードを変更せず、制限付きPowerShellでも日本語を保持する。プロセスはWindows Jobへ生成と同時に所属させ、停止時の子孫プロセス残存を防止した。ランチャーはTEMP外の個別ディレクトリ、ACL、ハッシュ検証で保護する。
- 回答IDと旧質問文の衝突で秘密回答が公開質問へ混ざる問題を修正。回答全体の形式を検証し、曖昧な入力を拒否する。
- 一般のsteer失敗を手番終了と誤認して再送不能になる問題を修正。質問と入力を保ち、失敗表示と再送を可能にした。
- 完了・異常終了・再起動後に検証だけが残る問題を修正。実子プロセスの停止と、保存された未完了状態の中断処理を確認した。
- モデル再ルートで古いモデル名と推論設定が残る問題を修正。通知されたモデルを表示し、新しい推論設定が不明なら値を推測しない。
- 長い同名添付が同一時刻に上書きされる問題を修正。表示名と保存用の一意な名前を分けた。
- 通常・画像・URIの候補と既定値、入れ子の秘密値が入力/確認画面へ露出する問題を修正した。
- 非Gitフォルダーの新規タスクで隠れた分離設定が有効になり起動が400で失敗する問題を修正。子フォルダーの情報を保持し、不明なパスで自動選択しない。
- URL手続きのリンクと完了確認を分けた。連続する承認カードに前の送信中状態を引き継がないようにした。

試験用MCPの初期実装にも誤りがあった。通常フォームへ未対応formatを送ったケースと、拡張フォームを通常のelicitation/createへ送ったケースは、試験側を公式のwire契約へ修正した。製品の不具合とは区別した。

## SDKと対応範囲

Claude Agent SDKの採用だけでClaude側の完全互換を証明したことにはならない。現実装にはMCPのonElicitationや部分ストリームの未接続が残る。Codexにも公式の[SDK](https://learn.chatgpt.com/docs/codex-sdk)と、対話型クライアント向けの[App Server](https://learn.chatgpt.com/docs/app-server)があり、Towerは後者を使用する。

Windows実バイナリのuserVerification/statusはproviderUnavailableを返した。本人確認を成功と偽って返したり、同じWindowsのVS Codeなら可能だと案内したりしない。任意の外部プラグインや将来追加される機能の完全一致まで、この検証からは保証できない。上表の操作に対する実測と、未対応・実行環境の制約を区別する。

## 最終チェック

最終の全体テストは233件成功、失敗・skipなし。全workspaceの型検査、WebとWindowsインストーラのビルド、deployが成功した。[テスト出力](final-tests.txt)。既存の大きいWebチャンクとElectronパッケージ設定に関するビルド警告は残る。重大な独立レビュー指摘は修正後に再確認した。

インストール済みTowerのサーバーとWeb入口がビルド成果物のSHA-256と一致。mangaを対象とする実Codexの一覧でモデル6、スキル13、MCP3、インストール済みプラグイン9を取得した。MCPの接続状態はAPI上未確認なので、接続成功とは表示していない。[インストールと実API](installed-runtime.json)。

更新版4800でも新しい実Codexタスクを作成し、添付テキストの合言葉、添付画像の青い円、日本語コマンド出力、2件の承認、非同期回答からの同一会話継続を実画面で確認した。JavaScript例外0。[結果](installed-ui-result.json)、[画面](installed-ui.png)。

検証用4818と5188は停止済み。利用者のTower4800（PID42488）と既存manga5000（PID22476）は起動中。5173/5179の既存プロセスには触れていない。変更は未コミットで、既存のdocs/feedback.mdの利用者変更4行を保持している。

## 後処理の制約

隔離したCodexから実モデルへ接続するため、既存の認証ファイルを検証専用のホームへ複製した。元の認証ファイルは変更していない。検証後、下記の複製ファイルだけを削除する操作が自動承認審査で「ポリシーによる禁止」として拒否された。別の手段で削除を迂回していない。ファイルの内容は検証記録へ出力していない。

残っている削除対象:

`C:\Users\kouta\AppData\Local\Tower\dogfood\codex-parity-141531ca-cc2c-43a3-8e47-d13e1ab4b018\auth.json`

この専用ホームを利用する検証サーバーとCodexは停止済み。後片付けのこの1ファイルは未完了として残す。前回mangaの検証用一時フォルダーについても、前回記録の削除拒否を覆す操作はしていない。
