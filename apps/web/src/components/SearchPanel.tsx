// プロジェクト全体から文字を探す（VS Code の Ctrl+Shift+F）。結果を押すと、その行を開く
import { useEffect, useRef, useState } from 'react';
import { workDir, type SearchResponse, type Session } from '@tower/shared';
import { api } from '../api';
import { useEditorWorkspace } from '../editor-workspace';
import { Icon } from './Icon';

export function SearchPanel({ session, focusKey }: { session: Session; focusKey: number }) {
  const [q, setQ] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [res, setRes] = useState<SearchResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const input = useRef<HTMLInputElement>(null);
  const open = useEditorWorkspace((s) => s.open);

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, [focusKey]);

  // 打ち終わって少し待ってから探す（1 文字ごとに全部のファイルを読まない）
  useEffect(() => {
    if (!q.trim()) {
      setRes(null);
      setErr('');
      setBusy(false);
      return;
    }
    let alive = true;
    const t = setTimeout(() => {
      setBusy(true);
      api
        .search(session.id, q, caseSensitive)
        .then((r) => {
          if (!alive) return;
          setRes(r);
          setErr('');
        })
        .catch((e) => alive && setErr(e instanceof Error ? e.message : String(e)))
        .finally(() => alive && setBusy(false));
    }, 300);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [q, caseSensitive, session.id]);

  return (
    <div className="p-2 space-y-2 text-[13px]">
      <p className="text-xs text-zinc-500 truncate" title={workDir(session)}>
        {session.project.name} の中を探します
      </p>
      <input
        ref={input}
        aria-label="プロジェクト全体から探す文字"
        placeholder="探す文字（Ctrl+Shift+F）"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        className="w-full rounded bg-black/30 border border-zinc-700 px-2 py-1.5"
      />
      <label className="flex items-center gap-1.5 text-xs text-zinc-400">
        <input type="checkbox" checked={caseSensitive} onChange={(e) => setCaseSensitive(e.target.checked)} />
        大文字と小文字を区別する
      </label>
      {err && <p role="alert" className="text-xs text-red-300">{err}</p>}
      {busy && <p className="text-xs text-zinc-500">探しています…</p>}
      {res && !busy && (
        <p role="status" className="text-xs text-zinc-400">
          {res.total ? `${res.total} 件（${res.files.length} ファイル）` : '見つかりませんでした'}
          {res.truncated && ' · 多すぎるので途中までです'}
        </p>
      )}
      <ul aria-label="検索結果" className="min-w-0">
        {res?.files.map((f) => {
          const cut = f.path.lastIndexOf('/');
          return (
            <li key={f.path}>
              <button
                aria-expanded={!closed[f.path]}
                title={f.path}
                onClick={() => setClosed((c) => ({ ...c, [f.path]: !c[f.path] }))}
                className="w-full flex items-center gap-1 px-1 py-0.5 text-left hover:bg-zinc-800"
              >
                <span aria-hidden="true" className="w-2 shrink-0 text-zinc-500">{closed[f.path] ? '▸' : '▾'}</span>
                <Icon name="file" className="text-sky-300" />
                <span className="shrink-0 text-zinc-100">{f.path.slice(cut + 1)}</span>
                <span className="truncate text-[11px] text-zinc-500">{f.path.slice(0, Math.max(0, cut))}</span>
                <span className="ml-auto shrink-0 rounded-full bg-zinc-700 px-1.5 text-[10px] text-zinc-200">{f.matches.length}</span>
              </button>
              {!closed[f.path] && (
                <ul>
                  {f.matches.map((m) => {
                    const lead = Math.min(m.at, m.text.length - m.text.trimStart().length);
                    return (
                      <li key={`${m.line}:${m.column}`}>
                        <button
                          title={`${f.path} の ${m.line} 行目を開く`}
                          onClick={() => open(session.id, f.path, undefined, { line: m.line, column: m.column, length: m.length })}
                          className="w-full truncate py-0.5 pl-6 pr-1 text-left text-xs text-zinc-400 hover:bg-zinc-800"
                        >
                          <span className="mr-1.5 text-zinc-600">{m.line}</span>
                          {m.text.slice(lead, m.at)}
                          <mark className="rounded-sm bg-amber-400/30 text-amber-100">{m.text.slice(m.at, m.at + m.length)}</mark>
                          {m.text.slice(m.at + m.length)}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
