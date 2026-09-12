// 画面の構成。「左の欄」（判断待ち・ファイル・検索・Git・設定）を出すか、中央に何を出すか、右に「チャット」を並べるかを
// 別々に切り替えられる。4分割・集中のパネルに出しているタスクもここで持つ。どれもこの端末（localStorage）に残す。
// タスクを開く操作（判断待ちの「答える」など）は openTask を通す。いまの構成で実際に見える場所へタスクを出すため
// （4分割でチャットを隠していると、選ぶだけでは画面のどこにも出なかった。#99b25c）
import { create } from 'zustand';
import type { Layout as EditorLayout } from './editor-persist';
import { useStore } from './store';
import { useEditorWorkspace } from './editor-workspace';

export type Main = 'files' | 'cards' | 'compact' | 'focus' | 'quad';
export type ScreenLayout = { sidebar: boolean; main: Main; chat: boolean };
/** 中央の切り替えボタン。自由配置は「ファイル」の並べ方の 1 つだが、よく使うので中央の選択肢として並べる */
export type Segment = 'files' | 'desk' | Exclude<Main, 'files'>;
/**
 * 開いたタスクをどこに出したか。at は開くたびに増える番号、ts は時刻（後から出した欄が古い合図に反応しないように）。
 * answer = 「答える」から来たので、指示欄にすぐ書けるようにする
 */
export type Reveal = { id: string; at: number; ts: number; target: 'chat' | 'panes'; answer: boolean };
type Store = Pick<Storage, 'getItem' | 'setItem'>;

export const SEGMENTS: { value: Segment; label: string; hint: string }[] = [
  { value: 'files', label: '開いたファイル', hint: '開いたファイルをタブで表示します。左右・上下に分けて見比べることもできます。' },
  { value: 'desk', label: '自由配置', hint: '開いたファイルを窓のように、好きな位置・大きさで並べます。' },
  { value: 'cards', label: 'カード', hint: 'プロジェクトごとにタスクを見渡します。普段の進み具合の確認に。' },
  { value: 'compact', label: 'コンパクト', hint: 'タスクを短い行で一覧します。タスクが多い時に。' },
  { value: 'focus', label: '集中', hint: '1つのタスクを大きく表示します。' },
  { value: 'quad', label: '4分割', hint: '4つのタスクを並べ、それぞれのパネルから指示できます。' },
];
const MAINS: Main[] = ['files', 'cards', 'compact', 'focus', 'quad'];
export const PANES = 4;
/** チャットを横に並べられる幅（これより狭い時、カード・コンパクトはタスクを選ぶと詳細を画面いっぱいに重ねる） */
export const CHAT_SIDE_WIDTH = 1100;
export const DEFAULT_LAYOUT: ScreenLayout = { sidebar: true, main: 'cards', chat: true };

const KEY = 'tower.layout', OLD_VIEW = 'tower.view', SLOTS = 'tower.quad-slots', FOCUS = 'tower.focus-task';

function storage(): Store | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}
function read(key: string, store: Store | null): unknown {
  try { const raw = store?.getItem(key); return raw ? JSON.parse(raw) : null; } catch { return null; }
}
function write(key: string, value: unknown, store: Store | null) {
  try { store?.setItem(key, JSON.stringify(value)); } catch { /* 残せなくても画面は動く */ }
}
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export function loadLayout(store = storage()): ScreenLayout {
  const v = read(KEY, store);
  if (isObj(v) && MAINS.includes(v.main as Main)) return { sidebar: v.sidebar !== false, main: v.main as Main, chat: v.chat !== false };
  // 前の版は「表示パターン」を 1 つだけ覚えていた。editor = ファイル＋チャット。集中・4分割はパネルの中で指示できたのでチャット無し
  let old: string | null = null;
  try { old = store?.getItem(OLD_VIEW) ?? null; } catch { /* 読めなければ既定 */ }
  if (old === 'editor') return { sidebar: true, main: 'files', chat: true };
  if (old === 'focus' || old === 'quad') return { sidebar: true, main: old, chat: false };
  if (old === 'cards' || old === 'compact') return { sidebar: true, main: old, chat: true };
  return { ...DEFAULT_LAYOUT };
}

