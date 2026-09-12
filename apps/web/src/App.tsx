import { WorkspaceChat } from './components/WorkspaceChat';
import { EditorWorkspace } from './components/EditorWorkspace';
import { useEditorWorkspace } from './editor-workspace';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { FeedbackContext, Session, SessionStatus } from '@tower/shared';
import { BridgeMenu } from './components/BridgeMenu';
import { FeedbackMenu } from './components/FeedbackMenu';
import { WorkspaceSidebar } from './components/WorkspaceSidebar';
import { NewSessionDialog } from './components/NewSessionDialog';
import { SessionCard } from './components/SessionCard';
import { SessionDetail } from './components/SessionDetail';
import { UsageMenu } from './components/UsageMenu';
import { STATUS, btn, needsYou, projectStyle, useTick } from './lib';
import { useStore } from './store';
import { projectKey } from './project-key';
import { MultiSessionView } from './components/MultiSessionView';

const VIEWS = [
  { value: 'editor', label: 'ファイル＋チャット', hint: '左にエクスプローラー、中央にファイル、右にチャット。狭い画面では上下に並びます。' },
  { value: 'cards', label: 'カード', hint: 'おすすめ：普段の進捗確認。プロジェクト別に見渡せます。' },
  { value: 'compact', label: 'コンパクト', hint: 'タスクが多いときにおすすめ。短い行で一覧できます。' },
  { value: 'focus', label: '集中', hint: '1つの作業に集中するときにおすすめ。詳細を広く表示します。' },
  { value: 'quad', label: '4分割', hint: '並行作業におすすめ。4つのタスクの履歴・報告を並べ、各パネルから指示できます。' },
] as const;
type ViewMode = typeof VIEWS[number]['value'];

// 並び順: 人を待っているもの → 作業中 → 報告あり → その他。同順位は新しい順
const ORDER: Record<SessionStatus, number> = {
  waiting_permission: 0,
  waiting_question: 0,
  running: 1,
  starting: 1,
  idle: 2,
  error: 3,
  done: 4,
  stopped: 4,
};

/** 「終わったもの」= もう動かないもの。報告待ち（idle）は次の指示を出せるので含めない */
const FINISHED: SessionStatus[] = ['stopped', 'done', 'error'];

/** 判断待ちの「どれ」を知らせたか。許可・質問はその要求、報告の判断はその報告ごと */
const needsYouKey = (s: Session) => (s.pending ? s.pending.id : `${s.id}:${s.report?.generatedAt ?? 0}`);

function notify(s: Session) {
  if (!('Notification' in window) || Notification.permission !== 'granted' || !needsYou(s)) return;
  const p = s.pending;
  const title = `${s.project.name}: ${!p ? '判断が必要です' : p.kind === 'permission' ? '許可待ち' : '質問があります'}`;
  const body = !p ? (s.report?.needsDecision ?? s.report?.summary[0] ?? '') : p.kind === 'permission' ? p.headline : (p.questions[0]?.question ?? '');
  try {
    new Notification(title, { body, tag: needsYouKey(s) });
  } catch {
    /* ブラウザによっては投げる */
  }
}

