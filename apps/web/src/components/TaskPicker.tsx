// パネルに出すタスクを選ぶメニュー（4分割・集中）。ふつうの選択欄だと白地に薄い文字で読めず、同じプロジェクト名が
// 延々と並んで探しにくかったので、検索・プロジェクトごとのまとまり・状態と更新時刻の付いた一覧にしている
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import type { Session } from '@tower/shared';
import { STATUS, projectStyle } from '../lib';
import { ago, pickerGroups } from '../task-picker';
import { isFinished } from '../task-state';
import { ExternalTag, StatusBadge } from './SessionBadges';

export function TaskPicker({
  sessions,
  value,
  onChange,
  open,
  onOpenChange,
  label,
  allowEmpty = false,
  shownIn = {},
}: {
  sessions: Session[];
  value: string | null;
  onChange: (id: string | null) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  label: string;
  /** 「このパネルを空にする」を出す */
  allowEmpty?: boolean;
  /** ほかのパネルに出しているタスク（id → パネル番号） */
  shownIn?: Record<string, number>;
}) {
  const current = sessions.find((s) => s.id === value) ?? null;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const [q, setQ] = useState('');
  const [showFinished, setShowFinished] = useState(false);
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);

  const { groups, hiddenFinished } = useMemo(() => pickerGroups(sessions, q, showFinished), [sessions, q, showFinished]);
  const flat = useMemo(() => groups.flatMap((g) => g.sessions), [groups]);
  const active = Math.min(index, flat.length - 1);

  // 開いた時は検索を空にし、いま出しているタスクに印を合わせる（終わったタスクを出していればそれも見せる）
  useEffect(() => {
    if (!open) return;
    const finished = !!current && isFinished(current);
    setQ('');
    setShowFinished(finished);
    const at = pickerGroups(sessions, '', finished).groups.flatMap((g) => g.sessions).findIndex((s) => s.id === value);
    setIndex(Math.max(0, at));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // パネルは中身がはみ出さないよう切ってあるので、一覧は画面の一番上に重ねて出し、ボタンの位置に合わせる
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const r = triggerRef.current?.getBoundingClientRect();
      if (r) setRect(r);
    };
    const onScroll = (e: Event) => {
      if (!popRef.current?.contains(e.target as Node)) place();
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!popRef.current?.contains(t) && !triggerRef.current?.contains(t)) onOpenChange(false);
    };
    document.addEventListener('pointerdown', down, true);
    return () => document.removeEventListener('pointerdown', down, true);
  }, [open, onOpenChange]);

  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active, open, rect]);

  const close = () => {
    onOpenChange(false);
    triggerRef.current?.focus();
  };
  const choose = (id: string | null) => {
    onChange(id);
    close();
  };

  // 日本語の変換中の Enter は確定なので無視する
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'ArrowDown') setIndex(Math.min(flat.length - 1, active + 1));
    else if (e.key === 'ArrowUp') setIndex(Math.max(0, active - 1));
    else if (e.key === 'Enter') {
      if (flat[active]) choose(flat[active].id);
    } else if (e.key === 'Escape' || e.key === 'Tab') close();
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  let pos: CSSProperties = {};
  if (rect) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const width = Math.min(Math.max(rect.width, 600), vw - 16);
    const left = Math.min(Math.max(8, rect.left), vw - width - 8);
    const below = vh - rect.bottom - 12;
    const above = rect.top - 12;
    const up = below < 320 && above > below;
    pos = { left, width, maxHeight: Math.min(560, up ? above : below), ...(up ? { bottom: vh - rect.top + 4 } : { top: rect.bottom + 4 }) };
  }

  let n = 0;
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={current ? `${current.project.name} / ${current.title}` : undefined}
        onClick={() => onOpenChange(!open)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && !open) {
            e.preventDefault();
            onOpenChange(true);
          }
        }}
        className={`flex-1 min-w-0 flex items-center gap-2 rounded-md border px-2 py-1 text-left text-[13px] ${open ? 'border-sky-500 bg-sky-400/10' : 'border-zinc-700 bg-zinc-900/60 hover:border-zinc-500 hover:bg-zinc-800'}`}
      >
        {current ? (
          <>
            <span className="shrink-0 max-w-[40%] truncate rounded border px-1.5 text-[11px]" style={projectStyle(current.project.path)}>
              {current.project.name}
            </span>
            <span className="truncate text-zinc-100">{current.title}</span>
          </>
        ) : (
          <span className="text-sky-300">表示するタスクを選ぶ</span>
        )}
        <svg aria-hidden="true" viewBox="0 0 16 16" className={`ml-auto h-3.5 w-3.5 shrink-0 text-zinc-400 transition-transform ${open ? 'rotate-180' : ''}`}>
          <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open &&
        rect &&
        createPortal(
          <div ref={popRef} role="dialog" aria-label={label} style={pos} className="fixed z-[1000] flex flex-col overflow-hidden rounded-md border border-zinc-600 bg-[#161a22] shadow-2xl shadow-black/60">
            <div className="shrink-0 border-b border-zinc-800 p-2">
              <input
                autoFocus
                role="combobox"
                aria-expanded="true"
                aria-controls={listId}
                aria-activedescendant={flat[active] ? `${listId}-${flat[active].id}` : undefined}
                aria-label="タスクを探す"
                placeholder="タスク名・プロジェクト名で探す"
                value={q}
                onChange={(e) => {
                  setQ(e.target.value);
                  setIndex(0);
                }}
                onKeyDown={onKey}
                className="w-full rounded border border-zinc-700 bg-black/30 px-2 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-sky-500 focus:outline-none"
              />
            </div>

            <div ref={listRef} id={listId} role="listbox" aria-label="タスク" className="min-h-0 flex-1 overflow-y-auto pb-1">
              {groups.map((g) => (
                <div key={g.key} role="group" aria-label={g.project.name}>
                  <div className="sticky top-0 z-10 flex items-center gap-2 bg-[#161a22] px-3 pb-1 pt-2">
                    <span className="min-w-0 truncate rounded border px-1.5 py-0.5 text-[11px] font-semibold" style={projectStyle(g.project.path)} title={g.project.path}>
                      {g.project.name}
                    </span>
                    <span className="shrink-0 text-[11px] text-zinc-500">{g.sessions.length}件</span>
                  </div>
                  {g.sessions.map((s) => {
                    const i = n++;
                    const st = STATUS[s.status];
                    const here = s.id === value;
                    return (
                      <div
                        key={s.id}
                        id={`${listId}-${s.id}`}
                        role="option"
                        aria-selected={here}
                        data-active={i === active}
                        onMouseMove={() => i !== active && setIndex(i)}
                        onClick={() => choose(s.id)}
                        className={`mx-1 flex cursor-pointer items-center gap-2 rounded border-l-2 px-2 py-1.5 ${here ? 'border-sky-400' : 'border-transparent'} ${i === active ? 'bg-sky-400/15' : ''}`}
                      >
                        <span aria-hidden="true" className={`h-2 w-2 shrink-0 rounded-full ${st.dot}`} />
                        <span title={s.title} className={`min-w-0 flex-1 truncate text-[13px] ${here ? 'font-semibold text-sky-200' : isFinished(s) ? 'text-zinc-400' : 'text-zinc-100'}`}>
                          {s.title}
                        </span>
                        <ExternalTag s={s} />
                        {here ? (
                          <span className="shrink-0 text-[10px] text-sky-300">表示中</span>
                        ) : (
                          shownIn[s.id] && <span className="shrink-0 text-[10px] text-zinc-500">パネル{shownIn[s.id]}</span>
                        )}
                        <StatusBadge s={s} className="shrink-0 text-[10px]" />
                        <span className="w-12 shrink-0 text-right text-[10px] text-zinc-500">{ago(s.updatedAt)}</span>
                      </div>
                    );
                  })}
                </div>
              ))}
              {!flat.length && (
                <p className="px-3 py-3 text-sm text-zinc-400">{q ? `「${q}」に当てはまるタスクはありません` : '動いているタスクはありません'}</p>
              )}
            </div>

            <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-t border-zinc-800 px-3 py-1.5 text-[11px] text-zinc-500">
              {/* 押しても検索欄から離れないようにする（矢印キーでそのまま選べるように） */}
              {!q && (hiddenFinished > 0 || showFinished) && (
                <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => setShowFinished((v) => !v)} className="text-sky-300 hover:text-sky-200">
                  {showFinished ? '終わったタスクを隠す' : `終わったタスク ${hiddenFinished}件も表示`}
                </button>
              )}
              {allowEmpty && value && (
                <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => choose(null)} className="text-zinc-400 hover:text-zinc-200">
                  このパネルを空にする
                </button>
              )}
              <span className="ml-auto">↑↓ で選ぶ · Enter で決定 · Esc で閉じる</span>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
