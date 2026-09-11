// VS Code 拡張やターミナルで動いている Claude Code セッションを、hooks 経由で Tower に取り込む。
// - 観測: SessionStart / UserPromptSubmit / PreToolUse / Notification / Stop / SessionEnd → カードとして表示
// - 許可: PermissionRequest hook を待たせて Tower で答える（時間切れなら元の画面に任せる）
// - 取り込み: 外部セッションに Tower から指示を送ると resume で Tower が引き継ぐ（manager.send）
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BridgeStatus, PendingPermission, PermissionChoice, Session, TimelineKind } from '@tower/shared';
import type { Hub } from './hub.ts';
import { assessRisk, describeActivity, describePermission, firstLine, toolDetail, touchedFile } from './humanize.ts';
import { detectPreview, targetLabel } from './preview.ts';
import { scheduleReformat } from './reformat.ts';
import { fallbackReport, parseReport } from './report.ts';

export interface HookInput {
  session_id: string;
  hook_event_name: string;
  transcript_path?: string;
  cwd?: string;
  permission_mode?: string;
  agent_id?: string;
  source?: string;
  prompt?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_use_id?: string;
  message?: string;
  notification_type?: string;
  last_assistant_message?: string;
  reason?: string;
}

type Decision = { behavior: 'allow' } | { behavior: 'deny'; message: string };

const HOOK_SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../hooks/tower-hook.mjs');
const SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');
const MARK = 'tower-hook.mjs';
const OBSERVE_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Stop', 'SessionEnd'];

/** transcript の先頭から entrypoint（cli / vscode / ...）を読んで表示名にする */
function detectEntrypoint(transcriptPath: string | undefined): string | undefined {
  if (!transcriptPath) return undefined;
  try {
    const fd = fs.openSync(transcriptPath, 'r');
    const buf = Buffer.alloc(8192);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const m = buf.toString('utf8', 0, n).match(/"entrypoint":"([^"]+)"/);
    if (!m) return undefined;
    const v = m[1].toLowerCase();
    if (v.includes('vscode') || v.includes('ide') || v.includes('jetbrains')) return 'VS Code';
    if (v.includes('cli')) return 'ターミナル';
    if (v.includes('sdk')) return 'SDK';
    return m[1];
  } catch {
    return undefined;
  }
}

/** transcript の先頭 / 末尾を指定バイト数だけ読む */
function readChunk(file: string, bytes: number, fromEnd: boolean): string {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(bytes, size);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, fromEnd ? size - len : 0);
    return buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * 途中から観測し始めたセッション用の題名。
 * Claude Code が付けた題名（ai-title）→ 直近の指示（last-prompt）→ 最初の利用者メッセージ の順で探す。
 */
function detectFirstPrompt(transcriptPath: string | undefined): string | undefined {
  if (!transcriptPath) return undefined;
  try {
    // 題名や直近の指示は末尾に記録される
    const tail = readChunk(transcriptPath, 64 * 1024, true).split(/\r?\n/).reverse();
    let lastPrompt: string | undefined;
    for (const line of tail) {
      if (!line.startsWith('{')) continue;
      try {
        const j = JSON.parse(line) as { type?: string; aiTitle?: string; lastPrompt?: string };
        if (j.type === 'ai-title' && j.aiTitle?.trim()) return j.aiTitle.trim();
        if (j.type === 'last-prompt' && j.lastPrompt?.trim() && !lastPrompt) lastPrompt = j.lastPrompt.trim();
      } catch {
        /* 途中で切れた行 */
      }
    }
    if (lastPrompt && !lastPrompt.startsWith('<')) return lastPrompt;

    for (const line of readChunk(transcriptPath, 64 * 1024, false).split(/\r?\n/)) {
      if (!line.startsWith('{')) continue;
      let j: { type?: string; isSidechain?: boolean; message?: { role?: string; content?: unknown } };
      try {
        j = JSON.parse(line);
      } catch {
        continue;
      }
      if (j.type !== 'user' || j.isSidechain || j.message?.role !== 'user') continue;
      const c = j.message.content;
      const text =
        typeof c === 'string'
          ? c
          : Array.isArray(c)
            ? (c.find((b) => b && typeof b === 'object' && (b as { type?: string }).type === 'text') as { text?: string } | undefined)?.text ?? ''
            : '';
      const t = text.trim();
      if (t && !t.startsWith('<')) return t; // <system-reminder> 等のメタは飛ばす
    }
  } catch {
    /* 読めない */
  }
  return undefined;
}

