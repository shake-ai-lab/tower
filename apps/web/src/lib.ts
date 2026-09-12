import { useCallback, useEffect, useRef, useState } from 'react';
import { projectKey } from './project-key';
import type { ReportOutcome, RiskLevel, Session, SessionStatus } from '@tower/shared';

/** プロジェクト名から決まる色（同じ名前は常に同じ色）。一覧でどのプロジェクトのタスクか一目で分かるように */
export function projectHue(name: string): number {
  let h = 7;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % 360;
}

/** プロジェクト名の札（チップ）の色。文字・背景・枠を同じ色相で */
export function projectStyle(name: string): { color: string; background: string; borderColor: string } {
  const h = projectHue(projectKey(name));
  return { color: `hsl(${h} 70% 78%)`, background: `hsl(${h} 55% 32% / 0.45)`, borderColor: `hsl(${h} 55% 50% / 0.55)` };
}

/** PC 幅（Tailwind の md = 768px 以上）かどうか。パネルの幅指定はこの時だけ効かせる */
export function useDesktop(minWidth = 768): boolean {
  const [on, setOn] = useState(() => window.matchMedia(`(min-width: ${minWidth}px)`).matches);
  useEffect(() => {
    const mq = window.matchMedia(`(min-width: ${minWidth}px)`);
    const f = () => setOn(mq.matches);
    mq.addEventListener('change', f);
    return () => mq.removeEventListener('change', f);
  }, [minWidth]);
  return on;
}

/**
 * ドラッグで幅を変えられるパネル。幅は localStorage に残す。
 * side = パネルが画面のどちら側にあるか（左のパネルは右へ引くと広がり、右のパネルは左へ引くと広がる）
 */
export function useResizable(key: string, def: number, min: number, max: number, side: 'left' | 'right') {
  const ref = useRef<HTMLElement>(null);
  const endDrag = useRef<(() => void) | null>(null);
  const [actualWidth, setActualWidth] = useState(def);
  useEffect(() => {
    const observer = new ResizeObserver(() => { if (ref.current) setActualWidth(Math.round(ref.current.getBoundingClientRect().width)); });
    if (ref.current) observer.observe(ref.current);
    return () => { observer.disconnect(); endDrag.current?.(); };
  }, []);
  const limit = useCallback(() => {
    // 同じ横並び（data-resizable-root。無ければ親）の中の、ほかの幅を変えられる欄の分を引く。チャットは中央の枠の中にあるので親だけでは足りない
    const root = ref.current?.closest('[data-resizable-root]') ?? ref.current?.parentElement;
    const siblings = [...(root?.querySelectorAll<HTMLElement>('[data-resizable-panel]') ?? [])];
    const otherWidth = siblings.filter((el) => el !== ref.current && getComputedStyle(el).position !== 'fixed' && el.getBoundingClientRect().width > 0).reduce((sum, el) => sum + el.getBoundingClientRect().width, 0);
    return Math.max(min, Math.min(max, window.innerWidth - otherWidth - 320));
  }, [min, max]);
  const storageKey = `tower.width.${key}`;
  const [width, setWidth] = useState(() => {
    const v = Number(localStorage.getItem(storageKey));
    return v >= min && v <= max ? v : def;
  });
  useEffect(() => localStorage.setItem(storageKey, String(width)), [storageKey, width]);
  useEffect(() => {
    const reset = () => setWidth(def);
    window.addEventListener('tower:reset-widths', reset);
    return () => window.removeEventListener('tower:reset-widths', reset);
  }, [def]);

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      endDrag.current?.();
      const start = ref.current?.getBoundingClientRect().width ?? width;
      // 画面の 6 割より広くはしない（真ん中の一覧が消えないように）
      const cap = limit();
      const prevCursor = document.body.style.cursor;
      const prevSelect = document.body.style.userSelect;
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      const move = (ev: MouseEvent) => {
        const dx = ev.clientX - startX;
        setWidth(Math.max(min, Math.min(cap, start + (side === 'left' ? dx : -dx))));
      };
      const up = () => {
        document.body.style.cursor = prevCursor;
        document.body.style.userSelect = prevSelect;
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        window.removeEventListener('blur', up);
        endDrag.current = null;
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
      window.addEventListener('blur', up);
      endDrag.current = up;
    },
    [width, min, side, limit],
  );
  const reset = useCallback(() => setWidth(def), [def]);
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Home') { e.preventDefault(); reset(); }
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const delta = (e.key === 'ArrowRight' ? 20 : -20) * (side === 'left' ? 1 : -1);
    setWidth(Math.max(min, Math.min(limit(), (ref.current?.getBoundingClientRect().width ?? width) + delta)));
  };
  return { ref, width, actualWidth, onMouseDown, onKeyDown, reset };
}

/** 保存してあるパネルの幅を全部消す（設定の「元に戻す」）。次の描画で既定に戻る */
export function clearSavedWidths() {
  for (const k of Object.keys(localStorage)) if (k.startsWith('tower.width.')) localStorage.removeItem(k);
  window.dispatchEvent(new Event('tower:reset-widths'));
}

