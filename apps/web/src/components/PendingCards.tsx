import { useState } from 'react';
import type { PendingPermission, PendingQuestion, Session } from '@tower/shared';
import { api } from '../api';
import { RISK, btn } from '../lib';

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** 許可要求の詳細。編集は「変更前 / 変更後」が両方見えるように 2 段で出す（1 段だと変更後がスクロールの下に隠れて判断できない） */
function DetailBlock({ detail }: { detail: string }) {
  const m = detail.match(/^([\s\S]*?)--- 変更前\n([\s\S]*?)\n\n\+\+\+ 変更後\n([\s\S]*)$/);
  if (!m) {
    return (
      <pre className="mono mt-2 text-xs bg-black/40 rounded p-2 max-h-56 overflow-auto whitespace-pre-wrap break-all text-zinc-300">
        {detail}
      </pre>
    );
  }
  const [, head, before, after] = m;
  return (
    <div className="mt-2 text-xs space-y-1">
      {head.trim() && <div className="mono text-zinc-500 break-all">{head.trim()}</div>}
      <div className="rounded overflow-hidden border border-zinc-800">
        <div className="px-2 py-0.5 bg-red-500/10 text-red-300/80 text-[11px]">変更前</div>
        <pre className="mono px-2 py-1 bg-black/40 max-h-32 overflow-auto whitespace-pre-wrap break-all text-zinc-400">{before || '(空)'}</pre>
        <div className="px-2 py-0.5 bg-emerald-500/10 text-emerald-300/80 text-[11px]">変更後</div>
        <pre className="mono px-2 py-1 bg-black/40 max-h-44 overflow-auto whitespace-pre-wrap break-all text-zinc-200">{after || '(空: この部分を消します)'}</pre>
      </div>
    </div>
  );
}

export function PermissionCard({ session, pending }: { session: Session; pending: PendingPermission }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const decide = async (decision: 'allow' | 'allow_always' | 'deny' | 'defer') => {
    setBusy(true);
    setErr(null);
    try {
      await api.permission(session.id, { requestId: pending.id, decision, message: reason.trim() || undefined });
    } catch (e) {
      setErr(errMsg(e));
      setBusy(false);
    }
  };

  const risk = RISK[pending.risk];
  const external = session.origin === 'external';
  const hint = session.externalHint ?? '元の画面';
  const vscodeUrl = `vscode://file/${session.project.path.replace(/\\/g, '/')}`;

  // 観測しているだけで Tower からは答えられない（元の画面で答える）
  if (pending.answerable === false) {
    return (
      <div className="rounded-lg border border-indigo-400/40 bg-indigo-400/5 p-3">
        <div className="text-xs text-indigo-200">{hint} で許可待ち</div>
        <div className="mt-1 font-medium leading-snug">{pending.headline}</div>
        <div className="mt-2 text-xs text-zinc-400 leading-relaxed">
          このセッションは {hint} 側で動いています。{hint} の画面で答えてください。 Tower
          で答えたい場合は、右上の「VS Code 連携」で「許可も Tower で答える」をオンにします。
        </div>
        <a href={vscodeUrl} className={`${btn.base} ${btn.ghost} inline-block mt-2`}>
          VS Code を開く
        </a>
      </div>
    );
  }

  return (
    <div
      className={`rounded-lg border p-3 ${pending.risk === 'high' ? 'border-red-500/60 bg-red-500/5' : 'border-amber-400/40 bg-amber-400/5'}`}
    >
      <div className="flex items-center gap-2 text-xs">
        <span className={`px-2 py-0.5 rounded ${risk.cls}`}>{risk.label}</span>
        <span className="text-zinc-500 mono">{pending.toolName}</span>
        {external && <span className="text-indigo-300">{hint} のセッション</span>}
      </div>
      <div className="mt-1.5 font-medium leading-snug">{pending.headline}</div>
      {pending.detail && <DetailBlock detail={pending.detail} />}
      <input
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="拒否する理由や代案（任意）。エージェントに伝わります"
        className="mt-2 w-full text-xs bg-black/30 border border-zinc-700 rounded px-2 py-1.5 outline-none focus:border-zinc-500"
      />
      <div className="mt-2 flex flex-wrap gap-2">
        <button disabled={busy} onClick={() => decide('allow')} className={`${btn.base} ${btn.success}`}>
          許可
        </button>
        {pending.canAlwaysAllow && (
          <button
            disabled={busy}
            onClick={() => decide('allow_always')}
            title={pending.alwaysRules?.join(' / ')}
            className={`${btn.base} ${btn.ghost}`}
          >
            以後も許可
          </button>
        )}
        {external && (
          <button
            disabled={busy}
            onClick={() => decide('defer')}
            title={`${hint} の通常の許可画面に任せます`}
            className={`${btn.base} ${btn.ghost}`}
          >
            {hint} に任せる
          </button>
        )}
        <button disabled={busy} onClick={() => decide('deny')} className={`${btn.base} ${btn.danger} ml-auto`}>
          拒否
        </button>
      </div>
      {pending.canAlwaysAllow && pending.alwaysRules?.length > 0 && (
        <div className="mt-1.5 text-[11px] text-zinc-500">「以後も許可」= {pending.alwaysRules.join(' / ')}</div>
      )}
      {err && <div className="text-red-400 text-xs mt-2">{err}</div>}
    </div>
  );
}

