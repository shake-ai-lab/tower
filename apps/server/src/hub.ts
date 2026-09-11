// Hub: 全セッションの現在状態を持ち、変更を WebSocket の購読者へ流す。
import type { ServerEvent, Session, TimelineItem } from '@tower/shared';
import type { Db } from './db.ts';

type Listener = (ev: ServerEvent) => void;

export class Hub {
  readonly sessions = new Map<string, Session>();
  private listeners = new Set<Listener>();

  constructor(private db: Db) {
    for (const s of db.loadSessions()) {
      // サーバー再起動でプロセスは死んでいるので、生きていた扱いのものは止まった扱いにする
      // （外部セッションは Tower の子プロセスではないので触らない）
      if (
        s.origin !== 'external' &&
        ['starting', 'running', 'waiting_permission', 'waiting_question', 'idle'].includes(s.status)
      ) {
        s.status = 'stopped';
        s.pending = null;
        s.activity = s.agentSessionId
          ? 'サーバー再起動で中断。指示を送ると続きから再開します'
          : 'サーバー再起動で中断（再開不可）';
        db.saveSession(s);
      }
      this.sessions.set(s.id, s);
    }
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
      if (delta.cost || delta.input || delta.output || delta.cacheRead) next.usageHistory = [...(cur.usageHistory ?? []), delta];
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
