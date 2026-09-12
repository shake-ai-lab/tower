import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { Preview, Report, Screenshot, Session, TimelineItem, Verification } from '@tower/shared';
import { PERMISSION_CHOICES, type PermissionChoice } from '@tower/shared';
import { api, errMsg } from '../api';
import { OUTCOME, STATUS, btn, fmtElapsed, fmtTime, fmtTokens, fmtUsd, isAlive, verifyBadge, useDesktop, useResizable } from '../lib';
import { useStore } from '../store';
import { PendingCard } from './PendingCards';
import { ChangesPanel } from './ChangesPanel';
import { AttachButton, AttachList, SentAttachments, useAttachments } from './Attachments';
import { SessionTags, StatusBadge } from './SessionBadges';

// Monaco は重いので、「直す」を押した時に初めて読み込む
import { useEditorWorkspace } from '../editor-workspace';

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

/** 道具ごとの印。何をしたか（読む・書く・直す・探す・コマンド）が一目で分かるように */
const TOOL_ICON: Record<string, string> = {
  Read: '📖',
  Write: '📝',
  Edit: '✏️',
  MultiEdit: '✏️',
  NotebookEdit: '✏️',
  Glob: '📂',
  Grep: '🔍',
  Bash: '💻',
  PowerShell: '💻',
  WebFetch: '🌐',
  WebSearch: '🌐',
  Task: '🤖',
  Agent: '🤖',
  TodoWrite: '📋',
  AskUserQuestion: '❓',
  Skill: '🧩',
};

const iconOf = (t: TimelineItem) =>
  t.kind !== 'tool_use' ? ICON[t.kind] : t.imagePath ? '🖼️' : (t.toolName && TOOL_ICON[t.toolName]) || ICON.tool_use;

