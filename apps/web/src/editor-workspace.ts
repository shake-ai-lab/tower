import { create } from 'zustand';

export type OpenFile = { id: string; sessionId: string; path: string; pane: number; dirty: boolean; onSaved?: () => void };
type Workspace = {
  files: OpenFile[]; selected: (string | null)[]; pane: number; visible: boolean;
  layout: 'single' | 'columns' | 'rows' | 'desk';
  open: (sessionId: string, path: string, onSaved?: () => void) => void;
  close: (id: string) => void;
  dirty: (id: string, dirty: boolean) => void;
  activate: (id: string) => void;
  split: (layout: Workspace['layout']) => void;
  move: (id: string) => void;
};
export const useEditorWorkspace = create<Workspace>((set, get) => ({
  files: [], selected: [null, null], pane: 0, visible: false, layout: 'single',
  open: (sessionId, path, onSaved) => {
    const id = JSON.stringify([sessionId, path]);
    const s = get();
    const file = s.files.find((f) => f.id === id);
    const pane = file?.pane ?? s.pane;
    set({ visible: true, pane, files: file ? s.files : [...s.files, { id, sessionId, path, pane, dirty: false, onSaved }], selected: s.selected.map((v, i) => i === pane ? id : v) });
  },
  close: (id) => {
    const s = get();
    const file = s.files.find((f) => f.id === id);
    if (file?.dirty && !confirm(`${file.path}\n保存していない変更を破棄して閉じますか？`)) return;
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
}));
