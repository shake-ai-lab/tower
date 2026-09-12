// Codex（app-server）の問い合わせと集計を Tower の形に翻訳する。純粋な関数だけ（codex.ts が使い、テストもここを見る）。
// 型は `codex app-server generate-ts --experimental` が出す定義のうち、Tower が使う所だけを写したもの
import path from 'node:path';
import type { PendingPermission, PendingQuestion, PermissionChoice, RiskLevel, Usage } from '@tower/shared';
import { assessRisk, describePermission, unwrapShell } from '../humanize.ts';

// ---- 許可方針 ----

export type AskForApproval = 'untrusted' | 'on-request' | 'never';
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
export type SandboxPolicy =
  | { type: 'dangerFullAccess' }
  | { type: 'readOnly'; networkAccess: boolean }
  | { type: 'workspaceWrite'; writableRoots: string[]; networkAccess: boolean; excludeTmpdirEnvVar: boolean; excludeSlashTmp: boolean };

export interface CodexPolicy {
  /** いつ利用者に聞くか */
  approvalPolicy: AskForApproval;
  /** どこまで触れるか（会話を始める時の指定） */
  sandbox: SandboxMode;
  /** 同じものを手番ごとに渡す形（途中で方針を変えた時に効かせる） */
  sandboxPolicy: SandboxPolicy;
}

const workspaceWrite = (): SandboxPolicy => ({
  type: 'workspaceWrite',
  writableRoots: [],
  // ネットは開けておく（パッケージを入れる・Web を調べる。Claude と同じ）
  networkAccess: true,
  excludeTmpdirEnvVar: false,
  excludeSlashTmp: false,
});

/** Tower の許可方針 → Codex の「いつ聞くか」と「どこまで触れるか」 */
export function codexPolicy(mode: PermissionChoice): CodexPolicy {
  switch (mode) {
    case 'default':
      // 毎回確認: 書き込めない所で動かし、ファイルの変更もコマンドも聞く
      return { approvalPolicy: 'untrusted', sandbox: 'read-only', sandboxPolicy: { type: 'readOnly', networkAccess: true } };
    case 'auto':
      // おまかせ（Codex の標準の動き）: 作業フォルダの中は自動で進め、そこから出る必要がある時だけ聞く
      return { approvalPolicy: 'on-request', sandbox: 'workspace-write', sandboxPolicy: workspaceWrite() };
    case 'bypassPermissions':
      // 全自動（VS Code の Codex の「Full access」と同じ）
      return { approvalPolicy: 'never', sandbox: 'danger-full-access', sandboxPolicy: { type: 'dangerFullAccess' } };
    case 'acceptEdits':
    default:
      // 編集は自動: 作業フォルダの中の編集は自動、読むだけと分かっているもの以外のコマンドは聞く
      return { approvalPolicy: 'untrusted', sandbox: 'workspace-write', sandboxPolicy: workspaceWrite() };
  }
}

export type Decision = 'allow' | 'allow_always' | 'deny';

