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
- `apps/server/src/janitor.ts` — 動きの無い外部セッションの自動掃除
- `apps/server/src/hub.ts` — 全セッションのメモリ上の状態 + WebSocket 配信 + SQLite 保存
- `apps/server/src/index.ts` — REST ルート（操作）と WS（配信）
- `apps/web/src/store.ts` — zustand。WS イベントをそのまま反映するだけ。フロントで状態を推測しない
- `apps/web/src/components/` — `Inbox`（判断待ち）/ `SessionCard`（フリート）/ `SessionDetail`（報告・年表・追加指示）/ `PendingCards`（許可・質問UI）/ `NewSessionDialog` / `FileEditor`（Monaco。`monaco.ts` でローカル同梱設定、遅延読み込み）

## 設計原則

- **翻訳はサーバーでやる。** フロントはエージェントの生イベントを知らない。新しい表示が欲しければ `Session` か `TimelineItem` に項目を足す
- 許可要求と AskUserQuestion は SDK の `canUseTool` 経由で来る。回答は `resolvers` の Promise を解決して返す
- 状態遷移: `starting → running ⇄ waiting_permission | waiting_question → idle（報告あり）→ (追加指示で running) / done / error / stopped`
- 認証は手元の Claude Code ログイン（Max）。`env` から `CLAUDECODE` を消してから子プロセスを起動する（入れ子判定回避）
- ロードマップと未実装は `docs/DESIGN.md`
