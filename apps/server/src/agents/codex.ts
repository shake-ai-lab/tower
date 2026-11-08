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
  CODEX_PERMISSION_CHOICES,
  validateFormContent,
  workDir,
  type Attachment,
  type FormAnswerBody,
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
import { instructionLine, replyReport } from '../report.ts';
import { VERSION } from '../version.ts';
import { detectVerifyCommand, runVerify } from '../verify.ts';
import { workspaceNote } from '../worktree.ts';
import { commitNote, recordAgentCommits } from '../commit.ts';
import { BROWSER_TOOLS, TowerBrowser, browserActivity, browserNote, isBrowserTool } from './codex-browser.ts';
import { RpcClient, RpcError, type RpcId } from './codex-rpc.ts';
import { CodexLiveOutput } from './codex-stream.ts';
import { agentStatusLabel, generatedImageDisplay, mergeAgentStates } from './codex-items.ts';
import { codexAppServerLaunch, codexAppServerEnv } from './codex-launch.ts';
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
  isFormElicitation,
  mcpActivity,
  permissionsPending,
  serverLabel,
  userInputAnswers,
  userInputPending,
  answerForQuestion,
  asyncQuestionPending,
  asyncQuestionAnswer,
  questionAnswerHistory,
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
interface QueuedMessage { text: string; attachments: SavedAttachment[]; asyncQuestionId?: string }

interface Waiting {
  pending: PendingRequest;
  /** Codex の問い合わせの id（serverRequest/resolved で取り下げを知る） */
  key: string;
  decide?: (d: Decision) => void;
  reply?: (answers: Record<string, string>) => void;
  formReply?: (body: FormAnswerBody) => void;
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
  private queued: QueuedMessage[] = [];
  private answeringQuestions = new Set<string>();
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
  private verificationAbort: AbortController | null = null;
  private mode: PermissionChoice;
  /** turn/start に渡した権限。途中の追加指示では切り替えられない */
  private activeMode: PermissionChoice;
  private meter: UsageMeter;
  private browser: TowerBrowser;
  private liveOutput: CodexLiveOutput;
  /** いまの手番のきっかけになった指示（返事に添える） */
  private lastInstruction = '';
  /** 前の返事から後に変えたファイル（返事に添える） */
  private turnFiles = new Set<string>();

  constructor(
    private session: Session,
    private hub: Hub,
  ) {
    this.mode = session.permissionMode ?? 'acceptEdits';
    this.activeMode = this.mode;
    const cur = hub.get(session.id) ?? session;
    this.meter = new UsageMeter(cur.usage ?? { input: 0, cacheRead: 0, output: 0 });
    this.browser = new TowerBrowser(session.id);
    this.liveOutput = new CodexLiveOutput((liveOutput) => this.hub.update(this.id, { liveOutput }));
  }

  get id() {
    return this.session.id;
  }

  /** @param resumeFrom Codex の会話（thread）の id。指定すると続きから */
  start(firstMessage: string, resumeFrom?: string, attachments: SavedAttachment[] = [], historyText?: string, asyncQuestionId?: string) {
    this.timeline('user', historyText ?? firstMessage, undefined, undefined, undefined, publicRefs(attachments));
    if (asyncQuestionId) this.answeringQuestions.add(asyncQuestionId);
    this.queued.push({ text: firstMessage, attachments, asyncQuestionId });
    this.hub.update(this.id, { status: resumeFrom ? 'running' : 'starting', activity: 'Codex を起動しています…', ...this.pendingState(), liveOutput: null });
    void this.boot(resumeFrom).catch((e) => this.fail(e));
  }

  send(text: string, attachments: SavedAttachment[] = [], historyText?: string, asyncQuestionId?: string) {
    this.verificationAbort?.abort();
    this.timeline('user', historyText ?? text, undefined, undefined, undefined, publicRefs(attachments));
    if (asyncQuestionId) this.answeringQuestions.add(asyncQuestionId);
    this.queued.push({ text, attachments, asyncQuestionId });
    if (this.queue.length) {
      this.timeline('system', '許可・質問に答えると、この指示に進みます');
      this.syncPending('指示を受け取りました');
    } else {
      this.hub.update(this.id, {
        status: 'running',
        activity: this.turnId ? '指示を受け取りました（作業中の Codex に伝えます）' : '指示を受け取りました',
        ...this.pendingState(),
      });
    }
    this.flush();
  }

