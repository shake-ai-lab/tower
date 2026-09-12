// Tower を「コードを読まない利用者」として使い込み、使い勝手の問題を洗い出す自動ドッグフーディング。
//
//   npm run dogfood                 全シナリオ
//   npm run dogfood -- --only todo-fix,site-dark
//   npm run dogfood -- --model sonnet
//   npm run dogfood -- --real       本物のプロジェクトの写しで（real-scenarios.ts。TOWER_API で本番と別の Tower を指す）
//
// 結果は docs/dogfood/<runId>.md に書く。作業フォルダは ~/.tower/dogfood/<runId>/。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChangesResponse, MergeResult, PendingPermission, PendingQuestion, Report, Session, TimelineItem } from '@tower/shared';
import { llmJson, type LlmImage } from './llm.ts';
import { SCENARIOS, type Scenario } from './scenarios.ts';
import { REAL_SCENARIOS } from './real-scenarios.ts';

const API = process.env.TOWER_API ?? 'http://127.0.0.1:4800/api';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const args = process.argv.slice(2);
const arg = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const only = arg('--only')?.split(',').filter(Boolean);
const modelOverride = arg('--model');
const TIMEOUT_MS = Number(arg('--timeout') ?? 8 * 60 * 1000);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const api = async <T>(p: string, init?: RequestInit): Promise<T> => {
  const res = await fetch(API + p, { headers: { 'content-type': 'application/json' }, ...init });
  const data = await res.json();
  if (!res.ok) throw new Error(`${p}: ${(data as { error?: string }).error ?? res.status}`);
  return data as T;
};
const now = () => Date.now();
const fmt = (ms: number) => `${(ms / 1000).toFixed(0)}秒`;

interface Track {
  sc: Scenario;
  dir: string;
  sessionId: string;
  startedAt: number;
  finishedAt: number | null;
  finishReason: string;
  activities: { t: number; text: string; status: string }[];
  permissions: { t: number; p: PendingPermission; decision: string; reason?: string; waitedMs: number }[];
  questions: { t: number; q: PendingQuestion; answers: Record<string, string> }[];
  reports: { t: number; r: Report }[];
  followUpIndex: number;
  handled: Set<string>;
  allowedCount: Record<string, number>;
  denyOnceUsed: boolean;
  verify?: { ok: boolean; output: string };
  /** isolate シナリオの「取り込む」結果 */
  merge?: MergeResult;
  judge?: Judge;
  /** 採点前に取った差分（画面の「差分を見る」相当）。採点役が成果物の中身を見られるように */
  changes?: string;
  timeline: TimelineItem[];
  session?: Session;
}

interface Judge {
  reportClarity: number;
  goalAchieved: 'yes' | 'partial' | 'no' | 'unknown';
  reportIssues: string[];
  activityIssues: string[];
  permissionIssues: string[];
  appSuggestions: string[];
  verdict: string;
}

const JUDGE_SCHEMA = {
  type: 'object',
  properties: {
    reportClarity: { type: 'integer', minimum: 1, maximum: 5 },
    goalAchieved: { type: 'string', enum: ['yes', 'partial', 'no', 'unknown'] },
    reportIssues: { type: 'array', items: { type: 'string' } },
    activityIssues: { type: 'array', items: { type: 'string' } },
    permissionIssues: { type: 'array', items: { type: 'string' } },
    appSuggestions: { type: 'array', items: { type: 'string' } },
    verdict: { type: 'string' },
  },
  required: ['reportClarity', 'goalAchieved', 'reportIssues', 'activityIssues', 'permissionIssues', 'appSuggestions', 'verdict'],
  additionalProperties: false,
};

const USER_PERSONA =
  'あなたはプログラミングをしない利用者です。AIエージェントに開発を任せる管制塔アプリ「Tower」を使っていて、画面に出る日本語だけを頼りに判断します。専門用語が出てくると困ります。';

