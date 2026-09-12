import { useMemo } from 'react';
import type { Session } from '@tower/shared';
import { useStore } from '../store';
import { PendingCard } from './PendingCards';
import { btn, fmtElapsed, needsYou, needsYouSince } from '../lib';

/** 報告の中で判断を求めて止まっているもの。答えは詳細の「追加の指示」から送る */
function ReportDecisionCard({ s }: { s: Session }) {
  const select = useStore((st) => st.select);
  const r = s.report!;
  return (
    <div className="rounded-md border border-amber-400/50 bg-amber-400/10 p-2.5 space-y-2 text-sm">
      <div className="text-[11px] text-amber-200/80">報告の中で、あなたの判断を求めています</div>
      <div className="leading-relaxed whitespace-pre-wrap break-words">
        {r.needsDecision ?? r.summary[0] ?? '報告を見て、続きの指示を出してください'}
      </div>
      {r.nextStep && (
        <div className="text-xs text-zinc-400 leading-relaxed break-words">
          <span className="text-zinc-500">エージェントの提案: </span>
          {r.nextStep}
        </div>
      )}
      <button onClick={() => select(s.id)} className={`${btn.base} ${btn.primary} !py-1 !text-xs`}>
        開いて答える
      </button>
    </div>
  );
}

export function Inbox({ className = '', embedded = false }: { className?: string; embedded?: boolean }) {
  const sessions = useStore((s) => s.sessions);
  const select = useStore((s) => s.select);
  const waiting = useMemo(
    () =>
      Object.values(sessions)
        .filter(needsYou)
        .sort((a, b) => needsYouSince(a) - needsYouSince(b)),
    [sessions],
  );

  return (
    <aside className={`${embedded ? 'w-full' : 'w-full md:w-[400px] shrink-0 md:border-r'} border-zinc-800 overflow-y-auto p-2 space-y-2 bg-[#0c0e12] ${className}`}>
      <h2 className="flex items-center gap-2 text-sm font-semibold text-zinc-300 px-1">
        判断インボックス
        <span
          className={`text-xs px-2 py-0.5 rounded-full ${waiting.length ? 'bg-amber-400 text-black' : 'bg-zinc-800 text-zinc-400'}`}
        >
          {waiting.length}
        </span>
      </h2>

      {waiting.length === 0 && (
        <p className="text-sm text-zinc-500 px-1 leading-relaxed">
          今あなたを待っているエージェントはいません。
          <br />
          許可や質問、報告で判断を求められたものがここに並びます。
        </p>
      )}

      {waiting.map((s) => (
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
              {fmtElapsed(needsYouSince(s))}前
            </span>
          </button>
          {s.pending ? <PendingCard session={s} /> : <ReportDecisionCard s={s} />}
        </div>
      ))}
    </aside>
  );
}
