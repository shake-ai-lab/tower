// Tower — フロント/サーバー共通の型定義。
// サーバーが「エージェントの生イベント」をこの形に翻訳し、フロントはこれだけを見て描画する。

export type AgentKind = 'claude' | 'codex';

export type SessionStatus =
  | 'starting'            // プロセス起動中
  | 'running'             // エージェントが作業中
  | 'waiting_permission'  // 許可待ち（人の判断が必要）
  | 'waiting_question'    // 質問への回答待ち
  | 'idle'                // ターン完了。追加指示を待っている
  | 'done'                // プロセス終了（正常）
  | 'error'               // エラーで停止
  | 'stopped';            // 人が止めた / サーバー再起動で中断（指示を送ると再開）

/** 許可の方針。Claude Code の permissionMode に対応 */
export type PermissionChoice = 'default' | 'acceptEdits' | 'auto';

export const PERMISSION_CHOICES: { value: PermissionChoice; label: string; hint: string }[] = [
  { value: 'acceptEdits', label: '編集は自動', hint: 'ファイルの編集は自動で進める。コマンド実行だけ確認する' },
  { value: 'default', label: '毎回確認', hint: 'ファイル編集もコマンドも、都度あなたが許可する' },
  { value: 'auto', label: 'おまかせ', hint: '安全そうな操作はAIが自動承認。危なそうなものだけ確認する' },
];

export interface ProjectRef {
  path: string;
  name: string;
}

export type RiskLevel = 'low' | 'mid' | 'high';

export interface PendingPermission {
  id: string;
  kind: 'permission';
  toolName: string;
  input: Record<string, unknown>;
  /** 日本語1行: 「テストを実行しようとしています」 */
  headline: string;
  /** コマンドやパスなどの生の中身 */
  detail: string;
  risk: RiskLevel;
  /** 「このセッションでは常に許可」が提示可能か */
  canAlwaysAllow: boolean;
  /** 「以後も許可」を選ぶと何が自動になるかの説明（例: "npm test で始まるコマンド"） */
  alwaysRules: string[];
  /** false = 観測しているだけで Tower からは答えられない（元の画面で答える） */
  answerable?: boolean;
  createdAt: number;
}

export interface QuestionOption {
  label: string;
  description: string;
}

export interface Question {
  question: string;
  header: string;
  options: QuestionOption[];
  multiSelect: boolean;
}

export interface PendingQuestion {
  id: string;
  kind: 'question';
  questions: Question[];
  createdAt: number;
}

export type PendingRequest = PendingPermission | PendingQuestion;

export type ReportOutcome = 'done' | 'partial' | 'failed' | 'question' | 'unknown';

/** エージェントの最終出力を「判断できる形」に翻訳したもの */
export interface Report {
  request: string;
  outcome: ReportOutcome;
  summary: string[];
  changedFiles: string[];
  needsDecision: string | null;
  nextStep: string | null;
  /** 整形前の原文 */
  raw: string;
  generatedAt: number;
  /** true = 決まった書式が無かったので Tower が AI（Haiku）で原文から整形した */
  reformatted?: boolean;
}

/** Tower が自分で走らせたチェック（テスト等）の結果。報告の裏取り用 */
export interface Verification {
  command: string;
  /** null = 実行中 */
  ok: boolean | null;
  /** 出力の末尾 */
  output: string;
  /** 件数の要約（例: 「失敗 2 件・成功 3 件」「全部成功（5 件）」）。拾えなければ省略 */
  summary?: string | null;
  /** 失敗したテストの名前（拾えた分だけ）。修正前との比較で「新しく壊れた」を見分ける */
  failed?: string[];
  at: number;
  durationMs: number;
}

/** Tower が撮ったサイトのスクリーンショット */
export interface Screenshot {
  /** 'before'（修正前）| 'after'（修正後） */
  label: string;
  scheme: 'light' | 'dark';
  file: string;
  /** 画像の API パス（/api/sessions/:id/shots/:file） */
  url: string;
  at: number;
  width: number;
  height: number;
}

/** 見た目の確認（撮影）の状態 */
export interface Preview {
  /** 何を撮っているか（'index.html' か URL） */
  target: string;
  /** 起動直後（修正前） */
  before: Screenshot[] | null;
  /** 直近の報告後（修正後） */
  after: Screenshot[] | null;
  taking: boolean;
  error: string | null;
}

/** セッションの出どころ。external = VS Code 拡張やターミナルで動いているものを hooks で観測 */
export type SessionOrigin = 'tower' | 'external';

/**
 * 分離した作業場所（git worktree）。同じプロジェクトに複数のセッションを同時に走らせても、
 * 互いのファイルを壊さないように、セッション専用のコピーとブランチで作業する。
 */
export interface Workspace {
  /** このセッションが実際に作業するフォルダ（cwd） */
  path: string;
  /** git worktree のルート。プロジェクトがリポジトリの一部フォルダの時は path と異なる */
  root: string;
  /** 作業用に切ったブランチ（tower/xxxxxxxx） */
  branch: string;
  /** 分離した時に元のプロジェクトで開いていたブランチ。取り込み先 */
  baseBranch: string;
  /** 分離した時点のコミット。差分の起点 */
  baseCommit: string;
  /** 最後に「元のプロジェクトに取り込む」を押した結果 */
  lastMerge: { at: number; ok: boolean; message: string } | null;
}

/** セッションが実際に作業しているフォルダ */
export const workDir = (s: Pick<Session, 'project' | 'workspace'>): string => s.workspace?.path ?? s.project.path;