// ---- 利用者役の判断 ----

function decidePermission(tr: Track, p: PendingPermission): { decision: 'allow' | 'allow_always' | 'deny'; reason?: string } {
  const sc = tr.sc;
  if (sc.denyOnce && !tr.denyOnceUsed && (sc.denyOnce.match.test(p.detail) || sc.denyOnce.match.test(p.headline))) {
    tr.denyOnceUsed = true;
    return { decision: 'deny', reason: sc.denyOnce.reason };
  }
  const always = sc.denyAlways?.find((d) => (!d.tools || d.tools.includes(p.toolName)) && (d.match.test(p.detail) || d.match.test(p.headline)));
  if (always) return { decision: 'deny', reason: always.reason };
  if (p.risk === 'high') return { decision: 'deny', reason: '危なそうな操作なので止めます。もっと安全な方法でお願いします' };
  const n = (tr.allowedCount[p.toolName] = (tr.allowedCount[p.toolName] ?? 0) + 1);
  // 同じ種類の許可が3回目なら「以後も許可」を試す（UI上の導線の検証）
  if (n >= 3 && p.canAlwaysAllow) return { decision: 'allow_always' };
  return { decision: 'allow' };
}

async function answerQuestion(tr: Track, q: PendingQuestion): Promise<Record<string, string>> {
  const schema = {
    type: 'object',
    properties: {
      answers: {
        type: 'array',
        items: {
          type: 'object',
          properties: { question: { type: 'string' }, choice: { type: 'string' } },
          required: ['question', 'choice'],
          additionalProperties: false,
        },
      },
    },
    required: ['answers'],
    additionalProperties: false,
  };
  const prompt = [
    `あなたの依頼: ${tr.sc.prompt}`,
    tr.sc.preference ? `あなたの好み: ${tr.sc.preference}` : '',
    '',
    'エージェントから次の質問が来ました。各質問について、選択肢の label をそのまま choice に入れて答えてください。',
    JSON.stringify(q.questions, null, 1),
  ].join('\n');
  try {
    const r = await llmJson<{ answers: { question: string; choice: string }[] }>(USER_PERSONA, prompt, schema);
    const out: Record<string, string> = {};
    for (const qq of q.questions) {
      const hit = r.answers.find((a) => a.question === qq.question)?.choice;
      out[qq.question] = hit && qq.options.some((o) => o.label === hit) ? hit : qq.options[0].label;
    }
    return out;
  } catch (e) {
    console.warn(`  [${tr.sc.key}] 質問回答のLLM失敗、先頭の選択肢を選ぶ:`, (e as Error).message);
    return Object.fromEntries(q.questions.map((qq) => [qq.question, qq.options[0].label]));
  }
}

// ---- 進行 ----

