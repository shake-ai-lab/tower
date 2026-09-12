// Claude Code を Agent SDK 経由で1セッション動かし、生イベントを Session/Timeline に翻訳する。
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import {
  query,
  type Options,
  type PermissionResult,
  type PermissionUpdate,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import {
  workDir,
  type Attachment,
  type PendingPermission,
  type PermissionChoice,
  type PendingQuestion,
  type PendingRequest,
  type Question,
  type Session,
  type TimelineKind,
  type Usage,
} from '@tower/shared';
import { attachmentDir, attachmentNote, canInline, publicRefs, type SavedAttachment } from '../attachments.ts';
import type { Hub } from '../hub.ts';
import {
  assessRisk,
  describeActivity,
  describePermission,
  describeSubagentProgress,
  firstLine,
  hasJapanese,
  readImage,
  summarizeToolResult,
  toolDetail,
  touchedFile,
} from '../humanize.ts';
import { previewNote } from '../preview.ts';
import { scheduleReformat } from '../reformat.ts';

/** サブエージェント・ワークフローの裏の作業か（コマンドの裏実行は含めない） */
const isAgentTask = (type?: string) => /agent|workflow/i.test(type ?? '');
import { REPORT_INSTRUCTIONS, fallbackReport, parseReport } from '../report.ts';
import { detectVerifyCommand, runVerify } from '../verify.ts';
import { workspaceNote } from '../worktree.ts';
import type { AgentRunner } from './types.ts';

/** 後から push できる AsyncIterable。SDK の streaming input に渡す */
class PushQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiters: ((r: IteratorResult<T>) => void)[] = [];
  private closed = false;

  push(item: T) {
    if (this.closed) return;
    const w = this.waiters.shift();
    if (w) w({ value: item, done: false });
    else this.items.push(item);
  }

  close() {
    this.closed = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined as never, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.items.length) return Promise.resolve({ value: this.items.shift() as T, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((res) => this.waiters.push(res));
      },
    };
  }
}

interface PendingResolver {
  resolve: (r: PermissionResult) => void;
  toolName: string;
  input: Record<string, unknown>;
  suggestions: PermissionUpdate[];
}

/** PermissionUpdate（SDK の「次回から聞かない」提案）を人向けの説明にする */
function describeRules(suggestions: PermissionUpdate[]): string[] {
  const out: string[] = [];
  for (const s of suggestions) {
    if (s.type === 'addRules' || s.type === 'replaceRules') {
      for (const r of s.rules) {
        if (!r.ruleContent) out.push(`${r.toolName} をすべて`);
        else if (r.toolName === 'Bash' || r.toolName === 'PowerShell') {
          const prefix = r.ruleContent.replace(/\s*\*$/, '').replace(/:\*$/, '');
          out.push(r.ruleContent.endsWith('*') ? `「${prefix}」で始まるコマンド` : `コマンド「${r.ruleContent}」`);
        } else out.push(`${r.toolName}: ${r.ruleContent}`);
      }
    } else if (s.type === 'setMode') {
      out.push(s.mode === 'acceptEdits' ? 'ファイル編集をすべて自動' : `モードを ${s.mode} に`);
    } else if (s.type === 'addDirectories') {
      out.push(`フォルダ ${s.directories.join(', ')} へのアクセス`);
    }
  }
  return [...new Set(out)];
}

export class ClaudeRunner implements AgentRunner {
  private input = new PushQueue<SDKUserMessage>();
  private abort = new AbortController();
  private resolvers = new Map<string, PendingResolver>();
  /** 判断待ちの行列。先頭を UI に出す */
  private queue: PendingRequest[] = [];
  private q: Query | null = null;
  private lastAssistantText = '';
  private stoppedByUser = false;
  private verifying = false;
  /** 直近の応答が使った文脈の大きさ（トークン）。会話の容量に対する割合を出す */
  private lastContext = 0;
  /** tool_use の id → 名前と入力。結果（tool_result）を人向けに要約する時に引く */
  private toolUses = new Map<string, { name: string; input: Record<string, unknown> }>();
  /** 始まった裏の作業（task_id → 種類・説明） */
  private tasks = new Map<string, { type: string; description: string }>();
  /** 裏で動いているサブエージェント（task_id）。手番が終わってもこれが残っていれば、報告にせず続きを待つ */
  private bgAgents = new Set<string>();
  /** query() は再開のたびに集計がゼロから始まるので、開始時点の値を土台にして足す */
  private usageBase: Usage = { input: 0, cacheRead: 0, output: 0 };
  private costBase = 0;