/** 許可・拒否 → Codex の答え（コマンドもファイルの変更も同じ言葉） */
export function approvalDecision(d: Decision): 'accept' | 'acceptForSession' | 'decline' {
  return d === 'allow' ? 'accept' : d === 'allow_always' ? 'acceptForSession' : 'decline';
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

// ---- コマンドの許可 ----

export interface CommandApprovalParams {
  itemId: string;
  kind?: 'command' | 'writeStdin';
  command?: string | null;
  cwd?: string | null;
  reason?: string | null;
  networkApprovalContext?: { host: string; protocol: string } | null;
  availableDecisions?: unknown[] | null;
}

export function commandPending(id: string, p: CommandApprovalParams, now = Date.now()): PendingPermission {
  const raw = p.command ?? '';
  // Codex は PowerShell で包んで送ってくる。見出しも詳細も中身で見せる
  const command = unwrapShell(raw);
  const reason = p.reason?.trim();
  const host = p.networkApprovalContext?.host;
  let risk: RiskLevel = assessRisk('Bash', { command });
  let headline: string;
  if (host) {
    headline = `ネットに接続したい: ${host}`;
    if (risk === 'low') risk = 'mid';
  } else if (p.kind === 'writeStdin') {
    headline = '動いているコマンドに入力を送りたい';
  } else {
    headline = describePermission('Bash', { command }).headline;
  }
  const canSession = !p.availableDecisions || p.availableDecisions.includes('acceptForSession');
  return {
    id,
    kind: 'permission',
    toolName: 'Bash',
    input: { command },
    headline,
    detail: [command || raw, p.cwd ? `場所: ${p.cwd}` : '', reason ? `理由: ${reason}` : ''].filter(Boolean).join('\n\n'),
    risk,
    canAlwaysAllow: canSession,
    alwaysRules: canSession ? [host ? `このタスクの間は ${host} への接続を確認しない` : 'このタスクの間は、同じコマンドを確認なしで実行'] : [],
    createdAt: now,
  };
}

// ---- ファイルの変更の許可 ----

export interface FileChange {
  path: string;
  kind: { type: 'add' | 'delete' | 'update'; move_path?: string | null };
  diff: string;
}

export interface FileChangeApprovalParams {
  itemId: string;
  reason?: string | null;
  grantRoot?: string | null;
}

const KIND_LABEL = { add: '追加', delete: '削除', update: '変更' } as const;

/** changes は item/started で先に届いた「これから変える中身」（許可の判断材料に見せる） */
export function fileChangePending(id: string, p: FileChangeApprovalParams, changes: FileChange[], now = Date.now()): PendingPermission {
  const names = changes.map((c) => path.basename(c.path));
  const list = `${names.slice(0, 3).join(', ')}${names.length > 3 ? ` ほか ${names.length - 3} 件` : ''}`;
  const verb = changes.every((c) => c.kind.type === 'add') ? '作りたい' : changes.some((c) => c.kind.type === 'delete') ? '変更・削除したい' : '編集したい';
  const headline = changes.length ? `ファイルを${verb}: ${list}` : p.grantRoot ? `フォルダに書き込みたい: ${p.grantRoot}` : 'ファイルを編集したい';
  const diffs = changes.map((c) => `${KIND_LABEL[c.kind.type] ?? '変更'}: ${c.path}\n${c.diff}`).join('\n\n');
  return {
    id,
    kind: 'permission',
    toolName: 'Edit',
    input: { file_path: changes[0]?.path ?? p.grantRoot ?? '' },
    headline,
    detail: [p.reason?.trim() ? `理由: ${p.reason.trim()}` : '', p.grantRoot ? `書き込み先: ${p.grantRoot}` : '', clip(diffs, 4000)].filter(Boolean).join('\n\n'),
    risk: p.grantRoot ? 'high' : 'mid',
    canAlwaysAllow: true,
    alwaysRules: ['このタスクの間は、ファイルの変更を確認なしで行う'],
    createdAt: now,
  };
}

// ---- 追加の権限（ネット・作業フォルダの外）の許可 ----

export interface PermissionProfile {
  network: { enabled: boolean | null } | null;
  fileSystem: { read: string[] | null; write: string[] | null; [k: string]: unknown } | null;
}

export interface PermissionsApprovalParams {
  reason: string | null;
  cwd?: string;
  permissions: PermissionProfile;
}

export function permissionsPending(id: string, p: PermissionsApprovalParams, now = Date.now()): PendingPermission {
  const write = p.permissions.fileSystem?.write ?? [];
  const read = p.permissions.fileSystem?.read ?? [];
  const parts: string[] = [];
  if (p.permissions.network?.enabled) parts.push('ネット接続');
  if (write.length) parts.push(`書き込み（${write.map((f) => path.basename(f) || f).join(', ')}）`);
  if (read.length) parts.push(`読み取り（${read.map((f) => path.basename(f) || f).join(', ')}）`);
  return {
    id,
    kind: 'permission',
    toolName: 'Permissions',
    input: p.permissions as unknown as Record<string, unknown>,
    headline: `追加の権限がほしい: ${parts.join('・') || '権限の追加'}`,
    detail: [
      p.reason?.trim() ? `理由: ${p.reason.trim()}` : '',
      p.permissions.network?.enabled ? 'ネットに接続する' : '',
      write.length ? `書き込む場所:\n${write.join('\n')}` : '',
      read.length ? `読む場所:\n${read.join('\n')}` : '',
    ]
      .filter(Boolean)
      .join('\n\n'),
    risk: write.length ? 'high' : 'mid',
    canAlwaysAllow: true,
    alwaysRules: ['このタスクの間は、同じ権限を確認なしで使う'],
    createdAt: now,
  };
}

/** 許可 → 求められた権限をそのまま渡す（以後も許可ならこのタスクの間ずっと）。拒否 → 何も渡さない */
export function grantedPermissions(p: PermissionsApprovalParams, d: Decision): { permissions: Record<string, unknown>; scope: 'turn' | 'session' } {
  if (d === 'deny') return { permissions: {}, scope: 'turn' };
  const granted: Record<string, unknown> = {};
  if (p.permissions.network) granted.network = p.permissions.network;
  if (p.permissions.fileSystem) granted.fileSystem = p.permissions.fileSystem;
  return { permissions: granted, scope: d === 'allow_always' ? 'session' : 'turn' };
}

// ---- 道具（MCP サーバー）からの確認 ----

/** Codex のプラグインが動かす道具の名前 → 利用者向けの呼び名 */
export function serverLabel(name: string): string {
  if (name === 'cua_repl') return '画面操作（Computer Use）';
  if (name === 'node_repl') return 'Node の実行環境';
  if (name === 'codex_apps') return 'Codex のアプリ連携';
  return name;
}

interface SchemaProp {
  type?: string;
  default?: unknown;
  enum?: unknown[];
  oneOf?: { const?: unknown }[];
}

export interface ElicitationParams {
  serverName: string;
  mode: string;
  message?: string;
  url?: string;
  title?: string;
  description?: string;
  requestedSchema?: { properties?: Record<string, SchemaProp | undefined>; required?: string[] } | null;
}

export function elicitationPending(id: string, p: ElicitationParams, now = Date.now()): PendingPermission {
  const who = serverLabel(p.serverName);
  return {
    id,
    kind: 'permission',
    toolName: 'Mcp',
    input: { server: p.serverName, mode: p.mode },
    headline: p.mode === 'url' ? `${who}: ページを開いて手続きしてほしい` : `${who}が確認を求めています`,
    detail: [p.title, p.message ?? p.description, p.url].filter(Boolean).join('\n\n'),
    risk: 'mid',
    canAlwaysAllow: false,
    alwaysRules: [],
    createdAt: now,
  };
}

/** 入力欄のある確認は、決まっている値（既定値・はい・最初の選択肢）で答える */
function formDefaults(schema: ElicitationParams['requestedSchema']): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const required = new Set(schema?.required ?? []);
  for (const [key, s] of Object.entries(schema?.properties ?? {})) {
    if (!s) continue;
    if (s.default !== undefined) out[key] = s.default;
    else if (s.type === 'boolean') out[key] = true;
    else if (s.enum?.length) out[key] = s.enum[0];
    else if (s.oneOf?.length && s.oneOf[0].const !== undefined) out[key] = s.oneOf[0].const;
    else if (required.has(key)) out[key] = s.type === 'number' || s.type === 'integer' ? 0 : '';
  }
  return out;
}

