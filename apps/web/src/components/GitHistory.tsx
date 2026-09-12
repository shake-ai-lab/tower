import { useEffect, useRef, useState } from 'react';
import type { CommitTask, HistoryCommit } from '@tower/shared';
import { projectHue } from '../lib';

type Commit = HistoryCommit;

/** タスクごとの色（同じタスクは常に同じ色）。グラフの点の輪・札・行の印に使う */
const taskColor = (id: string, alpha = 1) => `hsl(${projectHue(id)} 75% 62% / ${alpha})`;

/** 説明の最後のタスクの印（Tower-Task: の行）は、読む人には雑音なので出さない */
const withoutTaskMark = (message: string) => message.replace(/\n*^Tower-Task:.*$/gim, '').trim();

/** VS Code の Git Graph 拡張と同じ配色（線ごとに順番に使う） */
const COLORS = ['#0085d9', '#d9008f', '#00d90a', '#d98500', '#a300d9', '#ff0000', '#00d9cc', '#e138e8', '#85d900', '#dc5b23', '#6f24d6', '#ffcc00'];
const LANE = 16, ROW = 24, LEFT = 12, R = 4;

interface Segment { from: number; to: number; hash: string; color: string }
interface Row extends Commit { lane: number; color: string; /** この行の点から次の行へ伸びる線 */ down: Segment[] }

/**
 * 縦の列（レーン）に線を割り当てる。Git Graph 拡張と同じ考え方:
 * 各レーンは「次に来るはずのコミット」を覚えていて、そのコミットの行に来たら点を置き、最初の親へ線をつなぐ。
 * 2 番目以降の親（マージ元）は既にあるレーンへ曲げるか、新しいレーンを作る。
 */
function layout(commits: Commit[]): Row[] {
  const expect: (string | null)[] = [];
  const laneColor: string[] = [];
  let colorIndex = 0;
  const nextColor = () => COLORS[colorIndex++ % COLORS.length];
  const rows: Row[] = [];
  for (const commit of commits) {
    const prev = rows[rows.length - 1];
    let lane = expect.indexOf(commit.hash);
    if (lane < 0) {
      lane = expect.indexOf(null);
      if (lane < 0) lane = expect.length;
      laneColor[lane] = nextColor();
    }
    // このコミットに向かっていた線は全部この点に集める（別レーンから来た線は曲げて空ける）
    for (let i = 0; i < expect.length; i++) if (expect[i] === commit.hash && i !== lane) expect[i] = null;
    if (prev) for (const seg of prev.down) if (seg.hash === commit.hash) seg.to = lane;
    const color = laneColor[lane];
    const down: Segment[] = [];
    // この行を素通りする線（このコミットのレーン以外で、既に上から来ている線）
    expect.forEach((hash, i) => { if (hash && i !== lane) down.push({ from: i, to: i, hash, color: laneColor[i] }); });
    const first = commit.parents[0] ?? null;
    expect[lane] = first;
    if (first) down.push({ from: lane, to: lane, hash: first, color });
    commit.parents.slice(1).forEach((parent) => {
      let target = expect.indexOf(parent);
      if (target < 0) {
        target = expect.indexOf(null);
        if (target < 0) target = expect.length;
        expect[target] = parent;
        laneColor[target] = nextColor();
      }
      down.push({ from: lane, to: target, hash: parent, color: laneColor[target] });
    });
    rows.push({ ...commit, lane, color, down });
  }
  return rows;
}

interface Ref { kind: 'head' | 'branch' | 'remote' | 'tag' | 'other'; name: string }
function parseRefs(refs: string): Ref[] {
  return refs.split(',').map((s) => s.trim()).filter(Boolean).map((ref) => {
    if (ref.startsWith('HEAD -> ')) return { kind: 'head', name: ref.slice(8) };
    if (ref.startsWith('tag: ')) return { kind: 'tag', name: ref.slice(5) };
    if (ref === 'HEAD') return { kind: 'other', name: ref };
    if (ref.startsWith('origin/')) return { kind: 'remote', name: ref };
    return { kind: 'branch', name: ref };
  });
}

function formatDate(iso?: string): { short: string; full: string } {
  if (!iso) return { short: '', full: '' };
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { short: iso, full: iso };
  const pad = (n: number) => String(n).padStart(2, '0');
  return { short: `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`, full: d.toLocaleString('ja-JP') };
}