export function QuestionCard({ session, pending }: { session: Session; pending: PendingQuestion }) {
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const toggle = (q: string, label: string, multi: boolean) =>
    setPicked((p) => {
      const cur = p[q] ?? [];
      if (!multi) return { ...p, [q]: cur[0] === label ? [] : [label] };
      return { ...p, [q]: cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label] };
    });

  const answerOf = (q: string) => other[q]?.trim() || (picked[q] ?? []).join(', ');
  const ready = pending.questions.every((q) => answerOf(q.question));

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      const answers = Object.fromEntries(pending.questions.map((q) => [q.question, answerOf(q.question)]));
      await api.answer(session.id, { requestId: pending.id, answers });
    } catch (e) {
      setErr(errMsg(e));
      setBusy(false);
    }
  };

  return (
    <div className="rounded-lg border border-violet-400/40 bg-violet-400/5 p-3 space-y-3">
      {pending.questions.map((q) => (
        <div key={q.question}>
          <div className="flex items-center gap-2 text-xs">
            <span className="px-2 py-0.5 rounded bg-violet-900/70 text-violet-200">{q.header}</span>
            {q.multiSelect && <span className="text-zinc-500">複数選択可</span>}
          </div>
          <div className="mt-1 font-medium leading-snug">{q.question}</div>
          <div className="mt-2 grid gap-1.5">
            {q.options.map((o) => {
              const on = (picked[q.question] ?? []).includes(o.label);
              return (
                <button
                  key={o.label}
                  onClick={() => toggle(q.question, o.label, q.multiSelect)}
                  className={`text-left rounded-md border px-3 py-2 text-sm transition ${on ? 'border-violet-400 bg-violet-500/20' : 'border-zinc-700 bg-black/20 hover:border-zinc-500'}`}
                >
                  <div className="font-medium">{o.label}</div>
                  {o.description && <div className="text-xs text-zinc-400 mt-0.5">{o.description}</div>}
                </button>
              );
            })}
            <input
              value={other[q.question] ?? ''}
              onChange={(e) => setOther((p) => ({ ...p, [q.question]: e.target.value }))}
              placeholder="その他（自由に書く）"
              className="text-sm bg-black/30 border border-zinc-700 rounded px-3 py-1.5 outline-none focus:border-zinc-500"
            />
          </div>
        </div>
      ))}
      <div className="flex items-center gap-2">
        <button disabled={!ready || busy} onClick={submit} className={`${btn.base} ${btn.primary}`}>
          回答を送る
        </button>
        {err && <span className="text-red-400 text-xs">{err}</span>}
      </div>
    </div>
  );
}

export function PendingCard({ session }: { session: Session }) {
  const p = session.pending;
  if (!p) return null;
  return p.kind === 'permission' ? (
    <PermissionCard session={session} pending={p} />
  ) : (
    <QuestionCard session={session} pending={p} />
  );
}
