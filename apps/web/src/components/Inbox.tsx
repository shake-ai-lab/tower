import { useMemo } from 'react';
import { useStore } from '../store';
import { PendingCard } from './PendingCards';
import { fmtElapsed } from '../lib';

export function Inbox({ className = '', embedded = false }: { className?: string; embedded?: boolean }) {
  const sessions = useStore((s) => s.sessions);
  const select = useStore((s) => s.select);
  const pending = useMemo(
    () =>
      Object.values(sessions)
        .filter((s) => s.pending)
        .sort((a, b) => a.pending!.createdAt - b.pending!.createdAt),
    [sessions],
  );

  return (
    <aside className={`${embedded ? 'w-full' : 'w-full md:w-[400px] shrink-0 md:border-r'} border-zinc-800 overflow-y-auto p-2 space-y-2 bg-[#0c0e12] ${className}`}>
      <h2 className="flex items-center gap-2 text-sm font-semibold text-zinc-300 px-1">
        判断インボックス
        <span
          className={`text-xs px-2 py-0.5 rounded-full ${pending.length ? 'bg-amber-400 text-black' : 'bg-zinc-800 text-zinc-400'}`}
        >
          {pending.length}
        </span>
      </h2>

      {pending.length === 0 && (
        <p className="text-sm text-zinc-500 px-1 leading-relaxed">
          今あなたを待っているエージェントはいません。
          <br />
          許可や質問が来るとここに並びます。
        </p>
      )}

      {pending.map((s) => (
        <div key={s.id} className="space-y-1.5">
          <button
            onClick={() => select(s.id)}
            className="w-full text-left px-1 text-xs text-zinc-400 hover:text-zinc-200 flex justify-between gap-2"
          >
            <span className="truncate">
              <span className="font-semibold text-zinc-300">{s.project.name}</span> · {s.title}
            </span>
            <span className="shrink-0">
              {(s.pendingCount ?? 1) > 1 && <span className="text-amber-300 mr-2">他 {(s.pendingCount ?? 1) - 1} 件</span>}
              {fmtElapsed(s.pending!.createdAt)}前
            </span>
          </button>
          <PendingCard session={s} />
        </div>
      ))}
    </aside>
  );
}
