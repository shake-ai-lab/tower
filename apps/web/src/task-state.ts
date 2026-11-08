// タスクがいまどうなっているかの判定を 1 か所にまとめる。一覧・詳細・パネル選択の札、「完了にする」ボタン、
// 「終わったもの」の畳み方はすべてここを見る（場所ごとに別々に決めていて、報告は「完了」なのに札は「報告あり」、
// ボタンは「完了にする」と食い違っていた）。画面から切り離してテストできるようにしている
import type { Session } from '@tower/shared';

type Dated = Partial<Pick<Session, 'lastInstructionAt' | 'lastManualEditAt'>>;
type Judged = Pick<Session, 'status' | 'pending' | 'report' | 'verification' | 'completedByUser'> & Partial<Pick<Session, 'baseline' | 'workspace' | 'origin'>> & Dated;

/** 更新時刻には検証や取り込みも含まれるため、指示を受けた時刻だけと比較する。 */
export function reportIsStale(s: Pick<Session, 'report'> & Dated): boolean {
  return !!s.report && (s.lastInstructionAt ?? 0) > s.report.generatedAt;
}

export function verificationIsStale(s: Pick<Session, 'verification'> & Partial<Pick<Session, 'report'>> & Dated): boolean {
  return !!s.verification && s.verification.at < Math.max(s.lastInstructionAt ?? 0, s.lastManualEditAt ?? 0, s.report?.generatedAt ?? 0);
}

export type ReportContext = 'current' | 'previous' | 'merged' | 'completed';
export function reportContext(s: Pick<Session, 'report' | 'status'> & Partial<Pick<Session, 'workspace' | 'completedByUser'>> & Dated): ReportContext {
  if (reportIsStale(s) || ['starting', 'running', 'waiting_permission', 'waiting_question'].includes(s.status)) return 'previous';
  if (s.report && (s.completedByUser ?? 0) >= s.report.generatedAt) return 'completed';
  const m = s.workspace?.lastMerge;
  return m?.ok && s.report && m.at >= s.report.generatedAt ? 'merged' : 'current';
}

/**
 * 自動チェックの失敗が、作業を始める前からのものだけか（修正前も失敗していて、新しく失敗したものが無い）。
 * この時に「完了なのに失敗」と赤で責めると、エージェントの説明（前からの失敗で無関係）と画面が食い違って見える
 */
export function onlyOldFailures(s: Pick<Session, 'verification'> & Partial<Pick<Session, 'baseline'>>): boolean {
  const v = s.verification;
  const b = s.baseline;
  if (!v || v.ok !== false || !b || b.ok !== false) return false;
  const before = new Set(b.failed ?? []);
  return (v.failed ?? []).every((n) => before.has(n));
}

export type TaskState =
  | 'starting'
  | 'working'
  | 'permission'
  | 'question'
  /** あなたの番（エージェントが返事をして、次の指示を待っている。以前の報告では「判断が必要」） */
  | 'decision'
  /** 報告が「完了」（または、あなたが「完了」にした） */
  | 'done'
  | 'partial'
  | 'failed'
  /** 報告は「完了」だが、Tower の自動チェックが通っていない */
  | 'mismatch'
  /** 返事はあるが、あなたの番には数えないもの（VS Code・ターミナルのセッション） */
  | 'reported'
  /** 止まって次の指示を待っている（報告なし） */
  | 'waiting'
  | 'error'
  | 'stopped'
  /** エージェントの側で終わった（完了の報告なし） */
  | 'ended'
  /** 報告の後に、別の作業場所の変更を元のプロジェクトへ取り込んだ */
  | 'merged';

/**
 * 最新の報告の後に、別の作業場所の変更を元のプロジェクトへ取り込んだか（ボタンでも自動でも）。
 * 取り込んだ = その報告を受け入れたということなので、報告の「判断が必要」はもう待たない
 * （待ち続けると、取り込んだ後も「判断待ち」に数えられていた）
 */
export function mergedSinceReport(s: Pick<Session, 'report'> & Partial<Pick<Session, 'workspace'>> & Dated): boolean {
  const m = s.workspace?.lastMerge;
  return !!m?.ok && !!s.report && m.at >= Math.max(s.report.generatedAt, s.lastInstructionAt ?? 0, s.lastManualEditAt ?? 0);
}

/**
 * 以前の決まった書式の報告（【報告】の欄を Tower が読み取ったもの）か。今はエージェントの返事をそのまま出すので、
 * 結果（完了・一部完了…）も「判断が必要」も分からない（outcome は unknown、失敗で終わった時だけ failed）
 */
export function isStructuredReport(r: NonNullable<Session['report']>): boolean {
  return (
    ['done', 'partial', 'question'].includes(r.outcome) ||
    (r.summary?.length ?? 0) > 0 ||
    !!r.needsDecision ||
    !!r.nextStep ||
    !!r.details
  );
}

/**
 * あなたの番か。許可・質問（pending）に加えて、エージェントが返事をして止まっているもの（idle）。
 * 返事の中身からは「終わった」か「判断がほしい」かを見分けないので、返事が来たら全部あなたの番にして、
 * 次の指示を送る・「完了にする」・取り込むまで待つ。
 * VS Code・ターミナルのセッション（external）の返事はそちらで読んで答えるので数えない（許可要求は数える）。
 * 以前の決まった書式の報告は、これまでどおり「判断が必要」「質問あり」の時だけ
 */
