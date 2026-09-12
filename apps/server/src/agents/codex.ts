// OpenAI Codex を app-server（VS Code の Codex 拡張と同じ本式のつなぎ方）で 1 セッション動かし、Session / Timeline に翻訳する。
//
// - 普段の Codex と同じ設定（~/.codex/config.toml のプラグイン・MCP・スキル）がそのまま読み込まれる
// - 許可の確認・質問は Codex から問い合わせが来るので、Claude と同じく「判断待ち」に出して利用者の答えを返す
// - Tower の許可方針（毎回確認 / 編集は自動 / おまかせ / 全自動）を Codex の「いつ聞くか」「どこまで触れるか」に写す（codex-translate.ts）
// - Codex アプリの内蔵ブラウザーは Tower の中では使えないので、Tower のブラウザーを道具として渡す（codex-browser.ts）
// - 途中で来た指示は、作業中の手番にそのまま差し込む（turn/steer。VS Code の Codex と同じ）
// - 料金の見積もりは出ないので costUsd は 0 のまま
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  PERMISSION_CHOICES,
  workDir,
  type Attachment,
  type PendingPermission,
  type PendingQuestion,
  type PendingRequest,
  type PermissionChoice,
  type Session,
  type TimelineKind,
} from '@tower/shared';
import { attachmentNote, isInlineImage, publicRefs, type SavedAttachment } from '../attachments.ts';
import { CODEX_MISSING, findCodexBin } from '../codex-bin.ts';
import type { Hub } from '../hub.ts';
import { describeCommand, firstLine } from '../humanize.ts';
import { scheduleReformat } from '../reformat.ts';
import { REPORT_INSTRUCTIONS, fallbackReport, parseReport } from '../report.ts';
import { VERSION } from '../version.ts';
import { detectVerifyCommand, runVerify } from '../verify.ts';
import { workspaceNote } from '../worktree.ts';
import { commitNote, recordAgentCommits } from '../commit.ts';
import { BROWSER_TOOLS, TowerBrowser, browserActivity, browserNote, isBrowserTool } from './codex-browser.ts';
import { RpcClient, RpcError, type RpcId } from './codex-rpc.ts';
import {
  UsageMeter,
  approvalDecision,
  autoAllow,
  codexPolicy,
  commandDecision,
  commandPending,
  elicitationPending,
  elicitationResponse,
  fileChangePending,
  friendlyError,
  grantedPermissions,
  mcpActivity,
  permissionsPending,
  serverLabel,
  userInputAnswers,
  userInputPending,
  type AutoRequest,
  type CommandApprovalParams,
  type Decision,
  type ElicitationParams,
  type FileChange,
  type FileChangeApprovalParams,
  type PermissionsApprovalParams,
  type TokenBreakdown,
  type UserInputQuestion,
} from './codex-translate.ts';
import type { AgentRunner } from './types.ts';

/** app-server から届く中身（形は codex-translate.ts の冒頭の注記のとおり。Tower が見る所だけ取り出す） */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Params = Record<string, any>;
type UserInput = { type: 'text'; text: string; text_elements: never[] } | { type: 'localImage'; path: string };

interface Waiting {
  pending: PendingRequest;
  /** Codex の問い合わせの id（serverRequest/resolved で取り下げを知る） */
  key: string;
  decide?: (d: Decision) => void;
  reply?: (answers: Record<string, string>) => void;
  cancel: () => void;
}

