// Hub: 全セッションの現在状態を持ち、変更を WebSocket の購読者へ流す。
import type { ServerEvent, Session, TimelineItem } from '@tower/shared';
import type { Db, UsageRow } from './db.ts';

type Listener = (ev: ServerEvent) => void;

/** meta に置く印。台帳への過去分の取り込みを 1 回だけにする */
const USAGE_IMPORTED_KEY = 'usage_imported';

const ledgerBase = (s: Session): Omit<UsageRow, 'ts' | 'cost' | 'input' | 'cache_read' | 'output' | 'dated'> => ({
  session_id: s.id,
  project_path: s.project?.path ?? '',
  project_name: s.project?.name ?? '',
  agent: s.agent ?? '',
  model: s.model ?? null,
});

/**
 * 既存セッションの使った量を台帳の行にする（起動時の 1 回きりの取り込み用）。
 * usageHistory の各項目は記録時刻つき（dated = 1）。
 * 合計のうち usageHistory に無い残り（更新前の古い分）は日付が分からないので createdAt / dated = 0 の 1 行にまとめる。
 * 外部セッションは量が分からないので何も作らない
 */
export function ledgerRowsFor(s: Session): UsageRow[] {
  if (s.origin === 'external') return [];
  const base = ledgerBase(s);
  const history = s.usageHistory ?? [];
  const rows: UsageRow[] = history.map((h) => ({ ...base, ts: h.ts, cost: h.cost, input: h.input, cache_read: h.cacheRead, output: h.output, dated: 1 }));
  const recorded = history.reduce(
    (sum, h) => ({ cost: sum.cost + h.cost, input: sum.input + h.input, cacheRead: sum.cacheRead + h.cacheRead, output: sum.output + h.output }),
    { cost: 0, input: 0, cacheRead: 0, output: 0 },
  );
  const rest = {
    cost: Math.max(0, (s.costUsd ?? 0) - recorded.cost),
    input: Math.max(0, (s.usage?.input ?? 0) - recorded.input),
    cache_read: Math.max(0, (s.usage?.cacheRead ?? 0) - recorded.cacheRead),
    output: Math.max(0, (s.usage?.output ?? 0) - recorded.output),
  };
  if (rest.cost > 0 || rest.input > 0 || rest.cache_read > 0 || rest.output > 0) rows.push({ ...base, ts: s.createdAt, ...rest, dated: 0 });
  return rows;
}

/**
 * サーバー再起動で中断した扱いにする。対象外（外部セッション、作業中でないもの）なら null。
 * 報告あり（idle）はそのまま残す: 報告で判断を求めているものを判断待ちから落とさないため。
 * プロセスが無くても、起動時の自動再開か利用者の指示で manager.send が続きから再開する。
 * updatedAt は変えない（一覧の並びを再起動で崩さない）
 */
export function interruptForRestart(s: Session, now: number): Session | null {
  if (s.origin === 'external') return null;
  if (!['starting', 'running', 'waiting_permission', 'waiting_question'].includes(s.status)) return null;
  return {
    ...s,
    status: 'stopped',
    pending: null,
    pendingCount: 0,
    interrupted: { at: now, status: s.status },
    activity: s.agentSessionId
      ? 'サーバー再起動で中断。指示を送ると続きから再開します'
      : 'サーバー再起動で中断（再開不可）',
  };
}

export class Hub {
  readonly sessions = new Map<string, Session>();
  private listeners = new Set<Listener>();
  /** 今回の起動時刻。再起動で「中断」の印を付けた時刻と同じ値（起動時の自動再開は、この起動で付いた印だけを対象にする） */
  readonly bootAt: number;

  constructor(private db: Db) {
    const now = Date.now();
    this.bootAt = now;
    for (const loaded of db.loadSessions()) {
      // サーバー再起動でプロセスは死んでいるので、作業中だったものは止まった扱いにする
      // （外部セッションは Tower の子プロセスではないので触らない）
      const interrupted = interruptForRestart(loaded, now);
      const s = interrupted ?? loaded;
      if (interrupted) db.saveSession(s);
      this.sessions.set(s.id, s);
    }
    this.importUsageHistory();
  }

  /** 台帳が無かった頃のセッションの使った量を台帳に取り込む（meta の印で 1 回だけ） */
  private importUsageHistory() {
    if (this.db.getMeta(USAGE_IMPORTED_KEY)) return;
    // 途中で落ちて一部だけ入ると次回に二重で積んでしまうので、全部と印をひとまとまりで書く
    this.db.transaction(() => {
      for (const s of this.sessions.values()) {
        for (const row of ledgerRowsFor(s)) this.db.appendUsage(row);
      }
      this.db.setMeta(USAGE_IMPORTED_KEY, '1');
    });
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn({ type: 'snapshot', sessions: this.list() });
    return () => this.listeners.delete(fn);
  }

  list(): Session[] {
    return [...this.sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  /** 部分更新して保存・配信 */
  update(id: string, patch: Partial<Session>): Session | undefined {
    const cur = this.sessions.get(id);
    if (!cur) return undefined;
    const next: Session = { ...cur, ...patch, updatedAt: Date.now() };
    if (patch.costUsd !== undefined || patch.usage !== undefined) {
      const delta = { ts: next.updatedAt, cost: Math.max(0, next.costUsd - cur.costUsd), input: Math.max(0, (next.usage?.input ?? 0) - (cur.usage?.input ?? 0)), cacheRead: Math.max(0, (next.usage?.cacheRead ?? 0) - (cur.usage?.cacheRead ?? 0)), output: Math.max(0, (next.usage?.output ?? 0) - (cur.usage?.output ?? 0)) };
      if (delta.cost || delta.input || delta.output || delta.cacheRead) {
        next.usageHistory = [...(cur.usageHistory ?? []), delta];
        // 台帳にも同じ差分を積む（セッションを消しても「使った量」が減らないように）。外部セッションは量が分からないので積まない
        if (next.origin !== 'external') this.db.appendUsage({ ...ledgerBase(next), ts: delta.ts, cost: delta.cost, input: delta.input, cache_read: delta.cacheRead, output: delta.output, dated: 1 });
      }
    }
    this.sessions.set(id, next);
    this.db.saveSession(next);
    this.emit({ type: 'session', session: next });
    return next;
  }

  add(session: Session) {
    this.sessions.set(session.id, session);
    this.db.saveSession(session);
    this.emit({ type: 'session', session });
  }

  /** セッションを消す。使った量の台帳は消さない（消したタスクの分も合計に残す） */
  remove(id: string) {
    this.sessions.delete(id);
    this.db.deleteSession(id);
    this.emit({ type: 'session_removed', id });
  }

  timeline(item: TimelineItem) {
    this.db.appendTimeline(item);
    this.emit({ type: 'timeline', item });
  }

  private emit(ev: ServerEvent) {
    for (const fn of this.listeners) {
      try {
        fn(ev);
      } catch (e) {
        console.error('[hub] listener error', e);
      }
    }
  }
}