  async stop() {
    this.stoppedByUser = true;
    this.verificationAbort?.abort();
    this.liveOutput.clear();
    this.queued = [];
    this.cancelWaiting('停止したため、同期の質問は無効になりました。再開後にもう一度質問してもらってください。');
    const { rpc, threadId, turnId } = this;
    if (rpc && threadId && turnId && !rpc.closed) {
      await Promise.race([rpc.request('turn/interrupt', { threadId, turnId }).catch(() => {}), new Promise((r) => setTimeout(r, 3000))]);
    }
    this.shutdown();
    this.hub.update(this.id, { status: 'stopped', activity: '停止しました', ...this.pendingState() });
  }

  release(force: boolean): boolean {
    if (this.ended || this.stoppedByUser) return true;
    const childrenWorking = this.hub.get(this.id)?.subagents?.some((agent) => ['running', 'pendingInit'].includes(agent.status));
    const busy = this.turnId || this.turnStarting || this.queued.length || this.queue.length || this.waiting.size || this.verifying || this.asyncQuestions.length || childrenWorking;
    if (!force && busy) return false;
    this.shutdown();
    return true;
  }

  async setPermissionMode(mode: PermissionChoice) {
    this.mode = mode;
    this.hub.update(this.id, { permissionMode: mode });
    const label = CODEX_PERMISSION_CHOICES.find((p) => p.value === mode)?.label ?? mode;
    this.timeline('system', `許可方針を「${label}」に変更しました（現在の応答が終わった後の新しい指示から反映。すぐに切り替えるには停止してから指示を送ってください）`);
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
    if (this.ended || this.stoppedByUser || this.rpc?.closed) return false;
    const asynchronous = this.asyncQuestions.find((p) => p.id === requestId);
    if (asynchronous) {
      if (this.answeringQuestions.has(requestId)) return false;
      const response = asyncQuestionAnswer(asynchronous, answers);
      this.hub.update(this.id, { asyncQuestions: this.asyncQuestions.map(p => p.id === requestId ? { ...p, answerError: undefined } : p) });
      this.send(response.text, [], response.history, requestId);
      return true;
    }
    const w = this.waiting.get(requestId);
    if (!w?.reply || w.pending.kind !== 'question') return false;
    const pending = w.pending;
    if (pending.questions.some((q) => typeof answerForQuestion(q, pending.questions, answers) !== 'string')) throw new Error('すべての質問に回答してください。');
    this.take(requestId);
    w.reply(answers);
    this.timeline('user', questionAnswerHistory(pending, answers));
    this.syncPending('回答を受けて作業を続けています');
    return true;
  }

  answerForm(body: FormAnswerBody): boolean {
    const w = this.waiting.get(body.requestId);
    if (!w?.formReply || w.pending.kind !== 'form') return false;
    if (!['accept', 'decline', 'cancel'].includes(body.action)) throw new Error('回答の種類が不正です。');
    if (body.action === 'accept') {
      const error = validateFormContent(w.pending.schema, body.content);
      if (error) throw new Error(error);
    }
    this.take(body.requestId);
    w.formReply(body);
    this.timeline('permission', body.action === 'accept' ? '入力フォームの回答を送信しました（入力内容は記録しません）' : body.action === 'decline' ? '入力フォームを辞退しました' : '入力フォームを取り消しました');
    this.syncPending('回答を受けて作業を続けています');
    return true;
  }

  // ---- 起動 ----

