// SessionManager: セッションの生成・再開・停止・削除と、動いている Runner（Claude / Codex）の管理。
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  type CompareBody,
  PERMISSION_CHOICES,
  type PermissionChoice,
  modelLabel,
  workDir,
  type AgentAvailability,
  type AgentKind,
  type AttachmentUpload,
  type CreateSessionBody,
  type MergeResult,
  type Session,
  type SessionStatus,
  type TimelineKind,
} from '@tower/shared';
import { ClaudeRunner } from './agents/claude.ts';
import { CodexRunner } from './agents/codex.ts';
import type { AgentRunner } from './agents/types.ts';
import { checkUploads, removeAttachments, saveAttachments } from './attachments.ts';
import type { Hub } from './hub.ts';
import { SHOTS_DIR, capture, detectPreview, laterPreviewLabel, targetLabel } from './preview.ts';
import { detectVerifyCommand, runVerify } from './verify.ts';
import { createWorktree, mergeWorktree, removeWorktree } from './worktree.ts';

/** 画像・ファイルだけ添えて文を書かずに送った時の指示 */
const DEFAULT_ATTACH_PROMPT = '添えた画像・ファイルを見てください';

/** エージェントが手を動かしている最中（取り込み・直接編集はこの間できない） */
const WORKING: SessionStatus[] = ['starting', 'running', 'waiting_permission', 'waiting_question'];

/** 再起動後の自動再開でエージェントに送る指示（利用者が書いたのではないと分かる書き出しにする） */
export const AUTO_RESUME_MESSAGE =
  '（Tower からの自動メッセージ）Tower が再起動したため、作業が途中で止まりました。止まったところから続けてください。直前に許可や質問を待っていたなら、もう一度聞いてください。作業がすでに終わっていれば、報告だけ書いてください。';

/** 自動再開の連続回数の上限。これ以上は利用者の指示を待つ（再起動ループの歯止め） */
const AUTO_RESUME_LIMIT = 1;

/** 件と件の間に空ける時間（同時に何本も起動しない） */
const AUTO_RESUME_GAP_MS = 1500;

/** 中断直前の状態を日本語で */
const STATUS_LABEL: Partial<Record<SessionStatus, string>> = {
  starting: '起動中',
  running: '作業中',
  waiting_permission: '許可待ち',
  waiting_question: '質問待ち',
};

/** 今回の起動で付いた「中断」の印か。古い印は対象にしない（設定を後から入れた時に何日も前のタスクが一斉に動き出さないように） */
function isFreshInterrupt(s: Session, since: number): boolean {
  return !!s.interrupted && s.interrupted.at >= since && !!s.agentSessionId && s.origin !== 'external';
}

/** 起動時に自動で再開する候補（since 以降に付いた印だけ）。新しい順 */
export function pickInterrupted(sessions: Session[], since: number): Session[] {
  return sessions
    .filter((s) => isFreshInterrupt(s, since) && (s.autoResumes ?? 0) < AUTO_RESUME_LIMIT)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

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
        : { available: false, reason: 'Codex にログインしていません。「Codexにログイン」ボタンから接続してください。設定画面からもログインできます。' };
  } catch (e) {
    value = { available: false, reason: `Codex が見つかりません: ${e instanceof Error ? e.message : String(e)}` };
  }
  codexCache = { at: Date.now(), value };
  return value;
}

export function agentAvailability(refresh = false): Record<AgentKind, AgentAvailability> {
  if (refresh) codexCache = null;
  return { claude: { available: true }, codex: codexAvailability() };
}

export class SessionManager {
  private runners = new Map<string, AgentRunner>();
  /** 直近に見た報告の時刻。新しい報告が来た時だけ「報告後の仕事」（見た目の撮影）を走らせる */
  private lastReportAt = new Map<string, number>();
  private capturing = new Set<string>();

  constructor(private hub: Hub) {
    for (const s of hub.sessions.values()) this.lastReportAt.set(s.id, s.report?.generatedAt ?? 0);
    // ランナーに手を入れずに「報告が来た」を拾う（外部セッションの報告にも効く）
    hub.subscribe((ev) => {
      if (ev.type !== 'session') return;
      const s = ev.session;
      // 会話が終わった（正常終了・エラー）ランナーは手放す。残すと次の指示が誰にも読まれない列に入ってしまう
      if ((s.status === 'done' || s.status === 'error') && this.runners.has(s.id)) this.runners.delete(s.id);
      const at = s.report?.generatedAt ?? 0;
      if (at && at !== (this.lastReportAt.get(s.id) ?? 0)) {
        this.lastReportAt.set(s.id, at);
        if (s.preview) void this.capturePreview(s.id, 'after');
      }
      this.maybeAutoMerge(s);
    });
  }

