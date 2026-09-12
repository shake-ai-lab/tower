// タスクがいまどうなっているかの判定を 1 か所にまとめる。一覧・詳細・パネル選択の札、「完了にする」ボタン、
// 「終わったもの」の畳み方はすべてここを見る（場所ごとに別々に決めていて、報告は「完了」なのに札は「報告あり」、
// ボタンは「完了にする」と食い違っていた）。画面から切り離してテストできるようにしている
import type { Session } from '@tower/shared';

type Judged = Pick<Session, 'status' | 'pending' | 'report' | 'verification' | 'completedByUser'> & Partial<Pick<Session, 'baseline'>>;

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
  /** 報告の中であなたの判断を求めている */
  | 'decision'
  /** 報告が「完了」（または、あなたが「完了」にした） */
  | 'done'
  | 'partial'
  | 'failed'
  /** 報告は「完了」だが、Tower の自動チェックが通っていない */
  | 'mismatch'
  /** 決まった書式ではない報告 */
  | 'reported'
  /** 止まって次の指示を待っている（報告なし） */
  | 'waiting'
  | 'error'
  | 'stopped'
  /** エージェントの側で終わった（完了の報告なし） */
  | 'ended';

/**
 * あなたの判断を待っているか。許可・質問（pending）に加えて、報告で「判断が必要」「質問あり」と言って
 * 止まっているもの（idle）も含める。次の指示を送る・停止すると外れる
 */
export function needsYou(s: Pick<Session, 'status' | 'pending' | 'report'>): boolean {
  if (s.pending) return true;
  return s.status === 'idle' && !!s.report && (!!s.report.needsDecision || s.report.outcome === 'question');
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
      return s.completedByUser || s.report?.outcome === 'done' ? 'done' : 'ended';
    case 'idle':
      break;
  }
  if (needsYou(s)) return 'decision';
  switch (s.report?.outcome) {
    case undefined:
      return 'waiting';
    case 'done':
      // 前からの失敗が残っているだけなら、今回の変更は何も壊していないので「完了」のまま（詳細の自動チェック欄に黄色で出る）
      return s.verification?.ok === false && !onlyOldFailures(s) ? 'mismatch' : 'done';
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
  return ['done', 'error', 'ended'].includes(taskState(s));
}

/** 「完了にする」ボタンを出すか。もう完了しているもの・外で作業中のものには出さない */
export function canMarkDone(s: Judged & Pick<Session, 'origin'>): boolean {
  if (s.status === 'done' || taskState(s) === 'done') return false;
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
  decision: { label: '判断待ち', cls: 'bg-amber-400 text-black font-semibold', title: '報告の中で、あなたの判断を求めています' },
  done: { label: '✓ 完了', cls: 'bg-emerald-800/80 text-emerald-100', title: '完了しました。続きの指示を送れば、また動きます' },
  partial: { label: '一部完了', cls: 'bg-amber-900/70 text-amber-200', title: '報告が「一部完了」です。これで終わりにするなら「完了にする」を押してください' },
  failed: { label: '失敗', cls: 'bg-red-900/70 text-red-200', title: '報告が「失敗」です。やり直すなら指示を送り、あきらめるなら「完了にする」を押してください' },
  mismatch: { label: '要確認', cls: 'bg-red-600 text-white font-semibold', title: '報告は「完了」ですが、Tower の自動チェックが通っていません' },
  reported: { label: '報告あり', cls: 'bg-emerald-900/70 text-emerald-200' },
  waiting: { label: '指示待ち', cls: 'bg-zinc-800 text-zinc-300' },
  error: { label: 'エラー', cls: 'bg-red-900/70 text-red-200' },
  stopped: { label: '停止', cls: 'bg-zinc-800 text-zinc-300' },
  ended: { label: '終了', cls: 'bg-zinc-800 text-zinc-300' },
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

/** 札が報告の結果と同じことを言っているか（一覧のカードで「完了」を 2 度出さないため） */
export const badgeRepeatsReport = (s: Judged): boolean => !!s.report && SAME_AS_REPORT[taskState(s)] === s.report.outcome;
