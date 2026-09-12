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
export type PermissionChoice = 'default' | 'acceptEdits' | 'auto' | 'bypassPermissions';

export const PERMISSION_CHOICES: { value: PermissionChoice; label: string; hint: string }[] = [
  { value: 'acceptEdits', label: '編集は自動', hint: 'ファイルの編集は自動で進める。コマンド実行だけ確認する' },
  { value: 'default', label: '毎回確認', hint: 'ファイル編集もコマンドも、都度あなたが許可する' },
  { value: 'auto', label: 'おまかせ', hint: '安全そうな操作はAIが自動承認。危なそうなものだけ確認する' },
  { value: 'bypassPermissions', label: '全自動', hint: 'ツールの許可確認を省略して実行します。コマンドや削除も確認されません。質問への回答は必要です。' },
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
  /** true = 報告が「完了」で裏取りも通ったら、Tower が自動で取り込む */
  autoMerge?: boolean;
}

/** 「比べる」のグループ。label はモデルの表示名（「Haiku 4.5」など） */
export interface CompareRef {
  group: string;
  label: string;
}

/**
 * 使ったトークン量（目安）。エージェントが返す集計を Tower が足し合わせたもの。
 * 再開（サーバー再起動後の続き）をまたいでも積み上がる
 */
export interface Usage {
  /** 入力トークンの合計（キャッシュから読んだ分も含む） */
  input: number;
  /** 入力のうち、キャッシュ（前回までの会話の使い回し）から読んだ分 */
  cacheRead: number;
  /** 出力トークンの合計 */
  output: number;
  /** 直近の応答時点で会話が占めていた大きさ（トークン）。会話の容量に対する割合を出す */
  context?: number;
  /** モデルの会話の容量（トークン） */
  contextWindow?: number;
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
  /** 費用の目安（USD）。Max/Pro の定額なら請求はされない。Codex は 0 のまま */
  costUsd: number;
  usageHistory?: { ts: number; cost: number; input: number; cacheRead: number; output: number }[];
  /** 使ったトークン量（目安）。外部セッションは省略 */
  usage?: Usage | null;
  /** 同じ依頼を複数のモデルに投げて比べている時の印。同じ group のセッションが「他の案」 */
  compare?: CompareRef | null;
  toolCalls: number;
  /** このセッションで触ったファイル（Edit/Write から機械的に集計） */
  changedFiles: string[];
  createdAt: number;
  updatedAt: number;
  lastError: string | null;
  /** サーバー再起動で中断した印。at = 起動して気づいた時刻、status = 中断直前の状態。自動再開か利用者の指示で消す */
  interrupted?: { at: number; status: SessionStatus } | null;
  /** 利用者の指示を挟まずに連続で自動再開した回数（再起動ループの歯止め）。利用者が指示を送ると 0 に戻す */
  autoResumes?: number;
}

export type TimelineKind =
  | 'user'
  | 'assistant_text'
  | 'tool_use'
  | 'tool_result'
  | 'permission'
  | 'system'
  | 'error';

/** 指示に添えた画像・ファイル（サーバーが ~/.tower/attachments/<sessionId>/ に保存したもの） */
export interface Attachment {
  /** 利用者が付けた元の名前 */
  name: string;
  /** 保存した名前（url の末尾） */
  file: string;
  mime: string;
  size: number;
  /** 中身の API パス（/api/sessions/:id/attachments/:file） */
  url: string;
}

/** 画面 → サーバー: 添える画像・ファイル。data は base64（data: URL の前置きは付けない） */
export interface AttachmentUpload {
  name: string;
  mime: string;
  data: string;
}

