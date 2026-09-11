import { create } from 'zustand';
import type { Session, TimelineItem } from '@tower/shared';

interface State {
  connected: boolean;
  sessions: Record<string, Session>;
  timelines: Record<string, TimelineItem[]>;
  selectedId: string | null;
  /** 画面のエディタで開いているファイル（選んでいるセッションの作業フォルダからの相対パス） */
  openPath: string | null;
  setConnected: (v: boolean) => void;
  setSnapshot: (sessions: Session[]) => void;
  upsertSession: (s: Session) => void;
  removeSession: (id: string) => void;
  appendTimeline: (item: TimelineItem) => void;
  setTimeline: (id: string, items: TimelineItem[]) => void;
  select: (id: string | null) => void;
  openFile: (path: string | null) => void;
}

export const useStore = create<State>((set) => ({
  connected: false,
  sessions: {},
  timelines: {},
  selectedId: null,
  openPath: null,
  setConnected: (connected) => set({ connected }),
  setSnapshot: (list) => set({ sessions: Object.fromEntries(list.map((s) => [s.id, s])) }),
  upsertSession: (s) => set((st) => ({ sessions: { ...st.sessions, [s.id]: s } })),
  removeSession: (id) =>
    set((st) => {
      const sessions = { ...st.sessions };
      delete sessions[id];
      const timelines = { ...st.timelines };
      delete timelines[id];
      const gone = st.selectedId === id;
      return { sessions, timelines, selectedId: gone ? null : st.selectedId, openPath: gone ? null : st.openPath };
    }),
  appendTimeline: (item) =>
    set((st) => {
      const cur = st.timelines[item.sessionId];
      if (!cur) return {}; // まだ読み込んでいないセッションは、開いた時にまとめて取る
      if (cur.some((t) => t.id === item.id)) return {};
      return { timelines: { ...st.timelines, [item.sessionId]: [...cur, item] } };
    }),
  setTimeline: (id, items) => set((st) => ({ timelines: { ...st.timelines, [id]: items } })),
  // 別のセッションに移ったら、開いていたファイルは閉じる（作業フォルダが変わるので同じパスでも別物）
  select: (selectedId) => set((st) => (st.selectedId === selectedId ? { selectedId } : { selectedId, openPath: null })),
  openFile: (openPath) => set({ openPath }),
}));

/** 判断待ちのセッション（インボックス用） */
export function selectPending(st: State): Session[] {
  return Object.values(st.sessions)
    .filter((s) => s.pending)
    .sort((a, b) => (a.pending!.createdAt ?? 0) - (b.pending!.createdAt ?? 0));
}
