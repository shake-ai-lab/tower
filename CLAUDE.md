# Tower

AIエージェント（Claude Code / 将来 Codex）を複数プロジェクトで並走させ、人は「判断」だけをするための管制塔UI。
利用者はコードを読まない前提。**UIに出す文章はすべて日本語・平易な言葉**にする。

## 開発

```bash
npm install
npm run dev          # server(4800) + web(5173)
npm run typecheck    # 両方の型チェック。変更後は必ず通す
npm test             # サーバー・画面の単体テスト（node:test）
npm run installer    # インストーラだけ作る（apps/desktop/build.mjs）
```

サーバー単体: `npx tsx apps/server/src/index.ts`（`tsx watch` で自動再起動）。

```bash
npm run dogfood                        # 利用者役AIで全シナリオを回し docs/dogfood/<runId>.md に所見を書く
npm run dogfood -- --only todo-fix     # 一部だけ
npm run dogfood:ui                     # 実物の画面をブラウザで操作してエディタの使い勝手を確かめる（Vite 5173 が要る。--explore で AI の自由探索）
```

ドッグフーディング中はサーバーのソースを触らない（tsx watch が再起動して走行中セッションが全部止まる）。
作業フォルダは `~/.tower/dogfood/<runId>/`（リポジトリ内に置くと Claude Code が Tower 自身の CLAUDE.md を拾う）。
動作確認で利用者のデータ（`~/.tower`）と混ぜたくない時は `TOWER_DATA_DIR` で置き場所を、`TOWER_PORT` でポートを変える。

```bash
npm run deploy       # 直したものを使う: 画面ビルド → インストーラ → 動いている Tower.exe を止めて入れ直し → 開く（Windows）
```

利用者は普段、インストールした Tower（`%LOCALAPPDATA%\Programs\Tower\Tower.exe`。サーバーは束ねた 1 ファイル）を使っている。
ソースを直しただけでは利用者の手元は変わらない。**直したら `npm run deploy`**。開発サーバー（4800）が動いたままだと入れ直した Tower はそちらにつながるので先に止める。

## 利用者の「気づいたこと」（フィードバック）

利用者は画面右上の「気づいたこと」（キー `f`）から不満・要望・不具合・良かった点を一言で書き残す。
サーバーが `docs/feedback.md`（設定 `feedbackFile`。既定は `~/.tower/feedback.md`）に `- [ ] 日時 種類 #id` の形で追記する（`apps/server/src/feedback.ts`）。見ていた画面と版が「場面:」に付く。

- **セッションの最初に `docs/feedback.md` の `[ ]` を確認し、未対応があれば件数と中身を伝える**
- 「気づいたことに対応して」と言われたら: 項目ごとに直す → その項目を `[x]` にして直下に `  対応: 何をしたか（コミット）` を 1 行足す → `npm run typecheck` → `npm run deploy`
- サーバーは自分が書いた項目の追加と削除しかしない。手で書いた「対応:」や補足はそのまま残る。見出し行（`- [ ] 2026-… 種類 #id`）の形だけは崩さない
- 見出し行から次の見出し行までがその項目。項目の下に書いた行は項目の一部（利用者が画面の ✕ でその項目を消すと一緒に消える）。全体へのメモは最初の項目より上に書く

## 構成と責務