  constructor(
    private session: Session,
    private hub: Hub,
  ) {}

  get id() {
    return this.session.id;
  }

  /**
   * @param firstMessage 最初に送る指示（新規なら依頼文、再開なら続きの指示）
   * @param resumeFrom   Claude 側の session_id。指定すると会話の続きから再開する
   */
  start(firstMessage: string, resumeFrom?: string, attachments: SavedAttachment[] = []) {
    const s = this.session;
    // 添付の置き場所（作業フォルダの外）も読めるようにしておく。途中で添えた時にも効くよう、先に作っておく
    const attachDir = attachmentDir(s.id);
    fs.mkdirSync(attachDir, { recursive: true });
    const live = this.hub.get(s.id) ?? s;
    this.usageBase = live.usage ?? { input: 0, cacheRead: 0, output: 0 };
    this.costBase = live.costUsd ?? 0;
    // 自分自身が Claude Code の中から起動された場合の「入れ子」判定を避ける
    const env = { ...process.env };
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;
    // hooks 連携（bridge）に「これは Tower 自身のセッション」と伝えて二重取り込みを防ぐ
    env.TOWER_MANAGED = '1';

    const parts = [REPORT_INSTRUCTIONS];
    if (s.workspace) parts.push(workspaceNote(s.workspace, s.project.path));
    if (s.preview) parts.push(previewNote(s.preview.target));
    const append = parts.join('\n\n');
    const options: Options = {
      cwd: workDir(s),
      additionalDirectories: [attachDir],
      model: s.model ?? undefined,
      permissionMode: s.permissionMode ?? 'default',
      allowDangerouslySkipPermissions: true,
      resume: resumeFrom,
      systemPrompt: { type: 'preset', preset: 'claude_code', append },
      canUseTool: (toolName, input, opts) => this.onPermission(toolName, input, opts.suggestions ?? [], opts.signal),
      abortController: this.abort,
      env,
      agentProgressSummaries: true,
      stderr: (d) => {
        const t = d.trim();
        if (t) console.error(`[claude ${s.id.slice(0, 8)}] ${t.slice(0, 500)}`);
      },
    };

    this.timeline('user', firstMessage, undefined, undefined, undefined, publicRefs(attachments));
    this.pushUser(firstMessage, attachments);
    this.q = query({ prompt: this.input, options });
    void this.consume();
  }

  /** 追加指示を送る */
  async setPermissionMode(mode: PermissionChoice) {
    if (!this.q || this.stoppedByUser) throw new Error('タスクが停止しています。再開後に変更してください');
    await this.q.setPermissionMode(mode);
    this.hub.update(this.id, { permissionMode: mode });
    this.timeline('system', `許可方針を ${mode} に変更しました`);
    // 全自動を明示的に選んだ時だけ、既に並んでいる許可要求も進める。質問は残す。
    if (mode === 'bypassPermissions') {
      for (const pending of [...this.queue]) {
        if (pending.kind === 'permission') this.resolvePermission(pending.id, 'allow');
      }
    }
  }

  send(text: string, attachments: SavedAttachment[] = []) {
    this.timeline('user', text, undefined, undefined, undefined, publicRefs(attachments));
    this.pushUser(text, attachments);
    if (this.queue.length) {
      // 許可か質問に答えるまで、この指示はエージェントに届かない。待ちの表示は消さずに残す
      this.timeline('system', '許可・質問に答えると、この指示に進みます');
      this.syncPending('指示を受け取りました');
      return;
    }
    this.hub.update(this.id, { status: 'running', activity: '指示を受け取りました', pending: null, pendingCount: 0 });
  }

  async stop() {
    this.stoppedByUser = true;
    for (const [id, r] of this.resolvers) {
      r.resolve({ behavior: 'deny', message: 'セッションが停止されました' });
      this.resolvers.delete(id);
    }
    this.queue = [];
    try {
      await this.q?.interrupt();
    } catch {
      /* 既に終了している */
    }
    this.input.close();
    this.abort.abort();
    this.hub.update(this.id, { status: 'stopped', activity: '停止しました', pending: null, pendingCount: 0 });
  }