function RefLabel({ r, color }: { r: Ref; color: string }) {
  const icon = r.kind === 'tag'
    ? 'M3 12V3h9l9 9-9 9-9-9Z M7 7h.01'
    : 'M6 6v12 M18 6v3c0 5-12 2-12 7 M9 3a3 3 0 1 1-6 0a3 3 0 1 1 6 0 M9 21a3 3 0 1 1-6 0a3 3 0 1 1 6 0 M21 3a3 3 0 1 1-6 0a3 3 0 1 1 6 0';
  const strong = r.kind === 'head';
  return <span className={`inline-flex items-center gap-1 h-[18px] px-1.5 mr-1 rounded-[3px] text-[11px] leading-none whitespace-nowrap align-middle ${strong ? 'font-bold' : ''}`}
    style={{ border: `1px solid ${color}`, background: strong ? color : `${color}33`, color: strong ? '#fff' : '#e4e4e7' }}
    title={r.kind === 'head' ? `今いるブランチ: ${r.name}` : r.kind === 'remote' ? `リモートのブランチ: ${r.name}` : r.kind === 'tag' ? `タグ: ${r.name}` : `ブランチ: ${r.name}`}>
    <svg aria-hidden="true" viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d={icon} /></svg>{r.name}
  </span>;
}

/** どのタスクの記録かの札。他のタスクの札は押すとそのタスクを開く */
function TaskChip({ task, mine, onOpen }: { task: CommitTask; mine: boolean; onOpen?: (id: string) => void }) {
  const color = taskColor(task.id);
  const cls = 'inline-flex items-center h-[18px] max-w-[14em] px-1.5 mr-1 rounded-full text-[11px] leading-none align-middle text-zinc-100';
  const style = { border: `1px solid ${color}`, background: taskColor(task.id, mine ? 0.35 : 0.15) };
  if (mine || !task.title || !onOpen) {
    const label = mine ? 'このタスク' : task.title ?? '消したタスク';
    const hint = mine ? 'このタスクが記録したもの' : task.title ? `タスク「${task.title}」が記録したもの` : 'Tower のタスクが記録したもの（そのタスクはもう消しました）';
    return <span className={cls} style={style} title={hint}><span className="truncate">{label}</span></span>;
  }
  return <button type="button" className={`${cls} hover:brightness-125`} style={style} title={`タスク「${task.title}」が記録したもの。押すとそのタスクを開きます`}
    onClick={(e) => { e.stopPropagation(); onOpen(task.id); }}><span className="truncate">{task.title}</span></button>;
}

/**
 * @param taskId     いま見ているタスク。そのタスクの記録の行に色の印を付ける
 * @param onOpenTask 他のタスクの札を押した時
 */
