import React, { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { Preview, Report, Screenshot, Session, TimelineItem, Verification } from '@tower/shared';
import { CODEX_PERMISSION_CHOICES, PERMISSION_CHOICES, workDir, type PermissionChoice } from '@tower/shared';
import { api, errMsg } from '../api';
import { OUTCOME, STATUS, btn, fmtElapsed, fmtTime, fmtTokens, fmtUsd, isAlive, loadLocal, saveLocal, verifyBadge, useDesktop, useResizable, useSettled } from '../lib';
import { canMarkDone, mergedSinceReport, onlyOldFailures, reportContext, verificationIsStale, type ReportContext } from '../task-state';
import { useStore } from '../store';
import { openTask } from '../layout';
import { PendingCard } from './PendingCards';
import { ChangesPanel } from './ChangesPanel';
import { AttachButton, AttachList, SentAttachments, useAttachments } from './Attachments';
import { ReplyBody, useFileLinker, type FileLinker } from './Reply';
import { shortPath } from '../reply-links';
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

/** 起動直後の自動チェック（返事が来る前に見せる） */
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
  // 前からの失敗が残っているだけ: 今回の変更のせいではないので赤で責めない（エージェントの説明と食い違って見えていた）
  const old = onlyOldFailures({ verification: v, baseline });
  const conflict = v.ok === false && reportOutcome === 'done' && !old;
  const verdict = compareVerdict(baseline, v);
  const cls =
    v.ok === null
      ? 'border-zinc-700 bg-zinc-800/40'
      : v.ok
        ? 'border-emerald-500/40 bg-emerald-500/5'
        : old
          ? 'border-amber-500/50 bg-amber-500/5'
          : 'border-red-500/60 bg-red-500/10';
  return (
    <div className={`rounded-sm border p-2.5 text-sm ${cls}`}>
      <button onClick={() => setOpen((o) => !o)} className="w-full flex items-center gap-2 text-left">
        <span>{v.ok === null ? '⏳' : v.ok ? '✔' : old ? '△' : '✖'}</span>
        <span className="font-medium">
          {v.ok === null ? '裏取り中' : v.ok ? '裏取りOK' : old ? '裏取り: 前からの失敗' : '裏取りNG'}
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
          エージェントは「完了」と報告していますが、テストは失敗しています。鵜呑みにせず、追加指示で直させてください。
        </div>
      )}
      {old && (
        <div className="mt-1.5 text-xs text-amber-200/90">
          この失敗は作業を始める前から出ていて、今回の変更で増えたものはありません。今回の変更の良し悪しには関係しません。
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
export function WorkspaceStrip({ s }: { s: Session }) {
  const ws = s.workspace;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (!ws) return null;
  const working = ['starting', 'running', 'waiting_permission', 'waiting_question'].includes(s.status);
  const merged = mergedSinceReport(s) && !working;

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
        {merged ? 'この返事までの変更は、元のプロジェクトに取り込み済みです。再度取り込む必要はありません。'
          : ws.lastMerge?.ok ? '前回の変更は取り込み済みです。その後の作業は、このコピーで進めています。'
          : '別の作業場所（コピー）で作業しています。変更は「取り込む」を押すまで元のプロジェクトには反映されません。'}
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <button
          disabled={busy || working || merged}
          onClick={merge}
          title={working ? '作業中は取り込めません。返事が来てから押してください' : undefined}
          className={`${btn.base} ${btn.success} !py-1 !text-xs`}
        >
          {busy ? '取り込み中…' : merged ? '取り込み済み' : ws.lastMerge?.ok ? '追加の変更を取り込む' : '元のプロジェクトに取り込む'}
        </button>
        <span className="mono text-zinc-500">{ws.branch}</span>
        {working && <span className="text-zinc-500">作業中は取り込めません</span>}
      </div>
      {ws.mergeFix ? (
        <div className="whitespace-pre-wrap text-amber-200">
          ⏳ 元のプロジェクトの変更とぶつかったので、AI に合わせて直してもらっています。直した返事が来たら、Tower がもう一度取り込みます（AI から質問が来たら答えてください）。
          <span className="text-zinc-500 ml-2">{fmtTime(ws.mergeFix.at)}</span>
        </div>
      ) : ws.lastMerge && (
        <div className={`whitespace-pre-wrap ${ws.lastMerge.ok ? 'text-emerald-200' : 'text-red-200'}`}>
          {ws.lastMerge.ok ? '✔ ' : '✖ '}
          {ws.lastMerge.at < (s.lastInstructionAt ?? 0) && '前回の取り込み結果: '}
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
  const [busy, setBusy] = useState(false);
  const c = s.compare;
  if (!c) return null;
  const group = Object.values(sessions)
    .filter((x) => x.compare?.group === c.group)
    .sort((a, b) => a.createdAt - b.createdAt);
  const others = group.filter((x) => x.id !== s.id);
  const merged = mergedSinceReport(s) && !WORKING.includes(s.status);

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
        {merged ? 'この案は取り込み済みです。下の表で、他の案と返事をした時点の結果を見比べられます。' : `同じ依頼の ${group.length} つの案を比べています。採用する案の取り込み状況は、下の作業場所の欄で確認できます。`}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full whitespace-nowrap">
          <thead className="text-zinc-500">
            <tr>
              <th className="text-left font-normal pr-2">モデル</th>
              <th className="text-left font-normal pr-2">状態</th>
              <th className="text-left font-normal pr-2">返事の時点の結果</th>
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
              const me = x.id === s.id;
              const end = WORKING.includes(x.status) ? Date.now() : x.updatedAt;
              return (
                <tr key={x.id} className={`border-t border-zinc-800 ${me ? 'text-zinc-100' : 'text-zinc-300'}`}>
                  <td className="py-1 pr-2">
                    {x.compare?.label}
                    {me && <span className="ml-1 text-violet-300">← いま見ている</span>}
                    {mergedSinceReport(x) && !WORKING.includes(x.status) && <span className="ml-1 text-emerald-300">採用済み</span>}
                  </td>
                  <td className="pr-2">
                    <StatusBadge s={x} className="text-[11px]" />
                  </td>
                  <td className="pr-2">
                    {x.report ? (
                      <span className={`px-1.5 py-0.5 rounded ${OUTCOME[x.report.outcome].cls}`}>{x.report.outcome === 'unknown' ? '💬 返事あり' : OUTCOME[x.report.outcome].label}</span>
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
                      <button onClick={() => openTask(x.id)} className="underline text-sky-300 hover:text-sky-200">
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

/** 返事の本文。原文が空の古い報告だけ、読み取った欄から組み立てる */
const replyText = (r: Report) => r.raw?.trim() || [r.needsDecision, ...(r.summary ?? []), r.nextStep].filter(Boolean).join('\n\n') || '（本文はありません）';

/**
 * エージェントの返事を書き換えずにそのまま出す（Markdown として読みやすく）。Tower が足すのは、
 * 返事の後に起きたこと（取り込んだ・完了にした・作業を再開した）と、この回に変えたファイルの一覧だけ。
 * 結果の札は、以前の決まった書式の報告（完了・一部完了…が分かるもの）と、失敗で終わった時だけ出す
 */
export function ReportCard({ r, onFileClick, context = 'current', linker }: { r: Report; onFileClick?: () => void; context?: ReportContext; linker?: FileLinker }) {
  const o = OUTCOME[r.outcome];
  return (
    <section aria-label="エージェントの返事" className="rounded-md border border-zinc-700 bg-[#171a21] p-2.5 space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-xs text-zinc-400">💬 返事</span>
        {r.outcome !== 'unknown' && <span className={`text-xs px-2 py-0.5 rounded ${o.cls}`}>{o.label}</span>}
        <span className="text-xs text-zinc-500 ml-auto">{fmtTime(r.generatedAt)}</span>
      </div>
      {context !== 'current' && <div className="text-xs text-zinc-300">
        {context === 'merged' ? 'この返事の後、変更を元のプロジェクトに取り込みました。'
          : context === 'completed' ? 'この返事の後、タスクを完了にしました。'
          : 'この返事の後に作業を再開しています。いまの作業の結果ではありません。'}
      </div>}
      <ReplyBody text={replyText(r)} linker={linker} />
      {r.changedFiles.length > 0 && (
        <div className="border-t border-zinc-800 pt-2">
          <div className="text-[11px] text-zinc-500 mb-0.5">変更したファイル（{r.changedFiles.length}）— 押すと差分を見られます</div>
          <ul className="mono text-xs space-y-0.5 text-zinc-300 max-h-40 overflow-auto">
            {r.changedFiles.map((f) => (
              <li key={f}>
                <button onClick={onFileClick} className="hover:text-sky-300 hover:underline text-left break-all" title={`${f}\n差分を見る`}>
                  {linker ? shortPath(f, linker.root) : f}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

/** 古い経過の「報告を書きました（上の「報告」に表示）」の行（本文が残っていないもの） */
const OLD_REPORT_POINTER = /^報告を書きました/;

/**
 * 経過の 1 行。並びが伸びても、届いた行・変わった行だけを描き直す（memo）。
 * エージェントの文章は全文を Markdown で出す（上の返事と同じものは 1 行の案内だけ）。
 * 道具の行の詳細（長いと 1 万字を超える）は開いた時に初めて作る
 */
const TimelineRow = React.memo(function TimelineRow({ t, showImages, pointer = false, linker }: { t: TimelineItem; showImages: boolean; pointer?: boolean; linker?: FileLinker }) {
  if (t.kind === 'assistant_text') return <AssistantRow t={t} pointer={pointer || (!t.detail && OLD_REPORT_POINTER.test(t.text))} linker={linker} />;
  return <StepRow t={t} showImages={showImages} />;
});

function AssistantRow({ t, pointer, linker }: { t: TimelineItem; pointer: boolean; linker?: FileLinker }) {
  const time = <span className="ml-auto shrink-0 text-[11px] text-zinc-600">{fmtTime(t.ts)}</span>;
  if (pointer) {
    return (
      <div className="px-1 py-0.5 flex gap-2 text-sm text-zinc-500">
        <span className="shrink-0 w-5 text-center">{ICON.assistant_text}</span>
        <span>返事（上に表示）</span>
        {time}
      </div>
    );
  }
  return (
    <div className="px-1 py-1 flex gap-2 text-sm">
      <span className="shrink-0 w-5 text-center">{ICON.assistant_text}</span>
      <div className="min-w-0 flex-1">
        <ReplyBody text={t.detail ?? t.text} linker={linker} clamp="sm" />
      </div>
      {time}
    </div>
  );
}

/** 指示・道具・許可・お知らせの行。詳細（道具の出力など）があれば押すと開く */
function StepRow({ t, showImages }: { t: TimelineItem; showImages: boolean }) {
  const [open, setOpen] = useState(false);
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
      <details className="group" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
        <summary className="cursor-pointer list-none">{body}</summary>
        {open && (
          <pre className="mono mt-1 ml-7 text-xs whitespace-pre-wrap break-all bg-black/40 rounded p-2 max-h-72 overflow-auto text-zinc-400">
            {t.detail}
          </pre>
        )}
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
  const [collaborationBusy, setCollaborationBusy] = useState(false);
  const s = useStore((st) => st.sessions[id]);
  const timeline = useStore((st) => st.timelines[id]);
  const setTimeline = useStore((st) => st.setTimeline);
  const loadingTimeline = useStore((st) => st.loadingTimeline);
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
  const [showImages, setShowImages] = useState(() => loadLocal('tower.timeline-images') === '1');
  const toggleImages = () => setShowImages((v) => {
    saveLocal('tower.timeline-images', v ? '0' : '1');
    return !v;
  });
  // 「それより前のやりとり」は開いた時に初めて行を作る（畳んだままの何百行を毎回作らない）
  const [olderOpen, setOlderOpen] = useState(false);
  // 変更ファイルの読み直しは、操作のたびではなく作業が 2 秒落ち着いてから（続く時も 8 秒ごとには読む）
  const changesKey = useSettled(s ? s.turns + s.toolCalls : 0, 2000);
  const bottom = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const followOutput = useRef(true);
  // 返事の中のファイル名を押すと、ここで開く（保存したら変更ファイルを読み直す）
  const linker = useFileLinker(id, s ? workDir(s) : undefined, () => setEditVersion((v) => v + 1));
  // 上に出している返事と同じ文章の経過の行（いちばん後ろのもの）。経過では 1 行の案内にして、2 度出さない
  const replyRaw = s?.report?.raw?.trim();
  const shownReplyId = useMemo(() => {
    if (!replyRaw || !timeline) return null;
    for (let i = timeline.length - 1; i >= 0; i--) {
      const t = timeline[i];
      if (t.kind === 'assistant_text' && (t.detail ?? t.text).trim() === replyRaw) return t.id;
    }
    return null;
  }, [timeline, replyRaw]);

  useEffect(() => {
    if (timeline) return;
    // 読んでいる間に届いた経過は取っておいて、読み終わった時に混ぜる（取りこぼさない）
    loadingTimeline(id);
    api.timeline(id).then((items) => setTimeline(id, items)).catch((e) => setErr(errMsg(e)));
  }, [id, timeline, setTimeline, loadingTimeline]);

  // 返事や判断待ちが来たら一番上（カード）へ。上の経過を読んでいる間は末尾へ戻さない
  useLayoutEffect(() => {
    followOutput.current = true;
    scroller.current?.scrollTo({ top: 0 });
  }, [id, s?.pending?.id, s?.report?.generatedAt]);
  // 経過が届いたら末尾へ。長さではなく並びそのものを見る（上限まで溜まると、届いても長さが変わらない）
  useLayoutEffect(() => {
    if (s?.status === 'running' && followOutput.current && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [timeline, s?.status, s?.liveOutput]);

  if (!s) return null;
  // 経過は最後の指示から後だけを見せ、それより前のやりとりは畳む。上の返事はいちばん新しいやりとりのものなので、
  // 最初の指示からの経過を並べると、上の返事と下の経過で話がずれて見えていた
  const items = timeline ?? [];
  let lastUser = -1;
  for (let i = items.length - 1; i >= 0; i--) if (items[i].kind === 'user') { lastUser = i; break; }
  const older = lastUser > 0 ? items.slice(0, lastUser) : [];
  const latest = lastUser > 0 ? items.slice(lastUser) : items;
  const st = STATUS[s.status];
  const external = s.origin === 'external';
  const alive = (isAlive(s.status) || s.verification?.ok === null || s.baseline?.ok === null) && !external;
  const canSend = alive || !!s.agentSessionId;
  const working = WORKING.includes(s.status);
  const permissionChoices = s.agent === 'codex' ? CODEX_PERMISSION_CHOICES : PERMISSION_CHOICES;

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
  // 返事を読んで「もうこれでよい」と決めた時に。判断待ちから外れる。もう完了しているものには出さない
  const canComplete = canMarkDone(s);
  const complete = async () => {
    const head = working ? '作業を止めて、このタスクを「完了」にしますか？' : 'このタスクを「完了」にしますか？';
    const tail = s.agentSessionId ? '判断待ちの一覧から外れます。続きの指示を送れば、また再開できます。' : '判断待ちの一覧から外れます。';
    if (!confirm(`${head}\n${tail}`)) return;
    setErr(null);
    await api.complete(id).catch((e) => setErr(errMsg(e)));
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
      <header className={`relative p-3 border-b border-zinc-800 space-y-1 ${st.working ? 'working-head' : ''}`}>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-semibold">{s.project.name}</span>
          <SessionTags s={s} agent={false} />
          <StatusBadge s={s} />
          {(s.effectiveModel || s.model) && <span className="text-xs text-zinc-400" title={s.effectiveModel ? 'Codexが返した実際の設定' : '指定したモデル（実適用値は未取得）'}>
            {s.effectiveModel || s.model}{s.reasoningEffort ? ` · ${s.reasoningEffort}` : ''}
          </span>}
          <div className="ml-auto flex gap-1.5">
            {canComplete && (
              <button onClick={complete} title="これで終わりにします。判断待ちから外れます（続きの指示を送れば、また再開できます）" className={`${btn.base} ${btn.success} !py-1 !text-xs`}>
                完了にする
              </button>
            )}
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
        {!external && s.agent === 'codex' && <label className="block text-xs text-zinc-400">作業モード
          <select aria-label="タスクの作業モード" disabled={collaborationBusy} value={s.codexCollaborationMode ?? 'default'} className="ml-2 bg-zinc-800 rounded px-2 py-1" onChange={async e => {
            setCollaborationBusy(true); setErr(null);
            try { useStore.getState().upsertSession(await api.setCodexCollaborationMode(id, e.target.value as 'default' | 'plan')); }
            catch (error) { setErr(errMsg(error)); } finally { setCollaborationBusy(false); }
          }}><option value="default">通常</option><option value="plan">計画</option></select>
          <span className="block mt-1">計画モードでは調査・質問をして計画を立てます。現在の応答が終わった後の新しい指示から反映します。すぐに切り替えるには停止してから指示を送ってください。</span>
        </label>}
        {!external && <label className="block text-xs text-zinc-400">許可方針
          <select aria-label="タスクの許可方針" disabled={permissionBusy} value={s.permissionMode ?? 'default'} className="ml-2 bg-zinc-800 rounded px-2 py-1" onChange={async (e) => {
            const mode = e.target.value as PermissionChoice;
            setPermissionBusy(true); setErr(null);
            try { useStore.getState().upsertSession(await api.setPermissionMode(id, mode)); }
            catch (e) { setErr(errMsg(e)); } finally { setPermissionBusy(false); }
          }}>{permissionChoices.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}</select>
          <span className="block mt-1">{permissionChoices.find((p) => p.value === (s.permissionMode ?? 'default'))?.hint}</span>
          {s.agent === 'codex' && <span className="block mt-1">現在の応答が終わった後の新しい指示から反映します。すぐに切り替えるには停止してから指示を送ってください。</span>}
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

      <div ref={scroller} onScroll={(e) => {
        const el = e.currentTarget;
        followOutput.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 64;
      }} className="flex-1 overflow-y-auto p-2 space-y-2">
        {/* 外で作業している最中だけ注意する。止まっている時は指示欄の案内で足りる（毎回の大きな枠は場所を取るだけだった） */}
        {external && working && (
          <div className="text-xs text-indigo-200/80 bg-indigo-400/5 border border-indigo-400/30 rounded-md p-2 leading-relaxed">
            いま {s.externalHint ?? 'Tower の外'} で作業中です。ここから指示を送ると両方で同時に動いてしまうので、終わるのを待ってから送ってください。
          </div>
        )}
        {s.pending && <PendingCard session={s} />}
        {s.report && (reportContext(s) === 'previous' ? (
          // 作業中は前の回の返事をたたみ、今の作業の経過を先に見せる
          <details className="rounded-md border border-zinc-800 bg-[#12151b] px-3 py-2 text-xs text-zinc-400">
            <summary className="cursor-pointer hover:text-zinc-200">前回の返事を見る{s.report.outcome !== 'unknown' && `（${OUTCOME[s.report.outcome].label}）`}</summary>
            <div className="mt-2"><ReportCard r={s.report} context="previous" linker={linker} onFileClick={() => setShowChanges(true)} /></div>
          </details>
        ) : <ReportCard r={s.report} context={reportContext(s)} linker={linker} onFileClick={() => setShowChanges(true)} />)}
        {s.compare && <CompareStrip s={s} />}
        {s.workspace && <WorkspaceStrip s={s} />}
        {s.verification ? (
          verificationIsStale(s) ? <details className="rounded-md border border-zinc-800 p-2 text-xs text-zinc-400">
            <summary className="cursor-pointer">前回の自動チェックを見る（{fmtTime(s.verification.at)}）</summary>
            <div className="mt-2">現在の作業に対するチェック結果はまだありません。</div>
            <VerificationStrip v={s.verification} baseline={s.baseline} reportOutcome={null} />
          </details> : <VerificationStrip v={s.verification} baseline={s.baseline} reportOutcome={s.report?.outcome ?? null} />
        ) : (
          s.baseline && <BaselineStrip b={s.baseline} />
        )}
        {s.preview && <PreviewStrip p={s.preview} />}
        <UsageStrip s={s} />
        {!!s.subagents?.length && <details className="rounded-md border border-zinc-800 bg-[#12151b] p-3 text-xs" open={s.subagents.some(a => ['running', 'pendingInit', 'errored'].includes(a.status))}>
          <summary className="cursor-pointer">サブエージェント（{s.subagents.length}）</summary>
          <div className="mt-2 space-y-2">{s.subagents.map(agent => <div key={agent.id} className="rounded border border-zinc-800 p-2">
            <div className="flex gap-2"><span className="break-all">{agent.name || agent.id}</span><span className={agent.status === 'errored' ? 'text-red-300' : 'text-sky-200'}>{({ pendingInit: '起動中', running: '作業中', completed: '完了', interrupted: '中断', errored: '失敗', shutdown: '終了', notFound: '見つかりません' } as Record<string, string>)[agent.status] ?? agent.status}</span></div>
            {agent.message && <details className="mt-1"><summary className="cursor-pointer text-zinc-400">結果を見る</summary><div className="whitespace-pre-wrap break-words mt-1">{agent.message}</div></details>}
          </div>)}</div>
        </details>}
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
                refreshKey={changesKey + editVersion}
                onEdit={working ? undefined : setEditing}
                editHint="エージェントが作業中は編集できません。返事が来るか、停止してから直してください"
              />
            </div>
          )}
        </div>

        <div>
          <div className="flex items-center gap-2 text-[11px] text-zinc-500 mb-1 px-1">
            <span>{working ? '今の作業の経過' : older.length ? '最後の指示からの経過' : '経過'}（クリックで詳細）</span>
            {timeline?.some((t) => t.imagePath) && (
              <button type="button" onClick={toggleImages} aria-pressed={showImages} className="ml-auto underline hover:text-zinc-300">
                {showImages ? '画像をまとめて隠す' : '画像をまとめて表示'}
              </button>
            )}
          </div>
          {older.length > 0 && (
            <details className="mb-1 rounded border border-zinc-800 bg-[#12151b] px-2 py-1" open={olderOpen} onToggle={(e) => setOlderOpen(e.currentTarget.open)}>
              <summary className="cursor-pointer text-xs text-zinc-400 hover:text-zinc-200">
                それより前のやりとりを見る（{older.length} 件）
              </summary>
              {olderOpen && (
                <div className="mt-1 space-y-0.5">
                  {older.map((t) => (
                    <TimelineRow key={t.id} t={t} showImages={showImages} pointer={t.id === shownReplyId} linker={linker} />
                  ))}
                </div>
              )}
            </details>
          )}
          <div className="space-y-0.5">
            {latest.map((t) => (
              <TimelineRow key={t.id} t={t} showImages={showImages} pointer={t.id === shownReplyId} linker={linker} />
            ))}
            {!timeline && <div className="text-xs text-zinc-500 px-1">読み込み中…</div>}
          </div>
          {working && !!s.liveOutput?.length && <section aria-label="現在の出力" className="mt-2 space-y-2">
            {s.liveOutput.map((output) => <div key={output.itemId} className="rounded-md border border-sky-900 bg-sky-950/20 p-3">
              <div className="text-xs text-sky-300 mb-2">{output.kind === 'assistant_text' ? 'Codex が回答中' : 'コマンドの実行出力'}</div>
              {output.truncated && <p className="text-xs text-zinc-400 mb-1">出力が長いため、末尾を表示しています。</p>}
              <pre tabIndex={0} className={`max-h-80 overflow-auto whitespace-pre-wrap break-words text-xs text-zinc-200 leading-relaxed ${output.kind === 'command_output' ? 'mono' : 'font-sans'}`}>{output.text}</pre>
            </div>)}
          </section>}
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
                ? `続きの指示（送ると、${s.externalHint ? `${s.externalHint} で始めた` : 'Tower の外で始めた'}会話の続きを Tower が引き受けます）`
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
