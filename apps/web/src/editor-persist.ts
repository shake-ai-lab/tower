// 編集領域を、アプリの再起動・ページの読み直し・入れ直し（deploy）のあとも元に戻すための保存。
// この端末の localStorage に「どのファイルをどう並べていたか」と「保存していなかった書きかけ」を置く。
// 保存済みの中身はサーバーから読み直すので持たない。書きかけには読み込んだ時の中身の指紋を添え、
// その後ファイルが変わっていたら勝手には戻さない（戻すかどうかは利用者が選ぶ）。
import type { DeskRect } from './components/DeskWindowControls';

export type Layout = 'single' | 'columns' | 'rows' | 'desk';
export type SavedTab = { sessionId: string; path: string; pane: number };
export type SavedWorkspace = { tabs: SavedTab[]; selected: (string | null)[]; pane: number; layout: Layout; visible: boolean };
export type SavedDesk = { ratio: number; zoom: number; positions: Record<string, DeskRect>; restores: Record<string, DeskRect>; center: { x: number; y: number } };
export type Draft = { base: string; value: string; at: number };
export type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>;

const WORKSPACE = 'tower.editor.workspace', DESK = 'tower.editor.desk', DRAFT = 'tower.editor.draft:';
/** 書きかけを残すのは 30 ファイル・1 つ 100 万文字まで（localStorage は 5MB 前後しか無い） */
export const DRAFT_LIMITS = { files: 30, chars: 1_000_000 };
const LAYOUTS: Layout[] = ['single', 'columns', 'rows', 'desk'];

/** 開いているファイルの識別子。同じパスでもタスク（作業フォルダ）が違えば別物 */
export const fileKey = (sessionId: string, path: string) => JSON.stringify([sessionId, path]);

function storage(): Store | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}
function read(key: string, store: Store | null): unknown {
  try { const raw = store?.getItem(key); return raw ? JSON.parse(raw) : null; } catch { return null; }
}
function write(key: string, value: unknown, store: Store | null): boolean {
  if (!store) return false;
  try { store.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
}
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const clamp = (v: unknown, min: number, max: number, fallback: number) => finite(v) ? Math.max(min, Math.min(max, v)) : fallback;

export function loadWorkspace(store = storage()): SavedWorkspace | null {
  const v = read(WORKSPACE, store);
  if (!isObj(v) || !Array.isArray(v.tabs)) return null;
  const layout = LAYOUTS.includes(v.layout as Layout) ? v.layout as Layout : 'single';
  const seen = new Set<string>();
  const tabs = v.tabs.flatMap((t): SavedTab[] => {
    if (!isObj(t) || typeof t.sessionId !== 'string' || typeof t.path !== 'string' || !t.sessionId || !t.path) return [];
    const id = fileKey(t.sessionId, t.path);
    if (seen.has(id)) return [];
    seen.add(id);
    return [{ sessionId: t.sessionId, path: t.path, pane: layout !== 'single' && t.pane === 1 ? 1 : 0 }];
  });
  const saved = Array.isArray(v.selected) ? v.selected : [];
  // 選んでいたタブが無くなっていたら、そのグループの最後のタブを出す
  const selected = [0, 1].map((pane) => {
    const ids = tabs.filter((t) => t.pane === pane).map((t) => fileKey(t.sessionId, t.path));
    const id = saved[pane];
    return typeof id === 'string' && ids.includes(id) ? id : ids.at(-1) ?? null;
  });
  return { tabs, selected, pane: layout !== 'single' && v.pane === 1 ? 1 : 0, layout, visible: v.visible === true && tabs.length > 0 };
}

export const saveWorkspace = (ws: SavedWorkspace, store = storage()) => write(WORKSPACE, ws, store);

function rect(v: unknown): DeskRect | null {
  if (!isObj(v) || ![v.x, v.y, v.w, v.h, v.angle, v.z].every(finite) || (v.w as number) <= 0 || (v.h as number) <= 0) return null;
  const r: DeskRect = { x: v.x as number, y: v.y as number, w: v.w as number, h: v.h as number, angle: v.angle as number, z: v.z as number };
  if (finite(v.text)) r.text = clamp(v.text, .6, 2.5, 1);
  return r;
}
function rects(v: unknown): Record<string, DeskRect> {
  if (!isObj(v)) return {};
  return Object.fromEntries(Object.entries(v).flatMap(([id, r]) => { const ok = rect(r); return ok ? [[id, ok]] : []; }));
}

export function loadDesk(store = storage()): SavedDesk | null {
  const v = read(DESK, store);
  if (!isObj(v)) return null;
  const c = isObj(v.center) ? v.center : {};
  return {
    ratio: clamp(v.ratio, 20, 80, 50),
    zoom: clamp(v.zoom, .1, 2, 1),
    positions: rects(v.positions),
    restores: rects(v.restores),
    center: { x: finite(c.x) ? c.x : 0, y: finite(c.y) ? c.y : 0 },
  };
}

export const saveDesk = (desk: SavedDesk, store = storage()) => write(DESK, desk, store);

/** 中身の指紋（長さ + FNV-1a）。書きかけを取った時からファイルが変わったかを見るだけなので軽いもので足りる */
export function fingerprint(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return `${text.length}:${(h >>> 0).toString(16)}`;
}

export function readDraft(id: string, store = storage()): Draft | null {
  const v = read(DRAFT + id, store);
  return isObj(v) && typeof v.base === 'string' && typeof v.value === 'string' ? { base: v.base, value: v.value, at: finite(v.at) ? v.at : 0 } : null;
}

/** 書きかけを残す。大きすぎる・入りきらない時は、古い書きかけを戻してしまわないよう消して false */
export function writeDraft(id: string, original: string, value: string, store = storage(), now = Date.now()): boolean {
  const ok = value.length <= DRAFT_LIMITS.chars && write(DRAFT + id, { base: fingerprint(original), value, at: now } satisfies Draft, store);
  if (!ok) clearDraft(id, store);
  else pruneDrafts(store!);
  return ok;
}

export function clearDraft(id: string, store = storage()) {
  try { store?.removeItem(DRAFT + id); } catch { /* 消せなくても困らない */ }
}

export function draftIds(store = storage()): string[] {
  const ids: string[] = [];
  try {
    for (let i = 0; i < (store?.length ?? 0); i++) {
      const k = store!.key(i);
      if (k?.startsWith(DRAFT)) ids.push(k.slice(DRAFT.length));
    }
  } catch { /* 読めなければ空 */ }
  return ids;
}

/** 数が上限を超えたら古い書きかけから消す */
function pruneDrafts(store: Store) {
  const ids = draftIds(store);
  if (ids.length <= DRAFT_LIMITS.files) return;
  const old = ids.map((id) => ({ id, at: readDraft(id, store)?.at ?? 0 })).sort((a, b) => b.at - a.at).slice(DRAFT_LIMITS.files);
  for (const d of old) clearDraft(d.id, store);
}
