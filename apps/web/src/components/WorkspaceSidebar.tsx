import { useEffect, useState } from 'react';
import { imageType, workDir, type Session, type TreeResponse } from '@tower/shared';
import { api, errMsg } from '../api';
import { needsYou, projectStyle, useDesktop, useResizable } from '../lib';
import { useStore } from '../store';
import { Inbox } from './Inbox';
import { ChangesPanel } from './ChangesPanel';
import { SettingsPanel } from './SettingsPanel';
import { SearchPanel } from './SearchPanel';
import { QuickOpen } from './QuickOpen';
import { Icon } from './Icon';
import { useEditorWorkspace } from '../editor-workspace';

function Folder({ id, path = '', onOpen, version, selected, hidden }: { id: string; path?: string; onOpen: (path: string) => void; version: number; selected?: string; hidden: string[] }) {
  const [data, setData] = useState<TreeResponse | null>(null);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  useEffect(() => { if (selected) setExpanded((s) => ({ ...s, ...Object.fromEntries(selected.split('/').slice(0, -1).map((_, i, parts) => [parts.slice(0, i + 1).join('/'), true])) })); }, [selected]);
  useEffect(() => {
    let active = true;
    setError('');
    api.tree(id, path).then((d) => active && setData(d)).catch((e) => active && setError(errMsg(e)));
    return () => { active = false; };
  }, [id, path, version]);
  if (error) return <p role="alert" className="text-xs text-red-300 p-2">{error}</p>;
  if (!data) return <p className="text-xs p-2 text-zinc-500">読み込み中…</p>;
  return <ul className="text-[13px] min-w-0">
    {data.entries.filter((entry) => !hidden.some((pattern) => pattern === '.*' ? entry.name.startsWith('.') : entry.name === pattern || entry.path === pattern)).map((entry) => <li key={entry.path}>
      <button aria-current={selected === entry.path ? 'true' : undefined} className={`file-row w-full flex items-center gap-1 text-left px-1 py-0.5 hover:bg-zinc-800 ${selected === entry.path ? 'bg-sky-400/15 border-l-2 border-sky-400' : ''}`} title={`${entry.kind === 'dir' ? 'フォルダ' : 'ファイル'}: ${entry.path}`}
        aria-expanded={entry.kind === 'dir' ? !!expanded[entry.path] : undefined}
        onClick={() => entry.kind === 'dir' ? setExpanded((s) => ({ ...s, [entry.path]: !s[entry.path] })) : onOpen(entry.path)}>
        <span aria-hidden="true" className="w-2 text-zinc-500 shrink-0">{entry.kind === 'dir' ? (expanded[entry.path] ? '▾' : '▸') : ''}</span>
        <Icon name={entry.kind === 'dir' ? 'folder' : imageType(entry.path) ? 'image' : 'file'} className={entry.kind === 'dir' ? 'text-amber-300' : imageType(entry.path) ? 'text-violet-300' : 'text-sky-300'} />
        <span className={`truncate ${entry.kind === 'dir' ? 'font-medium text-zinc-100' : 'text-zinc-400'}`}>{entry.name}</span>
      </button>
      {entry.kind === 'dir' && expanded[entry.path] && <div className="ml-3 border-l border-zinc-800"><Folder id={id} path={entry.path} onOpen={onOpen} version={version} selected={selected} hidden={hidden} /></div>}
    </li>)}
    {!data.entries.length && <li className="p-2 text-xs text-zinc-500">空のフォルダです</li>}
    {!!data.skipped.length && <li className="p-2 text-xs text-zinc-500 break-words">省略: {data.skipped.join('、')}</li>}
    {!!data.truncated && <li className="p-2 text-xs text-amber-300">ほか {data.truncated} 件は表示上限を超えています</li>}
  </ul>;
}

function ProjectFiles({ session, git, onQuickOpen }: { session: Session; git: boolean; onQuickOpen: () => void }) {
  const open = useEditorWorkspace((s) => s.open);
  const setOpened = (path: string) => open(session.id, path, () => setVersion((v) => v + 1));
  const [version, setVersion] = useState(0);
  const selected = useEditorWorkspace((s) => s.files.find((f) => f.id === s.selected[s.pane] && f.sessionId === session.id)?.path);
  const [hiddenText, setHiddenText] = useState(() => localStorage.getItem('tower.explorer.hidden') ?? '');
  return <div className="p-2 space-y-2">
    <h2 className="rounded border px-2 py-1 truncate font-semibold" style={projectStyle(session.project.path)} title={workDir(session)}>{session.project.name}</h2>
    <p className="text-xs text-zinc-500 break-all">{workDir(session)}</p>
    <div className="flex gap-3">
      <button className="text-xs text-sky-300 hover:underline" onClick={() => setVersion((v) => v + 1)}>更新</button>
      {!git && <button className="text-xs text-sky-300 hover:underline" onClick={onQuickOpen}>名前で開く（Ctrl+P）</button>}
    </div>
    {git ? <ChangesPanel sessionId={session.id} refreshKey={version + (session.report?.generatedAt ?? 0)} onEdit={setOpened} /> :
      <><details className="text-xs text-zinc-400"><summary className="cursor-pointer">非表示の設定</summary><label className="block mt-2">名前または相対パスを1行ずつ入力（.* はドットで始まる項目）<textarea aria-label="非表示にする項目" className="w-full mt-2 p-2 bg-zinc-900 border border-zinc-700" rows={4} value={hiddenText} onChange={(e) => { setHiddenText(e.target.value); localStorage.setItem('tower.explorer.hidden', e.target.value); }} /></label></details><Folder id={session.id} onOpen={setOpened} version={version} selected={selected} hidden={hiddenText.split('\n').map((s) => s.trim()).filter(Boolean)} /></>}
  </div>;
}

