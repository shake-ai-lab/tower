# Tower

AIエージェント（Claude Code / 将来 Codex）を複数プロジェクトで並走させ、人は「判断」だけをするための管制塔UI。
利用者はコードを読まない前提。**UIに出す文章はすべて日本語・平易な言葉**にする。

## 開発

```bash
npm install
npm run dev          # server(4800) + web(5173)
npm run typecheck    # 両方の型チェック。変更後は必ず通す
```

サーバー単体: `npx tsx apps/server/src/index.ts`（`tsx watch` で自動再起動）。

```bash
npm run dogfood                        # 利用者役AIで全シナリオを回し docs/dogfood/<runId>.md に所見を書く
npm run dogfood -- --only todo-fix     # 一部だけ
```

ドッグフーディング中はサーバーのソースを触らない（tsx watch が再起動して走行中セッションが全部止まる）。
作業フォルダは `~/.tower/dogfood/<runId>/`（リポジトリ内に置くと Claude Code が Tower 自身の CLAUDE.md を拾う）。

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

- `packages/shared/src/index.ts` — フロント⇔サーバーの契約。`Session` / `TimelineItem` / `PendingRequest` / `Report` / `ServerEvent`。**ここを変えたら両側を直す**
- `apps/server/src/agents/types.ts` — `AgentRunner` インターフェース。Manager はこれだけを見る
- `apps/server/src/agents/claude.ts` — Agent SDK の `query()` を1セッション分ラップ。生の `SDKMessage` を `Session` の状態と `TimelineItem` に翻訳する
- `apps/server/src/agents/codex.ts` — Codex SDK（codex exec）の同等品。許可確認は無く砂場で動く
- `apps/server/src/bridge.ts` + `apps/server/hooks/tower-hook.mjs` — VS Code / ターミナルの Claude Code を hooks で観測・許可の橋渡し
- `apps/server/src/verify.ts` — 報告の裏取り（テスト実行）。`apps/server/src/diff.ts` — 差分
- `apps/server/src/worktree.ts` — 別の作業場所（git worktree）の作成・取り込み（merge）・後片付け。cwd は必ず `workDir(session)` で取る
- `apps/server/src/humanize.ts` — ツール呼び出し → 日本語の「今やってること」「許可の見出し」「危険度」
- `apps/server/src/report.ts` — 【報告】書式（システムプロンプト追記）と、その解析。`apps/server/src/reformat.ts` — 書式が無かった時に Haiku で整形し直す（裏で走らせて差し替え）
- `apps/server/src/files.ts` — 画面からの直接編集（Monaco）の読み書き。作業フォルダの外は拒否。保存後の後始末は `manager.manualEdit`（次の指示に補足を付ける）
- `apps/server/src/attachments.ts` — 指示に添えた画像・ファイル。`~/.tower/attachments/<id>/` に保存（作業フォルダの外なので差分・取り込みに混ざらない）。画像は会話にそのまま載せ、それ以外は保存場所を指示に書き添えて読ませる（`additionalDirectories` で読めるようにしている）。画面側は `components/Attachments.tsx`（貼り付け・ドラッグ・ボタン）
- `apps/server/src/janitor.ts` — 動きの無い外部セッションの自動掃除
- `apps/server/src/feedback.ts` — 「気づいたこと」の Markdown（追加・削除・一覧。手書き部分は触らない）。`version.ts` — 版（束ねた時は esbuild の define）
- `apps/server/src/preview.ts` — 見た目のスクリーンショット（playwright-core + 入っている Edge/Chrome）。撮るタイミングは `manager`（起動直後と、報告が来るたび）
- `apps/server/src/hub.ts` — 全セッションのメモリ上の状態 + WebSocket 配信 + SQLite 保存
- `apps/desktop/` — Electron 版。`main.cjs`（サーバーが無ければ起動・トレイ常駐・二重起動防止・サインイン時の自動起動）、`build.mjs`（`npm run installer`: esbuild でサーバーを 1 ファイルにし、stage/ に必要な依存だけ入れて electron-builder で NSIS）、`deploy.mjs`（`npm run deploy`: 作って止めて入れ直して開く）。束ねた時の置き場所は `TOWER_WEB_DIST` / `TOWER_HOOK_SCRIPT` / `TOWER_PORT` の環境変数で渡す
- `apps/server/src/index.ts` — REST ルート（操作）と WS（配信）
- `apps/web/src/store.ts` — zustand。WS イベントをそのまま反映するだけ。フロントで状態を推測しない
- `apps/web/src/components/` — `Inbox`（判断待ち）/ `SessionCard`（フリート）/ `SessionDetail`（報告・年表・追加指示）/ `PendingCards`（許可・質問UI）/ `NewSessionDialog` / `FileEditor`（Monaco。`monaco.ts` でローカル同梱設定、遅延読み込み）/ `UsageMenu`（使った量のまとめ。全セッションから画面側で集計）/ `FeedbackMenu`（気づいたこと。開いた時点の画面を場面として添える）

## 設計原則

- **翻訳はサーバーでやる。** フロントはエージェントの生イベントを知らない。新しい表示が欲しければ `Session` か `TimelineItem` に項目を足す
- 許可要求と AskUserQuestion は SDK の `canUseTool` 経由で来る。回答は `resolvers` の Promise を解決して返す
- 状態遷移: `starting → running ⇄ waiting_permission | waiting_question → idle（報告あり）→ (追加指示で running) / done / error / stopped`
- 認証は手元の Claude Code ログイン（Max）。`env` から `CLAUDECODE` を消してから子プロセスを起動する（入れ子判定回避）
- ロードマップと未実装は `docs/DESIGN.md`