/** working = エージェントが手を動かしている最中（流れる帯・くるくる・波紋の点で目立たせる。index.css の working-*） */
export const STATUS: Record<SessionStatus, { label: string; dot: string; badge: string; attention?: boolean; working?: boolean }> = {
  starting: { label: '起動中', dot: 'bg-zinc-400 working-dot', badge: 'bg-zinc-700 text-zinc-200', working: true },
  running: { label: '作業中', dot: 'bg-sky-400 working-dot', badge: 'bg-sky-500 text-white font-semibold', working: true },
  waiting_permission: {
    label: '許可待ち',
    dot: 'bg-amber-400',
    badge: 'bg-amber-400 text-black font-semibold',
    attention: true,
  },
  waiting_question: {
    label: '質問あり',
    dot: 'bg-violet-400',
    badge: 'bg-violet-500 text-white font-semibold',
    attention: true,
  },
  idle: { label: '報告あり', dot: 'bg-emerald-400', badge: 'bg-emerald-900/70 text-emerald-200' },
  done: { label: '終了', dot: 'bg-zinc-500', badge: 'bg-zinc-800 text-zinc-300' },
  error: { label: 'エラー', dot: 'bg-red-500', badge: 'bg-red-900/70 text-red-200' },
  stopped: { label: '停止', dot: 'bg-zinc-500', badge: 'bg-zinc-800 text-zinc-300' },
};

export const OUTCOME: Record<ReportOutcome, { label: string; cls: string }> = {
  done: { label: '✅ 完了', cls: 'bg-emerald-900/70 text-emerald-200' },
  partial: { label: '⚠️ 一部完了', cls: 'bg-amber-900/70 text-amber-200' },
  failed: { label: '❌ 失敗', cls: 'bg-red-900/70 text-red-200' },
  question: { label: '❓ 質問あり', cls: 'bg-violet-900/70 text-violet-200' },
  unknown: { label: '📝 報告', cls: 'bg-zinc-800 text-zinc-300' },
};

export const RISK: Record<RiskLevel, { label: string; cls: string }> = {
  low: { label: '危険度 低', cls: 'bg-emerald-900/70 text-emerald-200' },
  mid: { label: '危険度 中', cls: 'bg-amber-900/70 text-amber-200' },
  high: { label: '危険度 高', cls: 'bg-red-600 text-white font-semibold' },
};

// 判断待ちかどうかの判定は task-state.ts（札・完了ボタン・畳み方と同じ所）にある
export { needsYou } from './task-state';

/** 判断待ちになった時刻（インボックスの並び順と「◯分前」用） */
export const needsYouSince = (s: Session): number => s.pending?.createdAt ?? s.report?.generatedAt ?? s.updatedAt;

export const ALIVE: SessionStatus[] =['starting', 'running', 'waiting_permission', 'waiting_question', 'idle'];
export const isAlive = (s: SessionStatus) => ALIVE.includes(s);

/** 裏取りの一言バッジ（一覧カードと「比べる」の表で共通）。修正前の結果があれば「直った / 壊れた / まだNG」 */
export function verifyBadge(s: Pick<Session, 'verification' | 'baseline'>): { text: string; cls: string } | null {
  const v = s.verification;
  if (!v) return null;
  if (v.ok === null) return { text: '⏳ 確認中', cls: 'bg-zinc-800 text-zinc-400' };
  if (v.ok) return { text: s.baseline?.ok === false ? '✔ 直った' : '✔ 裏取りOK', cls: 'bg-emerald-900/70 text-emerald-200' };
  return {
    text: s.baseline?.ok === true ? '✖ 壊れた' : s.baseline?.ok === false ? '✖ まだNG' : '✖ 裏取りNG',
    cls: 'bg-red-600 text-white font-semibold',
  };
}

export function fmtElapsed(from: number, to = Date.now()): string {
  const s = Math.max(0, Math.floor((to - from) / 1000));
  if (s < 60) return `${s}秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}分`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}時間${m % 60}分`;
  return `${Math.floor(h / 24)}日`;
}

export function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
}

/** トークン数を「1.2万」「3.4千」のように短く */
export function fmtTokens(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 10000) return `${(n / 1000).toFixed(1)}千`;
  if (n < 100000) return `${(n / 10000).toFixed(1)}万`;
  return `${Math.round(n / 10000)}万`;
}

/** 費用の目安。1 セント未満は「$0.01 未満」 */
export function fmtUsd(x: number): string {
  if (x <= 0) return '$0';
  if (x < 0.005) return '$0.01 未満';
  return `$${x.toFixed(2)}`;
}

/** 経過時間表示のために定期的に再描画する */
export function useTick(ms = 15000) {
  const [, set] = useState(0);
  useEffect(() => {
    const t = setInterval(() => set((x) => x + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
}

export const btn = {
  base: 'px-3 py-1.5 rounded-md text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed transition',
  primary: 'bg-sky-600 hover:bg-sky-500 text-white',
  success: 'bg-emerald-600 hover:bg-emerald-500 text-white',
  danger: 'bg-red-700 hover:bg-red-600 text-white',
  ghost: 'bg-zinc-800 hover:bg-zinc-700 text-zinc-200',
};
