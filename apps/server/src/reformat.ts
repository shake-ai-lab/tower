// 報告の再整形: 【報告】の書式が無い・崩れている時に、Haiku で原文を報告カードの形に整える。
// Tower の外（VS Code / ターミナル）で動くセッションは報告のルールを知らないので、主にそちらで効く。
// 原文は残す（Report.raw）。整形したものには reformatted を付けて、画面で「Tower が整形」と分かるようにする。
import { randomUUID } from 'node:crypto';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Report, ReportOutcome, Session } from '@tower/shared';
import type { Hub } from './hub.ts';
import { firstLine } from './humanize.ts';

let enabled = true;
export function setReformatEnabled(v: boolean) {
  enabled = v;
}

const SYSTEM = [
  'あなたは、AIエージェントが書いた作業の出力を、コードを読まない利用者向けの「報告カード」に整える係です。',
  '利用者は「何が起きて、次に何を判断すればいいか」だけを知りたい。専門用語は避け、中学生にも分かる言葉で書く。',
  '守ること:',
  '- 原文に無いことは書かない。分からないことは「不明」や空にする',
  '- 「結果」は原文の内容から判断する。テストや動作確認が成功したと明記されていれば「完了」、確認していない・一部残っている・利用者の確認待ちなら「一部完了」、できなかったなら「失敗」、利用者に何か聞いているなら「質問あり」、判断できなければ「不明」',
  '- 「やったこと」は最大5行。コードや識別子（関数名・変数名・行番号）は書かず、何がどう変わったかを普通の言葉で',
  '- 「変更ファイル」は原文に出てくるファイルのパスをそのまま。無ければ空',
  '- 「判断が必要」は利用者に決めてほしいこと・確認してほしいことだけ。無ければ null',
  '- 「次の一手」は原文に手がかりがある時だけ（例: 原文が「〜しますか？」と聞いていれば、それに答えることを促す）。原文に無い作業（本番反映、他の機能の追加など）を勝手に提案しない。無ければ null',
  '- 原文の最後が「他に気になる点があれば」のような社交辞令だけなら、それは質問ではない',
  '- 出力は日本語',
].join('\n');

const SCHEMA = {
  type: 'object',
  properties: {
    request: { type: 'string', description: '何を頼まれたかを1行で' },
    outcome: { type: 'string', enum: ['完了', '一部完了', '失敗', '質問あり', '不明'] },
    summary: { type: 'array', items: { type: 'string' }, description: 'やったこと。最大5行' },
    changedFiles: { type: 'array', items: { type: 'string' } },
    needsDecision: { type: ['string', 'null'] },
    nextStep: { type: ['string', 'null'] },
  },
  required: ['request', 'outcome', 'summary', 'changedFiles', 'needsDecision', 'nextStep'],
  additionalProperties: false,
};

interface Out {
  request?: string;
  outcome?: string;
  summary?: string[];
  changedFiles?: string[];
  needsDecision?: string | null;
  nextStep?: string | null;
}

const OUTCOME: Record<string, ReportOutcome> = { 完了: 'done', 一部完了: 'partial', 失敗: 'failed', 質問あり: 'question' };

// 同時に走らせる整形は少数に絞る（外部セッションが一斉に止まった時に Haiku を大量に起動しない）
const MAX_PARALLEL = 2;
let running = 0;
const waiters: (() => void)[] = [];
async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= MAX_PARALLEL) await new Promise<void>((r) => waiters.push(r));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    waiters.shift()?.();
  }
}

function tryParse(s: string): Out | undefined {
  try {
    return JSON.parse(s) as Out;
  } catch {
    const m = s.match(/\{[\s\S]*\}/);
    if (!m) return undefined;
    try {
      return JSON.parse(m[0]) as Out;
    } catch {
      return undefined;
    }
  }
}

const clean = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const list = (v: unknown, max: number): string[] =>
  Array.isArray(v) ? v.map(clean).filter(Boolean).slice(0, max) : [];

/** 整形が要るか: 書式が読めなかった（結果が不明の）報告で、原文がある程度の長さ */
export function needsReformat(r: Report): boolean {
  return enabled && !r.reformatted && r.outcome === 'unknown' && r.raw.trim().length >= 60;
}

/** 原文を Haiku で報告カードに整える。失敗したら null（元の表示のまま） */
export async function reformatReport(raw: string, request: string, timeoutMs = 90_000): Promise<Report | null> {
  const env = { ...process.env };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  env.TOWER_MANAGED = '1'; // VS Code 連携の hooks に「外部セッション」として拾われないように
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    let out: Out | undefined;
    const prompt = `# 依頼\n${request || '(不明)'}\n\n# エージェントの出力（原文）\n${raw.slice(-12_000)}`;
    for await (const m of query({
      prompt,
      options: {
        model: 'haiku',
        tools: [],
        settingSources: [],
        persistSession: false,
        maxTurns: 2,
        systemPrompt: SYSTEM,
        outputFormat: { type: 'json_schema', schema: SCHEMA },
        abortController: abort,
        env,
      },
    })) {
      if (m.type === 'result' && m.subtype === 'success') out = (m.structured_output as Out | undefined) ?? tryParse(m.result);
    }
    if (!out) return null;
    const needs = clean(out.needsDecision);
    const next = clean(out.nextStep);
    return {
      request: clean(out.request) || request,
      outcome: OUTCOME[clean(out.outcome)] ?? 'unknown',
      summary: list(out.summary, 5),
      changedFiles: list(out.changedFiles, 30),
      needsDecision: needs && !/^(なし|null)$/i.test(needs) ? needs : null,
      nextStep: next && !/^(なし|null)$/i.test(next) ? next : null,
      raw,
      generatedAt: Date.now(),
      reformatted: true,
    };
  } catch (e) {
    console.warn('[reformat] 整形に失敗（元の表示のまま）:', e instanceof Error ? e.message : e);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 書式の崩れた報告を裏で整形し、まだその報告が最新なら差し替える。呼び出し側は待たない */
export function scheduleReformat(hub: Hub, sessionId: string, report: Report) {
  if (!needsReformat(report)) return;
  void withSlot(async () => {
    const fixed = await reformatReport(report.raw, report.request);
    if (!fixed) return;
    const cur = hub.get(sessionId);
    if (!cur || cur.report?.generatedAt !== report.generatedAt) return; // もう次の報告が来ている
    const patch: Partial<Session> = { report: { ...fixed, generatedAt: report.generatedAt } };
    if (cur.status === 'idle') {
      patch.activity = fixed.needsDecision ? `判断待ち: ${firstLine(fixed.needsDecision).slice(0, 60)}` : '指示待ち';
    }
    hub.update(sessionId, patch);
    hub.timeline({
      id: randomUUID(),
      sessionId,
      ts: Date.now(),
      kind: 'system',
      text: '報告に決まった書式が無かったので、Tower が読みやすく整形しました（原文は「原文を見る」で確認できます）',
    });
  });
}