- `packages/shared/src/index.ts` — フロント⇔サーバーの契約。`Session` / `TimelineItem` / `PendingRequest` / `Report` / `ServerEvent` / `UsageSummary` / `TowerSettings`。**ここを変えたら両側を直す**
- `apps/server/src/agents/types.ts` — `AgentRunner` インターフェース。Manager はこれだけを見る
- `apps/server/src/agents/claude.ts` — Agent SDK の `query()` を1セッション分ラップ。生の `SDKMessage` を `Session` の状態と `TimelineItem` に翻訳する
- `apps/server/src/agents/codex.ts` — Codex SDK（codex exec）の同等品。許可確認は無く砂場で動く。`codex-login.ts` — 画面からのログイン（同梱の codex を起動して URL を出す）
- `apps/server/src/bridge.ts` + `apps/server/hooks/tower-hook.mjs` — VS Code / ターミナルの Claude Code を hooks で観測・許可の橋渡し
- `apps/server/src/verify.ts` — 報告の裏取り（テスト実行）。`apps/server/src/diff.ts` — 差分と履歴（Git グラフ用）
- `apps/server/src/worktree.ts` — 別の作業場所（git worktree）の作成・取り込み（merge）・後片付け。cwd は必ず `workDir(session)` で取る
- `apps/server/src/humanize.ts` — ツール呼び出し → 日本語の「今やってること」「許可の見出し」「危険度」。英語の description は使わず、コマンドの中身から日本語を作る（`describeCommand`）
- `apps/server/src/report.ts` — 【報告】書式（システムプロンプト追記）と、その解析。`apps/server/src/reformat.ts` — 書式が無かった時に Haiku で整形し直す（裏で走らせて差し替え）
- `apps/server/src/files.ts` — 画面からの直接編集（Monaco）の読み書きとエクスプローラ（tree）。作業フォルダの外は拒否。保存後の後始末は `manager.manualEdit`（次の指示に補足を付ける）。`search.ts` — ファイル名で開く用の全ファイル一覧と全体検索（.gitignore に従う）、変わった行の印
- `apps/server/src/attachments.ts` — 指示に添えた画像・ファイル。`~/.tower/attachments/<id>/` に保存（作業フォルダの外なので差分・取り込みに混ざらない）。画像は会話にそのまま載せ、それ以外は保存場所を指示に書き添えて読ませる（`additionalDirectories` で読めるようにしている）。画面側は `components/Attachments.tsx`（貼り付け・ドラッグ・ボタン）
- `apps/server/src/janitor.ts` — 動きの無い外部セッションの自動掃除
- `apps/server/src/feedback.ts` — 「気づいたこと」の Markdown（追加・削除・一覧。手書き部分は触らない）。`version.ts` — 版（束ねた時は esbuild の define）
- `apps/server/src/preview.ts` — 見た目のスクリーンショット（playwright-core + 入っている Edge/Chrome）。撮るタイミングは `manager`（起動直後と、報告が来るたび）
- `apps/server/src/hub.ts` — 全セッションのメモリ上の状態 + WebSocket 配信 + SQLite 保存。起動時に中断の印付け（自動再開の元）と、使った量の台帳への過去分の取り込み
- `apps/server/src/db.ts` — SQLite（`node:sqlite`）。セッション・年表の JSON と、**使った量の台帳**（`usage` 表。セッションを消しても残る。`GET /api/usage` の集計元）
- `apps/server/src/config.ts` — `~/.tower/config.json` と設定の検証。置き場所は `TOWER_DATA_DIR`、ポートは `TOWER_PORT` で上書きできる。`project-browser.ts` — 設定でプロジェクトの置き場所を選ぶ時のフォルダ参照
- `apps/desktop/` — Electron 版。`main.cjs`（サーバーが無ければ起動・トレイ常駐・二重起動防止・サインイン時の自動起動）、`build.mjs`（`npm run installer`: esbuild でサーバーを 1 ファイルにし、stage/ に必要な依存だけ入れて electron-builder で NSIS）、`deploy.mjs`（`npm run deploy`: 作って止めて入れ直して開く）。束ねた時の置き場所は `TOWER_WEB_DIST` / `TOWER_HOOK_SCRIPT` / `TOWER_PORT` の環境変数で渡す
- `apps/server/src/index.ts` — REST ルート（操作）と WS（配信）。`guard.ts` — 他のサイトからブラウザ越しに操作されない守り（同じ画面・localhost・Origin 無しの Node だけ通す）
- `apps/web/src/store.ts` — zustand。WS イベントをそのまま反映するだけ。フロントで状態を推測しない
- `apps/web/src/components/` — `WorkspaceSidebar`（左端の縦ナビ: 判断待ち / ファイル / 検索 / Git / 設定と、その中身のエクスプローラ）/ `Inbox`（判断待ち）/ `SessionCard` + `SessionBadges`（フリート。カード・コンパクト）/ `MultiSessionView` + `TaskPicker`（集中・4分割）/ `SessionDetail`（報告・年表・追加指示）/ `PendingCards`（許可・質問UI）/ `NewSessionDialog` / `ChangesPanel` + `GitHistory`（差分と履歴グラフ）/ `SettingsPanel` / `EditorWorkspace` + `FileEditor` + `DeskWindowControls`（編集領域: タブ・分割・自由配置。Monaco は `monaco.ts` でローカル同梱、遅延読み込み）/ `QuickOpen`（Ctrl+P）/ `SearchPanel`（Ctrl+Shift+F）/ `WorkspaceChat`（ファイル＋チャット表示の指示欄）/ `Aquarium` + `DeskScene`（背景）/ `UsageMenu`（使った量。`GET /api/usage` を取って出すだけ）/ `FeedbackMenu`（気づいたこと。開いた時点の画面を場面として添える）/ `BridgeMenu`（VS Code 連携）/ `CodexAccount`（Codex ログイン）
- `apps/user-agent/` — 利用者役 AI。`index.ts`（`npm run dogfood`: タスクを投げて報告を採点）、`browser.ts` / `browser-explore.ts`（`npm run dogfood:ui`: 実物の画面をブラウザで操作）

## 設計原則

- **翻訳はサーバーでやる。** フロントはエージェントの生イベントを知らない。新しい表示が欲しければ `Session` か `TimelineItem` に項目を足す
- **集計もサーバーでやる。** 使った量は SQLite の台帳（`GET /api/usage`）から出す。画面でセッションから足し算しない（消したら減る）
- 許可要求と AskUserQuestion は SDK の `canUseTool` 経由で来る。回答は `resolvers` の Promise を解決して返す
- 状態遷移: `starting → running ⇄ waiting_permission | waiting_question → idle（報告あり）→ (追加指示で running) / done / error / stopped`
- 認証は手元の Claude Code ログイン（Max）。`env` から `CLAUDECODE` を消してから子プロセスを起動する（入れ子判定回避）
- ロードマップと決定事項は `docs/DESIGN.md`。編集領域の操作は `docs/editor-workspace.md`。開発の進め方（役割分担）は `AGENTS.md` と `docs/agent-loop/learning-log.md`
