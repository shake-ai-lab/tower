import type { Session } from '@tower/shared';
import { OUTCOME, STATUS, fmtElapsed, fmtUsd, projectStyle, verifyBadge } from '../lib';

export function SessionCard({ s, selected, onClick, compact = false }: { s: Session; selected: boolean; onClick: () => void; compact?: boolean }) {
  const st = STATUS[s.status];
  const vb = verifyBadge(s);
  if (compact) return <button onClick={onClick} aria-pressed={selected} className={`min-w-0 w-full flex flex-wrap items-center gap-2 text-left rounded-sm border px-3 py-2 ${selected ? 'border-sky-500 bg-sky-400/5' : 'border-zinc-800 bg-[#171a21] hover:bg-zinc-800'}`}>
    <span className={`w-2 h-2 rounded-full shrink-0 ${st.dot}`} />
    <span className="text-sm truncate flex-1 min-w-0" title={s.title}>{s.title}</span>
    <span className={`text-[10px] px-2 py-0.5 rounded-full ${st.badge}`}>{st.label}</span>
    <span className="w-full pl-4 text-[11px] text-zinc-500 truncate">{s.agent === 'codex' ? 'Codex' : 'Claude'} · {s.activity} · {fmtElapsed(s.createdAt)}経過</span>
  </button>;
  return (
    <button
      onClick={onClick}
      aria-pressed={selected}
      className={[
        'min-w-0 text-left rounded-md border p-3 bg-[#171a21] hover:bg-[#1c2029] transition flex flex-col gap-2',
        selected ? 'border-sky-500' : st.attention ? 'border-amber-400/70 attention' : 'border-zinc-800',
      ].join(' ')}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="font-semibold flex flex-wrap items-center gap-1.5 min-w-0 max-w-full">
          <span className="truncate rounded border px-1.5 py-0.5 text-xs" style={projectStyle(s.project.path)} title={s.project.path}>{s.project.name}</span>
          {s.agent === 'codex' && (
            <span className="shrink-0 text-[10px] font-normal px-1.5 py-0.5 rounded bg-teal-900/70 text-teal-200">Codex</span>
          )}
          {s.workspace && (
            <span
              title={`別の作業場所（コピー）で作業中。ブランチ ${s.workspace.branch}`}
              className="shrink-0 text-[10px] font-normal px-1.5 py-0.5 rounded bg-fuchsia-900/70 text-fuchsia-200"
            >
              分離
            </span>
          )}
          {s.compare && (
            <span
              title="同じ依頼を複数のモデルに投げて比べています"
              className="max-w-full truncate text-[10px] font-normal px-1.5 py-0.5 rounded bg-violet-900/70 text-violet-200"
            >
              比較 {s.compare.label}
            </span>
          )}
          {s.origin === 'external' && (
            <span className="max-w-full truncate text-[10px] font-normal px-1.5 py-0.5 rounded bg-indigo-900/70 text-indigo-200">
              {s.externalHint ?? '外部'}
            </span>
          )}
        </div>
        <span className={`text-xs px-2 py-0.5 rounded-full whitespace-nowrap ${st.badge}`}>{st.label}</span>
      </div>

      <div className="text-sm text-zinc-300 line-clamp-2 break-words [overflow-wrap:anywhere]">{s.title}</div>

      <div className="text-xs text-zinc-400 flex items-center gap-2 min-w-0">
        <span className={`inline-block w-2 h-2 rounded-full shrink-0 ${st.dot}`} />
        <span className="truncate">{s.activity}</span>
      </div>

      {s.report && (
        <div className="text-xs text-zinc-300 flex flex-wrap items-start gap-2 min-w-0">
          <span className={`px-1.5 py-0.5 rounded shrink-0 ${OUTCOME[s.report.outcome].cls}`}>
            {OUTCOME[s.report.outcome].label}
          </span>
          {vb && (
            <span title={`自動チェック: ${s.verification?.command}`} className={`px-1.5 py-0.5 rounded shrink-0 ${vb.cls}`}>
              {vb.text}
            </span>
          )}
          <span className="line-clamp-2 break-words [overflow-wrap:anywhere]">{s.report.needsDecision ?? s.report.summary[0] ?? ''}</span>
        </div>
      )}

      <div className="mt-auto pt-1 flex flex-wrap gap-x-2 gap-y-1 justify-between text-[11px] text-zinc-500">
        <span>{fmtElapsed(s.createdAt)}経過</span>
        <span title={s.costUsd > 0 ? '費用の目安（定額プランなら請求されません）' : undefined}>
          {s.turns}往復 · {s.toolCalls}操作 · {s.changedFiles.length}ファイル
          {s.costUsd > 0 && ` · ${fmtUsd(s.costUsd)}`}
        </span>
      </div>
    </button>
  );
}
