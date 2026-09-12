import { useEffect, useRef, useState } from 'react';
import type { Session } from '@tower/shared';
import { useStore } from '../store';
import { btn } from '../lib';
import { useLayout } from '../layout';
import { SessionDetail } from './SessionDetail';
import { StatusBadge } from './SessionBadges';
import { TaskPicker } from './TaskPicker';

/**
 * 4分割（single = false）と集中（single = true）。どのパネルに何を出すかは layout.ts が持つ（この端末に残る）。
 * chatShown = 右にチャットを並べているか。並べていない集中は、選んだタスクをそのまま大きく出す
 */
export function MultiSessionView({ sessions, single = false, chatShown = false }: { sessions: Session[]; single?: boolean; chatShown?: boolean }) {
  const selectedId = useStore((s) => s.selectedId);
  const select = useStore((s) => s.select);
  const slots = useLayout((s) => s.slots);
  const slotsSaved = useLayout((s) => s.slotsSaved);
  const focusId = useLayout((s) => s.focusId);
  const activeSlot = useLayout((s) => s.activeSlot);
  const reveal = useLayout((s) => s.reveal);
  /** タスク選びの一覧を開いているパネル */
  const [openSlot, setOpenSlot] = useState<number | null>(null);
  /** 開いたばかりで光らせているパネル */
  const [flash, setFlash] = useState<number | null>(null);
  const panes = useRef<(HTMLDivElement | null)[]>([]);
  const alive = (id: string | null | undefined): id is string => !!id && sessions.some((s) => s.id === id);

  // 初めて 4分割を開いた時は、上から 4 つ（判断待ち・作業中が先）を並べる
  useEffect(() => {
    if (!single && !slotsSaved && sessions.length) useLayout.getState().fillSlots(sessions.slice(0, 4).map((s) => s.id));
  }, [single, slotsSaved, sessions]);
  // 集中: チャットを横に並べていない時は、選んだタスクをそのまま大きく出す（並べている時は選び直すまで動かさない）
  useEffect(() => {
    if (single && !chatShown && selectedId) useLayout.getState().setFocus(selectedId);
  }, [single, chatShown, selectedId]);
  const focus = alive(focusId) ? focusId : alive(selectedId) ? selectedId : sessions[0]?.id ?? null;
  useEffect(() => {
    if (single && focus && focus !== focusId) useLayout.getState().setFocus(focus);
  }, [single, focus, focusId]);
  const ids = single ? [focus] : slots;

  // タスクを開いた（判断待ちの「答える」など）ら、出したパネルを見える所へ動かして光らせる
  const handled = useRef(0);
  useEffect(() => {
    if (!reveal || reveal.target !== 'panes' || handled.current === reveal.at || Date.now() - reveal.ts > 2000) return;
    handled.current = reveal.at;
    const i = single ? 0 : useLayout.getState().activeSlot;
    const el = panes.current[i];
    el?.scrollIntoView({ block: 'nearest' });
    setFlash(i);
    if (reveal.answer) requestAnimationFrame(() => el?.querySelector<HTMLTextAreaElement>('footer textarea:not(:disabled)')?.focus());
  }, [reveal, single]);
  useEffect(() => {
    if (flash === null) return;
    const t = setTimeout(() => setFlash(null), 1500);
    return () => clearTimeout(t);
  }, [flash]);

  const activate = (i: number, id: string | null) => {
    if (!single) useLayout.getState().activate(i);
    if (id) select(id);
  };

  return <div className={single ? 'h-full min-h-0' : 'multi-session-grid'} aria-label={single ? '集中ビュー' : '4分割ビュー'}>
    {ids.map((candidate, i) => {
      const id = alive(candidate) ? candidate : null;
      const current = !!id && id === selectedId && (single || i === activeSlot);
      // ほかのパネルに出しているもの（一覧で「パネル2」のように添える）
      const shownIn: Record<string, number> = {};
      if (!single) slots.forEach((v, j) => { if (v && j !== i) shownIn[v] = j + 1; });
      return <div key={i} ref={(el) => { panes.current[i] = el; }} aria-label={`パネル${i + 1}${current ? ' 選択中' : ''}`}
        className={`session-pane h-full min-h-0 min-w-0 flex flex-col border-2 ${current ? 'border-sky-400' : 'border-zinc-600'} ${flash === i ? 'reveal-flash' : ''} overflow-hidden bg-[#0c0e12]`}
        onFocusCapture={() => activate(i, id)} onPointerDown={() => activate(i, id)}>
        <div className="shrink-0 flex items-center gap-2 px-3 py-2 border-b border-zinc-800 bg-[#171c25]">
          <span className="text-[10px] text-sky-300 mono">{single ? 'FOCUS' : `0${i + 1}`}</span>
          <TaskPicker
            label={single ? '集中するタスク' : `パネル${i + 1}のタスク`}
            sessions={sessions}
            value={id}
            open={openSlot === i}
            onOpenChange={(open) => setOpenSlot(open ? i : null)}
            allowEmpty={!single}
            shownIn={shownIn}
            onChange={(next) => {
              if (single) useLayout.getState().setFocus(next);
              else useLayout.getState().setSlot(i, next);
              if (next) activate(i, next);
            }}
          />
          {id && <StatusBadge status={sessions.find((s) => s.id === id)!.status} className="text-[10px] shrink-0" />}
        </div>
        <div className="flex-1 min-h-0 min-w-0">{id ? <SessionDetail key={id} id={id} embedded /> : (
          <div className="h-full flex flex-col items-center justify-center gap-3 p-4 text-center">
            <p className="text-sm text-zinc-400">このパネルは空いています</p>
            <button type="button" onClick={() => setOpenSlot(i)} className={`${btn.base} ${btn.primary}`}>表示するタスクを選ぶ</button>
          </div>
        )}</div>
      </div>;
    })}
  </div>;
}