/** Tower が終わる時に、動かしている Codex も一緒に止める */
const live = new Set<ChildProcess>();
function killTree(p: ChildProcess) {
  if (!p.pid || p.exitCode !== null) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(p.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
  else p.kill();
}
process.once('exit', () => {
  for (const p of live) killTree(p);
});

export class CodexRunner implements AgentRunner {
  private proc: ChildProcess | null = null;
  private rpc: RpcClient | null = null;
  private threadId: string | null = null;
  /** 今動いている手番。途中で来た指示はこの手番に差し込む */
  private turnId: string | null = null;
  private turnStarting = false;
  private doneTurns = new Set<string>();
  /** まだ Codex に渡していない指示 */
  private queued: { text: string; attachments: SavedAttachment[] }[] = [];
  /** 判断待ちの行列。先頭を UI に出す */
  private queue: PendingRequest[] = [];
  private waiting = new Map<string, Waiting>();
  /** これから変える中身（item/started で先に届く）。ファイル変更の許可の詳細に使う */
  private fileChanges = new Map<string, FileChange[]>();
  private lastText = '';
  private lastErrorText: string | null = null;
  private stoppedByUser = false;
  /** Codex を止めた（エラー・停止）。以後の知らせで状態を書き換えない */
  private ended = false;
  private verifying = false;
  private mode: PermissionChoice;
  private meter: UsageMeter;
  private browser: TowerBrowser;

  constructor(
    private session: Session,
    private hub: Hub,
  ) {
    this.mode = session.permissionMode ?? 'acceptEdits';
    const cur = hub.get(session.id) ?? session;
    this.meter = new UsageMeter(cur.usage ?? { input: 0, cacheRead: 0, output: 0 });
    this.browser = new TowerBrowser(session.id);
  }

  get id() {
    return this.session.id;
  }

  /** @param resumeFrom Codex の会話（thread）の id。指定すると続きから */
  start(firstMessage: string, resumeFrom?: string, attachments: SavedAttachment[] = []) {
    this.timeline('user', firstMessage, undefined, undefined, undefined, publicRefs(attachments));
    this.queued.push({ text: firstMessage, attachments });
    this.hub.update(this.id, { status: resumeFrom ? 'running' : 'starting', activity: 'Codex を起動しています…', pending: null, pendingCount: 0 });
    void this.boot(resumeFrom).catch((e) => this.fail(e));
  }

  send(text: string, attachments: SavedAttachment[] = []) {
    this.timeline('user', text, undefined, undefined, undefined, publicRefs(attachments));
    this.queued.push({ text, attachments });
    if (this.queue.length) {
      this.timeline('system', '許可・質問に答えると、この指示に進みます');
      this.syncPending('指示を受け取りました');
    } else {
      this.hub.update(this.id, {
        status: 'running',
        activity: this.turnId ? '指示を受け取りました（作業中の Codex に伝えます）' : '指示を受け取りました',
        pending: null,
        pendingCount: 0,
      });
    }
    this.flush();
  }

  async stop() {
    this.stoppedByUser = true;
    this.queued = [];
    for (const w of this.waiting.values()) w.cancel();
    this.waiting.clear();
    this.queue = [];
    const { rpc, threadId, turnId } = this;
    if (rpc && threadId && turnId && !rpc.closed) {
      await Promise.race([rpc.request('turn/interrupt', { threadId, turnId }).catch(() => {}), new Promise((r) => setTimeout(r, 3000))]);
    }
    this.shutdown();
    this.hub.update(this.id, { status: 'stopped', activity: '停止しました', pending: null, pendingCount: 0 });
  }

  async setPermissionMode(mode: PermissionChoice) {
    this.mode = mode;
    this.hub.update(this.id, { permissionMode: mode });
    const label = PERMISSION_CHOICES.find((p) => p.value === mode)?.label ?? mode;
    this.timeline('system', `許可方針を「${label}」に変更しました（次の指示から効きます）`);
    // 全自動を選んだ時だけ、既に並んでいる許可要求も進める。質問は残す
    if (mode === 'bypassPermissions') {
      for (const p of [...this.queue]) if (p.kind === 'permission') this.resolvePermission(p.id, 'allow');
    }
  }

  resolvePermission(requestId: string, decision: Decision, message?: string): boolean {
    const w = this.waiting.get(requestId);
    if (!w?.decide) return false;
    this.take(requestId);
    w.decide(decision);
    if (decision === 'deny') {
      const why = message?.trim();
      this.timeline('permission', why ? `拒否: ${why}` : '拒否しました');
      // 拒否の理由は、作業中の Codex にそのまま伝える
      if (why) {
        this.queued.push({ text: `（さっきの操作を許可しなかった理由）${why}`, attachments: [] });
        this.flush();
      }
      this.syncPending('拒否を受けて考え直しています');
    } else {
      this.timeline('permission', decision === 'allow_always' ? '許可しました（このタスクの間は同じものを許可）' : '許可しました');
      this.syncPending('許可を受けて作業を続けています');
    }
    return true;
  }

  answerQuestion(requestId: string, answers: Record<string, string>): boolean {
    const w = this.waiting.get(requestId);
    if (!w?.reply) return false;
    this.take(requestId);
    w.reply(answers);
    this.timeline(
      'user',
      Object.entries(answers)
        .map(([q, a]) => `${q} → ${a}`)
        .join('\n'),
    );
    this.syncPending('回答を受けて作業を続けています');
    return true;
  }

  // ---- 起動 ----

  private async boot(resumeFrom?: string) {
    const s = this.hub.get(this.id) ?? this.session;
    const bin = findCodexBin();
    if (!bin) throw new Error(CODEX_MISSING);
    const cwd = workDir(s);
    // Tower 自身が Claude Code の中から起動されていても、その印は Codex に渡さない
    const env: NodeJS.ProcessEnv = { ...process.env, TOWER_MANAGED: '1' };
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;
    const proc = spawn(bin.command, [...bin.args, 'app-server'], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.proc = proc;
    live.add(proc);
    const rpc = new RpcClient(proc.stdout!, proc.stdin!);
    this.rpc = rpc;
    rpc.onNotification = (method, params) => this.onNotification(method, (params ?? {}) as Params);
    rpc.onRequest = (method, params, id) => this.onRequest(method, (params ?? {}) as Params, id);
    proc.stderr?.on('data', (d: Buffer) => {
      const t = d.toString().trim();
      if (t) console.error(`[codex ${this.id.slice(0, 8)}] ${t.slice(0, 500)}`);
    });
    proc.on('error', (e) => rpc.close(e));
    proc.on('exit', (code) => {
      live.delete(proc);
      rpc.close(new Error(`Codex が終了しました（終了コード ${code ?? '?'}）`));
      if (this.proc === proc) this.onExit(code);
    });

    await rpc.request('initialize', { clientInfo: { name: 'tower', title: 'Tower', version: VERSION }, capabilities: { experimentalApi: true } });
    rpc.notify('initialized');
    const policy = codexPolicy(this.mode);
    const common = {
      cwd,
      model: s.model ?? null,
      approvalPolicy: policy.approvalPolicy,
      sandbox: policy.sandbox,
      developerInstructions: this.instructions(s),
    };
    this.threadId = await this.openThread(common, resumeFrom);
    this.hub.update(this.id, { agentSessionId: this.threadId });
    this.flush();
  }

  private instructions(s: Session): string {
    const parts = [REPORT_INSTRUCTIONS];
    if (s.workspace) parts.push(workspaceNote(s.workspace, s.project.path));
    const commits = commitNote();
    if (commits) parts.push(commits);
    parts.push(browserNote(s.preview?.target));
    return parts.join('\n\n');
  }

  private async openThread(common: Record<string, unknown>, resumeFrom?: string): Promise<string> {
    const rpc = this.rpc!;
    if (resumeFrom) {
      try {
        const r = await rpc.request<{ thread: { id: string } }>('thread/resume', { threadId: resumeFrom, ...common, excludeTurns: true });
        return r.thread.id;
      } catch (e) {
        this.timeline('system', '前の会話を読み込めなかったので、新しい会話として続けます', e instanceof Error ? e.message : String(e));
      }
    }
    try {
      const r = await rpc.request<{ thread: { id: string } }>('thread/start', { ...common, dynamicTools: BROWSER_TOOLS });
      return r.thread.id;
    } catch (e) {
      // 道具を渡す口（試験中の機能）を受け付けない版の Codex なら、渡さずに始める
      if (!(e instanceof RpcError) || !/dynamic|unknown field|experimental/i.test(e.message)) throw e;
      this.timeline('system', 'この版の Codex には Tower のブラウザーを渡せませんでした（ブラウザーでの確認はできません）', e.message);
      const r = await rpc.request<{ thread: { id: string } }>('thread/start', common);
      return r.thread.id;
    }
  }

  // ---- 指示を渡す ----

  /** 溜まった指示を渡す。手番が動いていれば差し込み、止まっていれば新しい手番を始める */
  private flush() {
    if (!this.rpc || !this.threadId || this.turnStarting || this.ended || this.queued.length === 0) return;
    const items = this.queued.splice(0);
    const input = items.flatMap((m) => this.toInput(m.text, m.attachments));
    if (this.turnId) void this.steer(input, items);
    else void this.startTurn(input);
  }

  /** 画像は会話にそのまま載せ（Codex がすぐ見られる）、それ以外は保存場所を書き添えて読ませる */
  private toInput(text: string, attachments: SavedAttachment[]): UserInput[] {
    const images = attachments.filter(isInlineImage);
    return [
      { type: 'text', text: text + attachmentNote(attachments, isInlineImage), text_elements: [] },
      ...images.map((a) => ({ type: 'localImage' as const, path: a.path })),
    ];
  }

  private async startTurn(input: UserInput[]) {
    this.turnStarting = true;
    this.lastText = '';
    this.lastErrorText = null;
    const policy = codexPolicy(this.mode);
    this.hub.update(this.id, { status: 'running', activity: '作業を始めます', pending: null, pendingCount: 0, lastError: null });
    try {
      const r = await this.rpc!.request<{ turn: { id: string } }>('turn/start', {
        threadId: this.threadId,
        input,
        approvalPolicy: policy.approvalPolicy,
        sandboxPolicy: policy.sandboxPolicy,
      });
      if (!this.doneTurns.has(r.turn.id)) this.turnId = r.turn.id;
    } catch (e) {
      this.turnStarting = false;
      this.fail(e);
      return;
    }
    this.turnStarting = false;
    this.flush(); // 始めるのを待っている間に来た指示を差し込む
  }

  private async steer(input: UserInput[], items: { text: string; attachments: SavedAttachment[] }[]) {
    try {
      await this.rpc!.request('turn/steer', { threadId: this.threadId, input, expectedTurnId: this.turnId });
    } catch {
      // ちょうど手番が終わった: 次の手番で渡す
      this.queued.unshift(...items);
      if (!this.turnId) this.flush();
    }
  }

  // ---- Codex からの問い合わせ（許可・質問・道具） ----

  private onRequest(method: string, p: Params, rpcId: RpcId): Promise<unknown> {
    const id = randomUUID();
    const key = String(rpcId);
    switch (method) {
      case 'item/commandExecution/requestApproval': {
        const params = p as CommandApprovalParams;
        const req: AutoRequest =
          params.kind === 'writeStdin' ? { kind: 'other' } : { kind: 'command', command: params.command ?? '', network: !!params.networkApprovalContext };
        return this.ask<{ decision: unknown }>(commandPending(id, params), key, (d) => ({ decision: commandDecision(params, d) }), () => ({ decision: 'cancel' }), req);
      }
      case 'item/fileChange/requestApproval': {
        const params = p as FileChangeApprovalParams;
        const pending = fileChangePending(id, params, this.fileChanges.get(params.itemId) ?? []);
        return this.ask(pending, key, (d) => ({ decision: approvalDecision(d) }), () => ({ decision: 'cancel' }), { kind: 'file', outside: !!params.grantRoot });
      }
      case 'item/permissions/requestApproval': {
        const params = p as PermissionsApprovalParams;
        return this.ask(permissionsPending(id, params), key, (d) => grantedPermissions(params, d), () => grantedPermissions(params, 'deny'), { kind: 'other' });
      }
      case 'mcpServer/elicitation/request': {
        const params = p as ElicitationParams;
        if (params.mode === 'openai/userVerification') {
          this.timeline('error', `${serverLabel(params.serverName)}が本人確認を求めましたが、Tower からは行えません。VS Code の Codex で行ってください`);
          return Promise.resolve({ action: 'decline', content: null, _meta: null });
        }
        return this.ask<{ action: string; content: unknown; _meta: null }>(
          elicitationPending(id, params),
          key,
          (d) => elicitationResponse(params, d),
          () => ({ action: 'cancel', content: null, _meta: null }),
          { kind: 'other' },
        );
      }
      case 'item/tool/requestUserInput': {
        const qs = (p.questions ?? []) as UserInputQuestion[];
        return this.askQuestion(userInputPending(id, qs), key, (a) => userInputAnswers(qs, a), () => userInputAnswers(qs, {}));
      }
      case 'item/tool/call':
        return this.callTool(p);
      default:
        return Promise.reject(new RpcError(`Tower はこの問い合わせに対応していません: ${method}`, -32601));
    }
  }

  private ask<T>(pending: PendingPermission, key: string, answer: (d: Decision) => T, cancel: () => T, req: AutoRequest): Promise<T> {
    // 許可方針で決まっているものは聞かない（全自動・読むだけのコマンド・「編集は自動」の編集）
    const auto = autoAllow(this.mode, req);
    if (auto) {
      // 全自動の時だけ年表に残す（読むだけ・編集は、その操作自体が年表に出る）
      if (auto === '全自動') this.timeline('permission', `自動で許可: ${pending.headline}`, pending.detail, pending.toolName);
      return Promise.resolve(answer('allow'));
    }
    this.timeline('permission', `許可待ち: ${pending.headline}`, pending.detail, pending.toolName);
    return new Promise<T>((resolve) => this.enqueue({ pending, key, decide: (d) => resolve(answer(d)), cancel: () => resolve(cancel()) }));
  }

  private askQuestion<T>(pending: PendingQuestion, key: string, reply: (a: Record<string, string>) => T, cancel: () => T): Promise<T> {
    this.timeline('permission', `質問: ${pending.questions.map((q) => q.question).join(' / ')}`);
    return new Promise<T>((resolve) => this.enqueue({ pending, key, reply: (a) => resolve(reply(a)), cancel: () => resolve(cancel()) }));
  }

  private enqueue(w: Waiting) {
    this.waiting.set(w.pending.id, w);
    this.queue.push(w.pending);
    this.syncPending('');
  }

  /** 行列から 1 件取り出す */
  private take(id: string): Waiting | undefined {
    const w = this.waiting.get(id);
    if (!w) return undefined;
    this.waiting.delete(id);
    this.queue = this.queue.filter((p) => p.id !== id);
    return w;
  }

  /** 行列の先頭を UI に反映する。空なら作業中に戻す */
  private syncPending(activityWhenEmpty: string) {
    if (this.stoppedByUser || this.ended) return;
    const head = this.queue[0];
    if (!head) {
      if (this.turnId || this.turnStarting) {
        this.hub.update(this.id, { status: 'running', activity: activityWhenEmpty || '作業中', pending: null, pendingCount: 0 });
      } else {
        this.hub.update(this.id, { pending: null, pendingCount: 0 });
      }
      return;
    }
    this.hub.update(this.id, {
      status: head.kind === 'permission' ? 'waiting_permission' : 'waiting_question',
      activity:
        head.kind === 'permission'
          ? `許可待ち: ${head.headline}${this.queue.length > 1 ? `（他 ${this.queue.length - 1} 件）` : ''}`
          : 'あなたの回答を待っています',
      pending: head,
      pendingCount: this.queue.length,
    });
  }

  /** Tower が渡した道具（ブラウザー）の呼び出し */
  private async callTool(p: Params) {
    const tool = String(p.tool ?? '');
    const args = (p.arguments && typeof p.arguments === 'object' ? p.arguments : {}) as Record<string, unknown>;
    if (!isBrowserTool(tool)) return { contentItems: [{ type: 'inputText', text: `Unknown tool: ${tool}` }], success: false };
    const cur = this.hub.get(this.id);
    this.hub.update(this.id, { activity: browserActivity(tool, args), ...(cur ? { toolCalls: cur.toolCalls + 1 } : {}) });
    const r = await this.browser.call(tool, args);
    const text = r.contentItems.find((c) => c.type === 'inputText');
    this.timeline(r.success ? 'tool_use' : 'error', r.label, text?.type === 'inputText' ? text.text.slice(0, 3000) : undefined, 'Browser', r.shot);
    return { contentItems: r.contentItems, success: r.success };
  }

  // ---- Codex からの知らせ ----

  private onNotification(method: string, p: Params) {
    // サブエージェントの会話の知らせは本体の年表に混ぜない
    if (typeof p.threadId === 'string' && this.threadId && p.threadId !== this.threadId) return;
    switch (method) {
      case 'turn/started': {
        const t = String(p.turn?.id ?? '');
        if (t && !this.doneTurns.has(t)) this.turnId = t;
        return;
      }
      case 'item/started':
        this.onItem('started', (p.item ?? {}) as Params);
        return;
      case 'item/completed':
        this.onItem('completed', (p.item ?? {}) as Params);
        return;
      case 'turn/plan/updated': {
        const plan = (p.plan ?? []) as { step: string; status: string }[];
        const now = plan.find((s) => s.status === 'inProgress');
        this.activity(now ? `作業中: ${firstLine(now.step).slice(0, 60)}` : '作業計画を整理しています');
        return;
      }
      case 'thread/tokenUsage/updated': {
        const u = p.tokenUsage as { total: TokenBreakdown; last: TokenBreakdown | null; modelContextWindow: number | null } | undefined;
        if (u?.total) this.hub.update(this.id, { usage: this.meter.update(u.total, u.last, u.modelContextWindow) });
        return;
      }
      case 'turn/completed':
        this.onTurnCompleted((p.turn ?? {}) as Params);
        return;
      case 'error': {
        const msg = String(p.error?.message ?? '');
        // 手番が失敗で終わった時は turn/completed で年表に出す。ここでは覚えておくだけ
        if (p.willRetry) this.activity(`つながり直しています（${firstLine(msg).slice(0, 60)}）`);
        else this.lastErrorText = msg;
        return;
      }
      case 'serverRequest/resolved': {
        // Codex の側で片付いた確認（手番が中断された等）は、判断待ちから外す
        const key = String(p.requestId);
        for (const [id, w] of [...this.waiting]) {
          if (w.key !== key) continue;
          this.take(id);
          this.syncPending('作業中');
        }
        return;
      }
      case 'mcpServer/startupStatus/updated':
        if (p.status === 'failed' || p.error) {
          this.timeline('system', `${serverLabel(String(p.name ?? ''))}を起動できませんでした`, String(p.error ?? p.failureReason ?? ''));
        }
        return;
      default:
        return;
    }
  }

  private onItem(phase: 'started' | 'completed', item: Params) {
    const cur = this.hub.get(this.id);
    if (!cur) return;
    switch (item.type) {
      case 'agentMessage': {
        const text = String(item.text ?? '');
        if (phase === 'completed' && text.trim()) {
          this.timeline('assistant_text', firstLine(text).slice(0, 140), text);
          this.lastText = text;
        }
        return;
      }
      case 'reasoning':
        if (phase === 'started') this.activity('考えをまとめています');
        return;
      case 'commandExecution': {
        // Claude と同じく、コマンドの中身から日本語の一言を作る（PowerShell の包みは外す）
        const command = String(item.command ?? '');
        const what = describeCommand(command);
        if (phase === 'started') {
          this.hub.update(this.id, { activity: what, toolCalls: cur.toolCalls + 1 });
          this.timeline('tool_use', what, command, 'Bash');
          return;
        }
        if (item.status === 'declined') return; // 拒否は許可の所で年表に残している
        const out = String(item.aggregatedOutput ?? '').trim();
        const tail = out.split(/\r?\n/).slice(-1)[0] ?? '';
        const ok = item.status === 'completed' && (item.exitCode ?? 0) === 0;
        // 自分でコミットしたら、そのコミットをタスクの記録に加える（Git のグラフで結びつける）
        if (ok) recordAgentCommits(this.hub, this.id, command, out);
        this.timeline(
          ok ? 'tool_result' : 'error',
          ok ? tail.slice(0, 120) || '(出力なし)' : `失敗 (exit ${item.exitCode ?? '?'}): ${tail.slice(0, 120)}`,
          out.slice(-4000),
        );
        return;
      }
      case 'fileChange': {
        const changes = (item.changes ?? []) as FileChange[];
        if (phase === 'started') {
          this.fileChanges.set(String(item.id), changes);
          return;
        }
        this.fileChanges.delete(String(item.id));
        if (item.status === 'declined') return;
        const files = changes.map((c) => (path.isAbsolute(c.path) ? c.path : path.join(workDir(cur), c.path)));
        const names = changes.map((c) => `${c.kind?.type === 'add' ? '追加' : c.kind?.type === 'delete' ? '削除' : '変更'}: ${path.basename(c.path)}`);
        const ok = item.status === 'completed';
        this.timeline(ok ? 'tool_use' : 'error', `ファイルを${ok ? '変更しました' : '変更できませんでした'} (${names.join(', ')})`, files.join('\n'), 'Edit');
        if (ok) {
          this.hub.update(this.id, {
            activity: `${path.basename(files[0] ?? '')} を編集しました`,
            toolCalls: cur.toolCalls + 1,
            changedFiles: [...new Set([...cur.changedFiles, ...files])],
          });
        }
        return;
      }
      case 'mcpToolCall': {
        // プラグインの道具（画面操作・ブラウザー操作・アプリ連携など）
        const what = mcpActivity(String(item.server ?? ''), String(item.tool ?? ''), item.arguments);
        if (phase === 'started') {
          this.hub.update(this.id, { activity: what, toolCalls: cur.toolCalls + 1 });
          const code = item.arguments?.code;
          this.timeline('tool_use', what, (typeof code === 'string' ? code : JSON.stringify(item.arguments ?? {}, null, 2)).slice(0, 3000), 'Mcp');
          return;
        }
        if (item.error?.message) this.timeline('error', `${what} に失敗: ${firstLine(String(item.error.message)).slice(0, 120)}`, String(item.error.message));
        return;
      }
      case 'webSearch':
        if (phase === 'started') {
          const q = String(item.query ?? item.action?.query ?? '');
          this.activity(q ? `Web検索中 (${q.slice(0, 40)})` : 'Web を調べています');
        }
        return;
      case 'imageView':
        if (phase === 'completed' && item.path) {
          const file = String(item.path);
          this.timeline('tool_use', `画像を見ています（${path.basename(file)}）`, file, 'Read', file);
        }
        return;
      case 'collabAgentToolCall':
        if (phase === 'started') {
          const spawned = item.tool === 'spawnAgent';
          this.activity(spawned ? 'サブエージェントを動かしています' : 'サブエージェントとやりとりしています');
          if (spawned) this.timeline('tool_use', 'サブエージェントを動かしています', item.prompt ? String(item.prompt) : undefined, 'Agent');
        }
        return;
      case 'contextCompaction':
        if (phase === 'completed') this.timeline('system', '会話が長くなったので、これまでの内容を要約しました');
        return;
      case 'imageGeneration':
        if (phase === 'completed') this.timeline('tool_use', '画像を作りました', undefined, 'ImageGen');
        return;
      default:
        return;
    }
  }

  private onTurnCompleted(turn: Params) {
    const tid = String(turn.id ?? '');
    this.doneTurns.add(tid);
    if (this.turnId && this.turnId !== tid) return;
    this.turnId = null;
    // 手番が終わったので、答えを待っていた確認は取り下げる
    for (const w of this.waiting.values()) w.cancel();
    this.waiting.clear();
    this.queue = [];
    if (this.stoppedByUser || this.ended) return;
    const cur = this.hub.get(this.id);
    if (!cur) return;

    if (turn.status === 'failed') {
      const msg = friendlyError(String(turn.error?.message ?? this.lastErrorText ?? '原因の分からないエラーで止まりました'), CODEX_MISSING);
      this.timeline('error', msg, turn.error?.additionalDetails ?? undefined);
      this.hub.update(this.id, { status: 'error', activity: 'エラーで止まりました', lastError: msg, pending: null, pendingCount: 0 });
      this.shutdown();
      return;
    }
    if (turn.status === 'interrupted') {
      this.hub.update(this.id, { status: 'idle', activity: '中断しました。指示を送ると続けます', pending: null, pendingCount: 0 });
      this.flush();
      return;
    }

    const report = parseReport(this.lastText, cur.prompt) ?? fallbackReport(this.lastText || '(出力なし)', cur.prompt, false);
    const changed = new Set(cur.changedFiles);
    const known = new Set(cur.changedFiles.map((f) => path.basename(f)));
    for (const f of report.changedFiles) if (!known.has(path.basename(f))) changed.add(f);
    this.hub.update(this.id, {
      status: 'idle',
      activity: report.needsDecision ? `判断待ち: ${firstLine(report.needsDecision).slice(0, 60)}` : '指示待ち',
      report,
      turns: cur.turns + 1,
      changedFiles: [...changed],
      pending: null,
      pendingCount: 0,
      lastError: null,
    });
    if (changed.size > 0) void this.verify();
    scheduleReformat(this.hub, this.id, report);
    this.flush(); // 手番の終わりぎわに来た指示
  }

  // ---- 終わり方 ----

  /** Codex が勝手に終わった（落ちた） */
  private onExit(code: number | null) {
    this.proc = null;
    for (const w of this.waiting.values()) w.cancel();
    this.waiting.clear();
    this.queue = [];
    void this.browser.close();
    if (this.stoppedByUser || this.ended) return;
    this.ended = true;
    const msg = `Codex が途中で終了しました（終了コード ${code ?? '?'}）。指示を送ると続きから再開します`;
    this.timeline('error', msg);
    this.hub.update(this.id, { status: 'error', activity: 'Codex が止まりました', lastError: msg, pending: null, pendingCount: 0 });
  }

  private fail(e: unknown) {
    if (this.stoppedByUser || this.ended) return;
    const msg = friendlyError(e instanceof Error ? e.message : String(e), CODEX_MISSING);
    this.timeline('error', msg);
    this.hub.update(this.id, { status: 'error', activity: 'エラーで止まりました', lastError: msg, pending: null, pendingCount: 0 });
    this.shutdown();
  }

  /** Codex とブラウザーを止める。次の指示は Manager が新しいランナーで続きから再開する */
  private shutdown() {
    this.ended = true;
    const p = this.proc;
    this.proc = null;
    this.rpc?.close(new Error('Codex を止めました'));
    if (p) {
      live.delete(p);
      killTree(p);
    }
    void this.browser.close();
  }

  // ---- 小物 ----

  private activity(text: string) {
    if (!this.stoppedByUser && !this.ended) this.hub.update(this.id, { activity: text });
  }

  private timeline(kind: TimelineKind, text: string, detail?: string, toolName?: string, imagePath?: string, attachments?: Attachment[]) {
    this.hub.timeline({
      id: randomUUID(),
      sessionId: this.id,
      ts: Date.now(),
      kind,
      text,
      detail,
      toolName,
      imagePath,
      ...(attachments?.length ? { attachments } : {}),
    });
  }

  /** 報告の裏取り: プロジェクトのテストを Tower 側で走らせ、結果をセッションに載せる */
  private async verify() {
    const dir = workDir(this.session);
    const cmd = detectVerifyCommand(dir, this.session.project.path);
    if (!cmd || this.verifying) return;
    this.verifying = true;
    const at = Date.now();
    this.hub.update(this.id, { verification: { command: cmd, ok: null, output: '', at, durationMs: 0 } });
    try {
      const r = await runVerify(dir, cmd);
      this.hub.update(this.id, { verification: { command: cmd, ok: r.ok, output: r.output, summary: r.summary, failed: r.failed, at, durationMs: r.durationMs } });
      this.timeline('system', r.ok ? `自動チェック 成功: ${cmd}` : `自動チェック 失敗: ${cmd}`, r.output);
    } finally {
      this.verifying = false;
    }
  }
}
