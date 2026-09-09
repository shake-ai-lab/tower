import { useEffect, useRef, useState } from 'react';
import type { Report, TimelineItem, Verification } from '@tower/shared';
import { api } from '../api';
import { OUTCOME, STATUS, btn, fmtTime, isAlive } from '../lib';
import { useStore } from '../store';
import { PendingCard } from './PendingCards';
import { ChangesPanel } from './ChangesPanel';

const ICON: Record<TimelineItem['kind'], string> = {
  user: '🧑',
  assistant_text: '💬',
  tool_use: '🔧',
  tool_result: '↩',
  permission: '🛡️',
  system: 'ℹ️',
  error: '⚠️',
};

const URL_RE = /(https?:[^\s)）」]+)/g;

/** 文中の URL をリンクにする */
function Linkify({ text }: { text: string }) {
  const parts = text.split(URL_RE);
  return (
    <>
      {parts.map((p, i) =>
        /^https?:/.test(p) ? (
          <a key={i} href={p} target="_blank" rel="noreferrer" className="text-sky-400 underline break-all">
            {p}
          </a>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}

function VerificationStrip({ v, reportOutcome }: { v: Verification; reportOutcome: Report['outcome'] | null }) {
  const [open, setOpen] = useState(false);
  const conflict = v.ok === false && reportOutcome === 'done';
  const cls =
    v.ok === null
      ? 'border-zinc-700 bg-zinc-800/40'
      : v.ok
        ? 'border-emerald-500/40 bg-emerald-500/5'
        : 'border-red-500/60 bg-red-500/10';
  return (
    <div className={`rounded-lg border p-2.5 text-sm ${cls}`}>
      <button onClick={() => setOpen((o) => !o)} className="w-full flex items-center gap-2 text-left">
        <span>{v.ok === null ? '⏳' : v.ok ? '✔' : '✖'}</span>
        <span className="font-medium">
          {v.ok === null ? '裏取り中' : v.ok ? '裏取りOK' : '裏取りNG'}
          <span className="text-zinc-500 font-normal"> — Tower が </span>
          <span className="mono text-xs">{v.command}</span>
          <span className="text-zinc-500 font-normal"> を実行</span>
        </span>
        <span className="ml-auto text-xs text-zinc-500">{open ? '閉じる' : '出力を見る'}</span>
      </button>
      {conflict && (
        <div className="mt-1.5 text-xs text-red-200">
          エージェントは「完了」と報告していますが、テストは失敗しています。報告を鵜呑みにせず、追加指示で直させてください。
        </div>
      )}
      {open && (
        <pre className="mono mt-2 text-xs whitespace-pre-wrap break-all bg-black/40 rounded p-2 max-h-72 overflow-auto text-zinc-300">
          {v.output || '(出力なし)'}
        </pre>
      )}
    </div>
  );
}

function Row({ label, children, highlight }: { label: string; children: React.ReactNode; highlight?: boolean }) {
  return (
    <div className={highlight ? 'rounded-md bg-amber-400/10 border border-amber-400/40 p-2' : ''}>
      <div className="text-[11px] text-zinc-500 mb-0.5">{label}</div>
      <div className="text-sm leading-relaxed">{children}</div>
    </div>
  );
}

function ReportCard({ r, onFileClick }: { r: Report; onFileClick?: () => void }) {
  const [raw, setRaw] = useState(false);
  const o = OUTCOME[r.outcome];
  return (
    <div className="rounded-xl border border-zinc-700 bg-[#171a21] p-4 space-y-3">
      <div className="flex items-center gap-2">
        <span className="text-xs text-zinc-500">報告</span>
        <span className={`text-xs px-2 py-0.5 rounded ${o.cls}`}>{o.label}</span>
        <span className="text-xs text-zinc-500 ml-auto">{fmtTime(r.generatedAt)}</span>
      </div>
      <Row label="依頼"><Linkify text={r.request} /></Row>
      {r.summary.length > 0 && (
        <Row label="やったこと">
          <ul className="list-disc pl-5 space-y-0.5">
            {r.summary.map((l, i) => (
              <li key={i}><Linkify text={l} /></li>
            ))}
          </ul>
        </Row>
      )}
      {r.changedFiles.length > 0 && (
        <Row label="変更ファイル">
          <ul className="mono text-xs space-y-0.5 text-zinc-300">
            {r.changedFiles.map((f) => (
              <li key={f}>
                <button onClick={onFileClick} className="hover:text-sky-300 hover:underline text-left" title="差分を見る">
                  {f}
                </button>
              </li>
            ))}
          </ul>
        </Row>
      )}
      {r.needsDecision && (
        <Row label="判断が必要" highlight>
          <Linkify text={r.needsDecision} />
        </Row>
      )}
      {r.nextStep && (
        <Row label="次の一手">
          <Linkify text={r.nextStep} />
        </Row>
      )}
      <button onClick={() => setRaw((v) => !v)} className="text-xs text-zinc-500 hover:text-zinc-300">
        {raw ? '原文を隠す' : '原文を見る'}
      </button>
      {raw && (
        <pre className="text-xs whitespace-pre-wrap break-words bg-black/40 rounded p-2 max-h-80 overflow-auto text-zinc-300">
          {r.raw}
        </pre>
      )}
    </div>
  );
}

function TimelineRow({ t }: { t: TimelineItem }) {
  const cls =
    t.kind === 'user'
      ? 'text-sky-200'
      : t.kind === 'error'
        ? 'text-red-300'
        : t.kind === 'permission'
          ? 'text-amber-200'
          : t.kind === 'tool_result'
            ? 'text-zinc-500'
            : 'text-zinc-300';
  const body = (
    <div className={`flex gap-2 text-sm ${cls}`}>
      <span className="shrink-0 w-5 text-center">{ICON[t.kind]}</span>
      <span className="min-w-0 break-words whitespace-pre-wrap">{t.text}</span>
      <span className="ml-auto shrink-0 text-[11px] text-zinc-600">{fmtTime(t.ts)}</span>
    </div>
  );
  if (!t.detail) return <div className="px-1 py-0.5">{body}</div>;
  return (
    <details className="px-1 py-0.5 group">
      <summary className="cursor-pointer list-none">{body}</summary>
      <pre className="mono mt-1 ml-7 text-xs whitespace-pre-wrap break-all bg-black/40 rounded p-2 max-h-72 overflow-auto text-zinc-400">
        {t.detail}
      </pre>
    </details>
  );
}

export function SessionDetail({ id }: { id: string }) {
  const s = useStore((st) => st.sessions[id]);
  const timeline = useStore((st) => st.timelines[id]);
  const setTimeline = useStore((st) => st.setTimeline);
  const select = useStore((st) => st.select);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showChanges, setShowChanges] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!timeline) api.timeline(id).then((items) => setTimeline(id, items)).catch((e) => setErr(String(e)));
  }, [id, timeline, setTimeline]);

  // 報告や判断待ちが来たら一番上（カード）へ。作業中に年表が伸びる時だけ下へ追従する
  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 });
  }, [id, s?.pending?.id, s?.report?.generatedAt]);
  useEffect(() => {
    if (s?.status === 'running') bottom.current?.scrollIntoView({ block: 'end' });
  }, [timeline?.length, s?.status]);

  if (!s) return null;
  const st = STATUS[s.status];
  const external = s.origin === 'external';
  const alive = isAlive(s.status) && !external;
  const canSend = alive || !!s.agentSessionId;

  const send = async () => {
    const t = text.trim();
    if (!t) return;
    setBusy(true);
    setErr(null);
    try {
      await api.message(id, { text: t });
      setText('');
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    if (!confirm('このセッションを停止しますか？')) return;
    await api.stop(id).catch(() => {});
  };
  const remove = async () => {
    if (!confirm('このセッションを一覧から削除しますか？（履歴も消えます）')) return;
    await api.remove(id).catch(() => {});
  };

  return (
    <section className="w-[600px] shrink-0 border-l border-zinc-800 flex flex-col overflow-hidden bg-[#0c0e12]">
      <header className="p-3 border-b border-zinc-800 space-y-1">
        <div className="flex items-center gap-2">
          <span className="font-semibold">{s.project.name}</span>
          {external && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-900/70 text-indigo-200">{s.externalHint ?? '外部'}</span>
          )}
          <span className={`text-xs px-2 py-0.5 rounded-full ${st.badge}`}>{st.label}</span>
          {s.model && <span className="text-xs text-zinc-500">{s.model}</span>}
          <div className="ml-auto flex gap-1.5">
            {alive && (
              <button onClick={stop} className={`${btn.base} ${btn.danger} !py-1 !text-xs`}>
                停止
              </button>
            )}
            <button onClick={remove} className={`${btn.base} ${btn.ghost} !py-1 !text-xs`}>
              削除
            </button>
            <button onClick={() => select(null)} className={`${btn.base} ${btn.ghost} !py-1 !text-xs`}>
              閉じる
            </button>
          </div>
        </div>
        <div className="text-sm text-zinc-300">{s.title}</div>
        <div className="text-xs text-zinc-500 flex items-center gap-2">
          <span className={`inline-block w-2 h-2 rounded-full ${st.dot}`} />
          {s.activity}
          <span className="ml-auto">
            {s.turns}往復 · {s.toolCalls}操作 · ${s.costUsd.toFixed(2)}
          </span>
        </div>
      </header>

      <div ref={scroller} className="flex-1 overflow-y-auto p-3 space-y-3">
        {external && (
          <div className="text-xs text-indigo-200/80 bg-indigo-400/5 border border-indigo-400/30 rounded-md p-2 leading-relaxed">
            このセッションは {s.externalHint ?? '外部'} で動いています。ここから指示を送ると Tower が会話を引き継ぎます（{s.externalHint ?? '元の画面'} 側で同時に動かさないでください）。
          </div>
        )}
        {s.pending && <PendingCard session={s} />}
        {s.report && <ReportCard r={s.report} onFileClick={() => setShowChanges(true)} />}
        {s.verification && <VerificationStrip v={s.verification} reportOutcome={s.report?.outcome ?? null} />}
        {s.lastError && (
          <div className="rounded-md border border-red-500/50 bg-red-500/10 p-2 text-xs text-red-200 whitespace-pre-wrap">
            {s.lastError}
          </div>
        )}
        <div className="rounded-xl border border-zinc-800 bg-[#12151b] p-3">
          <button
            onClick={() => setShowChanges((v) => !v)}
            className="w-full flex items-center gap-2 text-sm text-left"
          >
            <span className="text-zinc-300">変更されたファイル</span>
            <span className="text-xs px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-300">{s.changedFiles.length}</span>
            <span className="ml-auto text-xs text-zinc-500">{showChanges ? '閉じる' : '差分を見る'}</span>
          </button>
          {showChanges && (
            <div className="mt-3">
              <ChangesPanel sessionId={id} refreshKey={s.turns + s.toolCalls} />
            </div>
          )}
        </div>

        <div>
          <div className="text-[11px] text-zinc-500 mb-1 px-1">経過（クリックで詳細）</div>
          <div className="space-y-0.5">
            {(timeline ?? []).map((t) => (
              <TimelineRow key={t.id} t={t} />
            ))}
            {!timeline && <div className="text-xs text-zinc-500 px-1">読み込み中…</div>}
          </div>
          <div ref={bottom} />
        </div>
      </div>

      <footer className="p-3 border-t border-zinc-800">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void send();
          }}
          disabled={!canSend}
          placeholder={
            alive
              ? '追加の指示（Ctrl+Enter で送信）'
              : external && s.agentSessionId
                ? `続きの指示（送ると Tower が ${s.externalHint ?? '外部'} から引き継ぎます）`
                : s.agentSessionId
                  ? '続きの指示（止まっているので、送ると再開します）'
                  : 'このセッションは再開できません'
          }
          rows={3}
          className="w-full text-sm bg-black/30 border border-zinc-700 rounded-md px-3 py-2 outline-none focus:border-zinc-500 disabled:opacity-50 resize-none"
        />
        <div className="mt-2 flex items-center gap-2">
          <button disabled={!canSend || busy || !text.trim()} onClick={send} className={`${btn.base} ${btn.primary}`}>
            {alive ? '送信' : external ? '引き継いで送信' : '再開して送信'}
          </button>
          {err && <span className="text-xs text-red-400">{err}</span>}
        </div>
      </footer>
    </section>
  );
}
