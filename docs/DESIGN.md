# Tower 設計メモ

## 背景

AIが進化するにつれ、開発者はコードを見ずに、複数プロジェクトで複数のエージェントに指示を出し、結果を見て判断する働き方になる。
VS Code は「1ウィンドウ＝1プロジェクト」「ファイルが中心単位」なので、この働き方には合わない。
Tower は **「エージェントのセッション」を中心単位** にした管制塔。

## 痛み → 機能

| 痛み | 機能 |
|---|---|
| 許可待ちに気づかない | 判断インボックス（全セッション横断の待ち行列）+ デスクトップ通知 + タブタイトルの件数 |
| 進捗が分からない | カードに「今やってること」1行を常時表示（ツール呼び出しを日本語化） |
| 結果確認が面倒 / 文章が読みづらい | 報告カード（依頼 / 結果 / やったこと / 変更ファイル / 判断が必要 / 次の一手）を毎ターン自動生成 |
| 起動が面倒 | プロジェクト選択 + 指示だけで起動。`n` キー、Ctrl+Enter |
| たまにコードも見たい | 年表の詳細（コマンド・入力）を展開。diff/Monaco はフェーズ2 |

## 技術判断

- **TypeScript 一本（React + Node）**: Claude Agent SDK / Codex SDK が TS 本家。AI が一番書き慣れている。型を共有できる
- **Agent SDK を直接使う**（`claude -p` の生パースはしない）: 許可要求・質問・結果が構造化イベントで来る。`canUseTool` で許可と AskUserQuestion の両方が取れる（2026-09-09 に実験で確認: Max の OAuth ログインのまま `apiKeySource: none` で動作）
- **報告書式はシステムプロンプト追記で強制**: `【報告】` マーカー + 固定ラベルを `report.ts` で解析。崩れた時は原文先頭を載せる保険（将来: Haiku で整形し直す）
- **危険度は正規表現ヒューリスティック**（`humanize.ts`）: `rm -rf` / `git push --force` / `reset --hard` などを高、`git push` / `npm install` などを中
- **ブラウザアプリ + ローカルサーバー**: Electron 化は後回し。`host: 0.0.0.0` にすればスマホからも見える
- **SQLite は Node 組み込み `node:sqlite`**: ネイティブビルド不要
- **VS Code 拡張にしない**: マルチプロジェクトの思想と合わないため

## データモデル（packages/shared）

- `Session`: id / project / title / status / activity / pending / report / turns / costUsd / changedFiles …
- `PendingRequest`: `permission`（headline, detail, risk, canAlwaysAllow）| `question`（questions[]）
- `Report`: request / outcome / summary[] / changedFiles[] / needsDecision / nextStep / raw
- `TimelineItem`: user / assistant_text / tool_use / tool_result / permission / system / error
- WS `ServerEvent`: snapshot / session / session_removed / timeline

## 状態遷移

```
starting → running ⇄ waiting_permission
                   ⇄ waiting_question
        → idle（報告あり・指示待ち）→ running（追加指示）
        → done / error / stopped
```

## ロードマップ

### フェーズ1（完了: 2026-09-09）
- Claude セッション起動 / 許可 / 質問 / 追加指示 / 停止 / 削除
- フリート画面・判断インボックス・報告カード・年表
- ブラウザ通知、`?s=<id>` ディープリンク

### フェーズ2（進行中: 2026-09-10）
できたもの:
- **再開（resume）**: 止まったセッションに指示を送ると `agentSessionId` で続きから
- **許可の方針**: 編集は自動 / 毎回確認 / おまかせ（SDK の permissionMode）
- **並列の許可要求**: 1メッセージで複数ツールが同時に許可を求めても待ち行列で1件ずつ捌く（ラウンド1で発見した永久停止バグの修正）
- **差分表示**: git があれば作業ツリーの diff、無ければ触ったファイルの現在の中身
- **裏取り（自動チェック）**: 報告のたびに `npm test` 等を Tower が走らせ、報告と食い違えば警告。「エージェントの『テスト通った』を信じられない」への答え
- **利用者役AIによるドッグフーディング**: `npm run dogfood`。7シナリオを並列で投げて採点と改善提案を出す

- **VS Code / ターミナル連携（bridge）**: Claude Code の hooks（SessionStart / UserPromptSubmit / PreToolUse / Notification / Stop / SessionEnd）を `~/.claude/settings.json` に書き、`apps/server/hooks/tower-hook.mjs` が Tower に転送。`PermissionRequest` hook は Tower の回答を待ち（既定 90 秒）、許可/拒否を返す。時間切れなら `{}` を返して元の画面へ。Tower 自身のセッションは env `TOWER_MANAGED=1` で除外。外部セッションへの指示送信は resume による引き継ぎ

