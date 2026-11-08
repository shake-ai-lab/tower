import { create } from 'zustand';
import type { Session, TimelineItem } from '@tower/shared';

/**
 * 1 つのタスクについて画面が持っておく経過の上限。古いものから手放す（何日も開いたままでも重くならないように）。
 * サーバーには全部残っている
 */
export const TIMELINE_CAP = 1000;

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
  /** これから経過をサーバーから読む。読み終わる（setTimeline）までに届いたものを取っておき、読んだものに混ぜる */
  loadingTimeline: (id: string) => void;
  setTimeline: (id: string, items: TimelineItem[]) => void;
  select: (id: string | null) => void;
  openFile: (path: string | null) => void;
}

/** 読み込み中のセッションに届いた経過。画面に出すものではないので状態には入れない */
const arriving = new Map<string, TimelineItem[]>();

/** 経過の並びごとの id の一覧（同じものが 2 度届いた時に、並びを端から見ずに分かるように） */
const idIndex = new WeakMap<TimelineItem[], Set<string>>();
function idsOf(list: TimelineItem[]): Set<string> {
  let ids = idIndex.get(list);
  if (!ids) {
    ids = new Set(list.map((t) => t.id));
    idIndex.set(list, ids);
  }
  return ids;
}

/** 新しい方から上限まで */
const capped = (list: TimelineItem[]) => (list.length > TIMELINE_CAP ? list.slice(list.length - TIMELINE_CAP) : list);

/**
 * 読み込んだ経過に、その間に届いたもの（と、もう画面にあるもの）を混ぜる。同じ id は先に来た方（読んだもの）を残し、
 * 混ぜたものがあれば時刻順に並べ直す（同じ時刻は元の順のまま）
 */
export function mergeTimeline(fetched: TimelineItem[], ...others: TimelineItem[][]): TimelineItem[] {
  const ids = new Set(fetched.map((t) => t.id));
  const extra: TimelineItem[] = [];
  for (const list of others) {
    for (const t of list) {
      if (ids.has(t.id)) continue;
      ids.add(t.id);
      extra.push(t);
    }
  }
  if (!extra.length) return capped(fetched);
  return capped([...fetched, ...extra].sort((a, b) => a.ts - b.ts));
}

export const useStore = create<State>((set) => ({
  connected: false,
  sessions: {},
  timelines: {},
  selectedId: null,
  openPath: null,
  setConnected: (connected) => set({ connected }),
  // 接続し直した時に来る。切れていた間の年表は届かないので、開いているものを読み直させる（空にすると詳細画面が取り直す）
  setSnapshot: (list) =>
    set((st) => {
      // 読み直すまでに届くものを取りこぼさないよう、読んでいた経過は「読み込み中」にしておく
      for (const id of Object.keys(st.timelines)) if (!arriving.has(id)) arriving.set(id, []);
      const alive = new Set(list.map((s) => s.id));
      for (const id of [...arriving.keys()]) if (!alive.has(id)) arriving.delete(id);
      return { sessions: Object.fromEntries(list.map((s) => [s.id, s])), timelines: {} };
    }),
  upsertSession: (s) => set((st) => ({ sessions: { ...st.sessions, [s.id]: s } })),
  removeSession: (id) =>
    set((st) => {
      arriving.delete(id);
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
      if (!cur) {
        // 読み込み中なら取っておいて、読み終わった時に混ぜる。まだ開いていないセッションは、開いた時にまとめて取る
        const buf = arriving.get(item.sessionId);
        if (buf && !buf.some((t) => t.id === item.id)) {
          buf.push(item);
          if (buf.length > TIMELINE_CAP) buf.shift();
        }
        return st; // 何も変えない（同じ状態を返すと、見ている画面に知らせずに済む）
      }
      const ids = idsOf(cur);
      if (ids.has(item.id)) return st;
      const next = cur.length >= TIMELINE_CAP ? cur.slice(cur.length - TIMELINE_CAP + 1) : cur.slice();
      next.push(item);
      // id の一覧は新しい並びへ引き継ぐ（前の並びはもう使わない）。あふれて手放したものは一覧からも消す
      for (let i = 0; i < cur.length - next.length + 1; i++) ids.delete(cur[i].id);
      ids.add(item.id);
      idIndex.delete(cur);
      idIndex.set(next, ids);
      return { timelines: { ...st.timelines, [item.sessionId]: next } };
    }),
  loadingTimeline: (id) => {
    if (!arriving.has(id)) arriving.set(id, []);
  },
  setTimeline: (id, items) =>
    set((st) => {
      const merged = mergeTimeline(items, st.timelines[id] ?? [], arriving.get(id) ?? []);
      arriving.delete(id);
      return { timelines: { ...st.timelines, [id]: merged } };
    }),
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
