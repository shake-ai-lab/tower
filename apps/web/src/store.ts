import { create } from 'zustand';
import type { Session, TimelineItem } from '@tower/shared';

interface State {
  connected: boolean;
  sessions: Record<string, Session>;
  timelines: Record<string, TimelineItem[]>;
  selectedId: string | null;
  setConnected: (v: boolean) => void;
  setSnapshot: (sessions: Session[]) => void;
  upsertSession: (s: Session) => void;
  removeSession: (id: string) => void;
  appendTimeline: (item: TimelineItem) => void;
  setTimeline: (id: string, items: TimelineItem[]) => void;
  select: (id: string | null) => void;
}

export const useStore = create<State>((set) => ({
  connected: false,
  sessions: {},
  timelines: {},
  selectedId: null,
  setConnected: (connected) => set({ connected }),
  setSnapshot: (list) => set({ sessions: Object.fromEntries(list.map((s) => [s.id, s])) }),
  upsertSession: (s) => set((st) => ({ sessions: { ...st.sessions, [s.id]: s } })),
  removeSession: (id) =>
    set((st) => {
      const sessions = { ...st.sessions };
      delete sessions[id];
      const timelines = { ...st.timelines };
      delete timelines[id];
      return { sessions, timelines, selectedId: st.selectedId === id ? null : st.selectedId };
    }),
  appendTimeline: (item) =>
    set((st) => {
      const cur = st.timelines[item.sessionId];
      if (!cur) return {}; // まだ読み込んでいないセッションは、開いた時にまとめて取る
      if (cur.some((t) => t.id === item.id)) return {};
      return { timelines: { ...st.timelines, [item.sessionId]: [...cur, item] } };
    }),
  setTimeline: (id, items) => set((st) => ({ timelines: { ...st.timelines, [id]: items } })),
  select: (selectedId) => set({ selectedId }),
}));

/** 判断待ちのセッション（インボックス用） */
export function selectPending(st: State): Session[] {
  return Object.values(st.sessions)
    .filter((s) => s.pending)
    .sort((a, b) => (a.pending!.createdAt ?? 0) - (b.pending!.createdAt ?? 0));
}