  resolvePermission(requestId: string, decision: 'allow' | 'allow_always' | 'deny', message?: string): boolean {
    const r = this.take(requestId);
    if (!r) return false;
    if (decision === 'deny') {
      r.resolve({
        behavior: 'deny',
        message: message?.trim() || '利用者がこの操作を拒否しました。別の方法を検討してください。',
      });
      this.timeline('permission', message ? `拒否: ${message}` : '拒否しました');
      this.syncPending('拒否を受けて考え直しています');
    } else {
      r.resolve({
        behavior: 'allow',
        updatedInput: r.input,
        updatedPermissions: decision === 'allow_always' ? r.suggestions : undefined,
      });
      this.timeline('permission', decision === 'allow_always' ? '許可しました（以後も許可）' : '許可しました');
      this.syncPending(describeActivity(r.toolName, r.input));
    }
    return true;
  }

  answerQuestion(requestId: string, answers: Record<string, string>): boolean {
    const r = this.take(requestId);
    if (!r) return false;
    r.resolve({ behavior: 'allow', updatedInput: { questions: r.input.questions, answers } });
    this.timeline(
      'user',
      Object.entries(answers)
        .map(([q, a]) => `${q} → ${a}`)
        .join('\n'),
    );
    this.syncPending('回答を受けて作業を続けています');
    return true;
  }

  // ---- 内部 ----

  /**
   * 使った量の集計。modelUsage（サブエージェントや内部の呼び出しも含む全モデル分）は
   * この query() の中で累積なので、開始時点の土台に「今回の query() の累計」を足す
   */
  private sumUsage(m: Extract<SDKMessage, { type: 'result' }>): Usage {
    const models = Object.values(m.modelUsage ?? {});
    let input = 0;
    let cacheRead = 0;
    let output = 0;
    let contextWindow = 0;
    let main = 0;
    for (const u of models) {
      input += (u.inputTokens ?? 0) + (u.cacheReadInputTokens ?? 0) + (u.cacheCreationInputTokens ?? 0);
      cacheRead += u.cacheReadInputTokens ?? 0;
      output += u.outputTokens ?? 0;
      // 一番たくさん読んだモデルを「本体」とみなして、その容量を使う
      const total = (u.inputTokens ?? 0) + (u.cacheReadInputTokens ?? 0);
      if (total >= main && u.contextWindow) {
        main = total;
        contextWindow = u.contextWindow;
      }
    }
    const b = this.usageBase;
    return {
      input: b.input + input,
      cacheRead: b.cacheRead + cacheRead,
      output: b.output + output,
      context: this.lastContext || b.context,
      contextWindow: contextWindow || b.contextWindow,
    };
  }