const URL_RE = /(https?:[^\s)）」]+|`[^`\n]+`)/g;

/** 文中の URL をリンクに、`バッククォート` をコード表示にする（エージェントは Markdown 風に書いてくるので記号のまま見せない） */
function Linkify({ text }: { text: string }) {
  const parts = text.split(URL_RE);
  return (
    <>
      {parts.map((p, i) =>
        /^https?:/.test(p) ? (
          <a key={i} href={p} target="_blank" rel="noreferrer" className="text-sky-400 underline break-all">
            {p}
          </a>
        ) : /^`[^`]+`$/.test(p) ? (
          <code key={i} className="mono text-[0.9em] px-1 py-px rounded bg-zinc-800 text-zinc-200 break-all">
            {p.slice(1, -1)}
          </code>
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
    <div className="rounded-sm border border-zinc-700 bg-zinc-800/40 p-2.5 text-xs text-zinc-300">
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
    <div className={`rounded-sm border p-2.5 text-sm ${cls}`}>
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
    <div className="rounded-sm border border-zinc-700 bg-zinc-800/30 p-2.5 text-sm">
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
      setErr(errMsg(e));
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

/** 「比べる」で作った案どうしの対比表。気に入った案を取り込み、残りを片付ける */
function CompareStrip({ s }: { s: Session }) {
  const sessions = useStore((st) => st.sessions);
  const select = useStore((st) => st.select);
  const [busy, setBusy] = useState(false);
  const c = s.compare;
  if (!c) return null;
  const group = Object.values(sessions)
    .filter((x) => x.compare?.group === c.group)
    .sort((a, b) => a.createdAt - b.createdAt);
  const others = group.filter((x) => x.id !== s.id);
  const merged = !!s.workspace?.lastMerge?.ok;

  // 他の案を片付けた後: 表を出しても比べる相手がいないので、一言だけにする
  if (others.length === 0) {
    return (
      <div className="text-xs bg-violet-400/5 border border-violet-400/30 rounded-md p-2 leading-relaxed text-violet-200/80">
        複数のモデルで比べた案のうち、この案（{c.label}）だけを残しています。
        {merged ? '元のプロジェクトに取り込み済みです。' : '採用するなら下の「元のプロジェクトに取り込む」を押してください。'}
      </div>
    );
  }

  const discard = async () => {
    const names = others.map((x) => x.compare?.label ?? '').join(' / ');
    if (
      !confirm(
        `他の ${others.length} 案（${names}）を削除しますか？\n作業場所（コピー）とブランチも消えます。取り込んでいない変更は失われます。`,
      )
    )
      return;
    setBusy(true);
    try {
      for (const x of others) await api.remove(x.id).catch(() => {});
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="text-xs bg-violet-400/5 border border-violet-400/30 rounded-md p-2 leading-relaxed space-y-1.5">
      <div className="text-violet-200/90">
        同じ依頼を {group.length} つのモデルに投げて比べています。下の表で見比べて、気に入った案を「元のプロジェクトに取り込む」で採用し、残りは片付けてください。
      </div>
      <div className="overflow-x-auto">
        <table className="w-full whitespace-nowrap">
          <thead className="text-zinc-500">
            <tr>
              <th className="text-left font-normal pr-2">モデル</th>
              <th className="text-left font-normal pr-2">状態</th>
              <th className="text-left font-normal pr-2">結果</th>
              <th className="text-left font-normal pr-2">裏取り</th>
              <th className="text-right font-normal pr-2">変更</th>
              <th className="text-right font-normal pr-2">時間</th>
              <th className="text-right font-normal pr-2">費用</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {group.map((x) => {
              const vb = verifyBadge(x);
              const st = STATUS[x.status];
              const me = x.id === s.id;
              const end = WORKING.includes(x.status) ? Date.now() : x.updatedAt;
              return (
                <tr key={x.id} className={`border-t border-zinc-800 ${me ? 'text-zinc-100' : 'text-zinc-300'}`}>
                  <td className="py-1 pr-2">
                    {x.compare?.label}
                    {me && <span className="ml-1 text-violet-300">← いま見ている</span>}
                    {x.workspace?.lastMerge?.ok && <span className="ml-1 text-emerald-300">採用済み</span>}
                  </td>
                  <td className="pr-2">
                    <span className={`px-1.5 py-0.5 rounded ${st.badge}`}>{st.label}</span>
                  </td>
                  <td className="pr-2">
                    {x.report ? (
                      <span className={`px-1.5 py-0.5 rounded ${OUTCOME[x.report.outcome].cls}`}>{OUTCOME[x.report.outcome].label}</span>
                    ) : (
                      <span className="text-zinc-600">—</span>
                    )}
                  </td>
                  <td className="pr-2">
                    {vb ? <span className={`px-1.5 py-0.5 rounded ${vb.cls}`}>{vb.text}</span> : <span className="text-zinc-600">—</span>}
                  </td>
                  <td className="text-right pr-2">{x.changedFiles.length} 件</td>
                  <td className="text-right pr-2">{fmtElapsed(x.createdAt, end)}</td>
                  <td className="text-right pr-2">{fmtUsd(x.costUsd)}</td>
                  <td className="text-right">
                    {!me && (
                      <button onClick={() => select(x.id)} className="underline text-sky-300 hover:text-sky-200">
                        見る
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {others.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap">
          <button disabled={busy} onClick={discard} className={`${btn.base} ${btn.ghost} !py-1 !text-xs`}>
            {busy ? '片付け中…' : `この案を残して、他の ${others.length} 案を片付ける`}
          </button>
          <span className="text-zinc-500">
            {merged ? '取り込み済みなので、他の案は片付けて構いません' : '取り込む前に片付けることもできますが、後で見比べられなくなります'}
          </span>
        </div>
      )}
    </div>
  );
}

/** 使った量（トークン）と費用の目安、会話の大きさ */
function UsageStrip({ s }: { s: Session }) {
  const u = s.usage;
  if (!u || (u.input === 0 && u.output === 0)) return null;
  const ratio = u.context && u.contextWindow ? u.context / u.contextWindow : null;
  const heavy = ratio !== null && ratio >= 0.7;
  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-900/40 p-2 text-xs text-zinc-400 space-y-1">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
        <span className="text-zinc-300">使った量（目安）</span>
        <span title="AI に読ませた量。「使い回し」は前回までの会話をそのまま読み直した分で、新しく読ませたわけではありません">
          読んだ {fmtTokens(u.input)}
          {u.cacheRead > 0 && <span className="text-zinc-500">（うち使い回し {fmtTokens(u.cacheRead)}）</span>}
        </span>
        <span title="AI が書いた量（考えた分も含む）">書いた {fmtTokens(u.output)}</span>
        {s.costUsd > 0 && (
          <span title="API 料金で換算した目安。Max/Pro の定額で使っているなら請求はされません">費用の目安 {fmtUsd(s.costUsd)}</span>
        )}
      </div>
      {ratio !== null && (
        <div className="flex items-center gap-2" title="AI が一度に覚えていられる量に対して、いまの会話がどれだけ占めているか">
          <span className="whitespace-nowrap">会話の大きさ {fmtTokens(u.context!)} / {fmtTokens(u.contextWindow!)}</span>
          <div className="flex-1 h-1.5 rounded bg-zinc-800 overflow-hidden max-w-[160px]">
            <div className={`h-full ${heavy ? 'bg-amber-400' : 'bg-sky-500'}`} style={{ width: `${Math.min(100, Math.round(ratio * 100))}%` }} />
          </div>
          <span className={heavy ? 'text-amber-300' : ''}>{Math.round(ratio * 100)}%</span>
        </div>
      )}
      {heavy && (
        <div className="text-amber-200/90">
          会話が大きくなってきました。この先も続けるなら、区切りの良いところで「新しいタスク」として仕切り直すと、AI が忘れにくくなります。
        </div>
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
    <div className="rounded-md border border-zinc-700 bg-[#171a21] p-2 space-y-2">
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

function TimelineRow({ t, showImages }: { t: TimelineItem; showImages: boolean }) {
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
      <span className="shrink-0 w-5 text-center" title={t.toolName}>{iconOf(t)}</span>
      <div className="min-w-0">
        <span className="break-words whitespace-pre-wrap">{t.text}</span>
        {t.attachments?.length ? <SentAttachments list={t.attachments} /> : null}
      </div>
      <span className="ml-auto shrink-0 text-[11px] text-zinc-600">{fmtTime(t.ts)}</span>
    </div>
  );
  // 画像を読んだ行は、押すと画像を画面の上に大きく出す（詳細は画像の場所だけなので畳まない）
  if (t.imagePath) return <TimelineImageRow t={t} body={body} showAll={showImages} />;
  if (!t.detail) return <div className="px-1 py-0.5">{body}</div>;
  return (
    <div className="px-1 py-0.5">
      <details className="group">
        <summary className="cursor-pointer list-none">{body}</summary>
        <pre className="mono mt-1 ml-7 text-xs whitespace-pre-wrap break-all bg-black/40 rounded p-2 max-h-72 overflow-auto text-zinc-400">
          {t.detail}
        </pre>
      </details>
    </div>
  );
}

const GONE_TEXT = 'この画像はもう残っていません（一時的な場所に置かれていた、など）';

/** エージェントが読んだ画像の行。行か小さい画像を押すと大きく出す。小さい画像は「画像を表示」で出し入れする */
function TimelineImageRow({ t, body, showAll }: { t: TimelineItem; body: ReactNode; showAll: boolean }) {
  const [own, setOwn] = useState<boolean | null>(null);
  const [popup, setPopup] = useState(false);
  const [gone, setGone] = useState(false);
  // 「まとめて表示／隠す」を押したら、行ごとの出し入れはそれに合わせ直す
  useEffect(() => setOwn(null), [showAll]);
  const shown = own ?? showAll;
  const name = t.imagePath?.split(/[\\/]/).pop() ?? '';
  const url = api.timelineImageUrl(t.sessionId, t.id);
  return (
    <div className="px-1 py-0.5">
      <button type="button" onClick={() => setPopup(true)} title="押すと画像を大きく表示します" className="block w-full text-left rounded hover:bg-zinc-800/60 cursor-zoom-in">
        {body}
      </button>
      <div className="ml-7 mt-0.5">
        {gone ? (
          <p className="text-xs text-zinc-500">{GONE_TEXT}</p>
        ) : (
          <button type="button" onClick={() => setOwn(!shown)} aria-pressed={shown} className="text-[11px] px-2 py-0.5 rounded border border-zinc-700 text-zinc-300 hover:bg-zinc-800">
            {shown ? '画像を隠す' : '🖼 画像を表示'}
          </button>
        )}
        {shown && !gone && (
          <button type="button" onClick={() => setPopup(true)} title="押すと大きく表示します" className="mt-1 block max-w-full cursor-zoom-in">
            <img src={url} alt={name} loading="lazy" onError={() => setGone(true)} className="max-h-32 max-w-full rounded border border-zinc-700 bg-black/40 object-contain" />
          </button>
        )}
      </div>
      {popup && <ImagePopup url={url} caption={t.imagePath ?? name} onClose={() => setPopup(false)} />}
    </div>
  );
}

/** 画像を画面いっぱいに出す。外側・「閉じる」・Esc で閉じる。親の枠に縛られないよう body 直下に出す */
function ImagePopup({ url, caption, onClose }: { url: string; caption: string; onClose: () => void }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    // 画面全体の Esc（詳細を閉じる）より先に受け取って、ここだけ閉じる
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  return createPortal(
    <div role="dialog" aria-modal="true" aria-label="画像" onClick={onClose} className="fixed inset-0 z-[100] bg-black/85 flex flex-col items-center justify-center gap-3 p-6 cursor-zoom-out">
      <div className="flex items-center gap-3 max-w-full text-xs text-zinc-300">
        <span className="mono truncate min-w-0" title={caption}>{caption}</span>
        <span className="shrink-0 text-zinc-500">外側を押すか Esc でも閉じます</span>
        <button type="button" autoFocus onClick={onClose} className="shrink-0 px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700">閉じる</button>
      </div>
      {failed ? (
        <p className="text-sm text-zinc-400">{GONE_TEXT}</p>
      ) : (
        <img src={url} alt={caption} onClick={(e) => e.stopPropagation()} onError={() => setFailed(true)} className="max-w-[92vw] max-h-[85vh] object-contain rounded shadow-2xl bg-black/40 cursor-default" />
      )}
    </div>,
    document.body,
  );
}

export function SessionDetail({ id, onShowWorkspace, embedded = false, onClose, hidden = false }: { hidden?: boolean; id: string; onShowWorkspace?: () => void; embedded?: boolean; onClose?: () => void }) {
  const desktop = useDesktop(1100);
  const resize = useResizable('detail', 600, 300, 1000, 'right');
  const [permissionBusy, setPermissionBusy] = useState(false);
  const s = useStore((st) => st.sessions[id]);
  const timeline = useStore((st) => st.timelines[id]);
  const setTimeline = useStore((st) => st.setTimeline);
  const select = useStore((st) => st.select);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showChanges, setShowChanges] = useState(false);
  const openFile = useEditorWorkspace((s) => s.open);
  const setEditing = (path: string) => openFile(id, path, () => setEditVersion((v) => v + 1));
  const [editVersion, setEditVersion] = useState(0);
  const attach = useAttachments();
  // 経過の画像は最初は畳んでおく（場所を取るので）。まとめて出したかどうかは覚えておく
  const [showImages, setShowImages] = useState(() => localStorage.getItem('tower.timeline-images') === '1');
  const toggleImages = () => setShowImages((v) => {
    localStorage.setItem('tower.timeline-images', v ? '0' : '1');
    return !v;
  });
  const bottom = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!timeline) api.timeline(id).then((items) => setTimeline(id, items)).catch((e) => setErr(errMsg(e)));
  }, [id, timeline, setTimeline]);

  // 報告や判断待ちが来たら一番上（カード）へ。作業中に年表が伸びる時だけ下へ追従する
  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 });
  }, [id, s?.pending?.id, s?.report?.generatedAt]);
  useEffect(() => {
    if (s?.status === 'running' && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [timeline?.length, s?.status]);

  if (!s) return null;
  const st = STATUS[s.status];
  const external = s.origin === 'external';
  const alive = isAlive(s.status) && !external;
  const canSend = alive || !!s.agentSessionId;
  const working = WORKING.includes(s.status);

  const send = async () => {
    const t = text.trim();
    if ((!t && !attach.items.length) || busy || !canSend) return;
    setBusy(true);
    setErr(null);
    try {
      await api.message(id, { text: t, attachments: attach.uploads() });
      setText('');
      attach.clear();
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    if (!confirm('このセッションを停止しますか？')) return;
    await api.stop(id).catch((e) => setErr(errMsg(e)));
  };
  const remove = async () => {
    const msg = s.workspace
      ? 'このセッションを一覧から削除しますか？（履歴も消えます）\n別の作業場所（コピー）も消えます。まだ取り込んでいない変更は失われます。'
      : 'このセッションを一覧から削除しますか？（履歴も消えます）';
    if (!confirm(msg)) return;
    await api.remove(id).catch((e) => setErr(errMsg(e)));
  };

  return (
    <section ref={resize.ref} data-resizable-panel={embedded ? undefined : true} aria-label="タスク詳細" style={{ ...(desktop && !embedded ? { width: resize.width, minWidth: 300, flexShrink: 1 } : {}), ...(hidden ? { display: 'none' } : {}) }} className={`w-full border-zinc-800 flex flex-col overflow-hidden bg-[#0c0e12] ${embedded ? 'relative h-full min-h-0 min-w-0' : desktop ? 'relative border-l' : 'fixed inset-0 z-40'}`}>
      {desktop && !embedded && <div role="separator" aria-label="タスク詳細の幅" aria-orientation="vertical" aria-valuemin={300} aria-valuemax={1000} aria-valuenow={resize.actualWidth} tabIndex={0} onMouseDown={resize.onMouseDown} onDoubleClick={resize.reset} onKeyDown={resize.onKeyDown} className="absolute left-0 top-0 bottom-0 w-1.5 z-10 cursor-col-resize hover:bg-sky-500/60 focus:bg-sky-500/60" />}
      <header className="relative p-3 border-b border-zinc-800 space-y-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-semibold">{s.project.name}</span>
          <SessionTags s={s} agent={false} />
          <StatusBadge status={s.status} />
          {s.model && <span className="hidden sm:inline text-xs text-zinc-500">{s.model}</span>}
          <div className="ml-auto flex gap-1.5">
            {alive && (
              <button onClick={stop} className={`${btn.base} ${btn.danger} !py-1 !text-xs`}>
                停止
              </button>
            )}
            <button onClick={remove} className={`${btn.base} ${btn.ghost} !py-1 !text-xs`}>
              削除
            </button>
            {(!embedded || onClose) && <button onClick={onClose ?? (() => select(null))} className={`${btn.base} ${btn.ghost} !py-1 !text-xs`}>
              閉じる
            </button>}
          </div>
        </div>
        <div title={s.title} className="text-sm text-zinc-300 line-clamp-2 break-words [overflow-wrap:anywhere]">{s.title}</div>
        {!desktop && !embedded && <button className="text-xs text-sky-300 text-left" onClick={onShowWorkspace}>ファイル・Git・設定を見る</button>}
        {s.agent === 'claude' && !external && <label className="block text-xs text-zinc-400">許可方針
          <select aria-label="タスクの許可方針" disabled={permissionBusy} value={s.permissionMode ?? 'default'} className="ml-2 bg-zinc-800 rounded px-2 py-1" onChange={async (e) => {
            const mode = e.target.value as PermissionChoice;
            setPermissionBusy(true); setErr(null);
            try { useStore.getState().upsertSession(await api.setPermissionMode(id, mode)); }
            catch (e) { setErr(errMsg(e)); } finally { setPermissionBusy(false); }
          }}>{PERMISSION_CHOICES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}</select>
          {!embedded && <span className="block mt-1">{PERMISSION_CHOICES.find((p) => p.value === s.permissionMode)?.hint}</span>}
        </label>}
        <div className={`text-xs flex items-center gap-2 ${st.working ? 'text-sky-200' : 'text-zinc-500'}`}>
          <span className={`inline-block w-2 h-2 rounded-full ${st.dot}`} />
          <span className="truncate min-w-0" title={s.activity}>{s.activity}</span>
          <span className="ml-auto whitespace-nowrap text-zinc-500">
            {s.turns}往復 · {s.toolCalls}操作
          </span>
        </div>
        {st.working && <span aria-hidden="true" className="working-bar absolute bottom-0 inset-x-0" />}
      </header>

      <div ref={scroller} className="flex-1 overflow-y-auto p-2 space-y-2">
        {external && (
          <div className="text-xs text-indigo-200/80 bg-indigo-400/5 border border-indigo-400/30 rounded-md p-2 leading-relaxed">
            このセッションは {s.externalHint ?? '外部'} で動いています。ここから指示を送ると Tower が会話を引き継ぎます（{s.externalHint ?? '元の画面'} 側で同時に動かさないでください）。
          </div>
        )}
        {s.pending && <PendingCard session={s} />}
        {s.report && <ReportCard r={s.report} onFileClick={() => setShowChanges(true)} />}
        {s.compare && <CompareStrip s={s} />}
        {s.workspace && <WorkspaceStrip s={s} />}
        {s.verification ? (
          <VerificationStrip v={s.verification} baseline={s.baseline} reportOutcome={s.report?.outcome ?? null} />
        ) : (
          s.baseline && <BaselineStrip b={s.baseline} />
        )}
        {s.preview && <PreviewStrip p={s.preview} />}
        <UsageStrip s={s} />
        {s.lastError && (
          <div className="rounded-md border border-red-500/50 bg-red-500/10 p-2 text-xs text-red-200 whitespace-pre-wrap">
            {s.lastError}
          </div>
        )}
        <div className="rounded-md border border-zinc-800 bg-[#12151b] p-3">
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
          <div className="flex items-center gap-2 text-[11px] text-zinc-500 mb-1 px-1">
            <span>経過（クリックで詳細）</span>
            {timeline?.some((t) => t.imagePath) && (
              <button type="button" onClick={toggleImages} aria-pressed={showImages} className="ml-auto underline hover:text-zinc-300">
                {showImages ? '画像をまとめて隠す' : '画像をまとめて表示'}
              </button>
            )}
          </div>
          <div className="space-y-0.5">
            {(timeline ?? []).map((t) => (
              <TimelineRow key={t.id} t={t} showImages={showImages} />
            ))}
            {!timeline && <div className="text-xs text-zinc-500 px-1">読み込み中…</div>}
          </div>
          <div ref={bottom} />
        </div>
      </div>

      <footer
        {...(canSend ? attach.dropProps : {})}
        className={`p-3 border-t space-y-2 ${attach.dragging ? 'border-sky-500 bg-sky-500/10' : 'border-zinc-800'}`}
      >
        <AttachList state={attach} />
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onPaste={canSend ? attach.onPaste : undefined}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void send(); }
          }}
          disabled={!canSend}
          placeholder={
            alive
              ? '追加の指示（Ctrl+Enter で送信）。画像は貼り付け（Ctrl+V）かドラッグで添えられます'
              : external && s.agentSessionId
                ? `続きの指示（送ると Tower が ${s.externalHint ?? '外部'} から引き継ぎます）`
                : s.agentSessionId
                  ? '続きの指示（止まっているので、送ると再開します）'
                  : 'このセッションは再開できません'
          }
          rows={embedded ? 2 : 3}
          className="w-full text-sm bg-black/30 border border-zinc-700 rounded-md px-3 py-2 outline-none focus:border-zinc-500 disabled:opacity-50 resize-none"
        />
        <div className="flex items-center gap-2">
          <button
            disabled={!canSend || busy || (!text.trim() && !attach.items.length)}
            onClick={send}
            className={`${btn.base} ${btn.primary}`}
          >
            {alive ? '送信' : external ? '引き継いで送信' : '再開して送信'}
          </button>
          <AttachButton state={attach} disabled={!canSend || busy} />
          {err && <span className="text-xs text-red-400">{err}</span>}
        </div>
      </footer>


    </section>
  );
}
