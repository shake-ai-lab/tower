// OpenAI Codex を Codex SDK（codex exec）経由で1セッション動かし、イベントを Session/Timeline に翻訳する。
//
// Claude との違い:
// - codex exec は非対話なので、コマンドごとの許可確認ができない。代わりに Codex の砂場
//   （作業フォルダ内だけ書き込み可・ネットワーク無し）で動かして安全側に倒す
// - システムプロンプトを差し込む口が無いので、報告書式は最初の指示の前置きとして渡す
// - 料金の見積もりは出ないので costUsd は 0 のまま
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { Codex, type Thread, type ThreadEvent, type ThreadItem } from '@openai/codex-sdk';
import { workDir, type Session, type TimelineKind } from '@tower/shared';
import type { Hub } from '../hub.ts';
import { firstLine } from '../humanize.ts';
import { scheduleReformat } from '../reformat.ts';
import { REPORT_INSTRUCTIONS, fallbackReport, parseReport } from '../report.ts';
import { detectVerifyCommand, runVerify } from '../verify.ts';
import { workspaceNote } from '../worktree.ts';
import type { AgentRunner } from './types.ts';

const REMINDER = '\n\n（前と同じ【報告】書式で報告してください）';

/** 最初の指示の前置き。分離した作業場所ならその注意書きも付ける */
function preamble(s: Session): string {
  const note = s.workspace ? `\n\n${workspaceNote(s.workspace, s.project.path)}` : '';
  return `${REPORT_INSTRUCTIONS}${note}\n\n---\n以下が依頼です。\n\n`;
}

/** Codex の失敗メッセージを、利用者が次に何をすればいいか分かる文にする */
function friendlyError(msg: string): string {
  const m = msg.toLowerCase();
  if (m.includes('not logged in') || m.includes('login') || m.includes('unauthorized') || m.includes('401')) {
    return 'Codex にログインしていません。ターミナルで `npx codex login`（ChatGPT アカウント）を実行してから、もう一度指示を送ってください。';
  }
  if (m.includes('enoent') || m.includes('not found')) {
    return 'Codex の実行ファイルが見つかりません。`npm install` をやり直してください。';
  }
  return msg;
}

export class CodexRunner implements AgentRunner {
  private thread: Thread | null = null;
  private abort = new AbortController();
  private busy = false;
  private queued: string[] = [];
  private stoppedByUser = false;
  private verifying = false;
  private first = true;

  constructor(
    private session: Session,
    private hub: Hub,
  ) {}

  get id() {
    return this.session.id;
  }

  start(firstMessage: string, resumeFrom?: string) {
    const s = this.session;
    const codex = new Codex();
    const opts = {
      workingDirectory: workDir(s),
      skipGitRepoCheck: true,
      sandboxMode: 'workspace-write' as const,
      approvalPolicy: 'never' as const,
      model: s.model ?? undefined,
    };
    this.thread = resumeFrom ? codex.resumeThread(resumeFrom, opts) : codex.startThread(opts);
    this.first = !resumeFrom;
    this.timeline('user', firstMessage);
    void this.runTurn(firstMessage);
  }

  send(text: string) {
    this.timeline('user', text);
    if (this.busy) {
      this.queued.push(text);
      this.hub.update(this.id, { activity: '指示を受け取りました（今の作業の後に実行）' });
      return;
    }
    void this.runTurn(text);
  }

  async stop() {
    this.stoppedByUser = true;
    this.queued = [];
    this.abort.abort();
    this.hub.update(this.id, { status: 'stopped', activity: '停止しました', pending: null, pendingCount: 0 });
  }

  resolvePermission(): boolean {
    return false; // codex exec は許可確認を持たない
  }

  answerQuestion(): boolean {
    return false;
  }

  // ---- 内部 ----

  private timeline(kind: TimelineKind, text: string, detail?: string, toolName?: string) {
    this.hub.timeline({ id: randomUUID(), sessionId: this.id, ts: Date.now(), kind, text, detail, toolName });
  }

  private async runTurn(text: string) {
    if (!this.thread) return;
    this.busy = true;
    this.hub.update(this.id, { status: 'running', activity: '準備完了。作業を始めます', pending: null, pendingCount: 0 });
    const input = this.first ? preamble(this.session) + text : text + REMINDER;
    this.first = false;
    let lastText = '';
    let failed: string | null = null;
    try {
      const { events } = await this.thread.runStreamed(input, { signal: this.abort.signal });
      for await (const ev of events) {
        const r = this.handle(ev);
        if (r.text) lastText = r.text;
        if (r.error) failed = r.error;
      }
    } catch (e) {
      failed = e instanceof Error ? e.message : String(e);
    } finally {
      this.busy = false;
    }
    if (this.stoppedByUser) return;

    const cur = this.hub.get(this.id);
    if (!cur) return;
    if (failed) {
      const msg = friendlyError(failed);
      this.timeline('error', msg);
      this.hub.update(this.id, { status: 'error', activity: 'エラーで止まりました', lastError: msg });
      return;
    }
    const report = parseReport(lastText, cur.prompt) ?? fallbackReport(lastText || '(出力なし)', cur.prompt, false);
    const changed = new Set(cur.changedFiles);
    const known = new Set(cur.changedFiles.map((f) => path.basename(f)));
    for (const f of report.changedFiles) if (!known.has(path.basename(f))) changed.add(f);
    this.hub.update(this.id, {
      status: 'idle',
      activity: report.needsDecision ? `判断待ち: ${firstLine(report.needsDecision).slice(0, 60)}` : '指示待ち',
      report,
      turns: cur.turns + 1,
      changedFiles: [...changed],
      lastError: null,
    });
    if (changed.size > 0) void this.verify();
    scheduleReformat(this.hub, this.id, report);

    const next = this.queued.shift();
    if (next) void this.runTurn(next);
  }