export default function App() {
  const workspaceVisible = useEditorWorkspace((s) => s.visible);
  const openFiles = useEditorWorkspace((s) => s.files.length);
  const sessions = useStore((s) => s.sessions);
  const selectedId = useStore((s) => s.selectedId);
  const select = useStore((s) => s.select);
  const connected = useStore((s) => s.connected);
  const [dialog, setDialog] = useState(false);
  const [showDetail, setShowDetail] = useState(true);
  const [view, setView] = useState<ViewMode>(() => {
    const saved = localStorage.getItem('tower.view');
    return VIEWS.some((v) => v.value === saved) ? saved as ViewMode : 'cards';
  });
  const editorVisible = workspaceVisible || view === 'editor';
  useEffect(() => { localStorage.setItem('tower.view', view); }, [view]);
  useEffect(() => setShowDetail(true), [selectedId]);
  /** 「気づいたこと」の書き込み欄 */
  const [feedback, setFeedback] = useState(false);
  /** スマホ表示のタブ（PC では両方見えるので関係ない） */
  const [tab, setTab] = useState<'inbox' | 'list'>('inbox');
  const [notifPerm, setNotifPerm] = useState<NotificationPermission>(
    'Notification' in window ? Notification.permission : 'denied',
  );
  useTick(15000);

  const list = useMemo(
    () => {
      // 報告で判断を求めて止まっているもの（idle）も、許可・質問と同じく先頭へ
      const rank = (s: Session) => (needsYou(s) ? 0 : ORDER[s.status]);
      return Object.values(sessions).sort((a, b) => rank(a) - rank(b) || b.updatedAt - a.updatedAt);
    },
    [sessions],
  );
  const waiting = list.filter(needsYou).length;
  const working = list.filter((s) => s.status === 'running' || s.status === 'starting').length;

  // 終わったもの（停止・完了・エラー）を隠して一覧を軽くする。消すわけではないので「使った量」の集計はそのまま
  const [hideDone, setHideDone] = useState(() => localStorage.getItem('tower.hideDone') === '1');
  useEffect(() => localStorage.setItem('tower.hideDone', hideDone ? '1' : '0'), [hideDone]);
  const finishedCount = list.filter((s) => FINISHED.includes(s.status)).length;

  // 履歴検索: プロジェクト名・依頼文・報告の言葉で絞り込む（空白区切りは AND）。検索中は隠しているものも対象
  const [q, setQ] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const [projectPath, setProjectPath] = useState('');
  const projects = useMemo(() => {
    const byPath = new Map(list.map((s) => [projectKey(s.project.path), s.project]));
    return [...byPath.values()].sort((a, b) => a.name.localeCompare(b.name, 'ja') || a.path.localeCompare(b.path));
  }, [list]);
  const activeProject = projects.some((p) => projectKey(p.path) === projectPath) ? projectPath : '';

  const shown = useMemo(() => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const candidates = activeProject ? list.filter((s) => projectKey(s.project.path) === activeProject) : list;
    if (words.length === 0) return hideDone ? candidates.filter((s) => !FINISHED.includes(s.status)) : candidates;
    const text = (s: Session) =>
      [s.project.name, s.project.path, s.title, s.prompt, s.model ?? '', s.agent, s.workspace?.branch ?? '', s.report?.raw ?? '', s.report?.summary.join(' ') ?? '']
        .join('\n')
        .toLowerCase();
    return candidates.filter((s) => {
      const t = text(s);
      return words.every((w) => t.includes(w));
    });
  }, [list, q, hideDone, activeProject]);
  // 最優先のタスクがあるプロジェクトから表示。同名でもパスが違えば別グループ。
  const groups = useMemo(() => {
    const byPath = new Map<string, { project: Session['project']; sessions: Session[] }>();
    for (const session of shown) {
      const key = projectKey(session.project.path);
      let group = byPath.get(key);
      if (!group) {
        group = { project: session.project, sessions: [] };
        byPath.set(key, group);
      }
      group.sessions.push(session);
    }
    return [...byPath.values()];
  }, [shown]);

  useEffect(() => {
    document.title = waiting ? `(${waiting}) Tower` : 'Tower';
  }, [waiting]);

  // ?new=1 で「新しいタスク」を開いた状態にする（ショートカットや共有リンク用）
  useEffect(() => {
    if (new URLSearchParams(location.search).has('new')) setDialog(true);
  }, []);

  // URL の ?s=<id> で開いた時はそのセッションを選択（通知や共有リンク用）
  useEffect(() => {
    const id = new URLSearchParams(location.search).get('s');
    if (id && sessions[id] && selectedId !== id) select(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [Object.keys(sessions).length]);

  // 新しく判断待ちになったものだけ通知する
  // 報告の判断は保存されて残るので、開き直すたびに古いものを知らせないよう、来たばかりのものだけにする
  const seen = useRef(new Set<string>());
  useEffect(() => {
    for (const s of list) {
      if (!needsYou(s)) continue;
      const key = needsYouKey(s);
      if (seen.current.has(key)) continue;
      seen.current.add(key);
      if (s.pending || Date.now() - (s.report?.generatedAt ?? 0) < 2 * 60_000) notify(s);
    }
  }, [list]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target instanceof HTMLElement ? e.target : null;
      if (!e.defaultPrevented && !e.isComposing && (e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'n') { e.preventDefault(); setDialog(true); return; }
      if (e.defaultPrevented || e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return;
      if (target?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]')) return;
      if (e.key === 'n' && !dialog) setDialog(true);
      if (e.key === 'f' && !dialog) {
        e.preventDefault();
        setFeedback(true);
      }
      if (e.key === '/' && !dialog && !editorVisible) {
        e.preventDefault();
        setTab('list');
        requestAnimationFrame(() => searchRef.current?.focus());
      }
      if (e.key === 'Escape') {
        if (feedback) setFeedback(false);
        else select(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dialog, feedback, select]);

  /** 「気づいたこと」に添える、いま見ている画面の説明 */
  const scene = (): FeedbackContext => {
    const s = selectedId ? sessions[selectedId] : null;
    const title = s ? (s.title.length > 40 ? `${s.title.slice(0, 40)}…` : s.title) : '';
    const view = dialog
      ? '新しいタスク'
      : s
        ? `詳細「${s.project.name} / ${title}」（${STATUS[s.status].label}）`
        : window.innerWidth < 768 && tab === 'inbox'
          ? '判断待ち'
          : q
            ? `一覧（「${q}」で検索中）`
            : '一覧';
    return {
      view,
      width: window.innerWidth,
      client: /Electron/i.test(navigator.userAgent) ? 'desktop' : 'browser',
    };
  };

  return (
    <div className="h-full flex flex-col">
      <header className="h-12 shrink-0 border-b border-zinc-800 flex items-center gap-4 px-4 bg-[#0c0e12]">
        <div className="font-bold tracking-wide">Tower</div>
        <div
          className="text-xs text-zinc-500 flex items-center gap-1.5"
          title={connected ? 'サーバーとつながっています' : 'サーバーとの接続が切れました。つなぎ直しています'}
        >
          <span className={`inline-block w-2 h-2 rounded-full ${connected ? 'bg-emerald-400' : 'bg-red-500 animate-pulse'}`} />
          {!connected && <span className="text-red-300">接続が切れました。つなぎ直しています…</span>}
        </div>
        <div className="hidden sm:block text-xs text-zinc-400">
          {working > 0 && <span aria-hidden="true" className="working-spinner mr-1 align-[-1px] text-sky-400" />}
          作業中 <b className={working ? 'text-sky-300' : 'text-zinc-200'}>{working}</b> · 判断待ち{' '}
          <b className={waiting ? 'text-amber-300' : 'text-zinc-200'}>{waiting}</b> · 全 {list.length}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <div className="hidden sm:flex items-center gap-2">
            <UsageMenu sessions={list} />
            <BridgeMenu />
          </div>
          <FeedbackMenu open={feedback} onOpenChange={setFeedback} scene={scene} />
          {notifPerm === 'default' && (
            <button
              onClick={() => Notification.requestPermission().then(setNotifPerm)}
              className={`${btn.base} ${btn.ghost} !text-xs whitespace-nowrap`}
            >
              通知<span className="hidden sm:inline">を有効にする</span>
            </button>
          )}
          <button onClick={() => setDialog(true)} className={`${btn.base} ${btn.primary} whitespace-nowrap`}>
            ＋ 新しいタスク <span className="hidden sm:inline opacity-60 text-xs ml-1">n</span>
          </button>
        </div>
      </header>
      <div className="shrink-0 border-b border-zinc-800 bg-[#10141b] flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2">
        <nav aria-label="表示パターン" className="flex flex-wrap gap-1">
          {VIEWS.map((v) => <button key={v.value} aria-pressed={view === v.value} title={v.hint} onClick={() => { setView(v.value); setTab('list'); useEditorWorkspace.setState({ visible: v.value === 'editor' }); }} className={`shrink-0 whitespace-nowrap px-3 py-1 rounded-md text-xs ${view === v.value ? 'bg-sky-400/15 text-sky-200' : 'text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200'}`}>{v.label}</button>)}
        </nav>
        {openFiles > 0 && <button className="text-xs text-sky-300" onClick={() => { if (view === 'editor') setView('cards'); useEditorWorkspace.setState({ visible: !editorVisible }); }}>{editorVisible ? 'タスクを表示' : `開いているファイル (${openFiles})`}</button>}
        <p className="text-[11px] text-zinc-500 w-full lg:w-auto">{VIEWS.find((v) => v.value === view)?.hint}</p>
      </div>

      <div className="flex-1 flex overflow-hidden">
        {/* スマホ（md 未満）では「判断待ち」と「セッション」をタブで切り替える。PC では横に並べる */}
        <WorkspaceSidebar className={editorVisible ? 'hidden md:block' : tab === 'inbox' ? 'block' : 'hidden md:block'} />

        <main style={editorVisible ? { display: 'none' } : undefined} className={`${tab === 'list' ? 'block' : 'hidden'} md:block task-list flex-1 min-w-0 overflow-y-auto p-3 md:p-4`}>
          {(view === 'quad' || view === 'focus') && list.length > 0 ? <MultiSessionView key={view} sessions={list} single={view === 'focus'} /> : list.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-zinc-500 gap-3">
              <div className="text-lg">まだセッションがありません</div>
              <button onClick={() => setDialog(true)} className={`${btn.base} ${btn.primary}`}>
                最初のタスクを任せる
              </button>
            </div>
          ) : (
            <>
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <input
                  aria-label="タスクの履歴を検索"
                  ref={searchRef}
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      setQ('');
                      (e.target as HTMLInputElement).blur();
                    }
                  }}
                  placeholder="履歴を検索（プロジェクト名・依頼・報告の言葉。/ で移動）"
                  className="flex-1 min-w-0 basis-48 max-w-[520px] bg-zinc-900 border border-zinc-800 rounded-md px-3 py-1.5 text-sm placeholder:text-zinc-600 focus:outline-none focus:border-sky-600"
                />
                <select
                  aria-label="プロジェクトで絞り込み"
                  value={activeProject}
                  onChange={(e) => setProjectPath(e.target.value)}
                  className="min-w-0 max-w-full sm:max-w-64 bg-zinc-900 border border-zinc-800 rounded-md px-2 py-1.5 text-sm focus:outline-none focus:border-sky-600"
                >
                  <option value="">すべてのプロジェクト（{projects.length}）</option>
                  {projects.map((project) => (
                    <option key={projectKey(project.path)} value={projectKey(project.path)}>
                      {project.name}{projects.filter((p) => p.name === project.name).length > 1 ? ` — ${project.path}` : ''}
                    </option>
                  ))}
                </select>
                {q && (
                  <span className="text-xs text-zinc-500 whitespace-nowrap">
                    {shown.length} 件
                    <button onClick={() => setQ('')} className="ml-2 underline hover:text-zinc-300">
                      解除
                    </button>
                  </span>
                )}
                {!q && finishedCount > 0 && (
                  <button
                    onClick={() => setHideDone((v) => !v)}
                    title="停止・完了・エラーで終わったものを一覧から隠します（消しません。検索と「使った量」には残ります）"
                    className="text-xs text-zinc-500 hover:text-zinc-300 underline whitespace-nowrap"
                  >
                    {hideDone ? `終わったもの ${finishedCount} 件を見せる` : `終わったもの ${finishedCount} 件を隠す`}
                  </button>
                )}
              </div>
              {shown.length === 0 ? (
                <div className="text-sm text-zinc-500 px-1">
                  {q ? `「${q}」に一致するセッションはありません` : '表示できるタスクはありません。終わったタスクを表示するか、プロジェクトの絞り込みを変更してください。'}
                </div>
              ) : (
                <div className="space-y-6">
                  {groups.map(({ project, sessions: tasks }) => (
                    <section key={project.path} aria-label={`${project.name} のタスク`}>
                      <div className="mb-2 flex flex-wrap items-center gap-2 min-w-0">
                        <h2 className="min-w-0 max-w-full truncate rounded-md border px-2 py-1 text-sm font-semibold" style={projectStyle(project.path)} title={project.path}>
                          {project.name}
                        </h2>
                        <span className="text-xs text-zinc-400">{tasks.length} 件</span>
                        {tasks.some(needsYou) && (
                          <span className="text-xs text-amber-300">判断待ち {tasks.filter(needsYou).length}</span>
                        )}
                        <span className="w-full truncate text-xs text-zinc-500" title={project.path}>{project.path}</span>
                      </div>
                      <div className={view === 'compact' ? 'grid gap-2' : 'grid gap-3 grid-cols-[repeat(auto-fill,minmax(min(100%,300px),1fr))]'}>
                        {tasks.map((s) => (
                          <SessionCard key={s.id} s={s} compact={view === 'compact'} selected={s.id === selectedId} onClick={() => { select(s.id); setShowDetail(true); }} />
                        ))}
                      </div>
                    </section>
                  ))}
                </div>
              )}
            </>
          )}
        </main>

        <div className={`editor-chat-layout ${editorVisible ? 'flex' : 'hidden'} flex-1 min-h-0 min-w-0`}>
          <EditorWorkspace forceVisible={view === 'editor'} onReturn={() => { setView('cards'); useEditorWorkspace.setState({ visible: false }); }} />
          {view === 'editor' && <WorkspaceChat />}
        </div>
        {view !== 'editor' && view !== 'quad' && view !== 'focus' && showDetail && selectedId && sessions[selectedId] && <SessionDetail hidden={editorVisible} key={selectedId} id={selectedId} onShowWorkspace={() => { setShowDetail(false); setTab('inbox'); }} />}
      </div>

      <nav className="md:hidden h-12 shrink-0 border-t border-zinc-800 flex bg-[#0c0e12]">
        {selectedId && !showDetail && <button onClick={() => setShowDetail(true)} className="px-3 text-sm text-sky-300">詳細に戻る</button>}
        <button
          onClick={() => { setTab('inbox'); if (view === 'editor') setView('cards'); useEditorWorkspace.setState({ visible: false }); }}
          className={`flex-1 text-sm flex items-center justify-center gap-2 ${tab === 'inbox' ? 'text-zinc-100 border-t-2 border-sky-500' : 'text-zinc-500'}`}
        >
          ワークスペース
          <span className={`text-xs px-1.5 py-0.5 rounded-full ${waiting ? 'bg-amber-400 text-black' : 'bg-zinc-800 text-zinc-400'}`}>{waiting}</span>
        </button>
        <button
          onClick={() => setTab('list')}
          className={`flex-1 text-sm flex items-center justify-center gap-2 ${tab === 'list' ? 'text-zinc-100 border-t-2 border-sky-500' : 'text-zinc-500'}`}
        >
          セッション
          <span className="text-xs px-1.5 py-0.5 rounded-full bg-zinc-800 text-zinc-400">{list.length}</span>
        </button>
      </nav>

      <NewSessionDialog open={dialog} onClose={() => setDialog(false)} />
    </div>
  );
}