  private autoMerged = new Map<string, number>();

  /** 自動取り込み: 報告が「完了」で、裏取りが（あれば）通った時に一度だけ取り込む */
  private maybeAutoMerge(s: Session) {
    if (!s.workspace?.autoMerge || s.status !== 'idle' || s.report?.outcome !== 'done') return;
    const at = s.report.generatedAt;
    if (this.autoMerged.get(s.id) === at) return;
    if (s.changedFiles.length === 0) return; // 何も変えていないなら取り込むものが無い
    const needsVerify = detectVerifyCommand(workDir(s)) !== null;
    if (needsVerify) {
      // 裏取りは報告の後に走る。この報告に対する結果が出るまで待つ
      if (!s.verification || s.verification.at < at || s.verification.ok === null) return;
      if (!s.verification.ok) {
        this.autoMerged.set(s.id, at);
        this.note(s.id, 'system', '裏取りが通らなかったので、自動では取り込みませんでした。直してから「取り込む」を押してください');
        return;
      }
    }
    this.autoMerged.set(s.id, at);
    try {
      const r = this.merge(s.id, true);
      if (!r.ok) console.warn(`[automerge] ${s.id.slice(0, 8)}: ${r.message.split('\n')[0]}`);
    } catch (e) {
      console.warn(`[automerge] ${s.id.slice(0, 8)}:`, e instanceof Error ? e.message : e);
    }
  }

  private makeRunner(session: Session): AgentRunner {
    return session.agent === 'codex' ? new CodexRunner(session, this.hub) : new ClaudeRunner(session, this.hub);
  }

  create(body: CreateSessionBody): Session {
    if (body.permissionMode !== undefined && !PERMISSION_CHOICES.some((p) => p.value === body.permissionMode)) {
      throw new Error('許可方針が不正です');
    }
    const projectPath = path.resolve(body.projectPath);
    if (!fs.existsSync(projectPath) || !fs.statSync(projectPath).isDirectory()) {
      throw new Error(`プロジェクトフォルダが見つかりません: ${projectPath}`);
    }
    const uploads = checkUploads(body.attachments);
    // 画像だけ貼って送った時も動けるように、文が空なら添付を見るよう頼む
    const prompt = (typeof body.prompt === 'string' ? body.prompt : '').trim() || (uploads.length ? DEFAULT_ATTACH_PROMPT : '');
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
    const previewDir = isolated?.workspace.path ?? projectPath;
    const previewTarget = detectPreview(previewDir);
    // 今は撮れなくても（開発用のページで依存パッケージが未導入）、撮る予定にしておく。修正前は飛ばし、報告の時に撮る
    const previewLabel = previewTarget ? targetLabel(previewTarget) : laterPreviewLabel(previewDir);
    const session: Session = {
      id,
      agent,
      agentSessionId: null,
      project: { path: projectPath, name: path.basename(projectPath) },
      // 「比べる」の時は自動取り込みをしない（複数の案が勝手に取り込まれるとぶつかる）
      workspace: isolated ? { ...isolated.workspace, autoMerge: body.autoMerge === true && !body.compare } : null,
      compare: body.compare ?? null,
      preview: previewLabel ? { target: previewLabel, before: null, after: null, taking: false, error: null } : null,
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
      const auto = body.autoMerge ? '。報告が「完了」で裏取りが通れば自動で取り込みます' : '';
      this.note(
        id,
        'system',
        `別の作業場所を作りました（ブランチ ${isolated.workspace.branch}）${shared}${auto}`,
        `${isolated.workspace.path}\n元のプロジェクト: ${projectPath}`,
      );
    }
    // エージェントが手を付ける前の状態を測っておく（「修正前 → 修正後」の対比用）。起動は待たせない
    void this.runBaseline(session);
    if (previewTarget) void this.capturePreview(id, 'before');
    const runner = this.makeRunner(session);
    this.runners.set(session.id, runner);
    runner.start(prompt, undefined, saveAttachments(id, uploads));
    return session;
  }

  /** 同じ依頼を複数のモデルに投げて比べる。全部「別の作業場所」で動かし、気に入った案だけ取り込める */
  createCompare(body: CompareBody): Session[] {
    const models = [...new Set((body.models ?? []).map((m) => m || null))];
    if (models.length < 2) throw new Error('比べるには、違うモデルを 2 つ以上選んでください');
    const group = randomUUID();
    const made: Session[] = [];
    try {
      for (const model of models) {
        made.push(
          this.create({
            projectPath: body.projectPath,
            prompt: body.prompt,
            permissionMode: body.permissionMode,
            model,
            attachments: body.attachments,
            isolate: true,
            compare: { group, label: modelLabel(model) },
          }),
        );
      }
    } catch (e) {
      // 途中で失敗したら、作りかけの分は片付けてからエラーにする
      for (const s of made) void this.remove(s.id);
      throw e;
    }
    const labels = models.map(modelLabel).join(' / ');
    for (const s of made) {
      this.note(
        s.id,
        'system',
        `比較: 同じ依頼を ${models.length} つのモデルに投げています（${labels}）。それぞれ別の作業場所で作業するので、気に入った案だけ取り込めます`,
      );
    }
    return made;
  }

