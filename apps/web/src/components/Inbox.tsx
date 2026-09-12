import { useMemo } from 'react';
import type { Session } from '@tower/shared';
import { useStore } from '../store';
import { openTask } from '../layout';
import { PendingCard } from './PendingCards';
import { btn, fmtElapsed, needsYou, needsYouSince } from '../lib';

/** 報告の中で判断を求めて止まっているもの。答えはそのタスクの指示欄から送る（「答える」で、いまの画面構成で見える所に開く） */
function ReportDecisionCard({ s }: { s: Session }) {
  const r = s.report!;
  const decision = r.needsDecision ?? r.summary[0] ?? '報告を見て、続きの指示を出してください';
  return (
    <div className="space-y-3 text-[13px] text-zinc-300">
      <div className="flex items-center gap-2 text-[11px] font-medium text-amber-300/90"><span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" />判断が必要</div>
      <div className="line-clamp-4 leading-relaxed whitespace-pre-wrap break-words">
        {decision}
      </div>
      <details className="text-xs text-zinc-400">
        <summary className="cursor-pointer rounded text-zinc-400 hover:text-zinc-200 focus-visible:outline focus-visible:outline-sky-400">全文・提案を見る</summary>
        <div className="mt-3 space-y-3 whitespace-pre-wrap break-words leading-relaxed">
          <p>{decision}</p>
          {r.nextStep && <div><p className="mb-1 text-zinc-500">エージェントの提案</p><p>{r.nextStep}</p></div>}
          {r.details && <div><p className="mb-1 text-zinc-500">報告の補足</p><p>{r.details}</p></div>}
        </div>
      </details>
      <button onClick={() => openTask(s.id, { answer: true })} title="このタスクのやりとりを開いて、指示欄に答えを書きます" className={`${btn.base} w-full border border-sky-400/20 bg-sky-400/10 text-sky-200 hover:bg-sky-400/20 !py-1.5 !text-xs`}>
        答える
      </button>
    </div>
  );
}

export function Inbox({ className = '', embedded = false }: { className?: string; embedded?: boolean }) {
  const sessions = useStore((s) => s.sessions);
  const waiting = useMemo(
    () =>
      Object.values(sessions)
        .filter(needsYou)
        .sort((a, b) => needsYouSince(a) - needsYouSince(b)),
    [sessions],
  );

  return (
    <aside aria-label="判断インボックス" className={`${embedded ? 'w-full' : 'w-full md:w-[400px] shrink-0 md:border-r overflow-y-auto'} min-w-0 border-zinc-800 p-3 space-y-3 bg-[#0c0e12] ${className}`}>
      <h2 className="flex items-center justify-between gap-2 text-xs font-medium text-zinc-400">
        <span>{embedded ? 'あなたの確認待ち' : '判断インボックス'}</span>
        <span
          className={`shrink-0 text-[11px] px-2 py-0.5 rounded-full ${waiting.length ? 'bg-amber-400/10 text-amber-300' : 'bg-zinc-800 text-zinc-400'}`}
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
        <div key={s.id} className="min-w-0 rounded-lg border border-zinc-800 bg-zinc-900/60 p-3 space-y-3">
          <button
            onClick={() => openTask(s.id)}
            title="このタスクを開く"
            className="w-full min-w-0 text-left text-xs text-zinc-400 hover:text-zinc-200 flex flex-col gap-1 rounded focus-visible:outline focus-visible:outline-sky-400"
          >
            <span className="block w-full truncate font-semibold text-zinc-200" title={s.project.name}>{s.project.name}</span>
            <span className="block w-full truncate" title={s.title}>{s.title}</span>
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