  private async boot(resumeFrom?: string) {
    const s = this.hub.get(this.id) ?? this.session;
    const bin = findCodexBin();
    if (!bin) throw new Error(CODEX_MISSING);
    const cwd = workDir(s);
    const env = codexAppServerEnv();
    const launch = codexAppServerLaunch(bin.command, bin.args);
    const proc = spawn(launch.command, launch.args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.proc = proc;
    live.add(proc);
    const rpc = new RpcClient(proc.stdout!, proc.stdin!);
    this.rpc = rpc;
    rpc.onNotification = (method, params) => this.onNotification(method, (params ?? {}) as Params);
    rpc.onRequest = (method, params, id) => this.onRequest(method, (params ?? {}) as Params, id);
    rpc.onClose = (error) => {
      if (this.proc === proc && !this.ended && !this.stoppedByUser) this.fail(error);
    };
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

    await rpc.request('initialize', {
      clientInfo: { name: 'tower', title: 'Tower', version: VERSION },
      capabilities: {
        experimentalApi: true,
        mcpServerOpenaiFormElicitation: true,
        // The legacy boolean enables only openai/form; modern form dispatch requires this extension.
        extensions: { 'openai/form': {}, 'openai/elicitation': { form: {} } },
      },
    });
    rpc.notify('initialized');
    const policy = codexPolicy(this.mode);
    const common = {
      cwd,
      model: s.model ?? null,
      approvalPolicy: policy.approvalPolicy,
      sandbox: policy.sandbox,
      developerInstructions: this.instructions(s),
      ...(s.requestedReasoningEffort ? { config: { model_reasoning_effort: s.requestedReasoningEffort } } : {}),
    };
    this.threadId = await this.openThread(common, resumeFrom);
    this.hub.update(this.id, { agentSessionId: this.threadId });
    this.flush();
  }

  private instructions(s: Session): string {
    // 書き方の注文はしない（出力を変えない）。Tower が用意した作業環境の事実だけ伝える
    const parts: string[] = [];
    if (process.platform === 'win32') parts.push(
      'WindowsではPowerShellのプロファイルを読み込みません。標準入出力はUTF-8の専用コンソールで実行します。UTF-8のファイルをPowerShellで読む場合はGet-Content -Encoding UTF8を指定してください。読めない出力から内容を推測せず、ファイルの文字コードを明示して再確認してください。依頼されていない文字コード変更や許可方針の変更で回避しないでください。',
    );
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
        const r = await rpc.request<Params>('thread/resume', { threadId: resumeFrom, ...common, excludeTurns: true });
        this.captureModel(r);
        return r.thread.id;
      } catch (e) {
        throw new Error(`前の会話を再開できませんでした。会話は保持しています。もう一度指示を送って再試行するか、新しいタスクを作成してください。\n${e instanceof Error ? e.message : String(e)}`, { cause: e });
      }
    }
    try {
      const r = await rpc.request<Params>('thread/start', { ...common, dynamicTools: BROWSER_TOOLS });
      this.captureModel(r);
      return r.thread.id;
    } catch (e) {
      // 道具を渡す口（試験中の機能）を受け付けない版の Codex なら、渡さずに始める
      if (!(e instanceof RpcError) || !/dynamic|unknown field|experimental/i.test(e.message)) throw e;
      this.timeline('system', 'この版の Codex には Tower のブラウザーを渡せませんでした（ブラウザーでの確認はできません）', e.message);
      const r = await rpc.request<Params>('thread/start', common);
      this.captureModel(r);
      return r.thread.id;
    }
  }

  // ---- 指示を渡す ----

  private captureModel(response: Params) {
    this.hub.update(this.id, {
      effectiveModel: typeof response.model === 'string' ? response.model : null,
      reasoningEffort: typeof response.reasoningEffort === 'string' ? response.reasoningEffort : null,
    });
  }

  /** 溜まった指示を渡す。手番が動いていれば差し込み、止まっていれば新しい手番を始める */
  private flush() {
    if (!this.rpc || !this.threadId || this.turnStarting || this.ended || this.queued.length === 0) return;
    const items = this.queued.splice(0);
    const last = [...items].reverse().find((m) => !m.asyncQuestionId) ?? items[items.length - 1];
    if (last) this.lastInstruction = instructionLine(last.text);
    const input = items.flatMap((m) => this.toInput(m.text, m.attachments));
    if (this.turnId) void this.steer(input, items);
    else void this.startTurn(input, items);
  }

  /** 画像は会話にそのまま載せ（Codex がすぐ見られる）、それ以外は保存場所を書き添えて読ませる */
  private toInput(text: string, attachments: SavedAttachment[]): UserInput[] {
    const images = attachments.filter(isInlineImage);
    return [
      { type: 'text', text: text + attachmentNote(attachments, isInlineImage), text_elements: [] },
      ...images.map((a) => ({ type: 'localImage' as const, path: a.path })),
    ];
  }

  private async startTurn(input: UserInput[], items: QueuedMessage[] = []) {
    this.turnStarting = true;
    this.liveOutput.clear();
    this.activeMode = this.mode;
    this.lastText = '';
    this.lastErrorText = null;
    const policy = codexPolicy(this.mode);
    this.hub.update(this.id, { status: 'running', activity: '作業を始めます', ...this.pendingState(), lastError: null });
    try {
      const session = this.hub.get(this.id) ?? this.session;
      // 未選択の通常モードはCodexの既存設定をそのまま使う。計画→通常の明示変更は送る。
      const collaborationMode = session.codexCollaborationMode;
      const actualModel = session.effectiveModel ?? session.model;
      if (collaborationMode && !actualModel) throw new Error('作業モードの変更に必要な実行モデルを取得できませんでした。再開してもう一度試してください。');
      const r = await this.rpc!.request<{ turn: { id: string } }>('turn/start', {
        threadId: this.threadId,
        input,
        approvalPolicy: policy.approvalPolicy,
        sandboxPolicy: policy.sandboxPolicy,
        ...(this.session.requestedReasoningEffort ? { effort: this.session.requestedReasoningEffort } : {}),
        ...(collaborationMode ? { collaborationMode: { mode: collaborationMode, settings: {
          model: actualModel!, reasoning_effort: session.requestedReasoningEffort ?? session.reasoningEffort ?? null, developer_instructions: null,
        } } } : {}),
      });
      if (!this.ended && !this.stoppedByUser && !this.doneTurns.has(r.turn.id)) {
        this.turnId = r.turn.id;
        this.liveOutput.start(r.turn.id);
      }
      this.turnStarting = false;
      if (!this.ended && !this.stoppedByUser) this.acknowledgeQuestions(items);
    } catch (e) {
      this.turnStarting = false;
      this.fail(e);
      return;
    }
    this.turnStarting = false;
    this.flush(); // 始めるのを待っている間に来た指示を差し込む
  }

  private async steer(input: UserInput[], items: QueuedMessage[]) {
    try {
      await this.rpc!.request('turn/steer', { threadId: this.threadId, input, expectedTurnId: this.turnId });
      if (!this.ended && !this.stoppedByUser) this.acknowledgeQuestions(items);
    } catch (error) {
      if (this.ended || this.stoppedByUser) return;
      // Only the documented active-turn race is eligible for automatic retry.
      if (error instanceof RpcError && /no active turn|(?:expected[_ ]?turn|turn)[^\n]*(?:mismatch|does not match)|turn[^\n]*(?:already completed|not active)/i.test(error.message)) {
        this.queued.unshift(...items);
        if (!this.turnId) this.flush();
        return;
      }
      const ids = items.flatMap(item => item.asyncQuestionId ? [item.asyncQuestionId] : []);
      for (const id of ids) this.answeringQuestions.delete(id);
      const message = '回答の送信に失敗しました。入力を確認して、もう一度送信してください。';
      this.hub.update(this.id, { asyncQuestions: this.asyncQuestions.map(p => ids.includes(p.id) ? { ...p, answerError: message } : p) });
      this.timeline('error', ids.length ? message : '追加指示を送信できませんでした。もう一度送信してください。');
      this.syncPending('送信に失敗しました。もう一度送信してください');
    }
  }

  // ---- Codex からの問い合わせ（許可・質問・道具） ----

  private onRequest(method: string, p: Params, rpcId: RpcId): Promise<unknown> {
    if (this.ended || this.stoppedByUser || this.rpc?.closed) return Promise.reject(new RpcError('この確認は接続終了のため無効です。再開後にもう一度質問してください。', -32000));
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
        if (isFormElicitation(params)) {
          const pending = { id, kind: 'form' as const, serverName: params.serverName, message: params.message ?? params.description ?? '入力内容を確認してください', schema: params.requestedSchema ?? false, createdAt: Date.now() };
          this.timeline('permission', `${serverLabel(params.serverName)}からの入力を待っています`);
          return new Promise((resolve) => this.enqueue({ pending, key,
            formReply: (body) => resolve({ action: body.action, content: body.action === 'accept' ? body.content : null, _meta: null }),
            cancel: () => resolve({ action: 'cancel', content: null, _meta: null }),
          }));
        }
        if (params.mode === 'openai/userVerification') {
          this.timeline('error', 'このCodexの実行環境は本人確認に対応していないため、この依頼は辞退しました。');
          return Promise.resolve({ action: 'decline', content: null, _meta: null });
        }
        return this.ask<{ action: string; content: unknown; _meta: null }>(
          elicitationPending(id, params),
          key,
          (d) => elicitationResponse(params, d),
          () => ({ action: 'cancel', content: null, _meta: null }),
          { kind: 'user_confirmation' },
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
    // 実行中の手番に渡した許可方針で判断する（次の手番用の選択とは区別する）
    const auto = autoAllow(this.activeMode, req);
    if (auto) {
      // 全自動の時だけ年表に残す（編集は、その操作自体が年表に出る）
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

  private get asyncQuestions(): PendingQuestion[] { return this.hub.get(this.id)?.asyncQuestions ?? []; }

  private acknowledgeQuestions(items: QueuedMessage[]) {
    const ids = items.flatMap((item) => item.asyncQuestionId ? [item.asyncQuestionId] : []);
    if (!ids.length) return;
    for (const id of ids) this.answeringQuestions.delete(id);
    this.hub.update(this.id, { asyncQuestions: this.asyncQuestions.filter((p) => !ids.includes(p.id)), resolvedAsyncQuestionIds: [...new Set([...(this.hub.get(this.id)?.resolvedAsyncQuestionIds ?? []), ...ids])] });
    this.syncPending('回答を受けて作業を続けています');
  }

  private pendingState(): Pick<Session, 'pending' | 'pendingCount'> {
    return { pending: this.queue[0] ?? this.asyncQuestions[0] ?? null, pendingCount: this.queue.length + this.asyncQuestions.length };
  }

  private cancelWaiting(reason: string) {
    if (this.queue.some((p) => p.kind === 'question')) this.timeline('system', reason);
    for (const w of this.waiting.values()) w.cancel();
    this.waiting.clear();
    this.queue = [];
  }

  /** 行列の先頭を UI に反映する。空なら作業中に戻す */
  private syncPending(activityWhenEmpty: string) {
    if (this.stoppedByUser || this.ended) return;
    const head = this.queue[0] ?? this.asyncQuestions[0];
    if (!head) {
      if (this.turnId || this.turnStarting) {
        this.hub.update(this.id, { status: 'running', activity: activityWhenEmpty || '作業中', pending: null, pendingCount: 0 });
      } else {
        this.hub.update(this.id, { pending: null, pendingCount: 0, ...(this.hub.get(this.id)?.status === 'waiting_question' ? { status: 'idle' as const, activity: '指示待ち' } : {}) });
      }
      return;
    }
    this.hub.update(this.id, {
      status: head.kind === 'question' && head.delivery === 'async' && (this.turnId || this.turnStarting) ? 'running' : head.kind === 'permission' ? 'waiting_permission' : 'waiting_question',
      activity:
        head.kind === 'permission'
          ? `許可待ち: ${head.headline}${this.queue.length > 1 ? `（他 ${this.queue.length - 1} 件）` : ''}`
          : head.kind === 'question' && head.delivery === 'async' && (this.turnId || this.turnStarting) ? '回答を待ちながら作業を続けています' : 'あなたの回答を待っています',
      pending: head,
      pendingCount: this.queue.length + this.asyncQuestions.length,
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
    if (this.ended || this.stoppedByUser) return;
    // サブエージェントの会話の知らせは本体の年表に混ぜない
    if (typeof p.threadId === 'string' && this.threadId && p.threadId !== this.threadId) {
      const current = this.hub.get(this.id);
      if (current?.subagents?.some(agent => agent.id === p.threadId)) {
        if (method === 'item/completed' && p.item?.type === 'agentMessage' && typeof p.item.text === 'string') {
          this.updateChild(p.threadId, { message: p.item.text });
        } else if (method === 'turn/started') this.updateChild(p.threadId, { status: 'running' });
        else if (method === 'turn/completed') {
          const status = p.turn?.status === 'failed' ? 'errored' : p.turn?.status === 'interrupted' ? 'interrupted' : 'completed';
          this.updateChild(p.threadId, { status, ...(p.turn?.error?.message ? { message: String(p.turn.error.message) } : {}) });
        }
      }
      return;
    }
    if (typeof p.turnId === 'string' && (this.doneTurns.has(p.turnId) || (this.turnId && p.turnId !== this.turnId))) return;
    switch (method) {
      case 'model/rerouted': {
        if (typeof p.toModel !== 'string' || !p.toModel) break;
        this.hub.update(this.id, { effectiveModel: p.toModel, reasoningEffort: null });
        const reason = p.reason === 'highRiskCyberActivity' ? '高度なサイバー関連の内容に対応するため' : String(p.reason ?? 'Codex側の判断');
        this.timeline('system', `実行モデルが ${String(p.fromModel ?? '以前のモデル')} から ${p.toModel} に変更されました`, `理由: ${reason}`);
        break;
      }
      case 'turn/started': {
        const t = String(p.turn?.id ?? '');
        if (t && !this.doneTurns.has(t) && (!this.turnId || this.turnId === t)) {
          this.turnId = t;
          this.liveOutput.start(t);
        }
        return;
      }
      case 'item/agentMessage/delta':
      case 'item/commandExecution/outputDelta':
        if (typeof p.delta === 'string' && typeof p.itemId === 'string') {
          this.liveOutput.append(String(p.turnId ?? this.turnId ?? ''), p.itemId, method === 'item/agentMessage/delta' ? 'assistant_text' : 'command_output', p.delta);
        }
        return;
      case 'item/started':
        this.onItem('started', (p.item ?? {}) as Params);
        return;
      case 'item/completed':
        this.liveOutput.complete(String(p.item?.id ?? ''));
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
          w.cancel();
          if (w.pending.kind === 'question') this.timeline('system', 'Codex側で同期の質問が終了しました。この質問には回答できません。必要ならもう一度質問してもらってください。');
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
        if (phase === 'completed' && typeof item.id === 'string' && Array.isArray(item.questions) && item.questions.length) {
          const questions = item.questions.filter((q: Params) => typeof q?.title === 'string');
          const pending = asyncQuestionPending(item.id, questions);
          if (pending.questions.length && !this.asyncQuestions.some((p) => p.id === pending.id) && !(cur.resolvedAsyncQuestionIds ?? []).includes(pending.id)) {
            this.hub.update(this.id, { asyncQuestions: [...this.asyncQuestions, pending] });
            this.syncPending('');
          }
        }
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
          for (const f of files) this.turnFiles.add(f);
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
      case 'collabAgentToolCall': {
        const agents = mergeAgentStates(cur.subagents, item);
        this.hub.update(this.id, { subagents: agents });
        if (phase === 'started') {
          const spawned = item.tool === 'spawnAgent';
          this.activity(spawned ? 'サブエージェントを動かしています' : 'サブエージェントとやりとりしています');
          if (spawned) this.timeline('tool_use', 'サブエージェントを動かしています', item.prompt ? String(item.prompt) : undefined, 'Agent');
        } else {
          const states = agents.filter(agent => (item.receiverThreadIds ?? []).includes(agent.id) || item.agentsStates?.[agent.id]);
          const failed = item.status === 'failed' || states.some(agent => agent.status === 'errored' || agent.status === 'notFound');
          this.timeline(failed ? 'error' : 'tool_result', failed ? 'サブエージェントの処理で問題が発生しました' : 'サブエージェントの状態を確認しました', states.map(agent => `${agent.name ?? agent.id}: ${agentStatusLabel(agent.status)}${agent.message ? `\n${agent.message}` : ''}`).join('\n\n'), 'Agent');
        }
        return;
      }
      case 'subAgentActivity': {
        if (typeof item.agentThreadId !== 'string') return;
        const status = item.kind === 'completed' ? 'completed' : item.kind === 'interrupted' ? 'interrupted' : 'running';
        this.updateChild(item.agentThreadId, { name: String(item.agentPath ?? item.agentThreadId), status });
        return;
      }
      case 'contextCompaction':
        if (phase === 'completed') this.timeline('system', '会話が長くなったので、これまでの内容を要約しました');
        return;
      case 'imageGeneration':
        if (phase === 'started') this.activity('画像を生成しています');
        else {
          const display = generatedImageDisplay(item, workDir(cur));
          this.timeline(display.kind, display.text, display.detail, 'ImageGen', display.imagePath);
        }
        return;
      default:
        return;
    }
  }

  private onTurnCompleted(turn: Params) {
    const tid = String(turn.id ?? '');
    if (this.doneTurns.has(tid)) return;
    this.doneTurns.add(tid);
    if (this.turnId && this.turnId !== tid) return;
    this.turnId = null;
    this.liveOutput.clear();
    // 手番が終わったので、答えを待っていた確認は取り下げる
    this.cancelWaiting('応答が終了したため、同期の質問は無効になりました。必要ならもう一度質問してもらってください。');
    if (this.stoppedByUser || this.ended) return;
    const cur = this.hub.get(this.id);
    if (!cur) return;

    if (turn.status === 'failed') {
      const msg = friendlyError(String(turn.error?.message ?? this.lastErrorText ?? '原因の分からないエラーで止まりました'), CODEX_MISSING);
      this.timeline('error', msg, turn.error?.additionalDetails ?? undefined);
      this.hub.update(this.id, { status: 'error', activity: 'エラーで止まりました', lastError: msg, ...this.pendingState() });
      this.shutdown();
      return;
    }
    if (turn.status === 'interrupted') {
      this.hub.update(this.id, { status: 'idle', activity: '中断しました。指示を送ると続けます', ...this.pendingState() });
      this.flush();
      return;
    }

    // 返事は書き換えずにそのまま持つ。この手番で変えたファイルを添える
    const report = replyReport(this.lastText || '(出力なし)', this.lastInstruction || instructionLine(cur.prompt), [...this.turnFiles], false);
    this.turnFiles = new Set();
    this.hub.update(this.id, {
      status: this.asyncQuestions.length ? 'waiting_question' : 'idle',
      activity: '返事が来ました。あなたの番です',
      report,
      turns: cur.turns + 1,
      ...this.pendingState(),
      lastError: null,
    });
    if (cur.changedFiles.length > 0) void this.verify();
    this.flush(); // 手番の終わりぎわに来た指示
  }

  // ---- 終わり方 ----

  /** Codex が勝手に終わった（落ちた） */
  private onExit(code: number | null) {
    this.verificationAbort?.abort();
    this.proc = null;
    this.liveOutput.clear();
    this.cancelWaiting('接続が終了したため、同期の質問は無効になりました。再開後にもう一度質問してもらってください。');
    void this.browser.close();
    if (this.stoppedByUser || this.ended) return;
    this.ended = true;
    const msg = `Codex が途中で終了しました（終了コード ${code ?? '?'}）。指示を送ると続きから再開します`;
    this.timeline('error', msg);
    this.hub.update(this.id, { status: 'error', activity: 'Codex が止まりました', lastError: msg, ...this.pendingState() });
  }

  private fail(e: unknown) {
    if (this.stoppedByUser || this.ended) return;
    const msg = friendlyError(e instanceof Error ? e.message : String(e), CODEX_MISSING);
    this.timeline('error', msg);
    this.cancelWaiting('接続が終了したため、同期の質問は無効になりました。再開後にもう一度質問してもらってください。');
    this.hub.update(this.id, { status: 'error', activity: 'エラーで止まりました', lastError: msg, ...this.pendingState() });
    this.shutdown();
  }

  /** Codex とブラウザーを止める。次の指示は Manager が新しいランナーで続きから再開する */
  private shutdown() {
    this.ended = true;
    this.verificationAbort?.abort();
    const children = this.hub.get(this.id)?.subagents;
    if (children?.some(agent => ['running', 'pendingInit'].includes(agent.status))) {
      this.hub.update(this.id, { subagents: children.map(agent => ['running', 'pendingInit'].includes(agent.status) ? { ...agent, status: 'interrupted' } : agent) });
    }
    this.liveOutput.clear();
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

  private updateChild(id: string, patch: Partial<NonNullable<Session['subagents']>[number]>) {
    const agents = this.hub.get(this.id)?.subagents ?? [];
    const found = agents.some(agent => agent.id === id);
    this.hub.update(this.id, { subagents: found
      ? agents.map(agent => agent.id === id ? { ...agent, ...patch, id } : agent)
      : [...agents, { id, status: 'pendingInit', ...patch }],
    });
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
    if (!cmd || this.verifying || this.stoppedByUser || this.ended) return;
    this.verifying = true;
    const controller = new AbortController();
    this.verificationAbort = controller;
    const at = Date.now();
    this.hub.update(this.id, { verification: { command: cmd, ok: null, output: '', at, durationMs: 0 } });
    try {
      const r = await runVerify(dir, cmd, undefined, controller.signal);
      if (this.verificationAbort !== controller || this.hub.get(this.id)?.verification?.at !== at) return;
      this.hub.update(this.id, { verification: { command: cmd, ok: r.ok, output: r.output, summary: r.summary, failed: r.failed, at, durationMs: r.durationMs } });
      if (this.stoppedByUser || this.ended || controller.signal.aborted) return;
      this.timeline('system', r.ok ? `自動チェック 成功: ${cmd}` : `自動チェック 失敗: ${cmd}`, r.output);
    } finally {
      this.verifying = false;
      if (this.verificationAbort === controller) this.verificationAbort = null;
    }
  }
}