export function GitHistory({ commits, taskId, onOpenTask }: { commits: Commit[]; taskId?: string; onOpenTask?: (id: string) => void }) {
  const [selected, setSelected] = useState<string | null>(null);
  const ref = useRef<HTMLElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  /** 狭い時は日付・作者の列をたたむ（内容はツールチップと下の詳細で見られる） */
  const compact = width > 0 && width < 560;
  const rows = layout(commits);
  const laneCount = Math.max(0, ...rows.map((r) => Math.max(r.lane, ...r.down.map((s) => Math.max(s.from, s.to))))) + 1;
  const graphWidth = LEFT * 2 + (laneCount - 1) * LANE;
  const x = (lane: number) => LEFT + lane * LANE;
  const th = 'sticky top-0 z-10 bg-[#161a22] text-left font-semibold text-[11px] text-zinc-300 px-2 h-[24px] border-b border-zinc-700 whitespace-nowrap';
  const td = 'px-2 h-[24px] text-[12px] whitespace-nowrap overflow-hidden text-ellipsis max-w-0';
  const mineCount = taskId ? rows.filter((r) => r.task?.id === taskId).length : 0;
  const anyTask = rows.some((r) => r.task);
  return <section ref={ref} aria-label="コミットグラフ" className="border border-zinc-800 bg-black/15 overflow-hidden">
    <h3 className="flex flex-wrap items-center gap-x-2 text-xs font-semibold px-3 py-2 border-b border-zinc-800"><span className="whitespace-nowrap">コミット履歴</span><span className="whitespace-nowrap font-normal text-[11px] text-zinc-500">最新40件・全ブランチ</span>
      {mineCount > 0 && taskId
        ? <span className="inline-flex items-center gap-1 whitespace-nowrap font-normal text-[11px] text-zinc-300" title="色の輪が付いた点が、Tower のタスクが記録したもの"><span aria-hidden="true" className="inline-block w-2.5 h-2.5 rounded-full" style={{ border: `2px solid ${taskColor(taskId)}` }} />このタスクの記録 {mineCount} 件</span>
        : anyTask && <span className="whitespace-nowrap font-normal text-[11px] text-zinc-500">色の輪＝タスクの記録</span>}
    </h3>
    {!rows.length ? <p className="p-3 text-xs text-zinc-500">コミットはまだありません。</p> : <div className="max-h-96 overflow-auto">
      <table className="w-full border-collapse table-fixed" style={{ minWidth: graphWidth + (compact ? 200 : 420) }}>
        <colgroup><col style={{ width: graphWidth + 8 }} /><col />{!compact && <><col style={{ width: 118 }} /><col style={{ width: 96 }} /></>}<col style={{ width: 64 }} /></colgroup>
        <thead><tr><th className={th}>グラフ</th><th className={th}>説明</th>{!compact && <><th className={th}>日付</th><th className={th}>作者</th></>}<th className={th}>コミット</th></tr></thead>
        <tbody className="relative">
          {rows.map((row, index) => {
            const refs = parseRefs(row.refs);
            const isHead = refs.some((r) => r.kind === 'head' || (r.kind === 'other' && r.name === 'HEAD'));
            const on = row.hash === selected;
            const task = row.task;
            const mine = !!task && task.id === taskId;
            const taskLine = task ? (mine ? 'このタスクの記録' : task.title ? `タスク「${task.title}」の記録` : '消したタスクの記録') : '';
            return <tr key={row.hash} className={`cursor-pointer border-b border-zinc-800/40 ${on ? 'bg-sky-400/15' : 'hover:bg-white/5'}`} style={mine && !on ? { background: taskColor(task.id, 0.08) } : undefined} onClick={() => setSelected(on ? null : row.hash)} title={[row.subject, taskLine, row.refs, `${row.author} · ${formatDate(row.date).full}`, row.hash].filter(Boolean).join('\n')}>
              <td className="p-0 h-[24px] align-top relative" style={{ width: graphWidth + 8, boxShadow: mine ? `inset 3px 0 0 ${taskColor(task.id)}` : undefined }}>
                <svg aria-hidden="true" className="block overflow-visible" width={graphWidth} height={ROW}>
                  {/* この行の点から下の行の点へ伸びる線（枠をはみ出して描く） */}
                  {index < rows.length - 1 && row.down.map((seg, i) => {
                    const x1 = x(seg.from), x2 = x(seg.to), yMid = ROW / 2, yBottom = ROW * 1.5;
                    return <path key={`d${i}`} d={x1 === x2 ? `M${x1},${yMid} L${x2},${yBottom}` : `M${x1},${yMid} C${x1},${yMid + ROW * 0.6} ${x2},${yBottom - ROW * 0.6} ${x2},${yBottom}`} fill="none" stroke={seg.color} strokeWidth="2" />;
                  })}
                  {/* タスクの記録: 点の周りにタスクの色の輪（札の色と同じ） */}
                  {task && <circle cx={x(row.lane)} cy={ROW / 2} r={R + 3.5} fill="none" stroke={taskColor(task.id)} strokeWidth={1.5} />}
                  <circle cx={x(row.lane)} cy={ROW / 2} r={isHead ? R + 1 : R} fill={isHead ? '#161a22' : row.color} stroke={row.color} strokeWidth={isHead ? 2.5 : 2} />
                </svg>
              </td>
              <td className={`${td} ${isHead ? 'font-bold' : ''} text-zinc-100`}>{task && <TaskChip task={task} mine={mine} onOpen={onOpenTask} />}{refs.map((r, i) => <RefLabel key={i} r={r} color={row.color} />)}<span className="align-middle">{row.subject}</span></td>
              {!compact && <><td className={`${td} text-zinc-400`} title={formatDate(row.date).full}>{formatDate(row.date).short}</td>
              <td className={`${td} text-zinc-400`} title={row.author}>{row.author}</td></>}
              <td className={`${td} mono text-zinc-400`}>{row.hash.slice(0, 7)}</td>
            </tr>;
          })}
        </tbody>
      </table>
    </div>}
    {rows.filter((row) => row.hash === selected).map((row) => <div key={row.hash} aria-label="コミット詳細" className="p-3 border-t border-sky-800 bg-sky-950/20 text-xs space-y-2"><p className="whitespace-pre-wrap break-words text-sm text-zinc-100">{row.message ? withoutTaskMark(row.message) : row.subject}</p>
      {row.task && <p className="flex flex-wrap items-center gap-2 text-zinc-300">
        <span aria-hidden="true" className="inline-block w-2.5 h-2.5 rounded-full" style={{ border: `2px solid ${taskColor(row.task.id)}` }} />
        <span>{row.task.id === taskId ? 'このタスクが記録したものです' : row.task.title ? `タスク「${row.task.title}」が記録したものです` : 'Tower のタスクが記録したものです（そのタスクはもう消しました）'}</span>
        {row.task.title && row.task.id !== taskId && onOpenTask && <button type="button" className="text-sky-300 hover:underline" onClick={() => onOpenTask(row.task!.id)}>そのタスクを開く</button>}
      </p>}<p className="text-violet-300 break-words">{row.refs}</p><p className="text-zinc-400 break-all">{row.author} · {formatDate(row.date).full} · {row.hash}</p></div>)}
  </section>;
}

/** 表示確認用（テスト） */
export const _internal = { layout, parseRefs };
