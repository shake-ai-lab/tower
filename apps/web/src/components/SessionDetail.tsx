import { Suspense, lazy, useEffect, useRef, useState } from 'react';
import type { Preview, Report, Screenshot, Session, TimelineItem, Verification } from '@tower/shared';
import { api } from '../api';
import { OUTCOME, STATUS, btn, fmtTime, isAlive } from '../lib';
import { useStore } from '../store';
import { PendingCard } from './PendingCards';
import { ChangesPanel } from './ChangesPanel';

// Monaco は重いので、「直す」を押した時に初めて読み込む
const FileEditor = lazy(() => import('./FileEditor').then((m) => ({ default: m.FileEditor })));

const WORKING: Session['status'][] = ['starting', 'running', 'waiting_permission', 'waiting_question'];

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

const okText = (v: Verification) => v.summary ?? (v.ok ? '成功' : '失敗');

/** 修正前と修正後を比べた一言。修正前が無ければ null */
export function compareVerdict(b: Verification | null | undefined, v: Verification): { text: string; tone: 'good' | 'bad' | 'warn' } | null {
  if (!b || b.ok === null || v.ok === null) return null;
  if (!b.ok && v.ok) return { text: '直りました', tone: 'good' };
  const before = new Set(b.failed ?? []);
  const newly = (v.failed ?? []).filter((n) => !before.has(n));
  const names = (xs: string[]) => (xs.length ? `: ${xs.slice(0, 3).join('、')}${xs.length > 3 ? ' など' : ''}` : '');
  if (b.ok && !v.ok) return { text: `修正で壊れました（修正前は通っていました${names(newly)}）`, tone: 'bad' };
  if (!b.ok && !v.ok) {
    if (newly.length) return { text: `新しく失敗が増えました${names(newly)}`, tone: 'bad' };
    return { text: '修正前からの失敗が残っています（新しく壊れたものは無し）', tone: 'warn' };
  }
  return null;
}

/** 起動直後の自動チェック（報告が来る前に見せる） */
function BaselineStrip({ b }: { b: Verification }) {
  return (
    <div className="rounded-lg border border-zinc-700 bg-zinc-800/40 p-2.5 text-xs text-zinc-300">
      修正前の自動チェック: <span className={b.ok ? 'text-emerald-300' : 'text-red-300'}>{b.ok ? '✔' : '✖'} {okText(b)}</span>
      <span className="text-zinc-500"> — Tower が </span>
      <span className="mono">{b.command}</span>
      <span className="text-zinc-500"> を実行</span>
    </div>
  );
}