  /** 報告の裏取り: プロジェクトのテストを Tower 側で走らせ、結果をセッションに載せる */
  private async verify() {
    const dir = workDir(this.session);
    const cmd = detectVerifyCommand(dir);
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

  /** 画像は会話にそのまま載せ（エージェントがすぐ見られる）、それ以外は保存場所を書き添えて読ませる */
  private pushUser(text: string, attachments: SavedAttachment[] = []) {
    const images = attachments.filter(canInline);
    const body = text + attachmentNote(attachments, (a) => images.includes(a));
    const content = images.length
      ? [
          { type: 'text' as const, text: body },
          ...images.map((a) => ({
            type: 'image' as const,
            source: {
              type: 'base64' as const,
              media_type: a.mime as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp',
              data: fs.readFileSync(a.path).toString('base64'),
            },
          })),
        ]
      : body;
    this.input.push({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null });
  }

  private timeline(
    kind: TimelineKind,
    text: string,
    detail?: string,
    toolName?: string,
    imagePath?: string,
    attachments?: Attachment[],
  ) {
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

  /** 行列から1件取り出す（resolver も外す） */
  private take(requestId: string): PendingResolver | undefined {
    const r = this.resolvers.get(requestId);
    if (!r) return undefined;
    this.resolvers.delete(requestId);
    this.queue = this.queue.filter((p) => p.id !== requestId);
    return r;
  }

  /** 行列の先頭を UI に反映する。空なら作業中に戻す */
  private syncPending(activityWhenEmpty: string) {
    const head = this.queue[0];
    if (!head) {
      this.hub.update(this.id, { status: 'running', activity: activityWhenEmpty, pending: null, pendingCount: 0 });
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

  private onPermission(
    toolName: string,
    input: Record<string, unknown>,
    suggestions: PermissionUpdate[],
    signal: AbortSignal,
  ): Promise<PermissionResult> {
    const id = randomUUID();
    let pending: PendingRequest;

    if (toolName === 'AskUserQuestion') {
      const questions = (input.questions as Question[] | undefined) ?? [];
      pending = { id, kind: 'question', questions, createdAt: Date.now() } satisfies PendingQuestion;
      this.timeline('permission', `質問: ${questions.map((q) => q.question).join(' / ')}`);
    } else {
      const { headline, detail } = describePermission(toolName, input);
      pending = {
        id,
        kind: 'permission',
        toolName,
        input,
        headline,
        detail,
        risk: assessRisk(toolName, input),
        canAlwaysAllow: suggestions.length > 0,
        alwaysRules: describeRules(suggestions),
        createdAt: Date.now(),
      } satisfies PendingPermission;
      this.timeline('permission', `許可待ち: ${headline}`, detail, toolName);
    }

    this.queue.push(pending);
    this.syncPending('');

    return new Promise<PermissionResult>((resolve) => {
      this.resolvers.set(id, { resolve, toolName, input, suggestions });
      signal.addEventListener('abort', () => {
        if (this.take(id)) {
          resolve({ behavior: 'deny', message: 'cancelled' });
          if (!this.stoppedByUser) this.syncPending('作業中');
        }
      });
    });
  }

  private async consume() {
    try {
      for await (const m of this.q as Query) this.handle(m);
      if (!this.stoppedByUser) this.hub.update(this.id, { status: 'done', activity: '終了しました', pending: null, pendingCount: 0 });
    } catch (e) {
      if (this.stoppedByUser) return;
      const msg = e instanceof Error ? e.message : String(e);
      this.timeline('error', msg);
      this.hub.update(this.id, { status: 'error', activity: 'エラーで停止しました', lastError: msg, pending: null, pendingCount: 0 });
    }
  }

  private handle(m: SDKMessage) {
    const cur = this.hub.get(this.id);
    if (!cur) return;

    switch (m.type) {
      case 'system': {
        if (m.subtype === 'init') {
          this.hub.update(this.id, {
            agentSessionId: m.session_id,
            status: 'running',
            activity: '準備完了。作業を始めます',
          });
        } else if (m.subtype === 'permission_denied') {
          this.timeline('system', `自動拒否: ${m.tool_name}`, m.message, m.tool_name);
        } else if (m.subtype === 'task_progress' && m.summary) {
          this.hub.update(this.id, { activity: describeSubagentProgress(m.summary, m.last_tool_name) });
        } else if (m.subtype === 'task_started') {
          // 待つのは裏で動くサブエージェントだけ（裏で動かしっぱなしのコマンド＝開発サーバーなどは終わらないので待たない）
          this.tasks.set(m.task_id, { type: m.task_type ?? '', description: m.description });
          if (isAgentTask(m.task_type) && m.is_backgrounded && !m.ambient) this.bgAgents.add(m.task_id);
        } else if (m.subtype === 'task_updated') {
          const t = this.tasks.get(m.task_id);
          if (m.patch.is_backgrounded && t && isAgentTask(t.type)) this.bgAgents.add(m.task_id);
          if (m.patch.status && !['pending', 'running', 'paused'].includes(m.patch.status)) this.bgAgents.delete(m.task_id);
        } else if (m.subtype === 'task_notification') {
          const t = this.tasks.get(m.task_id);
          const waited = this.bgAgents.delete(m.task_id);
          this.tasks.delete(m.task_id);
          if (waited) {
            const label = t && hasJapanese(t.description) ? `（${t.description.slice(0, 60)}）` : '';
            const done = m.status === 'completed' ? 'が終わりました' : m.status === 'failed' ? 'が失敗しました' : 'を止めました';
            this.timeline('system', `裏のサブエージェント${label}${done}`);
          }
        }
        break;
      }
      case 'tool_use_summary': {
        if (m.summary && this.queue.length === 0) this.hub.update(this.id, { activity: m.summary });
        break;
      }
      case 'assistant': {
        if (m.parent_tool_use_id) break; // サブエージェントの中身は年表に出さない
        {
          // 1 回の応答の入力トークン = その時点の会話の大きさ
          const u = m.message.usage as { input_tokens?: number | null; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null } | undefined;
          if (u) this.lastContext = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
        }
        let toolCalls = cur.toolCalls;
        const changed = new Set(cur.changedFiles);
        let activity: string | null = null;
        for (const block of m.message.content) {
          if (block.type === 'text' && block.text.trim()) {
            this.lastAssistantText = block.text;
            // 最後の【報告】は上の報告カードに整形して出るので、年表では「書いた」ことだけ分かればよい
            const head = block.text.trimStart().startsWith('【報告】')
              ? '報告を書きました（上の「報告」に表示）'
              : firstLine(block.text).slice(0, 140);
            this.timeline('assistant_text', head, block.text);
            activity = '考えをまとめています';
          } else if (block.type === 'tool_use') {
            const input = (block.input ?? {}) as Record<string, unknown>;
            toolCalls++;
            this.toolUses.set(block.id, { name: block.name, input });
            const f = touchedFile(block.name, input);
            if (f) changed.add(f);
            activity = describeActivity(block.name, input);
            this.timeline('tool_use', activity, toolDetail(block.name, input), block.name, readImage(block.name, input));
          }
        }
        // 判断待ち中は activity を上書きしない（許可待ちの表示を守る）
        const waiting = this.queue.length > 0;
        this.hub.update(this.id, {
          toolCalls,
          changedFiles: [...changed],
          ...(activity && !waiting ? { activity } : {}),
          ...(cur.status === 'idle' ? { status: 'running' } : {}),
        });
        break;
      }
      case 'user': {
        if (m.parent_tool_use_id) break;
        const content = m.message.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'tool_result') {
              const isErr = block.is_error === true;
              const tu = this.toolUses.get(block.tool_use_id);
              this.toolUses.delete(block.tool_use_id);
              // エラーは原文（何が起きたか）が要る。成功は「何をしたか」を日本語で
              const summary = isErr ? summarizeToolResult(block.content) : summarizeToolResult(block.content, tu?.name, tu?.input);
              this.timeline(isErr ? 'error' : 'tool_result', isErr ? `失敗: ${summary}` : summary || '(結果なし)');
            }
          }
        }
        break;
      }
      case 'result': {
        if (this.stoppedByUser) break; // 停止操作による中断結果は状態に反映しない
        const isError = m.subtype !== 'success' || m.is_error;
        const text = m.subtype === 'success' ? m.result : this.lastAssistantText;
        const errors = 'errors' in m && Array.isArray(m.errors) ? (m.errors as string[]).join('\n') : '';
        // 裏のサブエージェントがまだ動いている: 「少し待って」のような途中の一言なので報告にしない（整形・裏取りもしない）。
        // 終わると SDK が知らせを差し込み、エージェントが続きを書く
        if (!isError && this.bgAgents.size > 0) {
          this.hub.update(this.id, {
            status: 'running',
            activity: `裏でサブエージェントが作業中です（${this.bgAgents.size} 件）。終わると続きを書きます`,
            turns: cur.turns + 1,
            costUsd: this.costBase + (m.total_cost_usd ?? 0),
            usage: this.sumUsage(m),
          });
          this.timeline('system', '裏でサブエージェントが作業を続けています。終わると続きを書きます');
          break;
        }
        const report =
          parseReport(text || '', cur.prompt) ?? fallbackReport(text || errors || '(出力なし)', cur.prompt, isError);
        // 報告に書かれたファイル名は相対パスのことが多いので、既に追跡済み（絶対パス）のものと二重計上しない
        const changed = new Set(cur.changedFiles);
        const known = new Set(cur.changedFiles.map((f) => f.split(/[\\/]/).pop()));
        for (const f of report.changedFiles) if (!known.has(f.split(/[\\/]/).pop())) changed.add(f);
        this.hub.update(this.id, {
          status: isError ? 'error' : 'idle',
          activity: isError
            ? 'エラーで止まりました'
            : report.needsDecision
              ? `判断待ち: ${firstLine(report.needsDecision).slice(0, 60)}`
              : '指示待ち',
          report,
          turns: cur.turns + 1,
          costUsd: this.costBase + (m.total_cost_usd ?? 0),
          usage: this.sumUsage(m),
          changedFiles: [...changed],
          lastError: isError ? errors || text || 'unknown error' : null,
          pending: null,
          pendingCount: 0,
        });
        if (isError && errors) this.timeline('error', errors);
        if (!isError && changed.size > 0) void this.verify();
        scheduleReformat(this.hub, this.id, report);
        break;
      }
      default:
        break;
    }
  }
}