async function step(tr: Track, s: Session) {
  tr.session = s;
  const last = tr.activities.at(-1);
  if (!last || last.text !== s.activity || last.status !== s.status) tr.activities.push({ t: now(), text: s.activity, status: s.status });

  if (s.pending && !tr.handled.has(s.pending.id)) {
    tr.handled.add(s.pending.id);
    const waited = now() - s.pending.createdAt;
    await sleep(800 + Math.random() * 1200); // 人が読む時間
    if (s.pending.kind === 'permission') {
      const d = decidePermission(tr, s.pending);
      tr.permissions.push({ t: now(), p: s.pending, decision: d.decision, reason: d.reason, waitedMs: waited });
      console.log(`  [${tr.sc.key}] 許可要求「${s.pending.headline}」(${s.pending.risk}) → ${d.decision}${d.reason ? ` (${d.reason})` : ''}`);
      await api(`/sessions/${tr.sessionId}/permission`, {
        method: 'POST',
        body: JSON.stringify({ requestId: s.pending.id, decision: d.decision, message: d.reason }),
      }).catch((e) => console.warn('  permission post failed:', e.message));
    } else {
      const answers = await answerQuestion(tr, s.pending);
      tr.questions.push({ t: now(), q: s.pending, answers });
      console.log(`  [${tr.sc.key}] 質問 → ${JSON.stringify(answers)}`);
      await api(`/sessions/${tr.sessionId}/answer`, {
        method: 'POST',
        body: JSON.stringify({ requestId: s.pending.id, answers }),
      }).catch((e) => console.warn('  answer post failed:', e.message));
    }
    return;
  }

  if (s.status === 'idle' && s.report && !tr.reports.some((r) => r.r.generatedAt === s.report!.generatedAt)) {
    tr.reports.push({ t: now(), r: s.report });
    console.log(`  [${tr.sc.key}] 報告: ${s.report.outcome} / ${s.report.summary[0] ?? '(要約なし)'}`);
    const next = tr.sc.followUps?.[tr.followUpIndex];
    if (next) {
      tr.followUpIndex++;
      await sleep(1000);
      console.log(`  [${tr.sc.key}] 追加指示: ${next}`);
      // 1 本の失敗で走行全体を落とさない（他のシナリオは続ける）
      try {
        await api(`/sessions/${tr.sessionId}/message`, { method: 'POST', body: JSON.stringify({ text: next }) });
      } catch (e) {
        console.warn(`  [${tr.sc.key}] 追加指示を送れませんでした:`, e instanceof Error ? e.message : e);
        tr.finishedAt = now();
        tr.finishReason = 'message_failed';
      }
      return;
    }
    tr.finishedAt = now();
    tr.finishReason = 'report';
    return;
  }

  if (['error', 'done', 'stopped'].includes(s.status)) {
    tr.finishedAt = now();
    tr.finishReason = s.status;
  }
}

function runVerify(tr: Track) {
  if (!tr.sc.verify) return;
  const r = spawnSync(tr.sc.verify, { cwd: tr.dir, shell: true, encoding: 'utf8', timeout: 60000 });
  tr.verify = { ok: r.status === 0, output: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().slice(-1500) };
}

