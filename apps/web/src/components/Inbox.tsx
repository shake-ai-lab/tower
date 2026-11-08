import { useMemo, useState } from 'react';
import { workDir, type Session } from '@tower/shared';
import { useStore } from '../store';
import { openTask } from '../layout';
import { api, errMsg } from '../api';
import { PendingCard } from './PendingCards';
import { ReplyBody, useFileLinker } from './Reply';
import { btn, fmtElapsed, needsYou, needsYouSince, replyExcerpt } from '../lib';
import { canMarkDone, isStructuredReport } from '../task-state';

/**
 * エージェントが返事をして、あなたの番になっているもの。答えはそのタスクの指示欄から送る（「答える」で、いまの画面構成で見える所に開く）。
 * これで終わりなら「完了にする」で一覧から外す（続きの指示を送れば、また再開できる）
 */
function ReplyWaitingCard({ s }: { s: Session }) {
  const r = s.report!;
  const decision = isStructuredReport(r) && !!r.needsDecision;
  const excerpt = replyExcerpt(r) || '返事を読んで、続きの指示を出すか『完了にする』を押してください';
  const linker = useFileLinker(s.id, workDir(s));
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const complete = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.complete(s.id);
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-3 text-[13px] text-zinc-300">
      <div className="flex items-center gap-2 text-[11px] font-medium text-amber-300/90"><span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" />{decision ? '判断が必要' : '返事が来ました'}</div>
      <div className="line-clamp-4 leading-relaxed whitespace-pre-wrap break-words">
        {excerpt}
      </div>
      <details className="text-xs text-zinc-400" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
        <summary className="cursor-pointer rounded text-zinc-400 hover:text-zinc-200 focus-visible:outline focus-visible:outline-sky-400">返事の全文を見る</summary>
        {open && (
          <div className="mt-3 max-h-96 overflow-auto rounded border border-zinc-800 bg-black/20 p-2">
            <ReplyBody text={r.raw?.trim() || excerpt} linker={linker} clamp="none" />
          </div>
        )}
      </details>
      <div className="flex gap-2">
        <button onClick={() => openTask(s.id, { answer: true })} title="このタスクのやりとりを開いて、指示欄に続きの指示を書きます" className={`${btn.base} flex-1 border border-sky-400/20 bg-sky-400/10 text-sky-200 hover:bg-sky-400/20 !py-1.5 !text-xs`}>
          答える
        </button>
        {canMarkDone(s) && (
          <button disabled={busy} onClick={complete} title="これで終わりにします。判断待ちから外れます（続きの指示を送れば、また再開できます）" className={`${btn.base} border border-emerald-400/20 bg-emerald-400/10 text-emerald-200 hover:bg-emerald-400/20 !py-1.5 !text-xs`}>
            {busy ? '完了にしています…' : '完了にする'}
          </button>
        )}
      </div>
      {err && <p className="text-xs text-red-300">{err}</p>}
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
          許可や質問、エージェントの返事（あなたの番のもの）がここに並びます。
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
          {s.pending ? <PendingCard session={s} /> : <ReplyWaitingCard s={s} />}
        </div>
      ))}
    </aside>
  );
}