export function elicitationResponse(p: ElicitationParams, d: Decision): { action: 'accept' | 'decline'; content: unknown; _meta: null } {
  if (d === 'deny') return { action: 'decline', content: null, _meta: null };
  const form = p.mode === 'form' || p.mode === 'openai/form' || p.mode === 'openaiForm';
  return { action: 'accept', content: form ? formDefaults(p.requestedSchema) : null, _meta: null };
}

// ---- 質問 ----

export interface UserInputQuestion {
  id: string;
  header: string;
  question: string;
  isOther?: boolean;
  isSecret?: boolean;
  options: { label: string; description: string }[] | null;
}

export function userInputPending(id: string, questions: UserInputQuestion[], now = Date.now()): PendingQuestion {
  return {
    id,
    kind: 'question',
    // 選択肢の無い質問は、画面の「その他（自由に書く）」で答える
    questions: questions.map((q) => ({ question: q.question, header: q.header, options: q.options ?? [], multiSelect: false })),
    createdAt: now,
  };
}

/** 画面の答え（質問文 → 答え）→ Codex の答え（質問の id → 答えの並び） */
export function userInputAnswers(questions: UserInputQuestion[], answers: Record<string, string>): { answers: Record<string, { answers: string[] }> } {
  const out: Record<string, { answers: string[] }> = {};
  for (const q of questions) {
    const a = answers[q.question] ?? answers[q.header] ?? answers[q.id];
    out[q.id] = { answers: a ? [a] : [] };
  }
  return { answers: out };
}