async function judge(tr: Track): Promise<Judge> {
  const s = tr.session!;
  // Tower が撮ったスクリーンショットを採点役にも見せる（修正前ライト 1 枚 + 修正後 全部、最大 3 枚）
  const shots = [...(s.preview?.before ?? []).filter((x) => x.scheme === 'light').slice(0, 1), ...(s.preview?.after ?? [])].slice(0, 3);
  const images: LlmImage[] = [];
  for (const sh of shots) {
    try {
      const r = await fetch(API.replace(/\/api$/, '') + sh.url);
      if (r.ok) images.push({ data: Buffer.from(await r.arrayBuffer()).toString('base64'), mediaType: 'image/png' });
    } catch {
      /* 画像が取れなくても採点はする */
    }
  }
  const shotLabel = (x: { label: string; scheme: string }) => `${x.label === 'before' ? '修正前' : '修正後'}/${x.scheme === 'dark' ? 'ダーク' : 'ライト'}`;
  const prompt = [
    `## あなたの依頼\n${tr.sc.prompt}`,
    `## 成功の条件（アプリには見えていない、あなたの頭の中）\n${tr.sc.goal}`,
    `## 画面の「今やってること」の推移\n${tr.activities.map((a) => `- [${a.status}] ${a.text}`).join('\n')}`,
    `## 許可を求められた内容（見出し / 詳細 / 危険度 / あなたの判断）\n${tr.permissions.map((p) => `- ${p.p.headline} / ${p.p.detail.slice(0, 200)} / ${p.p.risk} / ${p.decision}`).join('\n') || '(なし)'}`,
    `## 質問された内容\n${tr.questions.map((q) => JSON.stringify(q.q.questions.map((x) => x.question))).join('\n') || '(なし)'}`,
    `## 報告カード（アプリが整形したもの）\n${tr.reports.map((r) => JSON.stringify({ ...r.r, raw: undefined }, null, 1)).join('\n') || '(報告なし)'}`,
    `## 報告の原文\n${tr.reports.map((r) => r.r.raw).join('\n---\n') || '(なし)'}`,
    tr.merge
      ? `## 別の作業場所からの取り込み（あなたが報告後に「元のプロジェクトに取り込む」ボタンを押した結果。エージェントはこの操作を知らない）: ${tr.merge.ok ? '成功' : '失敗'}\n${tr.merge.message}`
      : '',
    tr.verify
      ? `## 機械的な検証（${tr.sc.verify}${tr.merge ? '、取り込み後に元のプロジェクトで実行' : ''}）: ${tr.verify.ok ? '成功' : '失敗'}\n${tr.verify.output.slice(0, 600)}`
      : '',
    s.verification
      ? `## アプリが画面に出した自動チェック（${s.verification.command}）: ${s.verification.ok === null ? '実行中' : s.verification.ok ? '裏取りOK' : '裏取りNG'}${s.verification.summary ? `（${s.verification.summary}）` : ''}` +
        (s.baseline
          ? `\n修正前（エージェントが手を付ける前にアプリが実行）: ${s.baseline.ok ? '成功' : '失敗'}${s.baseline.summary ? `（${s.baseline.summary}）` : ''}${s.baseline.failed?.length ? ` 失敗していたテスト: ${s.baseline.failed.join('、')}` : ''} → 修正後: ${s.verification.ok ? '成功' : '失敗'}${s.verification.summary ? `（${s.verification.summary}）` : ''}${s.verification.failed?.length ? ` 失敗したテスト: ${s.verification.failed.join('、')}` : ''}` +
            (s.baseline.ok === false && s.verification.ok === false && (s.verification.failed ?? []).every((n) => (s.baseline!.failed ?? []).includes(n))
              ? '\n（画面の表示: 修正前からの失敗が残っています。新しく壊れたものは無し）'
              : '')
          : '')
      : '## アプリの自動チェック: 表示なし',
    tr.changes
      ? `## 変更の中身（画面の「差分を見る」。長いものは先頭だけ）\n${tr.changes}`
      : '',
    s.preview
      ? `## 見た目のスクリーンショット（Tower が ${s.preview.target} を自動で撮って画面に表示）: 修正前 ${s.preview.before?.length ?? 0} 枚、修正後 ${s.preview.after?.length ?? 0} 枚` +
        (images.length ? `。添付画像の順: ${shots.map(shotLabel).join('、')}` : '') +
        (s.preview.error ? `。撮影エラー: ${s.preview.error}` : '')
      : '',
    `## 終了理由: ${tr.finishReason}、所要 ${fmt((tr.finishedAt ?? now()) - tr.startedAt)}、状態 ${s.status}`,
    '',
    '上の画面表示だけを見て、利用者として評価してください（スクリーンショットが添付されていれば、それも画面で見えているものとして扱い、見た目の確認ができたかを判断に含める）。',
    '- reportClarity: 報告を読んで「何が起きて、次に何をすべきか」が分かるか（1=全く分からない〜5=完璧）',
    '- goalAchieved: 成功の条件を満たせたか',
    '- reportIssues / activityIssues / permissionIssues: 分かりにくかった点、足りない情報（具体的に。無ければ空配列）',
    '- appSuggestions: アプリ側（Tower）で直せる改善案。エージェントの性能の話ではなく、表示や導線の話',
    '- verdict: 一言の総評',
  ].join('\n\n');
  return llmJson<Judge>(USER_PERSONA, prompt, JUDGE_SCHEMA, 'haiku', images);
}

// ---- レポート ----