export interface Session {
  id: string;
  agent: AgentKind;
  /** 省略時は 'tower' */
  origin?: SessionOrigin;
  /** external の時の表示名: 'VS Code' | 'ターミナル' など */
  externalHint?: string;
  /** Claude 側の session_id（resume 用） */
  agentSessionId: string | null;
  project: ProjectRef;
  /** 分離した作業場所。null/省略 = プロジェクトのフォルダで直接作業 */
  workspace?: Workspace | null;
  /** 利用者が画面から直接編集したファイル（前回の指示以降）。次の指示でエージェントに伝えて空にする */
  manualEdits?: string[];
  /** 一覧に出す短い題名（最初の指示の先頭） */
  title: string;
  prompt: string;
  model: string | null;
  permissionMode: PermissionChoice;
  status: SessionStatus;
  /** 今やってること1行 */
  activity: string;
  /** いま判断してほしいもの（複数来た時は先頭。残りは pendingCount で示す） */
  pending: PendingRequest | null;
  /** 判断待ちの総数（pending を含む） */
  pendingCount?: number;
  report: Report | null;
  /** 直近の報告に対する自動チェック */
  verification?: Verification | null;
  /** 起動直後（エージェントが手を付ける前）の自動チェック。「修正前 → 修正後」の対比用 */
  baseline?: Verification | null;
  /** 修正前の失敗をエージェントに伝えたか（追加指示の補足として一度だけ伝える） */
  baselineNoted?: boolean;
  /** 見た目の撮影。null/省略 = 撮る対象が無い */
  preview?: Preview | null;
  turns: number;
  costUsd: number;
  toolCalls: number;
  /** このセッションで触ったファイル（Edit/Write から機械的に集計） */
  changedFiles: string[];
  createdAt: number;
  updatedAt: number;
  lastError: string | null;
}

export type TimelineKind =
  | 'user'
  | 'assistant_text'
  | 'tool_use'
  | 'tool_result'
  | 'permission'
  | 'system'
  | 'error';

export interface TimelineItem {
  id: string;
  sessionId: string;
  ts: number;
  kind: TimelineKind;
  /** 一覧に出す短文 */
  text: string;
  /** 展開したときに見せる詳細（コマンド全文、差分など） */
  detail?: string;
  toolName?: string;
}

// ---- WebSocket: サーバー → クライアント ----
export type ServerEvent =
  | { type: 'snapshot'; sessions: Session[] }
  | { type: 'session'; session: Session }
  | { type: 'session_removed'; id: string }
  | { type: 'timeline'; item: TimelineItem };

// ---- REST ボディ ----
export interface CreateSessionBody {
  projectPath: string;
  prompt: string;
  agent?: AgentKind;
  model?: string | null;
  permissionMode?: PermissionChoice;
  /** true = 別の作業場所（git worktree）で動かす。git 管理のプロジェクトのみ */
  isolate?: boolean;
}

/** 「元のプロジェクトに取り込む」の結果 */
export interface MergeResult {
  ok: boolean;
  /** 利用者向けの日本語 */
  message: string;
  /** 取り込んだファイル数 */
  files: number;
}

export interface PermissionDecisionBody {
  requestId: string;
  /** defer = 外部セッションで「元の画面に任せる」 */
  decision: 'allow' | 'allow_always' | 'deny' | 'defer';
  message?: string;
}

/** VS Code / ターミナル連携（hooks）の状態 */
export interface BridgeStatus {
  installed: boolean;
  /** PermissionRequest hook も入れて、許可を Tower で答えられるようにしているか */
  permissions: boolean;
  waitSeconds: number;
  settingsPath: string;
  hookScript: string;
}

export interface AnswerBody {
  requestId: string;
  /** question 文 → 選んだ label（複数選択はカンマ区切り） */
  answers: Record<string, string>;
}

export interface MessageBody {
  text: string;
}

export interface ChangedFile {
  /** プロジェクトからの相対パス */
  path: string;
  /** M=変更 A=追加 D=削除 ?=git無しで現在の内容のみ */
  status: 'M' | 'A' | 'D' | '?';
  /** unified diff（git 無しの時は全行 + の擬似 diff） */
  diff: string;
}

export interface ChangesResponse {
  isGit: boolean;
  files: ChangedFile[];
  /** 分離した作業場所の時: 差分の比較先の説明（例: 「元のブランチ main」） */
  against?: string;
}

/** 画面から直接編集するためのファイル内容 */
export interface FileContent {
  /** 作業フォルダからの相対パス（区切りは /） */
  path: string;
  content: string;
  size: number;
}

export interface SaveFileBody {
  path: string;
  content: string;
}

export interface ProjectInfo extends ProjectRef {
  hasGit: boolean;
  /** 最終更新（mtime） */
  modifiedAt: number;
}

export interface AgentAvailability {
  available: boolean;
  /** 使えない理由（利用者向けの日本語） */
  reason?: string;
}

export const AGENT_CHOICES: { value: AgentKind; label: string; hint: string }[] = [
  { value: 'claude', label: 'Claude Code', hint: '許可・質問・報告のすべてに対応' },
  {
    value: 'codex',
    label: 'Codex (OpenAI)',
    hint: '許可の都度確認はできないので、作業フォルダ内だけ書き込める砂場で動く。`npx codex login` が必要',
  },
];

export const CODEX_MODEL_CHOICES: { value: string | null; label: string }[] = [
  { value: null, label: '既定（Codex の設定）' },
  { value: 'gpt-5-codex', label: 'gpt-5-codex' },
  { value: 'gpt-5', label: 'gpt-5' },
];

export const MODEL_CHOICES: { value: string | null; label: string }[] = [
  { value: null, label: '既定（設定のモデル）' },
  { value: 'fable', label: 'Fable 5.1（最高性能）' },
  { value: 'opus', label: 'Opus 5' },
  { value: 'sonnet', label: 'Sonnet 5' },
  { value: 'haiku', label: 'Haiku 4.5（速い・軽い）' },
];
