// SessionManager: セッションの生成・再開・停止・削除と、動いている Runner（Claude / Codex）の管理。
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { AgentAvailability, AgentKind, CreateSessionBody, Session } from '@tower/shared';
import { ClaudeRunner } from './agents/claude.ts';
import { CodexRunner } from './agents/codex.ts';
import type { AgentRunner } from './agents/types.ts';
import type { Hub } from './hub.ts';

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

    const now = Date.now();
    const session: Session = {
      id: randomUUID(),
      agent,
      agentSessionId: null,
      project: { path: projectPath, name: path.basename(projectPath) },
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
    const runner = this.makeRunner(session);
    this.runners.set(session.id, runner);
    runner.start(prompt);
    return session;
  }

  /** 追加指示。動いていなければ会話IDで再開する（外部セッションはここで Tower が引き継ぐ） */
  send(id: string, text: string): void {
    const running = this.runners.get(id);
    if (running) {
      running.send(text);
      return;
    }
    const s = this.hub.get(id);
    if (!s) throw new Error('セッションが見つかりません');
    if (!s.agentSessionId) throw new Error('このセッションは再開できません（会話IDが記録される前に終わっています）');
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
    runner.start(text, s.agentSessionId);
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
    this.hub.remove(id);
  }

  async stopAll() {
    await Promise.all([...this.runners.keys()].map((id) => this.stop(id)));
  }
}