const PLACEHOLDER_TITLE = '（外部で起動したセッション）';

const toChoice = (mode: string | undefined): PermissionChoice =>
  mode === 'acceptEdits' || mode === 'auto' ? mode : 'default';

interface SettingsJson {
  hooks?: Record<string, { matcher?: string; hooks?: { type?: string; command?: string; timeout?: number }[] }[]>;
  [k: string]: unknown;
}

function readSettings(): SettingsJson {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')) as SettingsJson;
  } catch {
    return {};
  }
}

const isOurs = (g: { hooks?: { command?: string }[] }) => (g.hooks ?? []).some((h) => String(h.command ?? '').includes(MARK));

export class Bridge {
  private resolvers = new Map<string, (d: Decision | null) => void>();

  constructor(
    private hub: Hub,
    private opts: { port: number; waitSeconds: number },
  ) {}

  // ---- 観測 ----

  private isOwn(claudeSessionId: string): boolean {
    for (const s of this.hub.sessions.values()) {
      if (s.origin !== 'external' && s.agentSessionId === claudeSessionId) return true;
    }
    return false;
  }

  private ensure(input: HookInput): Session | null {
    if (this.isOwn(input.session_id)) return null;
    const id = `ext-${input.session_id}`;
    const cur = this.hub.get(id);
    if (cur) return cur;
    const cwd = input.cwd || process.cwd();
    const now = Date.now();
    const previewTarget = detectPreview(cwd);
    const s: Session = {
      id,
      agent: 'claude',
      origin: 'external',
      externalHint: detectEntrypoint(input.transcript_path),
      agentSessionId: input.session_id,
      project: { path: cwd, name: path.basename(cwd) },
      preview: previewTarget ? { target: targetLabel(previewTarget), before: null, after: null, taking: false, error: null } : null,
      title: PLACEHOLDER_TITLE,
      prompt: '',
      model: null,
      permissionMode: toChoice(input.permission_mode),
      status: 'idle',
      activity: '外部で起動しました',
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
    this.hub.add(s);
    return s;
  }

  private timeline(sessionId: string, kind: TimelineKind, text: string, detail?: string, toolName?: string) {
    this.hub.timeline({ id: randomUUID(), sessionId, ts: Date.now(), kind, text, detail, toolName });
  }

  handleEvent(input: HookInput) {
    if (!input.session_id || !input.hook_event_name) return;
    if (input.agent_id) return; // サブエージェントの中は年表に出さない
    const s = this.ensure(input);
    if (!s) return;
    const id = s.id;
    const hint = s.externalHint ?? detectEntrypoint(input.transcript_path);
    // transcript は起動直後には無いことがあるので、分かった時点で表示名・題名を埋める
    if (hint && !s.externalHint) this.hub.update(id, { externalHint: hint });
    if (s.title === PLACEHOLDER_TITLE && input.hook_event_name !== 'UserPromptSubmit') {
      const first = detectFirstPrompt(input.transcript_path);
      if (first) this.hub.update(id, { title: firstLine(first).slice(0, 60), prompt: s.prompt || first });
    }

    switch (input.hook_event_name) {
      case 'SessionStart':
        this.hub.update(id, {
          status: 'idle',
          activity: input.source === 'resume' ? '再開されました' : '起動しました',
          externalHint: hint,
        });
        break;

      case 'UserPromptSubmit': {
        const p = (input.prompt ?? '').trim();
        if (!p) break;
        this.timeline(id, 'user', p);
        const patch: Partial<Session> = {
          status: 'running',
          activity: '指示を受け取りました',
          pending: null,
          pendingCount: 0,
          externalHint: hint,
        };
        if (!s.prompt) {
          patch.prompt = p;
          patch.title = firstLine(p).slice(0, 60);
        }
        this.hub.update(id, patch);
        break;
      }

      case 'PreToolUse': {
        const tool = input.tool_name ?? '?';
        const inp = input.tool_input ?? {};
        const activity = describeActivity(tool, inp);
        const f = touchedFile(tool, inp);
        this.timeline(id, 'tool_use', activity, toolDetail(tool, inp), tool);
        this.hub.update(id, {
          status: s.pending ? s.status : 'running',
          activity: s.pending ? s.activity : activity,
          toolCalls: s.toolCalls + 1,
          changedFiles: f && !s.changedFiles.includes(f) ? [...s.changedFiles, f] : s.changedFiles,
        });
        break;
      }

      case 'Notification': {
        if (input.notification_type === 'permission_prompt') {
          if (s.pending) break; // PermissionRequest 経由で既に出ている
          const pending: PendingPermission = {
            id: randomUUID(),
            kind: 'permission',
            toolName: '',
            input: {},
            headline: input.message?.trim() || '許可を求めています',
            detail: '',
            risk: 'mid',
            canAlwaysAllow: false,
            alwaysRules: [],
            answerable: false,
            createdAt: Date.now(),
          };
          this.timeline(id, 'permission', `許可待ち（${hint ?? '外部'}側）: ${pending.headline}`);
          this.hub.update(id, {
            status: 'waiting_permission',
            activity: `許可待ち（${hint ?? '外部'}の画面で答えてください）`,
            pending,
            pendingCount: 1,
          });
        } else if (input.notification_type === 'idle_prompt') {
          this.hub.update(id, { status: 'idle', activity: '指示待ち', pending: null, pendingCount: 0 });
        }
        break;
      }

      case 'Stop': {
        const text = (input.last_assistant_message ?? '').trim();
        const request = s.prompt || s.title;
        const report = parseReport(text, request) ?? fallbackReport(text || '(出力なし)', request, false);
        if (text) this.timeline(id, 'assistant_text', firstLine(text).slice(0, 140), text);
        this.hub.update(id, {
          status: 'idle',
          activity: report.needsDecision ? `判断待ち: ${firstLine(report.needsDecision).slice(0, 60)}` : '指示待ち',
          report,
          turns: s.turns + 1,
          pending: null,
          pendingCount: 0,
        });
        // 外のセッションは報告のルールを知らないので、ほぼ毎回ここで整形する
        scheduleReformat(this.hub, id, report);
        break;
      }

      case 'SessionEnd':
        this.hub.update(id, { status: 'done', activity: '終了しました', pending: null, pendingCount: 0 });
        break;

      default:
        break;
    }
  }

  // ---- 許可の橋渡し ----

  /** PermissionRequest hook。Tower で答えるか、時間切れなら {} を返して元の画面に任せる */
  async handlePermission(input: HookInput): Promise<Record<string, unknown>> {
    const s = this.ensure(input);
    if (!s) return {};
    const tool = input.tool_name ?? '?';
    const inp = input.tool_input ?? {};
    const { headline, detail } = describePermission(tool, inp);
    const reqId = randomUUID();
    const pending: PendingPermission = {
      id: reqId,
      kind: 'permission',
      toolName: tool,
      input: inp,
      headline,
      detail,
      risk: assessRisk(tool, inp),
      canAlwaysAllow: false,
      alwaysRules: [],
      answerable: true,
      createdAt: Date.now(),
    };
    this.timeline(s.id, 'permission', `許可待ち: ${headline}`, detail, tool);
    this.hub.update(s.id, { status: 'waiting_permission', activity: `許可待ち: ${headline}`, pending, pendingCount: 1 });

    const decision = await new Promise<Decision | null>((resolve) => {
      this.resolvers.set(reqId, resolve);
      setTimeout(() => {
        if (this.resolvers.delete(reqId)) resolve(null);
      }, this.opts.waitSeconds * 1000);
    });

    const hint = s.externalHint ?? '外部';
    const cur = this.hub.get(s.id);
    if (cur?.pending?.id === reqId) {
      if (decision) {
        this.hub.update(s.id, {
          status: 'running',
          activity: decision.behavior === 'allow' ? describeActivity(tool, inp) : '拒否を受けて考え直しています',
          pending: null,
          pendingCount: 0,
        });
      } else {
        this.hub.update(s.id, {
          activity: `許可待ち（${hint}の画面で答えてください）`,
          pending: { ...pending, answerable: false, headline: `（Tower では時間切れ）${headline}` },
        });
      }
    }
    if (!decision) {
      this.timeline(s.id, 'permission', `Tower で答えなかったので ${hint} の画面に任せました`);
      return {};
    }
    this.timeline(
      s.id,
      'permission',
      decision.behavior === 'allow' ? '許可しました（Tower から）' : `拒否: ${decision.message}`,
    );
    return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } };
  }

  /** Tower の画面からの回答。defer = 元の画面に任せる */
  resolvePermission(requestId: string, decision: 'allow' | 'allow_always' | 'deny' | 'defer', message?: string): boolean {
    const r = this.resolvers.get(requestId);
    if (!r) return false;
    this.resolvers.delete(requestId);
    if (decision === 'defer') r(null);
    else if (decision === 'deny') r({ behavior: 'deny', message: message?.trim() || '利用者がこの操作を拒否しました。別の方法を検討してください。' });
    else r({ behavior: 'allow' });
    return true;
  }

  // ---- hooks の導入 ----

  status(): BridgeStatus {
    const hooks = readSettings().hooks ?? {};
    const installed = Object.values(hooks).some((groups) => groups.some(isOurs));
    const permissions = (hooks.PermissionRequest ?? []).some(isOurs);
    return { installed, permissions, waitSeconds: this.opts.waitSeconds, settingsPath: SETTINGS_PATH, hookScript: HOOK_SCRIPT };
  }

  /** ~/.claude/settings.json の hooks に Tower の分を書き込む（他の hooks はそのまま） */
  install(enabled: boolean, permissions: boolean): BridgeStatus {
    const settings = readSettings();
    const hooks = settings.hooks ?? {};
    for (const ev of Object.keys(hooks)) {
      hooks[ev] = hooks[ev].filter((g) => !isOurs(g));
      if (hooks[ev].length === 0) delete hooks[ev];
    }
    if (enabled) {
      const cmd = `node "${HOOK_SCRIPT}" --port ${this.opts.port}`;
      const entry = (matcher: string | undefined, command: string, timeout: number) => ({
        ...(matcher ? { matcher } : {}),
        hooks: [{ type: 'command', command, timeout }],
      });
      for (const ev of OBSERVE_EVENTS) (hooks[ev] ??= []).push(entry(undefined, cmd, 10));
      (hooks.Notification ??= []).push(entry('permission_prompt|idle_prompt', cmd, 10));
      if (permissions) {
        (hooks.PermissionRequest ??= []).push(
          entry(undefined, `${cmd} --wait ${this.opts.waitSeconds}`, this.opts.waitSeconds + 15),
        );
      }
    }
    if (Object.keys(hooks).length) settings.hooks = hooks;
    else delete settings.hooks;

    fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
    if (fs.existsSync(SETTINGS_PATH)) fs.copyFileSync(SETTINGS_PATH, `${SETTINGS_PATH}.tower-backup`);
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n');
    return this.status();
  }
}