- **Codex 対応**: `agents/codex.ts`（`@openai/codex-sdk`、バイナリ同梱）。`AgentRunner` インターフェース（`agents/types.ts`）で Claude と差し替え可能。codex exec は非対話なので許可確認の代わりに砂場（workspace-write・ネットワーク無し）で安全側に倒す。報告書式は最初の指示の前置きとして渡す。**未ログインのため実走は未検証**（`npx codex login` 後に要確認）

- **別の作業場所（worktree 分離）**（2026-09-10）: 起動時の「別の作業場所で動かす」で、`~/.tower/worktrees/<project>-<id8>/` に `git worktree add -b tower/<id8>` したコピーで作業する（`worktree.ts`）。同じプロジェクトで他のタスクが動いていれば既定でオン。
  - 成果は利用者が「元のプロジェクトに取り込む」を押すまで反映されない。取り込み = 作業場所の未保存分をコミット → 元のプロジェクトで今開いているブランチに `git merge`。競合したら abort して「このセッションに『元のブランチを取り込んで競合を直して』と指示」を案内。何度でも押せる（差分は分岐点からなので取り込み済みは出ない）
  - `node_modules` は元のプロジェクトからジャンクションで共有（無いと `npm test` すら動かない）。消す時は先にリンクを外す
  - セッション削除で worktree とブランチも消す。Windows は子プロセス終了までフォルダを消せないので最大 15 秒再試行
  - エージェントには system prompt で「コピーで作業中・元のフォルダを触らない・push しない・コミット不要」を伝える
  - 制約: git 管理 + コミットが1つ以上あるプロジェクトのみ。`.gitignore` されたファイル（`.env` 等）はコピーに無い

- **報告の再整形**（2026-09-11）: 【報告】が無い・崩れていて結果が「不明」になった報告は、裏で Haiku（Agent SDK をツール無し・JSON 出力で呼ぶ）に原文を渡して報告カードの形に整え、差し替える（`reformat.ts`）。カードに「Tower が整形」の印。原文は残す。主に VS Code / ターミナルの外部セッション向け（報告のルールを知らないので毎回崩れる）。同時実行は 2 本まで、60 文字未満の出力は対象外
- **外部セッションの自動掃除**（2026-09-11）: `externalKeepHours`（既定 24、0 で無効）以上動きの無い外部セッションを起動時と 10 分ごとに一覧から消す（`janitor.ts`）。また動けば hooks から入り直すので消して困らない。Tower 自身のセッションは消さない
- **画面から直す（Monaco）**（2026-09-11）: 「変更されたファイル」の各行に「直す」。Monaco はローカル同梱（CDN 不要）で、押した時に初めて読み込む。保存は作業フォルダ内のみ（`files.ts` でパスを検査、1MB・バイナリは拒否、改行コードは元に合わせる）。保存すると年表に残し、`Session.manualEdits` に覚えて **次の指示に「利用者が手で直したファイル: …」を自動で付け足す**（エージェントに伝わる）。裏取りも走る。エージェントの作業中は編集不可

フェーズ2の予定分は完了。

### フェーズ3（着手: 2026-09-11）
できたもの:
- **修正前 → 修正後の対比**: 起動直後（エージェントが手を付ける前）にも自動チェックを走らせて `Session.baseline` に持つ（`manager.runBaseline`。起動は待たせない）。報告後の裏取りと並べて「修正前: 失敗 2 件 → 修正後: 全部成功（3 件）」と出し、**直った / 修正で壊れた / まだ直っていない** を一言で示す。件数は `summarizeTestOutput` が node:test / jest / vitest / pytest / mocha / cargo の集計行から拾う（拾えなければ OK/NG だけ）。カードの印も「✔ 直った」「✖ 壊れた」「✖ まだNG」に