  /** 見た目の撮影（修正前 / 修正後）。失敗しても例外は出さず、preview.error に日本語で残す */
  private async capturePreview(id: string, which: 'before' | 'after') {
    const s = this.hub.get(id);
    if (!s?.preview || this.capturing.has(id)) return;
    const dir = workDir(s);
    const target = detectPreview(dir);
    if (!target) return;
    this.capturing.add(id);
    this.hub.update(id, { preview: { ...s.preview, taking: true } });
    try {
      const shots = await capture(id, dir, target, which);
      const cur = this.hub.get(id);
      if (!cur?.preview) return;
      this.hub.update(id, { preview: { ...cur.preview, [which]: shots, taking: false, error: null } });
      const kinds = shots.map((x) => (x.scheme === 'dark' ? 'ダーク' : 'ライト')).join(' / ');
      this.note(id, 'system', `${which === 'before' ? '修正前' : '修正後'}の見た目を撮りました（${kinds}）`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const cur = this.hub.get(id);
      if (cur?.preview) this.hub.update(id, { preview: { ...cur.preview, taking: false, error: msg } });
      this.note(id, 'error', `見た目の撮影に失敗: ${msg}`);
    } finally {
      this.capturing.delete(id);
    }
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

  /**
   * 起動時: 再起動で中断したタスクを 1 件ずつ続きから再開する（間隔 1.5 秒。同時に何本も起動しない）。
   * 1 件の失敗は年表に残して次へ進む。前回の自動再開のあとにまた落ちたものは、繰り返しを避けて利用者の指示を待つ
   */
  async resumeInterrupted(): Promise<void> {
    const all = this.hub.list();
    // 歯止めに掛かったもの: 自動では再開せず、理由を年表に残す（interrupted はそのまま）
    for (const s of all) {
      if (isFreshInterrupt(s, this.hub.bootAt) && (s.autoResumes ?? 0) >= AUTO_RESUME_LIMIT) {
        this.note(
          s.id,
          'system',
          '前回の自動再開のあとに、また再起動で中断しました。同じことの繰り返しを避けるため自動では再開しません。指示を送ると続きから再開します',
        );
      }
    }
    const targets = pickInterrupted(all, this.hub.bootAt);
    for (let i = 0; i < targets.length; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, AUTO_RESUME_GAP_MS));
      const s = this.hub.get(targets[i].id);
      if (!s?.interrupted) continue; // その間に消された / 利用者が先に指示を送った
      try {
        if (s.workspace && !fs.existsSync(s.workspace.path)) {
          this.note(s.id, 'error', '分離した作業場所のフォルダが見つからないので自動再開しません');
          this.hub.update(s.id, { interrupted: null });
          continue;
        }
        const before = s.interrupted.status;
        this.send(s.id, AUTO_RESUME_MESSAGE, undefined, { auto: true });
        this.hub.update(s.id, { autoResumes: (s.autoResumes ?? 0) + 1, interrupted: null });
        this.note(s.id, 'system', 'サーバー再起動で中断したため、自動で続きから再開しました', `中断直前の状態: ${STATUS_LABEL[before] ?? before}`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.note(s.id, 'error', `自動再開に失敗: ${msg}`);
        if (this.hub.get(s.id)) this.hub.update(s.id, { interrupted: null });
      }
    }
  }

  /** 追加指示。動いていなければ会話IDで再開する（外部セッションはここで Tower が引き継ぐ）。auto = 起動時の自動再開 */
  send(id: string, text: string, uploads?: AttachmentUpload[], opts?: { auto?: boolean }): void {
    const s = this.hub.get(id);
    if (!s) throw new Error('セッションが見つかりません');
    const checked = checkUploads(uploads);
    if (!text && !checked.length) throw new Error('指示が空です');
    if (!this.runners.has(id)) {
      // 再開できない時は、添付を保存する前に断る
      if (!s.agentSessionId) throw new Error('このセッションは再開できません（会話IDが記録される前に終わっています）');
      if (s.workspace && !fs.existsSync(s.workspace.path)) {
        throw new Error('分離した作業場所のフォルダが見つかりません（消された可能性があります）。新しいタスクとして起動してください');
      }
    }
    const attachments = saveAttachments(id, checked);
    // エージェントに伝えるべき補足があれば指示の末尾に足す（画面からの直接編集、作業前から落ちていたテスト）
    let message = text || DEFAULT_ATTACH_PROMPT;
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
    // 利用者の指示は「中断」の印を消し、自動再開の連続回数も 0 に戻す（自動再開の時は resumeInterrupted 側で消す）
    // 値が変わる時だけ載せる（変わらないのに hub.update すると保存と配信が余計に走り、再起動後の自動取り込みが二重に動く）
    if (!opts?.auto && ((s.autoResumes ?? 0) !== 0 || s.interrupted)) {
      patch.autoResumes = 0;
      patch.interrupted = null;
    }
    if (Object.keys(patch).length) this.hub.update(id, patch);
    const running = this.runners.get(id);
    if (running) {
      running.send(message, attachments);
      return;
    }
    this.hub.update(id, {
      status: 'starting',
      activity: opts?.auto
        ? 'サーバー再起動から自動で再開しています…'
        : s.origin === 'external'
          ? 'Tower が引き継いで再開しています…'
          : '続きから再開しています…',
      origin: 'tower',
      lastError: null,
      pending: null,
      pendingCount: 0,
    });
    const runner = this.makeRunner(s);
    this.runners.set(id, runner);
    runner.start(message, s.agentSessionId!, attachments);
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

  async setPermissionMode(id: string, mode: PermissionChoice): Promise<Session> {
    if (!PERMISSION_CHOICES.some((p) => p.value === mode)) throw new Error('許可方針が不正です');
    const session = this.hub.get(id);
    if (!session) throw new Error('セッションが見つかりません');
    if (session.agent !== 'claude' || session.origin === 'external') throw new Error('Towerで動かしているClaudeタスクで変更できます');
    const runner = this.runners.get(id);
    if (runner) {
      if (!runner.setPermissionMode) throw new Error('このタスクは許可方針の変更に対応していません');
      await runner.setPermissionMode(mode);
    } else {
      this.hub.update(id, { permissionMode: mode });
      this.note(id, 'system', `次回再開時の許可方針を ${mode} に変更しました`);
    }
    const current = this.hub.get(id);
    if (!current) throw new Error('セッションが削除されました');
    return current;
  }

  async stop(id: string) {
    const r = this.runners.get(id);
    if (!r) {
      // サーバー再起動後の「報告あり」は動いているプロセスが無いので、状態だけ止めた扱いにする
      const s = this.hub.get(id);
      if (s?.status !== 'idle' || s.origin === 'external') return false;
      this.hub.update(id, { status: 'stopped', activity: '停止しました', pending: null, pendingCount: 0 });
      return true;
    }
    await r.stop();
    this.runners.delete(id);
    return true;
  }

  async remove(id: string) {
    await this.stop(id);
    const s = this.hub.get(id);
    // 一覧からは先に消す（後片付けはプロセス終了待ちで数秒かかることがある）
    this.hub.remove(id);
    this.lastReportAt.delete(id);
    fs.rmSync(path.join(SHOTS_DIR, id), { recursive: true, force: true });
    removeAttachments(id);
    if (s?.workspace) {
      const warn = await removeWorktree(s.project.path, s.workspace);
      if (warn) console.warn(`[worktree] ${id.slice(0, 8)} の後片付けで問題:`, warn);
    }
  }

  /** 分離した作業場所の変更を、元のプロジェクトに取り込む。auto = Tower が自動で（裏取りが通った時） */
  merge(id: string, auto = false): MergeResult {
    const s = this.hub.get(id);
    if (!s) throw new Error('セッションが見つかりません');
    if (!s.workspace) throw new Error('このセッションは別の作業場所を使っていません（プロジェクトのフォルダで直接作業しています）');
    if (WORKING.includes(s.status)) {
      throw new Error('作業中は取り込めません。報告が来るまで待つか、停止してから取り込んでください');
    }
    const r = mergeWorktree(s.project.path, s.workspace, s.title);
    this.hub.update(id, { workspace: { ...s.workspace, lastMerge: { at: Date.now(), ok: r.ok, message: r.message } } });
    const head = auto ? (r.ok ? '裏取りが通ったので自動で取り込みました' : '自動取り込みに失敗') : r.ok ? '取り込み' : '取り込み失敗';
    this.note(id, r.ok ? 'system' : 'error', `${head}: ${r.message.split('\n')[0]}`, r.ok ? undefined : r.message);
    return r;
  }

  private note(sessionId: string, kind: TimelineKind, text: string, detail?: string) {
    this.hub.timeline({ id: randomUUID(), sessionId, ts: Date.now(), kind, text, detail });
  }

  async stopAll() {
    await Promise.all([...this.runners.keys()].map((id) => this.stop(id)));
  }
}
