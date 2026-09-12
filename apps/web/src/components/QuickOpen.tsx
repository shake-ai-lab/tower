// ファイル名で開く（VS Code の Ctrl+P）。名前の一部・飛び飛びの文字・空白区切りの複数語で絞り込む
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import type { FileListResponse, Session } from '@tower/shared';
import { api } from '../api';
import { rankFiles } from '../editor-tools';
import { useEditorWorkspace } from '../editor-workspace';
import { Icon } from './Icon';

/** text の各文字のうち hits に入っている位置（from からの通し番号）を強調する */
function Marked({ text, from, hits }: { text: string; from: number; hits: Set<number> }) {
  const out: ReactNode[] = [];
  let buf = '';
  let on = false;
  const flush = (key: number) => {
    if (buf) out.push(on ? <b key={key} className="text-sky-300">{buf}</b> : buf);
    buf = '';
  };
  for (let i = 0; i < text.length; i++) {
    const hit = hits.has(from + i);
    if (hit !== on) {
      flush(i);
      on = hit;
    }
    buf += text[i];
  }
  flush(text.length);
  return <>{out}</>;
}

export function QuickOpen({ session, onClose }: { session: Session | undefined; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [files, setFiles] = useState<FileListResponse | null>(null);
  const [err, setErr] = useState('');
  const [index, setIndex] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const returnFocus = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const chosen = useRef(false);
  const restoreFrame = useRef<number | null>(null);
  const open = useEditorWorkspace((s) => s.open);

  useEffect(() => {
    if (!session) return;
    let alive = true;
    setFiles(null);
    setErr('');
    setIndex(0);
    api
      .allFiles(session.id)
      .then((r) => alive && setFiles(r))
      .catch((e) => alive && setErr(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [session?.id]);

  useEffect(() => {
    // StrictMode の疑似アンマウントでは復元せず、本当に閉じたときだけ戻す。
    if (restoreFrame.current !== null) cancelAnimationFrame(restoreFrame.current);
    return () => {
      restoreFrame.current = requestAnimationFrame(() => {
        if (!chosen.current && returnFocus.current?.isConnected && !document.querySelector('[role="dialog"]')) returnFocus.current.focus();
      });
    };
  }, []);

  const list = useMemo(() => (files ? rankFiles(files.files, q) : []), [files, q]);
  useEffect(() => setIndex(0), [q]);
  useEffect(() => {
    listRef.current?.children[index]?.scrollIntoView({ block: 'nearest' });
  }, [index]);

  const choose = (path: string | undefined) => {
    if (!session || !path) return;
    chosen.current = true;
    open(session.id, path);
    onClose();
  };

  // 捕捉段階で受ける（後ろのエディタや画面の Esc に取られないように）。日本語の変換中の Enter は確定なので無視する
  const latest = useRef({ list, index, choose, onClose });
  latest.current = { list, index, choose, onClose };
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      const s = latest.current;
      if (e.key === 'Escape') s.onClose();
      else if (e.key === 'ArrowDown') setIndex((i) => Math.max(0, Math.min(s.list.length - 1, i + 1)));
      else if (e.key === 'ArrowUp') setIndex((i) => Math.max(0, i - 1));
      else if (e.key === 'Enter') s.choose(s.list[s.index]?.path);
      else if (e.key === 'Tab') inputRef.current?.focus();
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, []);

  return (
    <div className="fixed inset-0 z-[1000] flex items-start justify-center bg-black/40 pt-[12vh]" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label="ファイル名で開く" className="w-[min(640px,92vw)] border border-zinc-600 bg-zinc-900 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <p className="px-3 pt-2 text-xs text-zinc-500">{session ? `${session.project.name} のファイルを名前で開く` : 'ファイル名で開く'}</p>
        <input
          autoFocus
          ref={inputRef}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={!!files && !err}
          aria-controls={files && !err ? listId : undefined}
          aria-activedescendant={list[index] ? `${listId}-${index}` : undefined}
          aria-label="開くファイルの名前"
          placeholder="ファイル名の一部を入力（例: app tsx）"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="m-2 w-[calc(100%-1rem)] rounded border border-sky-700 bg-black/30 px-2 py-1.5 text-sm"
        />
        {!session ? (
          <p className="px-3 pb-3 text-sm text-zinc-400">タスクを選ぶと、そのプロジェクトのファイルを名前で探せます。</p>
        ) : err ? (
          <p role="alert" className="px-3 pb-3 text-sm text-red-300">{err}</p>
        ) : !files ? (
          <p className="px-3 pb-3 text-sm text-zinc-500">ファイルの一覧を読み込み中…</p>
        ) : (
          <ul id={listId} ref={listRef} role="listbox" aria-label="候補" className="max-h-[50vh] overflow-y-auto pb-1">
            {list.map((f, i) => {
              const cut = f.path.lastIndexOf('/');
              const hits = new Set(f.hits);
              return (
                <li
                  key={f.path}
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={i === index}
                  onMouseMove={() => setIndex(i)}
                  onClick={() => choose(f.path)}
                  className={`flex cursor-pointer items-center gap-2 px-3 py-1 text-[13px] ${i === index ? 'bg-sky-400/15' : ''}`}
                >
                  <Icon name="file" className="text-sky-300" />
                  <span className="shrink-0 text-zinc-100"><Marked text={f.path.slice(cut + 1)} from={cut + 1} hits={hits} /></span>
                  <span className="truncate text-xs text-zinc-500"><Marked text={f.path.slice(0, Math.max(0, cut))} from={0} hits={hits} /></span>
                </li>
              );
            })}
            {!list.length && <li className="px-3 py-2 text-sm text-zinc-500">当てはまるファイルがありません</li>}
          </ul>
        )}
        <p className="border-t border-zinc-800 px-3 py-1.5 text-[11px] text-zinc-500">
          ↑↓ で選ぶ · Enter で開く · Esc で閉じる{files?.truncated ? ' · ファイルが多いので一部だけ出しています' : ''}
        </p>
      </div>
    </div>
  );
}
