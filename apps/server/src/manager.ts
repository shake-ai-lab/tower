// SessionManager: セッションの生成・再開・停止・削除と、動いている Runner（Claude / Codex）の管理。
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  workDir,
  type AgentAvailability,
  type AgentKind,
  type CreateSessionBody,
  type MergeResult,
  type Session,
  type SessionStatus,
  type TimelineKind,
} from '@tower/shared';
import { ClaudeRunner } from './agents/claude.ts';
import { CodexRunner } from './agents/codex.ts';
import type { AgentRunner } from './agents/types.ts';
import type { Hub } from './hub.ts';
import { detectVerifyCommand, runVerify } from './verify.ts';
import { createWorktree, mergeWorktree, removeWorktree } from './worktree.ts';

/** エージェントが手を動かしている最中（取り込み・直接編集はこの間できない） */
const WORKING: SessionStatus[] = ['starting', 'running', 'waiting_permission', 'waiting_question'];

const require = createRequire(import.meta.url);

/** Codex のログイン状態（60秒キャッシュ）。バイナリは @openai/codex に同梱 */
let codexCache: { at: number; value: AgentAvailability } | null = null;
function codexAvailability(): AgentAvailability {
  if (codexCache && Date.now() - codexCache.at < 60_000) return codexCache.value;
  let value: AgentAvailability;
  try {
    const bin = require.resolve('@openai/codex/bin/codex.js');
    const r = spawnSync(process.execPath, [bin, 'login', 'status'], { encoding: 'utf8', timeout: 15_000 });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
    value =
      r.status === 0 && !/not logged in/i.test(out)
        ? { available: true }
        : { available: false, reason: 'Codex にログインしていません。ターミナルで `npx codex login` を実行してください' };
  } catch (e) {
    value = { available: false, reason: `Codex が見つかりません: ${e instanceof Error ? e.message : String(e)}` };
  }
  codexCache = { at: Date.now(), value };
  return value;
}

export function agentAvailability(): Record<AgentKind, AgentAvailability> {
  return { claude: { available: true }, codex: codexAvailability() };
}

export class SessionManager {
  private runners = new Map<string, AgentRunner>();

  constructor(private hub: Hub) {}

  private makeRunner(session: Session): AgentRunner {
    return session.agent === 'codex' ? new CodexRunner(session, this.hub) : new ClaudeRunner(session, this.hub);
  }

  create(body: CreateSessionBody): Session {
    const projectPath = path.resolve(body.projectPath);
    if (!fs.existsSync(projectPath) || !fs.statSync(projectPath).isDirectory()) {
      throw new Error(`プロジェクトフォルダが見つかりません: ${projectPath}`);
    }
    const prompt = body.prompt.trim();
    if (!prompt) throw new Error('指示が空です');
    const agent: AgentKind = body.agent === 'codex' ? 'codex' : 'claude';
    if (agent === 'codex') {
      const a = codexAvailability();
      if (!a.available) throw new Error(a.reason ?? 'Codex が使えません');
    }

    const id = randomUUID();
    // 別の作業場所（worktree）。作れなければセッションを作らずにエラーを返す
    const isolated = body.isolate ? createWorktree(projectPath, id) : null;

    const now = Date.now();
    const session: Session = {
      id,
      agent,
      agentSessionId: null,
      project: { path: projectPath, name: path.basename(projectPath) },
      workspace: isolated?.workspace ?? null,
      title: prompt.split(/\r?\n/)[0].slice(0, 60),
      prompt,
      model: body.model ?? null,
      permissionMode: body.permissionMode ?? 'acceptEdits',
      status: 'starting',
      activity: '起動しています…',
      pending: null,
      pendingCount: 0,
      report: null,
      turns: 0,
      costUsd: 0,
      toolCalls: 0,
      changedFiles: [],
      createdAt: now,
      updatedAt: now,
      lastError: null,
    };
    this.hub.add(session);
    if (isolated) {
      const shared = isolated.linked.length ? `。依存パッケージ（node_modules）は元のプロジェクトと共有` : '';
      this.note(
        id,
        'system',
        `別の作業場所を作りました（ブランチ ${isolated.workspace.branch}）${shared}`,
        `${isolated.workspace.path}\n元のプロジェクト: ${projectPath}`,
      );
    }
    // エージェントが手を付ける前の状態を測っておく（「修正前 → 修正後」の対比用）。起動は待たせない
    void this.runBaseline(session);
    const runner = this.makeRunner(session);
    this.runners.set(session.id, runner);
    runner.start(prompt);
    return session;
  }

  private async runBaseline(s: Session) {
    const dir = workDir(s);
    const cmd = detectVerifyCommand(dir);
    if (!cmd) return;
    const at = Date.now();
    const r = await runVerify(dir, cmd, 90_000);
    if (!this.hub.get(s.id)) return; // その間に消された
    this.hub.update(s.id, { baseline: { command: cmd, ok: r.ok, output: r.output, summary: r.summary, failed: r.failed, at, durationMs: r.durationMs } });
    this.note(
      s.id,
      'system',
      `修正前の自動チェック ${r.ok ? '成功' : '失敗'}: ${cmd}${r.summary ? `（${r.summary}）` : ''}`,
      r.output,
    );
  }

