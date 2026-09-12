import { create } from 'zustand';
import { clearDraft, fileKey, loadWorkspace, saveWorkspace, type Layout } from './editor-persist';

/** 開いた時に見せる場所（検索結果から開いた時など）。at が変わるたびにそこへ移る */
export type Reveal = { line: number; column: number; length: number; at: number };
export type OpenFile = { id: string; sessionId: string; path: string; pane: number; dirty: boolean; onSaved?: () => void; reveal?: Reveal; focusRequest?: number };
type Workspace = {
  files: OpenFile[]; selected: (string | null)[]; pane: number; visible: boolean;
  layout: Layout;
  open: (sessionId: string, path: string, onSaved?: () => void, at?: { line: number; column?: number; length?: number }) => void;
  close: (id: string) => void;
  dirty: (id: string, dirty: boolean) => void;
  activate: (id: string) => void;
  split: (layout: Workspace['layout']) => void;
  move: (id: string) => void;
  /** 消えたタスクのタブを閉じる（一覧が届いた時・タスクを消した時） */
  prune: (alive: Set<string>) => void;
};

// 前回の並べ方から始める（中身と書きかけは、各タブが開く時にサーバーと端末から読み直す）
const saved = loadWorkspace();
const initial: Pick<Workspace, 'files' | 'selected' | 'pane' | 'visible' | 'layout'> = saved
  ? { files: saved.tabs.map((t) => ({ id: fileKey(t.sessionId, t.path), sessionId: t.sessionId, path: t.path, pane: t.pane, dirty: false })), selected: saved.selected, pane: saved.pane, visible: saved.visible, layout: saved.layout }
  : { files: [], selected: [null, null], pane: 0, visible: false, layout: 'single' };

export const useEditorWorkspace = create<Workspace>((set, get) => ({
  ...initial,
  open: (sessionId, path, onSaved, at) => {
    const id = fileKey(sessionId, path);
    const s = get();
    const file = s.files.find((f) => f.id === id);
    const pane = file?.pane ?? s.pane;
    const reveal = at ? { line: at.line, column: at.column ?? 1, length: at.length ?? 0, at: Date.now() } : undefined;
    // 同じファイルを Ctrl+P で選び直した場合も、入力先を本文へ戻す。
    const focusRequest = (file?.focusRequest ?? 0) + 1;
    const files = file
      ? s.files.map((f) => f.id === id ? { ...f, reveal: reveal ?? f.reveal, onSaved: onSaved ?? f.onSaved, focusRequest } : f)
      : [...s.files, { id, sessionId, path, pane, dirty: false, onSaved, reveal, focusRequest }];
    set({ visible: true, pane, files, selected: s.selected.map((v, i) => i === pane ? id : v) });
  },
  close: (id) => {
    const s = get();
    const file = s.files.find((f) => f.id === id);
    if (file?.dirty && !confirm(`${file.path}\n保存していない変更を破棄して閉じますか？`)) return;
    clearDraft(id);
    const files = s.files.filter((f) => f.id !== id);
    set({ files, visible: files.length > 0 && s.visible, selected: s.selected.map((v, i) => v === id ? files.filter((f) => f.pane === i).at(-1)?.id ?? null : v) });
  },
  dirty: (id, dirty) => set((s) => s.files.find((f) => f.id === id)?.dirty === dirty ? s : ({ files: s.files.map((f) => f.id === id ? { ...f, dirty } : f) })),
  activate: (id) => {
    const s = get(), f = s.files.find((f) => f.id === id);
    if (f) set({ pane: f.pane, selected: s.selected.map((v, i) => i === f.pane ? id : v) });
  },
  split: (layout) => {
    const s = get();
    if (layout === 'desk') { set({ layout }); return; }
    if (layout === 'single') set({ layout, pane: 0, files: s.files.map((f) => ({ ...f, pane: 0 })), selected: [s.selected[s.pane] ?? s.selected[0] ?? s.selected[1], null] });
    else {
      set({ layout });
      if (s.layout === 'single') {
        const candidate = s.files.find((f) => f.id !== s.selected[0]);
        if (candidate) get().move(candidate.id);
        else set({ pane: 1 });
      }
    }
  },
  move: (id) => {
    const s = get(), file = s.files.find((f) => f.id === id);
    if (!file) return;
    const pane = 1 - file.pane;
    const files = s.files.map((f) => f.id === id ? { ...f, pane } : f);
    set({ files, layout: s.layout === 'single' ? 'columns' : s.layout, pane, selected: s.selected.map((v, i) => i === pane ? id : v === id ? files.find((f) => f.pane === i)?.id ?? null : v) });
  },
  prune: (alive) => {
    const s = get();
    const gone = s.files.filter((f) => !alive.has(f.sessionId));
    if (!gone.length) return;
    for (const f of gone) clearDraft(f.id); // タスクごと消えたので、作業フォルダも書きかけの行き先も無い
    const files = s.files.filter((f) => alive.has(f.sessionId));
    set({ files, visible: files.length > 0 && s.visible, selected: s.selected.map((v, i) => v && files.some((f) => f.id === v) ? v : files.filter((f) => f.pane === i).at(-1)?.id ?? null) });
  },
}));

// 並べ方が変わるたびに端末へ残す（開いているタブ・分割・選んでいるタブ・表示中か）
useEditorWorkspace.subscribe((s, prev) => {
  if (s.files === prev.files && s.selected === prev.selected && s.pane === prev.pane && s.layout === prev.layout && s.visible === prev.visible) return;
  saveWorkspace({ tabs: s.files.map(({ sessionId, path, pane }) => ({ sessionId, path, pane })), selected: s.selected, pane: s.pane, layout: s.layout, visible: s.visible });
});