function VerificationStrip({ v, baseline, reportOutcome }: { v: Verification; baseline?: Verification | null; reportOutcome: Report['outcome'] | null }) {
  const [open, setOpen] = useState(false);
  const conflict = v.ok === false && reportOutcome === 'done';
  const verdict = compareVerdict(baseline, v);
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
          {v.ok !== null && v.summary && <span className="font-normal">（{v.summary}）</span>}
          <span className="text-zinc-500 font-normal"> — Tower が </span>
          <span className="mono text-xs">{v.command}</span>
          <span className="text-zinc-500 font-normal"> を実行</span>
        </span>
        <span className="ml-auto text-xs text-zinc-500">{open ? '閉じる' : '出力を見る'}</span>
      </button>
      {baseline && baseline.ok !== null && v.ok !== null && (
        <div className="mt-1.5 text-xs text-zinc-300">
          修正前: <span className={baseline.ok ? 'text-emerald-300' : 'text-red-300'}>{okText(baseline)}</span>
          <span className="text-zinc-500"> → </span>
          修正後: <span className={v.ok ? 'text-emerald-300' : 'text-red-300'}>{okText(v)}</span>
          {verdict && (
            <span
              className={`ml-2 px-1.5 py-0.5 rounded ${
                verdict.tone === 'good'
                  ? 'bg-emerald-900/70 text-emerald-200'
                  : verdict.tone === 'bad'
                    ? 'bg-red-600 text-white font-semibold'
                    : 'bg-amber-900/70 text-amber-200'
              }`}
            >
              {verdict.text}
            </span>
          )}
        </div>
      )}
      {v.ok === false && (v.failed?.length ?? 0) > 0 && (
        <div className="mt-1 text-xs text-zinc-400">
          失敗したテスト: <span className="text-red-200">{v.failed!.slice(0, 5).join('、')}{v.failed!.length > 5 ? ' など' : ''}</span>
        </div>
      )}
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

function ShotThumb({ shot, onOpen }: { shot: Screenshot; onOpen: () => void }) {
  return (
    <button onClick={onOpen} className="block rounded border border-zinc-700 overflow-hidden hover:border-sky-500" title="クリックで拡大">
      <img src={shot.url} alt={shot.scheme} className="w-[150px] h-[96px] object-cover object-top bg-black" />
      <div className="text-[10px] text-center text-zinc-400 bg-zinc-900 py-0.5">{shot.scheme === 'dark' ? 'ダーク' : 'ライト'}</div>
    </button>
  );
}

/** Tower が撮った見た目（修正前 → 修正後） */
function PreviewStrip({ p }: { p: Preview }) {
  const [open, setOpen] = useState<Screenshot | null>(null);
  const group = (label: string, shots: Screenshot[]) => (
    <div>
      <div className="text-[11px] text-zinc-500 mb-1">{label}</div>
      <div className="flex gap-1.5">
        {shots.map((s) => (
          <ShotThumb key={s.file} shot={s} onOpen={() => setOpen(s)} />
        ))}
      </div>
    </div>
  );
  return (
    <div className="rounded-lg border border-zinc-700 bg-zinc-800/30 p-2.5 text-sm">
      <div className="flex items-center gap-2 text-xs">
        <span className="text-zinc-300">📷 見た目</span>
        <span className="text-zinc-500">
          — Tower が <span className="mono">{p.target}</span> を撮影
        </span>
        {p.taking && <span className="text-zinc-400">撮影中…</span>}
      </div>
      {(p.before || p.after) && (
        <div className="mt-2 flex items-start gap-3 flex-wrap">
          {p.before && group('修正前', p.before)}
          {p.before && p.after && <div className="self-center text-zinc-600">→</div>}
          {p.after && group('修正後', p.after)}
        </div>
      )}
      {!p.before && !p.after && !p.taking && !p.error && <div className="mt-1 text-xs text-zinc-500">まだ撮っていません</div>}
      {p.error && <div className="mt-1 text-xs text-red-300">{p.error}</div>}
      {open && (
        <div className="fixed inset-0 z-50 bg-black/85 flex items-center justify-center p-6 cursor-zoom-out" onClick={() => setOpen(null)}>
          <div className="max-w-full max-h-full overflow-auto rounded shadow-2xl">
            <img src={open.url} alt={open.scheme} className="max-w-[92vw]" />
          </div>
          <div className="absolute top-3 left-4 text-xs text-zinc-300">
            {open.label === 'before' ? '修正前' : '修正後'} / {open.scheme === 'dark' ? 'ダーク' : 'ライト'} / {open.width}×{open.height} — クリックで閉じる
          </div>
        </div>
      )}
    </div>
  );
}

/** 分離した作業場所の説明と「取り込む」ボタン */
function WorkspaceStrip({ s }: { s: Session }) {
  const ws = s.workspace;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (!ws) return null;
  const working = ['starting', 'running', 'waiting_permission', 'waiting_question'].includes(s.status);

  const merge = async () => {
    if (!confirm('この作業場所の変更を、元のプロジェクトに取り込みますか？')) return;
    setBusy(true);
    setErr(null);
    try {
      await api.merge(s.id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="text-xs bg-fuchsia-400/5 border border-fuchsia-400/30 rounded-md p-2 leading-relaxed space-y-1.5">
      <div className="text-fuchsia-200/90">
        {ws.autoMerge
          ? '別の作業場所（コピー）で作業しています。報告が「完了」で裏取りが通れば、Tower が自動で元のプロジェクトに取り込みます（手で押すこともできます）。'
          : '別の作業場所（コピー）で作業しています。変更は「取り込む」を押すまで元のプロジェクトには反映されません。'}
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <button
          disabled={busy || working}
          onClick={merge}
          title={working ? '作業中は取り込めません。報告が来てから押してください' : undefined}
          className={`${btn.base} ${btn.success} !py-1 !text-xs`}
        >
          {busy ? '取り込み中…' : '元のプロジェクトに取り込む'}
        </button>
        <span className="mono text-zinc-500">{ws.branch}</span>
        {working && <span className="text-zinc-500">作業中は取り込めません</span>}
      </div>
      {ws.lastMerge && (
        <div className={`whitespace-pre-wrap ${ws.lastMerge.ok ? 'text-emerald-200' : 'text-red-200'}`}>
          {ws.lastMerge.ok ? '✔ ' : '✖ '}
          {ws.lastMerge.message}
          <span className="text-zinc-500 ml-2">{fmtTime(ws.lastMerge.at)}</span>
        </div>
      )}
      {err && <div className="text-red-300">{err}</div>}
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
        {r.reformatted && (
          <span
            title="エージェントの出力に決まった書式が無かったので、Tower が AI で読みやすく整形しました。原文は「原文を見る」で確認できます"
            className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400"
          >
            Tower が整形
          </span>
        )}
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
  const [editing, setEditing] = useState<string | null>(null);
  const [editVersion, setEditVersion] = useState(0);
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
  const working = WORKING.includes(s.status);

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
    const msg = s.workspace
      ? 'このセッションを一覧から削除しますか？（履歴も消えます）\n別の作業場所（コピー）も消えます。まだ取り込んでいない変更は失われます。'
      : 'このセッションを一覧から削除しますか？（履歴も消えます）';
    if (!confirm(msg)) return;
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
          {s.workspace && (
            <span title={`ブランチ ${s.workspace.branch}`} className="text-[10px] px-1.5 py-0.5 rounded bg-fuchsia-900/70 text-fuchsia-200">
              分離
            </span>
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
        {s.workspace && <WorkspaceStrip s={s} />}
        {s.verification ? (
          <VerificationStrip v={s.verification} baseline={s.baseline} reportOutcome={s.report?.outcome ?? null} />
        ) : (
          s.baseline && <BaselineStrip b={s.baseline} />
        )}
        {s.preview && <PreviewStrip p={s.preview} />}
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
              <ChangesPanel
                sessionId={id}
                refreshKey={s.turns + s.toolCalls + editVersion}
                onEdit={working ? undefined : setEditing}
                editHint="エージェントが作業中は編集できません。報告が来るか、停止してから直してください"
              />
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

      {editing && (
        <Suspense
          fallback={
            <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center text-sm text-zinc-300">
              エディタを読み込み中…
            </div>
          }
        >
          <FileEditor
            sessionId={id}
            path={editing}
            onClose={() => setEditing(null)}
            onSaved={() => setEditVersion((v) => v + 1)}
          />
        </Suspense>
      )}
    </section>
  );
}
