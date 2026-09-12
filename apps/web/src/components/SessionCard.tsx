// フリート（一覧）の 1 枚。ふつうのカードと、1 行に詰めたコンパクト表示の 2 種類
import type { Session } from '@tower/shared';
import { OUTCOME, STATUS, fmtElapsed, fmtUsd, needsYou, projectStyle, verifyBadge } from '../lib';
import { SessionTags, StatusBadge, agentLabel } from './SessionBadges';

type CardProps = { s: Session; selected: boolean; onClick: () => void };

export function SessionCard({ compact = false, ...p }: CardProps & { compact?: boolean }) {
  return compact ? <CompactCard {...p} /> : <FullCard {...p} />;
}

/** 作業中はカードの上端に流れる線を出す */
function WorkingBar({ s }: { s: Session }) {
  return STATUS[s.status].working ? <span aria-hidden="true" className="working-bar absolute top-0 inset-x-0" /> : null;
}

/** 状態の色の点 */
function StatusDot({ s }: { s: Session }) {
  return <span aria-hidden="true" className={`inline-block w-2 h-2 rounded-full shrink-0 ${STATUS[s.status].dot}`} />;
}

const elapsed = (s: Session) => `${fmtElapsed(s.createdAt)}経過`;

function CompactCard({ s, selected, onClick }: CardProps) {
  const st = STATUS[s.status];
  const frame = selected ? 'border-sky-500 bg-sky-400/5' : st.working ? 'working-card' : 'border-zinc-800 bg-[#171a21] hover:bg-zinc-800';
  return (
    <button onClick={onClick} aria-pressed={selected} className={`relative overflow-hidden min-w-0 w-full flex flex-wrap items-center gap-2 text-left rounded-sm border px-3 py-2 ${frame}`}>
      <WorkingBar s={s} />
      <StatusDot s={s} />
      <span className="text-sm truncate flex-1 min-w-0" title={s.title}>{s.title}</span>
      <StatusBadge status={s.status} className="text-[10px]" />
      <span className={`w-full pl-4 text-[11px] truncate ${st.working ? 'text-sky-200/80' : 'text-zinc-500'}`}>
        {agentLabel(s)} · {s.activity} · {elapsed(s)}
      </span>
    </button>
  );
}

function FullCard({ s, selected, onClick }: CardProps) {
  const st = STATUS[s.status];
  const frame = selected ? 'border-sky-500' : st.attention || needsYou(s) ? 'border-amber-400/70 attention' : st.working ? 'working-card' : 'border-zinc-800';
  return (
    <button
      onClick={onClick}
      aria-pressed={selected}
      className={`relative overflow-hidden min-w-0 text-left rounded-md border p-3 bg-[#171a21] hover:bg-[#1c2029] transition flex flex-col gap-2 ${frame}`}
    >
      <WorkingBar s={s} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="font-semibold flex flex-wrap items-center gap-1.5 min-w-0 max-w-full">
          <span className="truncate rounded border px-1.5 py-0.5 text-xs" style={projectStyle(s.project.path)} title={s.project.path}>{s.project.name}</span>
          <SessionTags s={s} />
        </div>
        <StatusBadge status={s.status} />
      </div>

      <div className="text-sm text-zinc-300 line-clamp-2 break-words [overflow-wrap:anywhere]">{s.title}</div>

      <div className={`text-xs flex items-center gap-2 min-w-0 ${st.working ? 'text-sky-200' : 'text-zinc-400'}`}>
        <StatusDot s={s} />
        <span className="truncate">{s.activity}</span>
      </div>

      {s.report && <ReportLine s={s} report={s.report} />}

      <div className="mt-auto pt-1 flex flex-wrap gap-x-2 gap-y-1 justify-between text-[11px] text-zinc-500">
        <span>{elapsed(s)}</span>
        <span title={s.costUsd > 0 ? '費用の目安（定額プランなら請求されません）' : undefined}>
          {s.turns}往復 · {s.toolCalls}操作 · {s.changedFiles.length}ファイル
          {s.costUsd > 0 && ` · ${fmtUsd(s.costUsd)}`}
        </span>
      </div>
    </button>
  );
}

/** 報告の要点 1 行: 結果の札・自動チェックの札・判断してほしいこと（無ければ要約の先頭） */
function ReportLine({ s, report }: { s: Session; report: NonNullable<Session['report']> }) {
  const outcome = OUTCOME[report.outcome];
  const vb = verifyBadge(s);
  return (
    <div className="text-xs text-zinc-300 flex flex-wrap items-start gap-2 min-w-0">
      <span className={`px-1.5 py-0.5 rounded shrink-0 ${outcome.cls}`}>{outcome.label}</span>
      {vb && (
        <span title={`自動チェック: ${s.verification?.command}`} className={`px-1.5 py-0.5 rounded shrink-0 ${vb.cls}`}>
          {vb.text}
        </span>
      )}
      <span className="line-clamp-2 break-words [overflow-wrap:anywhere]">{report.needsDecision ?? report.summary[0] ?? ''}</span>
    </div>
  );
}
