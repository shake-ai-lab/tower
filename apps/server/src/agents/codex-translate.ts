// Codex（app-server）の問い合わせと集計を Tower の形に翻訳する。純粋な関数だけ（codex.ts が使い、テストもここを見る）。
// 型は `codex app-server generate-ts --experimental` が出す定義のうち、Tower が使う所だけを写したもの
import path from 'node:path';
import type { PendingPermission, PendingQuestion, PermissionChoice, RiskLevel, Usage } from '@tower/shared';
import { assessRisk, describePermission, unwrapShell } from '../humanize.ts';

// ---- 許可方針 ----

export type AskForApproval = 'untrusted' | 'on-request' | 'never' | { granular: { sandbox_approval: boolean; rules: boolean; mcp_elicitations: boolean; request_permissions: boolean; skill_approval: boolean } };
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
      // フルアクセスでもMCPの入力・手続きは人が答える。neverだとCodex本体が問い合わせ前に辞退してしまう。
      return { approvalPolicy: { granular: { sandbox_approval: false, rules: false, mcp_elicitations: true, request_permissions: false, skill_approval: false } }, sandbox: 'danger-full-access', sandboxPolicy: { type: 'dangerFullAccess' } };
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
  /** 「以後も許可」で Codex の設定に足す、コマンドの頭の並び（例: ["npm", "test"]） */
  proposedExecpolicyAmendment?: string[] | null;
  availableDecisions?: unknown[] | null;
}

type CommandDecision = 'accept' | 'acceptForSession' | 'decline' | { acceptWithExecpolicyAmendment: { execpolicy_amendment: string[] } };

/**
 * 「以後も許可」を選んだ時に Codex へ返す答えと、その説明。
 * このタスクの間だけの許可（acceptForSession）を出せるならそれ。出せない時（「毎回確認」の方針など）は、
 * Codex が案として出してきた「このコマンドで始まるものは今後も確認しない」（Codex の設定に残る）を使う
 */
function alwaysChoice(p: CommandApprovalParams): { decision: CommandDecision; rule: string } | null {
  const offered = p.availableDecisions;
  if (!offered || offered.includes('acceptForSession')) {
    return {
      decision: 'acceptForSession',
      rule: p.networkApprovalContext ? `このタスクの間は ${p.networkApprovalContext.host} への接続を確認しない` : 'このタスクの間は、同じコマンドを確認なしで実行',
    };
  }
  const offer = offered.find((d): d is { acceptWithExecpolicyAmendment: { execpolicy_amendment: string[] } } => !!d && typeof d === 'object' && 'acceptWithExecpolicyAmendment' in d);
  const prefix = offer?.acceptWithExecpolicyAmendment.execpolicy_amendment ?? p.proposedExecpolicyAmendment;
  if (offer && prefix?.length) {
    return {
      decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: prefix } },
      rule: `「${prefix.join(' ')}」で始まるコマンドは、今後も確認しない（Codex の設定に残る）`,
    };
  }
  return null;
}

/** 許可・拒否 → Codex への答え（コマンド） */
export function commandDecision(p: CommandApprovalParams, d: Decision): CommandDecision {
  if (d === 'deny') return 'decline';
  if (d === 'allow_always') return alwaysChoice(p)?.decision ?? 'accept';
  return 'accept';
}

/** 利用者に聞かずに許可してよいかを決める材料 */
export type AutoRequest = { kind: 'command'; command: string; network?: boolean } | { kind: 'file'; outside: boolean } | { kind: 'user_confirmation' } | { kind: 'other' };

/**
 * 利用者に聞かずに許可してよいか（Tower の許可方針に合わせる）。聞かない時はその理由、聞く時は null。
 * コマンドの承認要求は Codex の判断を尊重する。名前が読み取り用でも、オプションや式で書き込めるため
 * Tower 独自のコマンド解析では自動承認しない。
 */
