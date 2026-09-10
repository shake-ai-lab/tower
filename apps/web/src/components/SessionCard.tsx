import type { Session } from '@tower/shared';
import { OUTCOME, STATUS, fmtElapsed } from '../lib';

export function SessionCard({ s, selected, onClick }: { s: Session; selected: boolean; onClick: () => void }) {
  const st = STATUS[s.status];
  return (
    <button
      onClick={onClick}
      className={[
        'text-left rounded-xl border p-4 bg-[#171a21] hover:bg-[#1c2029] transition flex flex-col gap-2',
        selected ? 'border-sky-500' : st.attention ? 'border-amber-400/70 attention' : 'border-zinc-800',
      ].join(' ')}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="font-semibold truncate flex items-center gap-1.5 min-w-0">
          <span className="truncate">{s.project.name}</span>
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
          {s.origin === 'external' && (
            <span className="shrink-0 text-[10px] font-normal px-1.5 py-0.5 rounded bg-indigo-900/70 text-indigo-200">
              {s.externalHint ?? '外部'}
            </span>
          )}
        </div>
        <span className={`text-xs px-2 py-0.5 rounded-full whitespace-nowrap ${st.badge}`}>{st.label}</span>
      </div>

      <div className="text-sm text-zinc-300 line-clamp-2">{s.title}</div>

      <div className="text-xs text-zinc-400 flex items-center gap-2 min-w-0">
        <span className={`inline-block w-2 h-2 rounded-full shrink-0 ${st.dot}`} />
        <span className="truncate">{s.activity}</span>
      </div>

      {s.report && (
        <div className="text-xs text-zinc-300 flex items-start gap-2 min-w-0">
          <span className={`px-1.5 py-0.5 rounded shrink-0 ${OUTCOME[s.report.outcome].cls}`}>
            {OUTCOME[s.report.outcome].label}
          </span>
          {s.verification && (
            <span
              title={`自動チェック: ${s.verification.command}`}
              className={`px-1.5 py-0.5 rounded shrink-0 ${
                s.verification.ok === null
                  ? 'bg-zinc-800 text-zinc-400'
                  : s.verification.ok
                    ? 'bg-emerald-900/70 text-emerald-200'
                    : 'bg-red-600 text-white font-semibold'
              }`}
            >
              {s.verification.ok === null ? '⏳ 確認中' : s.verification.ok ? '✔ 裏取りOK' : '✖ 裏取りNG'}
            </span>
          )}
          <span className="line-clamp-2">{s.report.needsDecision ?? s.report.summary[0] ?? ''}</span>
        </div>
      )}

      <div className="mt-auto pt-1 flex justify-between text-[11px] text-zinc-500">
        <span>{fmtElapsed(s.createdAt)}経過</span>
        <span>
          {s.turns}往復 · {s.toolCalls}操作 · {s.changedFiles.length}ファイル
        </span>
      </div>
    </button>
  );
}
