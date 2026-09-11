import { useState } from 'react';
import type { ChangesResponse } from '@tower/shared';

export function GitHistory({ commits }: { commits: NonNullable<ChangesResponse['history']> }) {
  const [selected, setSelected] = useState<string | null>(null);
  const lanes: string[] = [];
  const rows = commits.map((commit) => {
    let lane = lanes.indexOf(commit.hash);
    if (lane < 0) { lane = lanes.indexOf(''); if (lane < 0) lane = lanes.length; }
    lanes[lane] = commit.parents[0] ?? '';
    for (const parent of commit.parents.slice(1)) {
      if (!lanes.includes(parent)) {
        const free = lanes.indexOf('');
        lanes[free < 0 ? lanes.length : free] = parent;
      }
    }
    return { ...commit, lane };
  });
  const width = Math.max(32, (Math.max(0, ...rows.map((r) => r.lane)) + 1) * 16 + 16);
  /** 1 件の高さ（見出し 2 行 + ハッシュ等 1 行）。点は見出し 1 行目の高さに置く */
  const ROW = 64, DOT = 15;
  const colors = ['#7dd3fc', '#c4b5fd', '#6ee7b7', '#fcd34d', '#fda4af'];
  return <section aria-label="コミットグラフ" className="border border-zinc-800 bg-black/15 overflow-hidden">
    <h3 className="flex flex-wrap items-baseline gap-x-2 text-xs font-semibold px-3 py-2 border-b border-zinc-800"><span className="whitespace-nowrap">コミット履歴</span><span className="whitespace-nowrap font-normal text-[11px] text-zinc-500">最新40件・全ブランチ</span></h3>
    {!rows.length ? <p className="p-3 text-xs text-zinc-500">コミットはまだありません。</p> : <div className="max-h-80 overflow-auto"><div className="relative" style={{ minWidth: width + 150 }}>
      <svg aria-hidden="true" className="absolute top-0 left-0" width={width} height={rows.length * ROW}>
        {rows.flatMap((row, index) => row.parents.map((parent) => {
          const dest = rows.findIndex((r) => r.hash === parent);
          if (dest < 0) return null;
          const x1 = 16 + row.lane * 16, x2 = 16 + rows[dest].lane * 16, y1 = index * ROW + DOT, y2 = dest * ROW + DOT;
          return <path key={`${row.hash}-${parent}`} d={`M${x1},${y1} C${x1},${y1 + 20} ${x2},${y2 - 20} ${x2},${y2}`} fill="none" stroke={colors[row.lane % colors.length]} strokeWidth="1.5" opacity=".65" />;
        }))}
        {rows.map((row, index) => <circle key={row.hash} cx={16 + row.lane * 16} cy={index * ROW + DOT} r="4" fill="#10141b" stroke={colors[row.lane % colors.length]} strokeWidth="2" />)}
      </svg>
      <ol style={{ paddingLeft: width }}>{rows.map((row) => <li key={row.hash} style={{ height: ROW }} className="pr-3 py-1.5 text-xs border-b border-zinc-800/50" title={`${row.subject}\n${row.hash}\n${row.refs}`}>
        <button className="line-clamp-2 text-left text-zinc-100 hover:text-sky-200 leading-[18px] w-full" onClick={() => setSelected(row.hash)}>{row.subject}</button>
        <div className="truncate mt-0.5 text-[10px] leading-[14px] text-zinc-500"><span className="mono text-sky-300">{row.hash.slice(0, 7)}</span> · {row.author}{row.refs && <span className="ml-2 text-violet-300">{row.refs}</span>}</div>
      </li>)}</ol>
    </div></div>}
    {rows.filter((row) => row.hash === selected).map((row) => <div key={row.hash} aria-label="コミット詳細" className="p-3 border-t border-sky-800 bg-sky-950/20 text-xs space-y-2"><p className="whitespace-pre-wrap break-words text-sm text-zinc-100">{row.message ?? row.subject}</p><p className="text-violet-300 break-words">{row.refs}</p><p className="text-zinc-400 break-all">{row.author} · {row.hash}</p></div>)}
  </section>;
}
