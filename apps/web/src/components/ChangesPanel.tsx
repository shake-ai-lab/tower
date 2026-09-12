import { useEffect, useState } from 'react';
import type { ChangesResponse } from '@tower/shared';
import { api } from '../api';
import { openTask } from '../layout';
import { GitHistory } from './GitHistory';
import { Icon } from './Icon';

const STATUS_LABEL: Record<string, { text: string; cls: string }> = {
  M: { text: '変更', cls: 'bg-amber-900/70 text-amber-200' },
  A: { text: '追加', cls: 'bg-emerald-900/70 text-emerald-200' },
  D: { text: '削除', cls: 'bg-red-900/70 text-red-200' },
  '?': { text: '現在の内容', cls: 'bg-zinc-800 text-zinc-300' },
};

/** git の diff ヘッダ（diff --git / index / --- a/ / +++ b/ …）。コードを読まない人には雑音なので出さない */
const HEADER_RE = /^(diff --git |index [0-9a-f]+\.\.[0-9a-f]+|--- (a\/|\/dev\/null)|\+\+\+ (b\/|\/dev\/null)|new file mode|deleted file mode|similarity index|rename (from|to) |old mode|new mode|Binary files )/;

function DiffBody({ diff }: { diff: string }) {
  const lines = diff.split('\n').filter((line) => !HEADER_RE.test(line));
  let hunks = 0;
  return (
    <pre className="mono text-xs leading-5 overflow-auto max-h-[420px] bg-black/40 rounded p-2">
      {lines.map((line, i) => {
        const hunk = line.match(/^@@[^@]*@@\s?(.*)$/);
        if (hunk) {
          hunks++;
          // 離れた場所の変更の区切り。先頭の 1 つ目は区切り線を出さない
          return (
            <div key={i} className={`px-1 whitespace-pre text-zinc-600 ${hunks > 1 ? 'border-t border-zinc-800 mt-1 pt-1' : ''}`}>
              {hunks > 1 ? '… ' : ''}
              {hunk[1] ? <span className="text-sky-400/70">{hunk[1]}</span> : hunks > 1 ? '' : ' '}
            </div>
          );
        }
        const cls = line.startsWith('+')
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

export function ChangesPanel({
  sessionId,
  refreshKey,
  onEdit,
  editHint,
}: {
  sessionId: string;
  refreshKey: number;
  /** 「直す」を押した時。渡さなければボタンは押せない（editHint に理由を出す） */
  onEdit?: (path: string) => void;
  editHint?: string;
}) {
  const [data, setData] = useState<ChangesResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});

  useEffect(() => {
    let alive = true;
    setErr(null);
    setData(null);
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

  // 変更ファイルをフォルダごとにまとめる（プロジェクト直下を先頭に、フォルダ順 → 名前順）
  const dirOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
  const groups: [string, ChangesResponse['files']][] = [];
  for (const f of [...data.files].sort((a, b) => dirOf(a.path).localeCompare(dirOf(b.path)) || a.path.localeCompare(b.path))) {
    const folder = dirOf(f.path) || 'プロジェクト直下';
    const last = groups.at(-1);
    if (last?.[0] === folder) last[1].push(f);
    else groups.push([folder, [f]]);
  }

  return (
    <div className="space-y-2">
      {data.isGit && <><div className="flex items-center gap-2 rounded-sm bg-sky-400/10 border border-sky-400/20 px-2.5 py-2 text-xs text-sky-300 break-all"><Icon name="git" className="shrink-0" />ブランチ: {data.branch || 'HEAD（ブランチ未選択）'}</div><GitHistory commits={data.history ?? []} taskId={sessionId} onOpenTask={(id) => openTask(id)} /></>}
      <h3 className="text-xs font-semibold text-zinc-300 pt-3">変更ファイル <span className="rounded-full bg-zinc-800 px-2 py-0.5 ml-1">{data.files.length}</span></h3>
      {data.files.length === 0 && <div className="text-xs text-zinc-500">変更されたファイルはありません。</div>}
      {!data.isGit && (
        <div className="text-[11px] text-zinc-500">
          このフォルダは git 管理されていないので「変更前」が分かりません。触ったファイルの今の中身を表示しています。
        </div>
      )}
      {data.against && (
        <div className="text-[11px] text-zinc-500">{data.against}</div>
      )}
      {!!groups.length && (
        <ul className="text-xs">
          {groups.map(([folder, files]) => (
            <li key={folder} className="pt-1">
              {/* 長いフォルダ名は末尾（いちばん近いフォルダ）を残して頭を省く。\u200E は先頭の「.」などが右へ回らないように */}
              <div title={folder} className="flex items-center gap-1.5 px-1 py-1 text-[11px] text-zinc-500">
                <Icon name="folder" className="shrink-0 text-amber-300/70" />
                <span dir="rtl" className="truncate">{`\u200E${folder}\u200E`}</span>
              </div>
              <ul className="ml-2.5 border-l border-zinc-800">
                {files.map((f) => {
                  const st = STATUS_LABEL[f.status] ?? STATUS_LABEL['?'];
                  const isOpen = open[f.path] ?? false;
                  return (
                    <li key={f.path}>
                      <div className={`group flex items-center gap-1 h-7 pl-1.5 pr-1 rounded-r hover:bg-zinc-800/60 ${isOpen ? 'bg-zinc-800/40' : ''}`}>
                        <button
                          onClick={() => setOpen((o) => ({ ...o, [f.path]: !isOpen }))}
                          aria-expanded={isOpen}
                          title={`${f.path}（押すと変更点を${isOpen ? '閉じる' : '見る'}）`}
                          className="flex-1 min-w-0 h-full flex items-center gap-1.5 text-left"
                        >
                          <span aria-hidden="true" className="w-2 shrink-0 text-[10px] text-zinc-600">{isOpen ? '▾' : '▸'}</span>
                          <span className={`shrink-0 whitespace-nowrap rounded-sm px-1 text-[10px] leading-4 ${st.cls}`}>{st.text}</span>
                          <span className={`truncate ${f.status === 'D' ? 'text-zinc-500 line-through' : 'text-zinc-200'}`}>{f.path.split('/').at(-1)}</span>
                        </button>
                        {/* 狭い幅でも名前を読めるよう、「開く」は行に乗った時・選んだ時・変更点を開いている時だけ出す（タッチ操作では常に出す） */}
                        {f.status !== 'D' && (
                          <button
                            disabled={!onEdit}
                            onClick={() => onEdit?.(f.path)}
                            title={onEdit ? 'このファイルを画面で開いて自分で直す' : editHint}
                            className={`shrink-0 rounded px-1.5 leading-5 text-sky-300 hover:bg-zinc-700 disabled:text-zinc-500 disabled:cursor-not-allowed ${isOpen ? 'inline-block' : 'hidden group-hover:inline-block group-focus-within:inline-block [@media(hover:none)]:inline-block'}`}
                          >
                            開く
                          </button>
                        )}
                      </div>
                      {isOpen && (
                        <div className="pl-2 pr-1 pt-1 pb-2">
                          <DiffBody diff={f.diff} />
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