/** 4分割に出していたタスク。残っていなければ null（最初に開いた時に上から 4 つを入れる） */
export function loadSlots(store = storage()): (string | null)[] | null {
  const v = read(SLOTS, store);
  return Array.isArray(v) && v.length === PANES && v.every((id) => id === null || typeof id === 'string') ? v : null;
}

export const segmentOf = (main: Main, editorLayout: EditorLayout): Segment => (main === 'files' ? (editorLayout === 'desk' ? 'desk' : 'files') : main);

/** 「左の欄 ＋ カード ＋ チャット」のように、いまの構成を言葉にする（画面の案内と「気づいたこと」の場面に使う） */
export function describeLayout(l: ScreenLayout, editorLayout: EditorLayout): string {
  const center = SEGMENTS.find((s) => s.value === segmentOf(l.main, editorLayout))!.label;
  return [l.sidebar && '左の欄', center, l.chat && 'チャット'].filter(Boolean).join(' ＋ ');
}

/** recent（古い → 新しい）の最後に i を移す */
export function touch(recent: number[], i: number): number[] {
  return [...recent.filter((x) => x !== i), i];
}

/** 4分割のどのパネルに出すか: もう出ていればそこ、空き（消えたタスクの跡も空き）があれば最初の空き、無ければ一番長く触っていないパネル */
export function slotFor(slots: (string | null)[], id: string, recent: number[], alive: (id: string) => boolean): number {
  const at = slots.indexOf(id);
  if (at >= 0) return at;
  const empty = slots.findIndex((v) => !v || !alive(v));
  if (empty >= 0) return empty;
  return recent.find((i) => i >= 0 && i < slots.length) ?? 0;
}

type PanesState = Pick<LayoutState, 'main' | 'chat' | 'slots' | 'focusId' | 'activeSlot' | 'recent'>;
export type OpenPlan = Omit<PanesState, 'main'> & { target: Reveal['target'] };

/**
 * タスクを開く時にどこへ出すか。
 * - 4分割・集中: もうパネルに出ていればそのパネル。チャットを横に並べていればチャット。どちらでもなければパネルに入れる
 * - カード・コンパクト・ファイル: チャットに出す（隠していたら出す。自分で押して開いたので、見える所に出すのが先）
 * wide = チャットを横に並べられる幅か（狭い時、4分割・集中はチャットを出さない）
 */
export function planOpen(s: PanesState, id: string, wide: boolean, alive: (id: string) => boolean): OpenPlan {
  const { main, chat, slots, focusId, activeSlot, recent } = s;
  const keep = { chat, slots, focusId, activeSlot, recent };
  if (main === 'quad') {
    const shown = slots.indexOf(id);
    if (shown >= 0) return { ...keep, activeSlot: shown, recent: touch(recent, shown), target: 'panes' };
    if (chat && wide) return { ...keep, target: 'chat' };
    const i = slotFor(slots, id, recent, alive);
    return { ...keep, slots: slots.map((v, j) => (j === i ? id : v)), activeSlot: i, recent: touch(recent, i), target: 'panes' };
  }
  if (main === 'focus') {
    if (focusId === id || !(chat && wide)) return { ...keep, focusId: id, target: 'panes' };
    return { ...keep, target: 'chat' };
  }
  return { ...keep, chat: true, target: 'chat' };
}