// ---- 使った量 ----

export interface TokenBreakdown {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

const ZERO: TokenBreakdown = { totalTokens: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };

/**
 * 使った量を足していく。Codex は会話の累計（total）と直近の 1 回分（last）を知らせてくる。
 * 再開した会話では累計に前回までの分が入っているので、最初の知らせは直近の 1 回分だけ足し、以後は累計の差分を足す
 * （Codex の入力トークンはキャッシュから読んだ分を含む = Tower の数え方と同じ）
 */
export class UsageMeter {
  private prev: TokenBreakdown | null = null;

  constructor(private sum: Usage) {}

  update(total: TokenBreakdown, last: TokenBreakdown | null, contextWindow: number | null): Usage {
    const d =
      this.prev && total.totalTokens >= this.prev.totalTokens
        ? {
            inputTokens: total.inputTokens - this.prev.inputTokens,
            cachedInputTokens: total.cachedInputTokens - this.prev.cachedInputTokens,
            outputTokens: total.outputTokens - this.prev.outputTokens,
          }
        : (last ?? ZERO);
    this.prev = total;
    this.sum = {
      ...this.sum,
      input: this.sum.input + Math.max(0, d.inputTokens),
      cacheRead: this.sum.cacheRead + Math.max(0, d.cachedInputTokens),
      output: this.sum.output + Math.max(0, d.outputTokens),
    };
    if (last?.inputTokens) this.sum.context = contextWindow ? Math.min(last.inputTokens, contextWindow) : last.inputTokens;
    if (contextWindow) this.sum.contextWindow = contextWindow;
    return { ...this.sum };
  }
}

// ---- 今やっていること ----

/** プラグインの道具の呼び出し → 「今やっていること」。Codex が付けた題（title）があればそれを使う */
export function mcpActivity(server: string, tool: string, args: unknown): string {
  const t = args && typeof args === 'object' ? (args as { title?: unknown }).title : undefined;
  const title = typeof t === 'string' ? clip(t.trim(), 60) : '';
  if (server === 'cua_repl') return title ? `画面操作: ${title}` : '画面を操作しています';
  if (server === 'node_repl') return title ? `JavaScript を実行しています: ${title}` : 'JavaScript を実行しています';
  return title ? `${serverLabel(server)}: ${title}` : `${serverLabel(server)}の ${tool} を使っています`;
}

/** Codex の失敗メッセージを、利用者が次に何をすればいいか分かる文にする */
export function friendlyError(msg: string, missing: string): string {
  const m = msg.toLowerCase();
  if (m.includes('usage limit') || m.includes('rate limit') || m.includes('quota')) {
    return `Codex の利用上限に達しました。時間をおいてから、もう一度指示を送ってください。（${clip(msg, 200)}）`;
  }
  if (m.includes('not logged in') || m.includes('login') || m.includes('unauthorized') || m.includes('401')) {
    return 'Codex にログインしていません。左端の「設定」→「Codexにログイン」で接続してから、もう一度指示を送ってください。';
  }
  if (m.includes('enoent')) return missing;
  return msg;
}
