// Claude Code を Agent SDK 経由で1セッション動かし、生イベントを Session/Timeline に翻訳する。
import { randomUUID } from 'node:crypto';
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
  type PendingPermission,
  type PendingQuestion,
  type PendingRequest,
  type Question,
  type Session,
  type TimelineKind,
} from '@tower/shared';
import type { Hub } from '../hub.ts';
import {
  assessRisk,
  describeActivity,
  describePermission,
  firstLine,
  summarizeToolResult,
  toolDetail,
  touchedFile,
} from '../humanize.ts';
import { previewNote } from '../preview.ts';
import { scheduleReformat } from '../reformat.ts';
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
  start(firstMessage: string, resumeFrom?: string) {
    const s = this.session;
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
      model: s.model ?? undefined,
      permissionMode: s.permissionMode ?? 'default',
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

    this.timeline('user', firstMessage);
    this.pushUser(firstMessage);
    this.q = query({ prompt: this.input, options });
    void this.consume();
  }

  /** 追加指示を送る */
  send(text: string) {
    this.timeline('user', text);
    this.hub.update(this.id, { status: 'running', activity: '指示を受け取りました', pending: null, pendingCount: 0 });
    this.pushUser(text);
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

  private pushUser(text: string) {
    this.input.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null });
  }

  private timeline(kind: TimelineKind, text: string, detail?: string, toolName?: string) {
    this.hub.timeline({ id: randomUUID(), sessionId: this.id, ts: Date.now(), kind, text, detail, toolName });
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
          this.hub.update(this.id, { activity: `サブエージェント: ${m.summary}` });
        }
        break;
      }
      case 'tool_use_summary': {
        if (m.summary && this.queue.length === 0) this.hub.update(this.id, { activity: m.summary });
        break;
      }
      case 'assistant': {
        if (m.parent_tool_use_id) break; // サブエージェントの中身は年表に出さない
        let toolCalls = cur.toolCalls;
        const changed = new Set(cur.changedFiles);
        let activity: string | null = null;
        for (const block of m.message.content) {
          if (block.type === 'text' && block.text.trim()) {
            this.lastAssistantText = block.text;
            this.timeline('assistant_text', firstLine(block.text).slice(0, 140), block.text);
            activity = '考えをまとめています';
          } else if (block.type === 'tool_use') {
            const input = (block.input ?? {}) as Record<string, unknown>;
            toolCalls++;
            const f = touchedFile(block.name, input);
            if (f) changed.add(f);
            activity = describeActivity(block.name, input);
            this.timeline('tool_use', activity, toolDetail(block.name, input), block.name);
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
              const summary = summarizeToolResult(block.content);
              const isErr = block.is_error === true;
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
          costUsd: m.total_cost_usd ?? cur.costUsd,
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
