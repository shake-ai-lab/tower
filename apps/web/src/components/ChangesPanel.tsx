import { useEffect, useState } from 'react';
import type { ChangesResponse } from '@tower/shared';
import { api } from '../api';

const STATUS_LABEL: Record<string, { text: string; cls: string }> = {
  M: { text: '変更', cls: 'bg-amber-900/70 text-amber-200' },
  A: { text: '追加', cls: 'bg-emerald-900/70 text-emerald-200' },
  D: { text: '削除', cls: 'bg-red-900/70 text-red-200' },
  '?': { text: '現在の内容', cls: 'bg-zinc-800 text-zinc-300' },
};

function DiffBody({ diff }: { diff: string }) {
  return (
    <pre className="mono text-xs leading-5 overflow-auto max-h-[420px] bg-black/40 rounded p-2">
      {diff.split('\n').map((line, i) => {
        const cls = line.startsWith('+++') || line.startsWith('---')
          ? 'text-zinc-500'
          : line.startsWith('@@')
            ? 'text-sky-400'
            : line.startsWith('+')
              ? 'text-emerald-300 bg-emerald-500/10'
              : line.startsWith('-')
                ? 'text-red-300 bg-red-500/10'
                : 'text-zinc-400';
        return (
          <div key={i} className={`px-1 whitespace-pre ${cls}`}>
            {line || ' '}
          </div>
        );
      })}
    </pre>
  );
}

export function ChangesPanel({ sessionId, refreshKey }: { sessionId: string; refreshKey: number }) {
  const [data, setData] = useState<ChangesResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});

  useEffect(() => {
    let alive = true;
    api
      .changes(sessionId)
      .then((d) => alive && setData(d))
      .catch((e) => alive && setErr(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [sessionId, refreshKey]);

  if (err) return <div className="text-xs text-red-400">{err}</div>;
  if (!data) return <div className="text-xs text-zinc-500">変更を読み込み中…</div>;
  if (data.files.length === 0) return <div className="text-xs text-zinc-500">変更されたファイルはありません。</div>;

  return (
    <div className="space-y-2">
      {!data.isGit && (
        <div className="text-[11px] text-zinc-500">
          このフォルダは git 管理されていないので「変更前」が分かりません。触ったファイルの今の中身を表示しています。
        </div>
      )}
      {data.against && (
        <div className="text-[11px] text-zinc-500">{data.against}との差分です。すでに取り込んだ分は含みません。</div>
      )}
      {data.files.map((f) => {
        const st = STATUS_LABEL[f.status] ?? STATUS_LABEL['?'];
        const isOpen = open[f.path] ?? data.files.length <= 3;
        return (
          <div key={f.path} className="rounded-md border border-zinc-800">
            <button
              onClick={() => setOpen((o) => ({ ...o, [f.path]: !isOpen }))}
              className="w-full flex items-center gap-2 px-2 py-1.5 text-left text-xs hover:bg-zinc-800/60"
            >
              <span className={`px-1.5 py-0.5 rounded ${st.cls}`}>{st.text}</span>
              <span className="mono text-zinc-200 truncate">{f.path}</span>
              <span className="ml-auto text-zinc-600">{isOpen ? '▾' : '▸'}</span>
            </button>
            {isOpen && (
              <div className="px-2 pb-2">
                <DiffBody diff={f.diff} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