- **見た目の確認（スクリーンショット）**（2026-09-11）: `preview.ts`。PC に入っている Edge / Chrome を `playwright-core` の `channel` 指定で起動する（ブラウザのダウンロード不要。Edge 起動 0.2 秒、2 枚で 1.4 秒）。対象は `.tower.json` の `preview`（URL）か、フォルダ直下の `index.html`（Tower が空きポートで静的配信）。CSS/HTML に `prefers-color-scheme` があればダークも撮る。起動直後（修正前）と、報告が来るたび（修正後。`manager` が hub の購読で `report.generatedAt` の変化を見る）に撮って `Session.preview` に持ち、画面に「修正前 → 修正後」のサムネイルと拡大表示。エージェントには system prompt で「Tower が撮るのでブラウザを開かなくてよい」と伝える（site-dark で Playwright を入れ始めて 10 回許可を求めた対策）。採点役にも画像を渡す（Haiku の画像入力）

  - 効果（site-dark）: 許可 10 回・207 秒 → **0〜1 回・30 秒**、達成 partial → **yes**（採点役が画像でダークモードを確認）。「完了」+「添付のスクリーンショットで確認して」は完了のまま（保険の対象外）、落とす時は「残り: あなたの確認（…Tower が一部完了にしました）」をやったことに足して理由を見せる

- **開発サーバーの起動**（2026-09-11）: `.tower.json` の `preview.command`。URL に繋がらない時だけ起動し（`BROWSER=none`、`CI=1`）、応答するまで `readySeconds`（既定 60）待って撮り、`taskkill /T`（Windows）かプロセスグループで止める。すぐ落ちたら出力の末尾を添えて失敗
- **自動取り込み**（2026-09-11）: 起動時の「裏取りが通ったら自動で取り込む」（`Workspace.autoMerge`）。`manager` の hub 購読で「報告が完了・裏取りがこの報告に対して OK（テストが無いプロジェクトなら完了だけ）」を見て一度だけ `merge(id, true)`。裏取り NG なら取り込まず年表に理由を残す。ドッグフーディングの todo-isolated はこの方式で採点

- **スマホ向け画面**（2026-09-11）: Tailwind の `md`（768px）未満で、判断インボックスとセッション一覧を下のタブで切り替え、詳細は全画面の重ね表示。起動ダイアログは縦積み。サーバーが `apps/web/dist` を配信するようになった（`npm run build -w apps/web` 後）ので、`host: 0.0.0.0` にすればスマホから 4800 だけで開ける。Playwright（Edge）で 390px 幅の画面を撮って確認
- **デスクトップ版（Electron）**（2026-09-11）: `apps/desktop/main.cjs`。サーバーが無ければ `node tsx apps/server/src/index.ts` を起動し、Vite が動いていれば 5173、無ければ 4800 の配信画面を読む。閉じるとトレイに隠れ、トレイの WebSocket 購読で「判断待ち N 件」をツールチップに出す。通知は画面側の Notification API がそのまま Windows 通知になる（`setAppUserModelId`）。配布用のパッケージ（electron-builder）は未着手。アイコンは Playwright で HTML から描いた PNG。npm の allow-scripts で postinstall が止まるので、初回は `node node_modules/electron/install.js` が要る

### ドッグフーディングで分かったこと（ラウンド1, 2026-09-09）
- 並列ツール呼び出しで2件目の許可要求が消えるバグ → 修正
- 「テスト通った」と報告して実際は落ちている（半分はテンプレの不備、半分はエージェントの確認不足）→ 裏取り機能
- 「README を直した」と言われても中身が見えない → 差分表示
- 進捗・許可の見出しが英語（Bash の description）→ 日本語で書くよう指示
- 報告に `this.items[index + 1]` のようなコード片 → 平易な言葉で書くよう指示
- 利用者役AIの「分かりやすさ」平均 3.3/5（7本）。ラウンド2で再計測

### ラウンド2（2026-09-10、上の修正後）
- 分かりやすさ 3.3 → **4.3/5**、達成 yes 3→4本・no 3→**0本**、並列許可バグ再発なし、質問フロー完走
- 新たな指摘 → 反映済み: 「完了」なのに「次の一手: 確認して」の矛盾（→ 目視が要るなら「一部完了」）、質問で決めた内容を報告に書く、依頼外の変更に印、専門用語に括弧で説明、許可画面で編集の変更前後を見せる、報告の変更ファイル名クリックで差分
- 保留（フェーズ3候補）: 画面の見た目確認をスクリーンショットで自動化して報告に添付、「修正前: 失敗 N 件 → 修正後: 全部成功」のような対比表示