  /** イベント1件を状態に反映。最終テキストとエラーを返す */
  private handle(ev: ThreadEvent): { text?: string; error?: string } {
    const cur = this.hub.get(this.id);
    if (!cur) return {};
    switch (ev.type) {
      case 'thread.started':
        this.hub.update(this.id, { agentSessionId: ev.thread_id });
        return {};
      case 'turn.started':
        return {};
      case 'item.started':
      case 'item.updated':
      case 'item.completed':
        return this.handleItem(ev.type, ev.item, cur);
      case 'turn.failed':
        return { error: ev.error.message };
      case 'error':
        return { error: ev.message };
      case 'turn.completed':
        return {};
      default:
        return {};
    }
  }

  private handleItem(phase: 'item.started' | 'item.updated' | 'item.completed', item: ThreadItem, cur: Session): { text?: string; error?: string } {
    switch (item.type) {
      case 'agent_message':
        if (phase === 'item.completed' && item.text.trim()) {
          this.timeline('assistant_text', firstLine(item.text).slice(0, 140), item.text);
          return { text: item.text };
        }
        return {};
      case 'reasoning':
        if (phase === 'item.started') this.hub.update(this.id, { activity: '考えをまとめています' });
        return {};
      case 'command_execution': {
        const cmd = firstLine(item.command).slice(0, 60);
        if (phase === 'item.started') {
          this.hub.update(this.id, { activity: `コマンド実行中: ${cmd}`, toolCalls: cur.toolCalls + 1 });
          this.timeline('tool_use', `コマンド実行中: ${cmd}`, item.command, 'Bash');
        } else if (phase === 'item.completed') {
          const ok = item.exit_code === 0;
          const tail = item.aggregated_output.trim().split(/\r?\n/).slice(-1)[0] ?? '';
          this.timeline(ok ? 'tool_result' : 'error', ok ? tail.slice(0, 120) || '(出力なし)' : `失敗 (exit ${item.exit_code}): ${tail.slice(0, 120)}`, item.aggregated_output.slice(-4000));
        }
        return {};
      }
      case 'file_change': {
        if (phase !== 'item.completed') return {};
        const files = item.changes.map((c) => (path.isAbsolute(c.path) ? c.path : path.join(workDir(cur), c.path)));
        const names = item.changes.map((c) => `${c.kind === 'add' ? '追加' : c.kind === 'delete' ? '削除' : '変更'}: ${path.basename(c.path)}`);
        this.timeline(item.status === 'completed' ? 'tool_use' : 'error', `ファイルを${item.status === 'completed' ? '変更しました' : '変更できませんでした'} (${names.join(', ')})`, files.join('\n'), 'Edit');
        this.hub.update(this.id, {
          activity: `${path.basename(files[0] ?? '')} を編集しました`,
          toolCalls: cur.toolCalls + 1,
          changedFiles: [...new Set([...cur.changedFiles, ...files])],
        });
        return {};
      }
      case 'web_search':
        if (phase === 'item.started') this.hub.update(this.id, { activity: `Web検索中 (${item.query.slice(0, 40)})` });
        return {};
      case 'mcp_tool_call':
        if (phase === 'item.started') this.hub.update(this.id, { activity: `${item.tool} を実行しています`, toolCalls: cur.toolCalls + 1 });
        else if (phase === 'item.completed' && item.error) this.timeline('error', `${item.tool} 失敗: ${item.error.message.slice(0, 120)}`);
        return {};
      case 'todo_list':
        if (phase === 'item.started') this.hub.update(this.id, { activity: '作業計画を整理しています' });
        return {};
      case 'error':
        this.timeline('error', item.message);
        return {};
      default:
        return {};
    }
  }

  private async verify() {
    const dir = workDir(this.session);
    const cmd = detectVerifyCommand(dir);
    if (!cmd || this.verifying) return;
    this.verifying = true;
    const at = Date.now();
    this.hub.update(this.id, { verification: { command: cmd, ok: null, output: '', at, durationMs: 0 } });
    try {
      const r = await runVerify(dir, cmd);
      this.hub.update(this.id, { verification: { command: cmd, ok: r.ok, output: r.output, summary: r.summary, at, durationMs: r.durationMs } });
      this.timeline('system', r.ok ? `自動チェック 成功: ${cmd}` : `自動チェック 失敗: ${cmd}`, r.output);
    } finally {
      this.verifying = false;
    }
  }
}
