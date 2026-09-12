import { useEffect, useState } from 'react';
import type { Session } from '@tower/shared';
import { useStore } from '../store';
import { SessionDetail } from './SessionDetail';
import { StatusBadge } from './SessionBadges';

export function MultiSessionView({ sessions, single = false }: { sessions: Session[]; single?: boolean }) {
  const selectedId = useStore((s) => s.selectedId);
  const select = useStore((s) => s.select);
  const [activeSlot, setActiveSlot] = useState(0);
  const [slots, setSlots] = useState<(string | null)[]>(() => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem('tower.quad-slots') ?? 'null');
      if (Array.isArray(saved) && saved.length === 4 && saved.every((id) => id === null || typeof id === 'string')) return saved;
    } catch { /* use the initial tasks if old preferences are invalid */ }
    return Array.from({ length: 4 }, (_, i) => sessions[i]?.id ?? null);
  });
  useEffect(() => { if (!single) localStorage.setItem('tower.quad-slots', JSON.stringify(slots)); }, [slots, single]);
  const ids = single ? [sessions.some((s) => s.id === selectedId) ? selectedId : sessions[0]?.id ?? null] : slots;
  return <div className={single ? 'h-full min-h-0' : 'multi-session-grid'} aria-label={single ? '集中ビュー' : '4分割ビュー'}>
    {ids.map((candidate, i) => {
      const id = sessions.some((s) => s.id === candidate) ? candidate : null;
      return <div key={i} aria-label={`パネル${i + 1}${id && i === activeSlot && id === selectedId ? ' 選択中' : ''}`} className={`session-pane h-full min-h-0 min-w-0 flex flex-col border-2 ${id && i === activeSlot && id === selectedId ? 'border-sky-400' : 'border-zinc-600'} overflow-hidden bg-[#0c0e12]`} onFocusCapture={() => { setActiveSlot(i); if (id) select(id); }} onPointerDown={() => { setActiveSlot(i); if (id) select(id); }}>
        <div className="shrink-0 flex items-center gap-2 px-3 py-2 border-b border-zinc-800 bg-[#171c25]">
          <span className="text-[10px] text-sky-300 mono">{single ? 'FOCUS' : `0${i + 1}`}</span>
          <select aria-label={single ? '集中するタスク' : `パネル${i + 1}のタスク`} className="flex-1 min-w-0 bg-transparent text-xs text-zinc-200 py-1" value={id ?? ''} onChange={(e) => {
            const next = e.target.value || null;
            if (single) select(next);
            else setSlots((cur) => cur.map((v, index) => index === i ? next : v));
            if (next) select(next);
          }}>
            {!single && <option value="">タスクを選択</option>}
            {sessions.map((s) => <option key={s.id} value={s.id}>{s.project.name} / {s.title}</option>)}
          </select>
          {id && <StatusBadge status={sessions.find((s) => s.id === id)!.status} className="text-[10px] shrink-0" />}
        </div>
        <div className="flex-1 min-h-0 min-w-0">{id ? <SessionDetail key={id} id={id} embedded /> : <div className="h-full flex items-center justify-center p-4 text-xs text-zinc-500">上のメニューから表示するタスクを選択</div>}</div>
      </div>;
    })}
  </div>;
}