type Tab = 'inbox' | 'files' | 'search' | 'git' | 'settings';
const TITLE: Record<Tab, string> = { inbox: '判断待ち', files: 'エクスプローラー', search: '検索', git: 'ソース管理', settings: '設定' };

export function WorkspaceSidebar({ className = '' }: { className?: string }) {
  const taskId = useStore((s) => s.selectedId);
  const fileId = useEditorWorkspace((s) => s.visible ? s.files.find((f) => f.id === s.selected[s.pane])?.sessionId : undefined);
  const id = fileId ?? taskId;
  const session = useStore((s) => id ? s.sessions[id] : undefined);
  const waiting = useStore((s) => Object.values(s.sessions).filter(needsYou).length);
  const [tab, setTab] = useState<Tab>('inbox');
  const [searchFocus, setSearchFocus] = useState(0);
  const [quickOpen, setQuickOpen] = useState(false);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || !(e.ctrlKey || e.metaKey)) return;
      const next = e.shiftKey && e.key.toLowerCase() === 'e' ? 'files' : e.shiftKey && e.key.toLowerCase() === 'g' ? 'git' : e.key === ',' ? 'settings' : null;
      if (next) { e.preventDefault(); setTab(next); }
    };
    // Ctrl+P（名前で開く）と Ctrl+Shift+F（全体検索）は、エディタや印刷に取られないよう捕捉段階で受ける
    const early = (e: KeyboardEvent) => {
      if (e.isComposing || !(e.ctrlKey || e.metaKey) || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === 'p' && !e.shiftKey) setQuickOpen(true);
      else if (k === 'f' && e.shiftKey) { setTab('search'); setSearchFocus((n) => n + 1); }
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('keydown', key);
    window.addEventListener('keydown', early, true);
    return () => { window.removeEventListener('keydown', key); window.removeEventListener('keydown', early, true); };
  }, []);
  const desktop = useDesktop();
  const resize = useResizable('sidebar', 320, 220, 600, 'left');
  // タスクを選んだらファイル一覧へ。ただし判断待ちがまだ残っている時は、その一覧から次々に答えられるよう留まる
  useEffect(() => { if (id) setTab((t) => t === 'git' || t === 'search' || (t === 'inbox' && waiting > 0) ? t : 'files'); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  return <>
  <aside ref={resize.ref} data-resizable-panel className={`relative w-full md:border-r border-zinc-800 bg-[#0c0e12] ${className}`} style={desktop ? { width: resize.width, minWidth: 220, flexShrink: 1 } : undefined}>
    <div className="flex h-full min-h-0">
      <nav aria-label="ワークスペース" className="activity-rail flex flex-col w-14 shrink-0 border-r border-zinc-800 bg-[#10141b] py-2 gap-1">
        {([['inbox', `判断待ち ${waiting}`], ['files', 'ファイル'], ['search', '検索'], ['git', 'Git'], ['settings', '設定']] as const).map(([value, label]) =>
          <button key={value} aria-label={value === 'inbox' ? `判断待ち ${waiting}` : label} title={label} aria-pressed={tab === value} onClick={() => { setTab(value); if (value === 'search') setSearchFocus((n) => n + 1); }} className={`relative flex flex-col items-center gap-1 py-2 text-[10px] border-l-2 ${value === 'settings' ? 'mt-auto' : ''} ${tab === value ? 'border-sky-400 text-sky-200 bg-sky-400/10' : 'border-transparent text-zinc-500 hover:text-zinc-200 hover:bg-white/5'}`}><Icon name={value} className="!w-5 !h-5" /><span>{value === 'inbox' ? '判断待ち' : label}</span>{value === 'inbox' && waiting > 0 && <span className="absolute top-0 right-0 rounded-full bg-amber-400 text-black px-1">{waiting}</span>}</button>)}
      </nav>
      <div className="flex-1 min-w-0 min-h-0 overflow-y-auto">
        <div className="sticky top-0 z-10 px-3 py-2 bg-[#0c0e12]/95 border-b border-zinc-800 text-xs font-semibold tracking-wide text-zinc-300">{TITLE[tab]}</div>
        {tab === 'inbox' ? <Inbox embedded /> : tab === 'settings' ? <SettingsPanel /> : !session ?
          <p className="p-4 text-sm text-zinc-500">{tab === 'search' ? 'タスクを選ぶと、そのプロジェクトの中の文字を探せます。' : `タスクを選ぶと、プロジェクトの${tab === 'git' ? 'ブランチと差分' : 'ファイル'}が表示されます。`}</p> :
          tab === 'search' ? null :
          <ProjectFiles key={session.id} session={session} git={tab === 'git'} onQuickOpen={() => setQuickOpen(true)} />}
        {session && <div hidden={tab !== 'search'}><SearchPanel key={session.id} session={session} focusKey={searchFocus} active={tab === 'search'} /></div>}
      </div>
    </div>
    {desktop && <div role="separator" aria-label="左パネルの幅" aria-orientation="vertical" aria-valuemin={220} aria-valuemax={600} aria-valuenow={resize.actualWidth} tabIndex={0}
      className="absolute right-0 top-0 bottom-0 w-1.5 cursor-col-resize hover:bg-sky-500/60 focus:bg-sky-500/60 z-10"
      onMouseDown={resize.onMouseDown} onDoubleClick={resize.reset} onKeyDown={resize.onKeyDown} />}
  </aside>
  {quickOpen && <QuickOpen session={session} onClose={() => setQuickOpen(false)} />}
  </>;
}