/** 添付の上限（画面とサーバーで同じ値を使う） */
export const ATTACH_LIMITS = {
  /** 1 つあたり */
  fileBytes: 20 * 1024 * 1024,
  /** 1 回の指示あたり */
  count: 10,
};

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
  /** エージェントが画像を読んだ時、その画像の場所。画面は GET /api/sessions/:id/timeline/:itemId/image で見る */
  imagePath?: string;
  /** 利用者が指示に添えた画像・ファイル（kind='user' の時） */
  attachments?: Attachment[];
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
  /** isolate の時: 報告が「完了」で裏取りも通ったら自動で取り込む */
  autoMerge?: boolean;
  /** 内部用: 「比べる」で作る時のグループ。API から直接指定しない */
  compare?: CompareRef;
  /** 依頼に添える画像・ファイル */
  attachments?: AttachmentUpload[];
}

/** 同じ依頼を複数のモデルに投げて比べる（POST /api/sessions/compare）。全部「別の作業場所」で動く */
export interface CompareBody {
  projectPath: string;
  prompt: string;
  permissionMode?: PermissionChoice;
  /** 2 つ以上。null = 既定のモデル */
  models: (string | null)[];
  /** 依頼に添える画像・ファイル（それぞれの案に同じものを渡す） */
  attachments?: AttachmentUpload[];
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
  /** 指示に添える画像・ファイル。添付があれば text は空でもよい */
  attachments?: AttachmentUpload[];
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
  branch?: string;
  history?: { hash: string; parents: string[]; subject: string; refs: string; author: string; /** ISO 8601 */ date?: string; message?: string }[];
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

// ---- 作業フォルダの中身（画面左のエクスプローラ。1 階層ずつ取る） ----

export interface TreeEntry {
  name: string;
  /** 作業フォルダからの相対パス（区切りは /） */
  path: string;
  kind: 'dir' | 'file';
  /** ファイルの大きさ（バイト） */
  size?: number;
}

export interface TreeResponse {
  /** 取ったフォルダ（'' = 作業フォルダそのもの） */
  path: string;
  /** フォルダ → ファイルの順、それぞれ名前順 */
  entries: TreeEntry[];
  /** 重いので省いたフォルダの名前（node_modules など） */
  skipped: string[];
  /** 多すぎて途中で切った時、出していない数 */
  truncated: number;
}

// ---- エディタの道具（ファイル名で開く・全体検索・変わった行の印） ----

/** 作業フォルダの全ファイル（ファイル名で開く用。.gitignore で除外されたものと重いフォルダは入れない） */
export interface FileListResponse {
  /** 作業フォルダからの相対パス（区切りは /） */
  files: string[];
  /** 多すぎて途中で切ったか */
  truncated: boolean;
}

export interface SearchMatch {
  /** 1 始まり */
  line: number;
  /** 1 始まり。見つかった文字の位置 */
  column: number;
  /** 見つかった文字の長さ */
  length: number;
  /** その行（長い行は見つかった所の前後だけ） */
  text: string;
  /** text の中で見つかった文字が始まる位置（0 始まり） */
  at: number;
}

export interface SearchResponse {
  query: string;
  files: { path: string; matches: SearchMatch[] }[];
  /** 見つかった数（表示上限を超えた分も含む） */
  total: number;
  /** 上限・時間切れで途中までしか探していない */
  truncated: boolean;
}

/** 行の横に付ける印。deleted は「この行の下で行が消えた」 */
export interface LineMark {
  kind: 'added' | 'modified' | 'deleted';
  /** 1 始まり（両端を含む） */
  start: number;
  end: number;
}

export interface LineMarksResponse {
  marks: LineMark[];
  /** 何と比べた印か（利用者向けの説明）。git が無く比べられない時は null */
  against: string | null;
}

/** 画面で開ける画像。拡張子（小文字） → MIME */
export const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
};

/** 画像なら MIME、そうでなければ null */
export function imageType(p: string): string | null {
  const name = p.split(/[\\/]/).pop() ?? '';
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  return IMAGE_TYPES[ext] ?? null;
}

// ---- 設定（~/.tower/config.json。画面の「設定」から変えられる） ----