function writeReport(runId: string, tracks: Track[]) {
  const lines: string[] = [];
  lines.push(`# ドッグフーディング ${runId}`, '');
  lines.push(`モデル: ${modelOverride ?? 'haiku'} / シナリオ ${tracks.length} 本を並列実行`, '');
  lines.push('| シナリオ | 終了 | 所要 | 許可(許/拒) | 質問 | 報告 | 裏取り表示 | 検証 | 分かりやすさ | 達成 |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|');
  for (const t of tracks) {
    const allow = t.permissions.filter((p) => p.decision !== 'deny').length;
    const deny = t.permissions.length - allow;
    lines.push(
      `| ${t.sc.key} | ${t.finishReason} | ${fmt((t.finishedAt ?? now()) - t.startedAt)} | ${allow}/${deny} | ${t.questions.length} | ${t.reports.map((r) => r.r.outcome).join(',') || '-'} | ${t.session?.baseline ? `${t.session.baseline.ok ? '✔' : '✖'}→` : ''}${t.session?.verification ? (t.session.verification.ok === null ? '⏳' : t.session.verification.ok ? '✔' : '✖') : '-'} | ${t.verify ? (t.verify.ok ? '✅' : '❌') : '-'} | ${t.judge?.reportClarity ?? '-'} | ${t.judge?.goalAchieved ?? '-'} |`,
    );
  }
  lines.push('', '## アプリへの改善提案（利用者役AIの意見・重複あり）', '');
  for (const t of tracks) for (const s of t.judge?.appSuggestions ?? []) lines.push(`- (${t.sc.key}) ${s}`);

  for (const t of tracks) {
    lines.push('', `## ${t.sc.key}`, '', `依頼: ${t.sc.prompt}`, '', `総評: ${t.judge?.verdict ?? '-'}`, '');
    lines.push('### 今やってること の推移');
    for (const a of t.activities) lines.push(`- [${a.status}] ${a.text}`);
    lines.push('', '### 許可要求');
    for (const p of t.permissions) lines.push(`- ${p.p.risk} | ${p.p.headline} | \`${p.p.detail.slice(0, 120).replace(/\n/g, ' ')}\` → ${p.decision}${p.reason ? ` (${p.reason})` : ''}（待ち ${fmt(p.waitedMs)}）`);
    if (t.questions.length) {
      lines.push('', '### 質問');
      for (const q of t.questions) lines.push(`- ${q.q.questions.map((x) => x.question).join(' / ')} → ${JSON.stringify(q.answers)}`);
    }
    lines.push('', '### 報告カード');
    for (const r of t.reports) {
      lines.push(`- 結果: ${r.r.outcome} / 依頼: ${r.r.request}`);
      for (const s of r.r.summary) lines.push(`  - ${s}`);
      if (r.r.changedFiles.length) lines.push(`  - 変更: ${r.r.changedFiles.join(', ')}`);
      if (r.r.needsDecision) lines.push(`  - 判断が必要: ${r.r.needsDecision}`);
      if (r.r.nextStep) lines.push(`  - 次の一手: ${r.r.nextStep}`);
    }
    if (t.merge) lines.push('', `### 取り込み（別の作業場所 → 元のプロジェクト）: ${t.merge.ok ? '成功' : '失敗'} — ${t.merge.message}`);
    if (t.verify) lines.push('', `### 検証 \`${t.sc.verify}\`: ${t.verify.ok ? '成功' : '失敗'}`, '```', t.verify.output.slice(-600), '```');
    if (t.judge) {
      lines.push('', '### 利用者役AIの評価');
      lines.push(`- 分かりやすさ ${t.judge.reportClarity}/5、達成 ${t.judge.goalAchieved}`);
      for (const s of t.judge.reportIssues) lines.push(`- 報告: ${s}`);
      for (const s of t.judge.activityIssues) lines.push(`- 進捗表示: ${s}`);
      for (const s of t.judge.permissionIssues) lines.push(`- 許可: ${s}`);
    }
    lines.push('', `### 年表（${t.timeline.length}件）`);
    for (const x of t.timeline) lines.push(`- ${x.kind} | ${x.text.slice(0, 100).replace(/\n/g, ' ')}`);
  }
  const file = path.join(ROOT, 'docs/dogfood', `${runId}.md`);
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

// ---- main ----

async function main() {
  await api('/health').catch(() => {
    throw new Error(`Tower サーバーに繋がりません: ${API}。先に npm run dev で起動してください`);
  });
  const real = args.includes('--real');
  const runId = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + (real ? '-real' : '');
  // リポジトリの外に置く。中だと Claude Code が Tower 自身の CLAUDE.md や git を「プロジェクト」として拾ってしまう
  const runsDir = path.join(os.homedir(), '.tower', 'dogfood', runId);
  const scenarios = (real ? REAL_SCENARIOS : SCENARIOS).filter((s) => !only || only.includes(s.key));
  if (scenarios.length === 0) throw new Error('シナリオがありません');
  console.log(`run ${runId}: ${scenarios.map((s) => s.key).join(', ')}`);

  const tracks: Track[] = [];
  for (const sc of scenarios) {
    const dir = path.join(runsDir, sc.key);
    if (sc.source && fs.existsSync(path.join(sc.source, '.git'))) {
      // 本物のプロジェクトは clone で写す。送り先（origin）は外して、写しから元のリポジトリへ push できないようにする
      const r = spawnSync('git', ['clone', '-q', sc.source, dir], { encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`${sc.key}: 写しを作れませんでした: ${r.stderr}`);
      spawnSync('git', ['remote', 'remove', 'origin'], { cwd: dir, stdio: 'ignore' });
    } else {
      const from = sc.source ?? path.join(ROOT, 'playground/templates', sc.template ?? '');
      // .mcp.json は写さない（Blender などの道具を立ち上げる設定。写しの確認で本物の道具を動かさない）
      fs.cpSync(from, dir, { recursive: true, filter: (p) => !/[\\/](node_modules|\.venv|venv|__pycache__|\.git)([\\/]|$)|[\\/]\.mcp\.json$/.test(p) });
      // git 管理にしておくと Tower の「差分を見る」が使える（本物のプロジェクトと同じ条件にする）
      for (const a of [['init', '-q'], ['add', '-A'], ['-c', 'user.name=tower', '-c', 'user.email=tower@local', 'commit', '-qm', 'init']]) {
        spawnSync('git', a, { cwd: dir, stdio: 'ignore' });
      }
    }
    const s = await api<Session>('/sessions', {
      method: 'POST',
      body: JSON.stringify({
        projectPath: dir,
        prompt: sc.prompt,
        model: modelOverride ?? sc.model ?? 'haiku',
        permissionMode: sc.permissionMode,
        isolate: sc.isolate === true,
        autoMerge: sc.autoMerge === true,
      }),
    });
    tracks.push({
      sc, dir, sessionId: s.id, startedAt: now(), finishedAt: null, finishReason: '', activities: [], permissions: [], questions: [],
      reports: [], followUpIndex: 0, handled: new Set(), allowedCount: {}, denyOnceUsed: false, timeline: [],
    });
    console.log(`  起動 ${sc.key} → ${s.id.slice(0, 8)}`);
    await sleep(500);
  }

  let pollFailures = 0;
  while (tracks.some((t) => !t.finishedAt)) {
    // サーバーの再起動などで一時的に取れなくても、少し待って続ける
    let sessions: Session[];
    try {
      sessions = await api<Session[]>('/sessions');
      pollFailures = 0;
    } catch (e) {
      if (++pollFailures > 10) throw e;
      console.warn(`  一覧を取れませんでした（${pollFailures} 回目）:`, e instanceof Error ? e.message : e);
      await sleep(3000);
      continue;
    }
    await Promise.all(
      tracks
        .filter((t) => !t.finishedAt)
        .map(async (t) => {
          const s = sessions.find((x) => x.id === t.sessionId);
          if (!s) {
            t.finishedAt = now();
            t.finishReason = 'missing';
            return;
          }
          if (now() - t.startedAt > TIMEOUT_MS) {
            t.finishedAt = now();
            t.finishReason = 'timeout';
            t.session = s;
            await api(`/sessions/${t.sessionId}/stop`, { method: 'POST' }).catch(() => {});
            return;
          }
          await step(t, s);
        }),
    );
    await sleep(800);
  }

  console.log('\n全シナリオ終了。検証と評価を行います…');
  // Tower 側の裏取り（テスト実行）と見た目の撮影は報告の後に非同期で走るので、少し待って結果を拾う
  const settled = (s: Session | undefined) =>
    (!s?.verification || s.verification.ok !== null) && (!s?.preview || (!s.preview.taking && (!!s.preview.after || !!s.preview.error)));
  for (let i = 0; i < 30; i++) {
    const sessions = await api<Session[]>('/sessions');
    for (const t of tracks) t.session = sessions.find((x) => x.id === t.sessionId) ?? t.session;
    if (tracks.every((t) => settled(t.session))) break;
    await sleep(1000);
  }
  for (const t of tracks) {
    t.timeline = await api<TimelineItem[]>(`/sessions/${t.sessionId}/timeline`);
    if (t.sc.isolate && t.sc.autoMerge) {
      // 自動取り込み: Tower が裏取りの後に取り込むはずなので、押さずに結果を待つ
      let lm: { ok: boolean; message: string } | null = null;
      for (let i = 0; i < 30 && !lm; i++) {
        const s = await api<Session[]>('/sessions').then((xs) => xs.find((x) => x.id === t.sessionId));
        lm = s?.workspace?.lastMerge ?? null;
        if (s) t.session = s;
        if (!lm) await sleep(1000);
      }
      t.merge = lm ? { ok: lm.ok, message: `（自動）${lm.message}`, files: 0 } : { ok: false, message: '自動取り込みが 30 秒待っても起きなかった', files: 0 };
      console.log(`  [${t.sc.key}] 自動取り込み: ${t.merge.ok ? '成功' : '失敗'} ${t.merge.message.split('\n')[0]}`);
    } else if (t.sc.isolate) {
      // 分離した作業場所の成果は「取り込む」までプロジェクトに入らない。利用者がボタンを押すのと同じ操作をする
      try {
        t.merge = await api<MergeResult>(`/sessions/${t.sessionId}/merge`, { method: 'POST' });
      } catch (e) {
        t.merge = { ok: false, message: (e as Error).message, files: 0 };
      }
      console.log(`  [${t.sc.key}] 取り込み: ${t.merge.ok ? '成功' : '失敗'} ${t.merge.message.split('\n')[0]}`);
    }
    runVerify(t);
    try {
      try {
        const ch = await api<ChangesResponse>(`/sessions/${t.sessionId}/changes`);
        let budget = 6000;
        const parts: string[] = [];
        for (const f of ch.files) {
          const body = f.diff.slice(0, Math.min(1500, budget));
          budget -= body.length;
          parts.push(`### ${f.status} ${f.path}\n${body}${f.diff.length > body.length ? '\n…（省略）' : ''}`);
          if (budget <= 0) break;
        }
        t.changes = parts.join('\n\n') || '(変更なし)';
      } catch {
        /* 差分が取れなくても採点はする */
      }
      t.judge = await judge(t);
    } catch (e) {
      console.warn(`  [${t.sc.key}] 評価LLM失敗:`, (e as Error).message);
    }
    console.log(`  ${t.sc.key}: ${t.finishReason} / 検証 ${t.verify ? (t.verify.ok ? 'OK' : 'NG') : '-'} / 分かりやすさ ${t.judge?.reportClarity ?? '-'} / 達成 ${t.judge?.goalAchieved ?? '-'}`);
  }
  const file = writeReport(runId, tracks);
  console.log(`\nレポート: ${path.relative(ROOT, file)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