export function autoAllow(mode: PermissionChoice, req: AutoRequest): string | null {
  if (req.kind === 'user_confirmation') return null;
  if (mode === 'bypassPermissions') return '全自動';
  if (req.kind === 'file' && !req.outside && (mode === 'acceptEdits' || mode === 'auto')) return '編集は自動';
  return null;
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
  const always = alwaysChoice(p);
  return {
    id,
    kind: 'permission',
    toolName: 'Bash',
    input: { command },
    headline,
    detail: [command || raw, p.cwd ? `場所: ${p.cwd}` : '', reason ? `理由: ${reason}` : ''].filter(Boolean).join('\n\n'),
    risk,
    canAlwaysAllow: !!always,
    alwaysRules: always ? [always.rule] : [],
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

export interface ElicitationParams {
  serverName: string;
  mode: string;
  message?: string;
  url?: string;
  title?: string;
  description?: string;
  requestedSchema?: import('@tower/shared').FormSchema | null;
}

export function elicitationPending(id: string, p: ElicitationParams, now = Date.now()): PendingPermission {
  const who = serverLabel(p.serverName);
  return {
    id,
    kind: 'permission',
    toolName: 'Mcp',
    input: { server: p.serverName, mode: p.mode, ...(p.mode === 'url' ? { url: p.url } : {}) },
    headline: p.mode === 'url' ? `${who}: ページを開いて手続きしてほしい` : `${who}が確認を求めています`,
    detail: [p.title, p.message ?? p.description, p.url, p.mode === 'url' ? 'ページでの手続きが完了してから「手続きが完了しました」を押してください。まだ完了していない場合は、この確認を残してください。' : ''].filter(Boolean).join('\n\n'),
    risk: 'mid',
    canAlwaysAllow: false,
    alwaysRules: [],
    createdAt: now,
  };
}

export function isFormElicitation(p: ElicitationParams): boolean {
  return p.mode === 'form' || p.mode === 'openai/form' || p.mode === 'openaiForm' || (!p.mode && !!p.requestedSchema);
}

export function elicitationResponse(p: ElicitationParams, d: Decision): { action: 'accept' | 'decline'; content: unknown; _meta: null } {
  // 入力フォームは専用の回答経路を使い、許可方針から入力内容を作って返さない。
  if (d === 'deny' || isFormElicitation(p)) return { action: 'decline', content: null, _meta: null };
  return { action: 'accept', content: null, _meta: null };
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
    questions: questions.map((q) => ({ id: q.id, isSecret: q.isSecret, question: q.question, header: q.header, options: q.options ?? [], multiSelect: false })),
    createdAt: now,
  };
}

/** 画面の答え（質問文 → 答え）→ Codex の答え（質問の id → 答えの並び） */
export function userInputAnswers(questions: UserInputQuestion[], answers: Record<string, string>): { answers: Record<string, { answers: string[] }> } {
  return { answers: Object.fromEntries(questions.map((q) => {
    const a = answerForQuestion(q, questions, answers);
    return [q.id, { answers: a === undefined ? [] : [a] }];
  })) };
}

/** 回答全体で形式を決める。IDと旧画面の質問文/見出しキーを混ぜない。 */
export function answerForQuestion(q: { id?: string; question: string; header: string }, questions: { id?: string; question: string; header: string }[], answers: Record<string, string>): string | undefined {
  const keys = Object.keys(answers);
  const complete = (candidate: (string | undefined)[]): candidate is string[] => candidate.length === keys.length && new Set(candidate).size === candidate.length && candidate.every(key => typeof key === 'string' && Object.hasOwn(answers, key));
  const ids = questions.map(item => item.id);
  const usesId = ids.some(id => id && Object.hasOwn(answers, id));
  if (usesId && !complete(ids)) return undefined;
  const candidates = [ids, questions.map(item => item.question), questions.map(item => item.header)].filter(complete);
  if (!candidates.length) return undefined;
  const index = questions.indexOf(q);
  if (index < 0) return undefined;
  // A payload which has two different interpretations must be re-entered with unambiguous IDs.
  if (candidates.some(candidate => candidate.some((key, i) => answers[key] !== answers[candidates[0][i]]))) return undefined;
  return answers[candidates[0][index]];
}

export function questionAnswerHistory(pending: PendingQuestion, answers: Record<string, string>): string {
  return pending.questions.map((q) => `${q.question} → ${q.isSecret ? '（非公開の回答）' : answerForQuestion(q, pending.questions, answers) ?? '（回答なし）'}`).join('\n');
}

export function asyncQuestionPending(itemId: string, questions: { title: string; options?: string[] | null }[], now = Date.now()): PendingQuestion {
  return { id: `async:${itemId}`, kind: 'question', delivery: 'async', itemId, createdAt: now,
    questions: questions.map((q, index) => ({ id: `${itemId}:${index}`, question: q.title, header: `質問 ${index + 1}`, multiSelect: false, options: (q.options ?? []).map((label) => ({ label, description: '' })) })),
  };
}

export function asyncQuestionAnswer(pending: PendingQuestion, answers: Record<string, string>): { text: string; history: string } {
  const responses = pending.questions.map((q) => {
    const answer = answerForQuestion(q, pending.questions, answers);
    if (typeof answer !== 'string') throw new Error('すべての質問に回答してください。');
    return { id: q.id, question: q.question, answer };
  });
  return { text: `非同期の質問（メッセージ ${pending.itemId ?? pending.id}）への回答です:\n${JSON.stringify(responses)}`, history: questionAnswerHistory(pending, answers) };
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
  if (m.includes('at capacity') || m.includes('overloaded') || m.includes('503') || m.includes('server_error')) {
    return `Codex のモデルが混み合っていて、応えられませんでした。少し時間をおいてから、もう一度指示を送ってください（続きから再開します）。（${clip(msg, 200)}）`;
  }
  if (m.includes('not logged in') || m.includes('login') || m.includes('unauthorized') || m.includes('401')) {
    return 'Codex にログインしていません。左端の「設定」→「Codexにログイン」で接続してから、もう一度指示を送ってください。';
  }
  if (m.includes('enoent')) return missing;
  return msg;
}