export interface TowerSettings {
  /** 127.0.0.1 = このPCのみ。0.0.0.0 にすると同じWi-Fiのスマホからも開ける（要再起動） */
  host: string;
  /** 待ち受けポート（要再起動） */
  port: number;
  /** この下のフォルダを「プロジェクト」として一覧に出す */
  projectRoots: string[];
  /** 報告のたびにプロジェクトのテストを Tower 側で走らせて裏取りする（プロジェクトの .tower.json の "verify" で上書き可） */
  autoVerify: boolean;
  /** VS Code 連携で許可を Tower で答える時、何秒待ってから元の画面に任せるか */
  bridgeWaitSeconds: number;
  /** 報告に決まった書式が無かった時、Haiku で読みやすく整形し直す */
  reformatReports: boolean;
  /** VS Code / ターミナルのセッションを、最後の動きから何時間で一覧から自動で消すか（0 = 消さない） */
  externalKeepHours: number;
  /** 画面の「気づいたこと」を溜める Markdown */
  feedbackFile: string;
  /** サーバー再起動で中断した作業中のタスクを、起動時に自動で続きから再開する */
  autoResume: boolean;
}

export interface SettingsStatus {
  /** 設定ファイルの場所 */
  file: string;
  settings: TowerSettings;
  /** Tower の版 */
  version: string;
  /** 起動時から変わっていて、Tower を開き直さないと反映されない項目の説明（例: 「ポート（4800 → 4801）」） */
  needsRestart: string[];
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

// ---- 気づいたこと（利用者が使いながら書き残す不満・要望・不具合・良かった点） ----
// 1 つの Markdown（設定 feedbackFile。既定 ~/.tower/feedback.md）に溜まり、Claude Code がそれを読んで直す

export type FeedbackKind = 'complaint' | 'request' | 'bug' | 'praise';

export const FEEDBACK_KINDS: { value: FeedbackKind; label: string; hint: string }[] = [
  { value: 'complaint', label: '不満', hint: '使いにくい・分かりにくい・遅い' },
  { value: 'request', label: '要望', hint: 'こうなってほしい・これが欲しい' },
  { value: 'bug', label: '不具合', hint: '動きがおかしい・止まった' },
  { value: 'praise', label: '良かった', hint: 'このままがいい・助かった' },
];

/** 書いた時に見ていた画面。サーバーが「場面:」の 1 行にする */
export interface FeedbackContext {
  /** 例: 「詳細「shakeailab-zenn / 記事の校正」（報告あり）」「新しいタスク」「一覧」 */
  view?: string;
  /** 画面の幅（px）。狭ければ「スマホ幅」と記す */
  width?: number;
  /** 'desktop' = Electron の窓 / 'browser' = ブラウザ */
  client?: 'desktop' | 'browser';
}

export interface FeedbackNote {
  id: string;
  createdAt: number;
  kind: FeedbackKind;
  text: string;
  /** 「場面:」の中身（見ていた画面・版・幅） */
  scene: string;
  /** true = ファイル上で [x]（対応済み） */
  done: boolean;
  /** 「対応:」の中身（Claude Code が直した時に書く） */
  resolution: string | null;
}

export interface CreateFeedbackBody {
  kind: FeedbackKind;
  text: string;
  context?: FeedbackContext;
}

export interface FeedbackStatus {
  /** 溜めているファイルの場所 */
  file: string;
  /** Tower の版 */
  version: string;
  /** ファイル上の順（古い → 新しい） */
  notes: FeedbackNote[];
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

/** モデル指定の表示名（「Haiku 4.5」のように括弧の補足を外したもの） */
export const modelLabel = (value: string | null | undefined): string => {
  const hit = MODEL_CHOICES.find((m) => m.value === (value ?? null));
  return hit ? hit.label.replace(/（.*）$/, '') : (value ?? '既定');
};