### ラウンド3（2026-09-11、フェーズ2完了後・対比表示あり）
- 分かりやすさ 4.0/5（8本）、達成 yes 4・partial 2・no 1・unknown 1。todo-isolated は取り込み込みで 5/5
- **todo-followup が no**: テンプレートに元からある別のバグでテストが落ち、エージェントが「complete メソッドも直すべきか」と利用者に聞いて止まった。対比表示は「修正前から失敗」と出ていたが、**どのテストが前から落ちていたか**が無いと「壊した」のか「元からか」が分からない → 失敗したテスト名を拾って「新しく壊れた / 修正前からの失敗」を区別。追加指示の時にエージェントにも「作業前から失敗していたテスト」を補足で伝える。報告ルールに「自分の変更が原因か必ず書く」「依頼外のバグは平易に聞く」を追加
- **site-dark**: 「完了」なのに「ブラウザで確認してください」の矛盾が再発（ルールはあるが Haiku が守らない）→ サーバー側で「確認してください」系の文があれば一部完了に落とす保険。スクリーンショットの自動化はエージェントが Playwright を入れ始めて 10 回も許可を求めた（207 秒）ので、Tower 側で持つ方が良い
- **notes-readme が unknown**: 文書系の成果は採点役が中身を見られなかった → 採点役に差分（先頭 1500 文字/ファイル）を渡す
- 未対応の提案: 裏取りが通ったら自動で取り込む（todo-isolated）、報告カードに裏取り結果を統合（別枠を見に行く手間）、失敗テストを赤で目立たせる（対応済み）

### 使った量と履歴検索（2026-09-11）
- 「Tower を使うとタスク以外にトークンを食うのか」という問いに答えられるように、**使った量**を見せる。`Session.usage`（読んだ / うち使い回し / 書いた / 会話の大きさ / 容量）と `costUsd`
  - Claude: result の `modelUsage`（サブエージェントや内部呼び出しも含む全モデル分）を合算。query() の中では累積なので、再開のたびに「開始時点の値」を土台にして足す（以前は `total_cost_usd` をそのまま入れていたので再開でリセットされていた）。会話の大きさは直近の assistant メッセージの入力トークン（= その時点の文脈）
  - Codex: `turn.completed` の usage を 1 ターン分ずつ足す。費用は出ない
  - 外部（VS Code）セッションは量が分からないので出さない
- 詳細パネルに「使った量（目安）」の帯。会話の大きさが容量の 70% を超えたら「新しいタスクとして仕切り直すと忘れにくい」と一言。ヘッダの **使った量** で今日 / 7 日 / 全部と今日のプロジェクト別（画面側で全セッションから集計。サーバーに集計 API は無い）
- 一覧の上に **履歴検索**（プロジェクト名・依頼文・報告の原文・モデル・ブランチ。空白区切りは AND。`/` で移動、Esc で解除）
- Tower 自身が使うトークン: システムプロンプト追記（報告ルール 1331 字 + 撮影の注意 337 字 + 分離の注意）はキャッシュに乗るので 2 往復目以降はほぼ増えない。Haiku 整形は書式が無い時だけ。`agentProgressSummaries` はサブエージェントの進捗一言で、SDK の説明では「キャッシュを使い回すのでコストは最小」

### 複数のモデルで比べる（2026-09-11）
- `POST /api/sessions/compare`（`CompareBody`: models 2 つ以上）→ 同じ依頼をモデルごとに 1 セッションずつ、全部 `isolate: true` で作る。`Session.compare = { group, label }`。自動取り込みは強制オフ（複数の案が勝手に取り込まれるとぶつかる）
- 画面: 起動ダイアログの「複数のモデルで比べる」（モデルのチップを 2 つ以上）。詳細に `CompareStrip`（同じ group のセッションを store から拾って対比表: 状態 / 結果 / 裏取り / 変更 / 時間 / 費用、「見る」で移動、「他の案を片付ける」= 他を DELETE）。採用は既存の「元のプロジェクトに取り込む」
- 通し試験（todo テンプレート、Haiku 4.5 vs Sonnet 5）: 両方 40 秒で「完了・直った」、Haiku $0.05 / Sonnet $0.22。Haiku を取り込み → Sonnet を片付け → 元のフォルダで npm test 成功、worktree も 1 つに戻った
- 判断は人がする（AI に「どちらが良いか」を採点させない）。裏取り・差分・スクリーンショット・費用が並べば十分で、余計なトークンも使わない