export function needsYou(s: Pick<Session, 'status' | 'pending' | 'report'> & Partial<Pick<Session, 'workspace' | 'origin' | 'completedByUser'>> & Dated): boolean {
  if (s.pending) return true;
  if (s.status !== 'idle' || !s.report || reportContext(s) !== 'current') return false;
  if (isStructuredReport(s.report)) return !!s.report.needsDecision || s.report.outcome === 'question';
  return s.origin !== 'external';
}

export function taskState(s: Judged): TaskState {
  switch (s.status) {
    case 'starting':
      return 'starting';
    case 'running':
      return 'working';
    case 'waiting_permission':
      return 'permission';
    case 'waiting_question':
      return 'question';
    case 'error':
      return 'error';
    case 'stopped':
      return 'stopped';
    case 'done':
      return s.completedByUser || (!reportIsStale(s) && s.report?.outcome === 'done') ? 'done' : 'ended';
    case 'idle':
      break;
  }
  if (needsYou(s)) return 'decision';
  if (mergedSinceReport(s)) return 'merged';
  if (reportIsStale(s)) return 'waiting';
  switch (s.report?.outcome) {
    case undefined:
      return 'waiting';
    case 'done':
      // 前からの失敗が残っているだけなら、今回の変更は何も壊していないので「完了」のまま（詳細の自動チェック欄に黄色で出る）
      return !verificationIsStale(s) && s.verification?.ok === false && !onlyOldFailures(s) ? 'mismatch' : 'done';
    case 'partial':
      return 'partial';
    case 'failed':
      return 'failed';
    default:
      return 'reported';
  }
}

/**
 * もう片付いたもの（完了・エラー・終了）。一覧で「終わったもの」として畳める。報告が「完了」のものも含める（判断することが残っていない）。
 * 停止は途中で止めただけで、指示を送れば続きから再開するので含めない（終わりにしたい時は「完了にする」）
 */
export function isFinished(s: Judged): boolean {
  return ['done', 'error', 'ended', 'merged'].includes(taskState(s));
}

/** 「完了にする」ボタンを出すか。もう完了・取り込み済みのもの、外で作業中のものには出さない */
export function canMarkDone(s: Judged & Pick<Session, 'origin'>): boolean {
  if (s.status === 'done' || ['done', 'merged'].includes(taskState(s))) return false;
  const working = ['starting', 'running', 'waiting_permission', 'waiting_question'].includes(s.status);
  return !(s.origin === 'external' && working);
}

export interface StateBadge {
  label: string;
  cls: string;
  title?: string;
  working?: boolean;
}

const BADGE: Record<TaskState, StateBadge> = {
  starting: { label: '起動中', cls: 'bg-zinc-700 text-zinc-200', working: true },
  working: { label: '作業中', cls: 'bg-sky-500 text-white font-semibold', working: true },
  permission: { label: '許可待ち', cls: 'bg-amber-400 text-black font-semibold' },
  question: { label: '質問あり', cls: 'bg-violet-500 text-white font-semibold' },
  decision: { label: '判断待ち', cls: 'bg-amber-400 text-black font-semibold', title: 'あなたの番です。返事を読んで、続きの指示を送るか「完了にする」を押してください' },
  done: { label: '✓ 完了', cls: 'bg-emerald-800/80 text-emerald-100', title: '完了しました。続きの指示を送れば、また動きます' },
  partial: { label: '一部完了', cls: 'bg-amber-900/70 text-amber-200', title: '報告が「一部完了」です。これで終わりにするなら「完了にする」を押してください' },
  failed: { label: '失敗', cls: 'bg-red-900/70 text-red-200', title: '報告が「失敗」です。やり直すなら指示を送り、あきらめるなら「完了にする」を押してください' },
  mismatch: { label: '要確認', cls: 'bg-red-600 text-white font-semibold', title: '報告は「完了」ですが、Tower の自動チェックが通っていません' },
  reported: { label: '返事あり', cls: 'bg-emerald-900/70 text-emerald-200', title: '元の画面（VS Code など）で返事を読んで答えてください' },
  waiting: { label: '指示待ち', cls: 'bg-zinc-800 text-zinc-300' },
  error: { label: 'エラー', cls: 'bg-red-900/70 text-red-200' },
  stopped: { label: '停止', cls: 'bg-zinc-800 text-zinc-300' },
  ended: { label: '終了', cls: 'bg-zinc-800 text-zinc-300' },
  merged: { label: '✓ 取り込み済み', cls: 'bg-emerald-800/80 text-emerald-100', title: '元のプロジェクトに取り込みました。続きの指示を送れば、また動きます' },
};

export function stateBadge(s: Judged): StateBadge {
  const b = BADGE[taskState(s)];
  if (s.status === 'done' && s.completedByUser) return { ...b, title: 'あなたが「完了」にしました。続きの指示を送れば再開できます' };
  return b;
}

const SAME_AS_REPORT: Partial<Record<TaskState, NonNullable<Session['report']>['outcome']>> = {
  done: 'done',
  partial: 'partial',
  failed: 'failed',
  reported: 'unknown',
};

/**
 * 一覧のカードで報告の結果の札を省くか。札が報告の結果と同じことを言っている時（「完了」を 2 度出さない）と、
 * 取り込み済みの時（取り込んだことが今の状態。横に「一部完了」と並ぶと、まだ終わっていないように見えていた）
 */
export const badgeRepeatsReport = (s: Judged): boolean => {
  if (!s.report) return false;
  const state = taskState(s);
  return state === 'merged' || SAME_AS_REPORT[state] === s.report.outcome;
};