  /** 追加指示。動いていなければ会話IDで再開する（外部セッションはここで Tower が引き継ぐ） */
  send(id: string, text: string): void {
    const s = this.hub.get(id);
    if (!s) throw new Error('セッションが見つかりません');
    // エージェントに伝えるべき補足があれば指示の末尾に足す（画面からの直接編集、作業前から落ちていたテスト）
    let message = text;
    const patch: Partial<Session> = {};
    if (s.manualEdits?.length) {
      message += `\n\n（補足: 利用者が Tower の画面から次のファイルを直接編集しました。作業の前に内容を確認してください: ${s.manualEdits.join(', ')}）`;
      patch.manualEdits = [];
    }
    if (s.baseline && s.baseline.ok === false && !s.baselineNoted) {
      const names = s.baseline.failed?.length ? `（失敗していたテスト: ${s.baseline.failed.slice(0, 5).join('、')}）` : '';
      message += `\n\n（補足: このプロジェクトは作業前の時点で自動チェック「${s.baseline.command}」が失敗していました${names}。あなたの変更が原因でない失敗は、報告でそう書いてください。依頼の範囲外なら、直すかどうかを平易な言葉で一言だけ聞いてください）`;
      patch.baselineNoted = true;
    }
    if (Object.keys(patch).length) this.hub.update(id, patch);
    const running = this.runners.get(id);
    if (running) {
      running.send(message);
      return;
    }
    if (!s.agentSessionId) throw new Error('このセッションは再開できません（会話IDが記録される前に終わっています）');
    if (s.workspace && !fs.existsSync(s.workspace.path)) {
      throw new Error('分離した作業場所のフォルダが見つかりません（消された可能性があります）。新しいタスクとして起動してください');
    }
    this.hub.update(id, {
      status: 'starting',
      activity: s.origin === 'external' ? 'Tower が引き継いで再開しています…' : '続きから再開しています…',
      origin: 'tower',
      lastError: null,
      pending: null,
      pendingCount: 0,
    });
    const runner = this.makeRunner(s);
    this.runners.set(id, runner);
    runner.start(message, s.agentSessionId);
  }

  /** 画面から直接編集してよい状態なら、作業フォルダを返す */
  editableDir(id: string): string {
    const s = this.hub.get(id);
    if (!s) throw new Error('セッションが見つかりません');
    if (WORKING.includes(s.status)) {
      throw new Error('エージェントが作業中はファイルを編集できません。報告が来るか、停止してから編集してください');
    }
    if (s.workspace && !fs.existsSync(s.workspace.path)) throw new Error('分離した作業場所のフォルダが見つかりません');
    return workDir(s);
  }

  /** 直接編集の後始末: 年表に残し、次の指示でエージェントに伝えるために覚え、裏取りも走らせる */
  manualEdit(id: string, rel: string) {
    const s = this.hub.get(id);
    if (!s) return;
    const abs = path.resolve(workDir(s), rel);
    const already = s.changedFiles.some((f) => f === rel || path.resolve(workDir(s), f) === abs);
    this.hub.update(id, {
      manualEdits: [...new Set([...(s.manualEdits ?? []), rel])],
      changedFiles: already ? s.changedFiles : [...s.changedFiles, abs],
    });
    this.note(id, 'system', `画面から直接編集しました: ${rel}`, '次に指示を送る時、このファイルを手で直したことをエージェントに自動で伝えます');
    void this.verifyNow(id);
  }

  private verifying = new Set<string>();

  /** 裏取り（テスト実行）をエージェントの外から走らせる。直接編集の後などに使う */
  private async verifyNow(id: string) {
    const s = this.hub.get(id);
    if (!s) return;
    const dir = workDir(s);
    const cmd = detectVerifyCommand(dir);
    if (!cmd || this.verifying.has(id)) return;
    this.verifying.add(id);
    const at = Date.now();
    this.hub.update(id, { verification: { command: cmd, ok: null, output: '', at, durationMs: 0 } });
    try {
      const r = await runVerify(dir, cmd);
      this.hub.update(id, { verification: { command: cmd, ok: r.ok, output: r.output, summary: r.summary, failed: r.failed, at, durationMs: r.durationMs } });
      this.note(id, 'system', r.ok ? `自動チェック 成功: ${cmd}` : `自動チェック 失敗: ${cmd}`, r.output);
    } finally {
      this.verifying.delete(id);
    }
  }

  runner(id: string): AgentRunner | undefined {
    return this.runners.get(id);
  }

  async stop(id: string) {
    const r = this.runners.get(id);
    if (!r) return false;
    await r.stop();
    this.runners.delete(id);
    return true;
  }

  async remove(id: string) {
    await this.stop(id);
    const s = this.hub.get(id);
    // 一覧からは先に消す（後片付けはプロセス終了待ちで数秒かかることがある）
    this.hub.remove(id);
    if (s?.workspace) {
      const warn = await removeWorktree(s.project.path, s.workspace);
      if (warn) console.warn(`[worktree] ${id.slice(0, 8)} の後片付けで問題:`, warn);
    }
  }

  /** 分離した作業場所の変更を、元のプロジェクトに取り込む */
  merge(id: string): MergeResult {
    const s = this.hub.get(id);
    if (!s) throw new Error('セッションが見つかりません');
    if (!s.workspace) throw new Error('このセッションは別の作業場所を使っていません（プロジェクトのフォルダで直接作業しています）');
    if (WORKING.includes(s.status)) {
      throw new Error('作業中は取り込めません。報告が来るまで待つか、停止してから取り込んでください');
    }
    const r = mergeWorktree(s.project.path, s.workspace, s.title);
    this.hub.update(id, { workspace: { ...s.workspace, lastMerge: { at: Date.now(), ok: r.ok, message: r.message } } });
    this.note(id, r.ok ? 'system' : 'error', r.ok ? `取り込み: ${r.message}` : `取り込み失敗: ${r.message.split('\n')[0]}`, r.ok ? undefined : r.message);
    return r;
  }

  private note(sessionId: string, kind: TimelineKind, text: string, detail?: string) {
    this.hub.timeline({ id: randomUUID(), sessionId, ts: Date.now(), kind, text, detail });
  }

  async stopAll() {
    await Promise.all([...this.runners.keys()].map((id) => this.stop(id)));
  }
}