### デスクトップ版のインストーラ（2026-09-11）
- `npm run installer` = `apps/desktop/build.mjs`: 画面ビルド → esbuild でサーバーを `stage/app/server.mjs` に束ねる（子プロセスを起動する SDK・playwright-core は external にして stage で `npm install --omit=dev --ignore-scripts`）→ electron-builder（NSIS、oneClick、`asar: false`、`electronDist` に手元の `node_modules/electron/dist` を指定してダウンロード無し、`signAndEditExecutable: false` で winCodeSign の symlink 問題を避ける）
- 束ねると `import.meta.url` 基準の置き場所が変わるので、`TOWER_WEB_DIST` / `TOWER_HOOK_SCRIPT` を環境変数で渡す。`TOWER_PORT` / `TOWER_HOST` も config を触らずに上書きできるようにした（main.cjs の TOWER_PORT がサーバーに効いていなかったのを修正）
- 入れた先には Node.js 22.13 以上が要る（node:sqlite と、Claude Code の CLI を `node` で起動するため）。無ければ起動時にダイアログ
- monorepo の node_modules は入れない（Monaco・Vite・Electron 自体が入って巨大になる）。stage に要るものだけ。それでも `@openai/codex-win32-x64`（378MB）が入って 1GB 近くになったので、`@openai/codex-sdk` は `stubs/codex-sdk.mjs` に差し替えて束ね、インストーラには入れない（サーバーは「見つからない」扱いで起動する）
- ESM に束ねると ws などの CommonJS 側の `require('events')` が "Dynamic require is not supported" で落ちる → banner で `globalThis.require = createRequire(import.meta.url)` を入れて本物の require に流す

### 人間役で使ってみた（2026-09-11、フェーズ3 の後）
利用者役 AI ではなく、自分で画面を操作して一通り通した（起動 → 許可 → 報告 → 差分 → 直接編集 → 追加指示 → 質問に答える → 停止と再開 → 比べる → 取り込み → 片付け → 検索 → 使った量 → スマホ幅 → 削除。材料は `~/.tower/dogfood/human/` の 4 テンプレ、操作台は `~/.tower/dogfood/drive.mjs`（playwright を HTTP で操る）。所見は `docs/dogfood/2026-09-11-human.md`）。直したもの:
- 報告の「変更ファイル」に書かれた「README.md（新規作成）」がそのまま `changedFiles` に足され、件数が 1 多かった → `report.ts cleanFileName` で注釈（括弧・バッククォート・「- 説明」「: 説明」）を落としてから合流
- Python のテストを走らせると `__pycache__/*.pyc` が「追加」として差分に出た（中身はバイナリの化け文字）→ `diff.ts` で生成物（`__pycache__` / `node_modules` / `.venv` / `coverage` 等）とバイナリ（先頭 8KB に NUL）を未追跡一覧から外す
- 年表のツール結果が英語の定型文だった（"The file … has been updated successfully"）→ tool_use の id → 名前を覚えておき、`summarizeToolResult` で「README.md を読みました（11 行）」「todo.js を書き換えました」に。エラー時は原文の先頭行のまま。最後の【報告】本文は「報告を書きました（上の「報告」に表示）」
- 許可カードの編集プレビューが 1 段の枠で、変更後がスクロールの下に隠れて判断できなかった → 変更前 / 変更後を 2 段に（`PendingCards DetailBlock`）
- 差分の `diff --git` / `index …` / `--- a/` などのヘッダ行を消し、`@@` は区切り線に
- 報告文中の `バッククォート` をコード表示に（記号のまま見えていた）
- ヘッダの「接続中」（つながっているのか、つなごうとしているのか分からない）→ つながっている時は緑の点だけ、切れた時だけ赤字で説明
- 一覧が古い「停止」で埋まる → 「終わったもの N 件を隠す」（localStorage。消さないので使った量の集計と検索には残る）
- 比べる案を片付けた後に「同じ依頼を 1 つのモデルに投げて比べています」と出ていた → 残した案だけの一言に

気づいたが直していないこと:
- 使った量はセッションから集計しているので、セッションを削除すると今日の合計も減る（比較の片付けで $0.20 減った）。台帳を別に持つなら後で
- サーバー再起動で全部「停止」になり、「隠す」がオンだと一覧から消える（件数は出る）。指示を送れば再開はできる
- 外部セッションの「今やってること」には Claude Code 側の Bash 説明文（英語）がそのまま出る
- 「変更されたファイル」の開閉状態が、別のセッションを選んでも引き継がれる（困りはしない）

### フェーズ3 の残り
- なし（全部済み）。次は使いながらの改善

## 既知の制約
- サーバー再起動で動作中セッションは `stopped` になる
- 認証無し。LAN公開時は自宅内限定で
- Windows で開発。macOS/Linux でも動くはずだが未確認