type LayoutState = ScreenLayout & {
  /** 4分割の各パネルのタスク */
  slots: (string | null)[];
  /** 4分割を一度でも決めたか（まだなら最初に上から 4 つを入れる） */
  slotsSaved: boolean;
  /** 集中で大きく出しているタスク */
  focusId: string | null;
  /** 4分割で最後に触ったパネル */
  activeSlot: number;
  /** 4分割のパネルを触った順（古い → 新しい）。空きが無い時に入れ替える先を決める */
  recent: number[];
  reveal: Reveal | null;
  /** 判断待ちを左の欄に出してほしい、という合図（変わるたびに左の欄が「判断待ち」に切り替わる） */
  inboxAt: number;
  /** ファイルを開いて中央がファイルになる前の表示（「タスクに戻る」の行き先） */
  returnTo: Main | null;
  /** スマホ幅の下のタブ（判断待ち＝左の欄 / セッション＝中央）。PC では両方見えるので関係ない */
  mobileTab: 'inbox' | 'list';
  setSidebar: (on: boolean) => void;
  setChat: (on: boolean) => void;
  setMain: (main: Main) => void;
  setSlot: (i: number, id: string | null) => void;
  fillSlots: (ids: string[]) => void;
  setFocus: (id: string | null) => void;
  activate: (i: number) => void;
  showInbox: () => void;
};

const saved = loadLayout();
const savedSlots = loadSlots();
let savedFocus: string | null = null;
try { savedFocus = storage()?.getItem(FOCUS) ?? null; } catch { /* 無ければ選んでいるタスク */ }

export const useLayout = create<LayoutState>((set, get) => ({
  ...saved,
  slots: savedSlots ?? Array.from({ length: PANES }, () => null),
  slotsSaved: !!savedSlots,
  focusId: savedFocus,
  activeSlot: 0,
  recent: Array.from({ length: PANES }, (_, i) => i),
  reveal: null,
  inboxAt: 0,
  returnTo: null,
  mobileTab: 'inbox',
  setSidebar: (sidebar) => set({ sidebar }),
  setChat: (chat) => set({ chat }),
  setMain: (main) => {
    const cur = get();
    set({ main, returnTo: main === 'files' ? (cur.main === 'files' ? cur.returnTo : cur.main) : null });
    // 中央がファイルの時だけ編集領域を出す（ショートカットもこの印を見る）
    if (useEditorWorkspace.getState().visible !== (main === 'files')) useEditorWorkspace.setState({ visible: main === 'files' });
  },
  setSlot: (i, id) => set((s) => ({ slots: s.slots.map((v, j) => (j === i ? id : v)), slotsSaved: true })),
  fillSlots: (ids) => set({ slots: Array.from({ length: PANES }, (_, i) => ids[i] ?? null), slotsSaved: true }),
  setFocus: (focusId) => set((s) => (s.focusId === focusId ? s : { focusId })),
  activate: (i) => set((s) => (s.activeSlot === i && s.recent.at(-1) === i ? s : { activeSlot: i, recent: touch(s.recent, i) })),
  showInbox: () => set((s) => ({ sidebar: true, inboxAt: s.inboxAt + 1, mobileTab: 'inbox' })),
}));

useLayout.subscribe((s, p) => {
  const store = storage();
  if (s.sidebar !== p.sidebar || s.main !== p.main || s.chat !== p.chat) write(KEY, { sidebar: s.sidebar, main: s.main, chat: s.chat }, store);
  if (s.slots !== p.slots && s.slotsSaved) write(SLOTS, s.slots, store);
  if (s.focusId !== p.focusId) {
    try { if (s.focusId) store?.setItem(FOCUS, s.focusId); } catch { /* 残せなくても困らない */ }
  }
});

/** 判断待ち・カード・「見る」などからタスクを開く。いまの構成で見える場所に出して選ぶ */
export function openTask(id: string, opts: { answer?: boolean } = {}) {
  const sessions = useStore.getState().sessions;
  const wide = typeof matchMedia === 'function' && matchMedia(`(min-width: ${CHAT_SIDE_WIDTH}px)`).matches;
  const cur = useLayout.getState();
  const { target, ...plan } = planOpen(cur, id, wide, (x) => !!sessions[x]);
  useLayout.setState({
    ...plan,
    slotsSaved: cur.slotsSaved || plan.slots !== cur.slots,
    // スマホ幅でパネルに出した時は、同じ更新で中央のタブへ切り替える（隠れたままだと指示欄に入力できない）
    ...(target === 'panes' ? { mobileTab: 'list' as const } : {}),
    reveal: { id, at: (cur.reveal?.at ?? 0) + 1, ts: Date.now(), target, answer: !!opts.answer },
  });
  useStore.getState().select(id);
}
