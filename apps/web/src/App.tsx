import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FeedbackContext, Session, SessionStatus } from '@tower/shared';
import { WorkspaceChat } from './components/WorkspaceChat';
import { EditorWorkspace } from './components/EditorWorkspace';
import { useEditorWorkspace } from './editor-workspace';
import type { Layout as EditorLayout } from './editor-persist';
import { BridgeMenu } from './components/BridgeMenu';
import { FeedbackMenu } from './components/FeedbackMenu';
import { WorkspaceSidebar } from './components/WorkspaceSidebar';
import { NewSessionDialog } from './components/NewSessionDialog';
import { SessionCard } from './components/SessionCard';
import { SessionDetail } from './components/SessionDetail';
import { UsageMenu } from './components/UsageMenu';
import { MultiSessionView } from './components/MultiSessionView';
import { btn, loadLocal, needsYou, projectStyle, saveLocal, useDesktop, useTick } from './lib';
import { isFinished, stateBadge } from './task-state';
import { useStore } from './store';
import { projectKey } from './project-key';
import { CHAT_SIDE_WIDTH, SEGMENTS, describeLayout, openTask, segmentOf, useLayout, type Segment } from './layout';

// 並び順: 人を待っているもの → 作業中 → 報告あり → その他。同順位は新しい順
const ORDER: Record<SessionStatus, number> = {
  waiting_permission: 0,
  waiting_question: 0,
  running: 1,
  starting: 1,
  idle: 2,
  // 停止は途中で止めただけ（指示を送れば続きから）なので、報告待ちと同じ所に置く
  stopped: 2,
  error: 3,
  done: 4,
};

/** 判断待ちの「どれ」を知らせたか。許可・質問はその要求、報告の判断はその報告ごと */
const needsYouKey = (s: Session) => (s.pending ? s.pending.id : `${s.id}:${s.report?.generatedAt ?? 0}`);

function notify(s: Session) {
  if (!('Notification' in window) || Notification.permission !== 'granted' || !needsYou(s)) return;
  const p = s.pending;
  const title = `${s.project.name}: ${!p ? '判断が必要です' : p.kind === 'permission' ? '許可待ち' : '質問があります'}`;
  const body = !p ? (s.report?.needsDecision ?? s.report?.summary[0] ?? '') : p.kind === 'permission' ? p.headline : p.kind === 'form' ? `${p.serverName}から入力の依頼があります` : (p.questions[0]?.question ?? '');
  try {
    new Notification(title, { body, tag: needsYouKey(s) });
  } catch {
    /* ブラウザによっては投げる */
  }
}

/** 左の欄・チャットの出し入れボタンに添える小さな図。どちら側の欄か、いま出ているかを形で見せる */
function PanelIcon({ side, on }: { side: 'left' | 'right'; on: boolean }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 18 14" className="h-3.5 w-[18px] shrink-0">
      <rect x="0.75" y="0.75" width="16.5" height="12.5" rx="2" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <rect x={side === 'left' ? 2.25 : 10.75} y="2.25" width="5" height="9.5" rx="1" fill="currentColor" opacity={on ? 0.95 : 0.2} />
    </svg>
  );
}

function PanelToggle({ side, on, label, title, onClick }: { side: 'left' | 'right'; on: boolean; label: string; title: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      title={title}
      onClick={onClick}
      className={`hidden md:inline-flex shrink-0 items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs whitespace-nowrap ${on ? 'border-sky-500/50 bg-sky-400/15 text-sky-200' : 'border-zinc-700 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'}`}
    >
      {side === 'left' && <PanelIcon side="left" on={on} />}
      {label}
      {side === 'right' && <PanelIcon side="right" on={on} />}
    </button>
  );
}

export default function App() {
  const workspaceVisible = useEditorWorkspace((s) => s.visible);
  const openFiles = useEditorWorkspace((s) => s.files.length);
  const editorLayout = useEditorWorkspace((s) => s.layout);
  const fileTask = useEditorWorkspace((s) => s.files.find((f) => f.id === s.selected[s.pane])?.sessionId);
  const sessions = useStore((s) => s.sessions);
  const selectedId = useStore((s) => s.selectedId);
  const select = useStore((s) => s.select);
  const connected = useStore((s) => s.connected);
  // 画面の構成（左の欄・中央・チャット）。別々に切り替えられ、この端末に残る（layout.ts）
  const sidebar = useLayout((s) => s.sidebar);
  const main = useLayout((s) => s.main);
  const chat = useLayout((s) => s.chat);
  const { setSidebar, setChat, setMain } = useLayout.getState();
  const filesMain = main === 'files';
  const panesMain = main === 'quad' || main === 'focus';
  const segment = segmentOf(main, editorLayout);
  const wide = useDesktop(CHAT_SIDE_WIDTH);
  // チャットを出すか。ファイルの時は狭い画面でも下に並べる。ほかは横に並べられる幅の時だけ
  const chatShown = chat && (filesMain || wide);
  const [dialog, setDialog] = useState(false);
  const [showDetail, setShowDetail] = useState(true);
  useEffect(() => setShowDetail(true), [selectedId]);
  /** 「気づいたこと」の書き込み欄 */
  const [feedback, setFeedback] = useState(false);
  /** スマホ表示のタブ（PC では両方見えるので関係ない）。タスクをパネルに出した時に切り替えるので layout.ts が持つ */
  const tab = useLayout((s) => s.mobileTab);
  const setTab = (mobileTab: 'inbox' | 'list') => useLayout.setState({ mobileTab });
  const [notifPerm, setNotifPerm] = useState<NotificationPermission>(
    'Notification' in window ? Notification.permission : 'denied',
  );
  useTick(15000);

  // ファイルを開いたら（エクスプローラー・差分・検索から）中央をファイルにする。「タスクに戻る」で元の表示へ。
  // そうして開いた時は、最後のファイルを閉じたら元の表示に戻す（自分で「開いたファイル」を選んだ時は空のまま残す）
  const autoFiles = useRef(false);
  useEffect(() => {
    const l = useLayout.getState();
    if (workspaceVisible && l.main !== 'files') {
      autoFiles.current = true;
      setMain('files');
    } else if (!workspaceVisible && l.main === 'files' && autoFiles.current && !useEditorWorkspace.getState().files.length) {
      autoFiles.current = false;
      setMain(l.returnTo ?? 'cards');
    }
  }, [workspaceVisible, setMain]);
  // 中央がファイルの時は編集領域を「表示中」にしておく（保存・タブ移動のキー操作がこの印を見る）
  useEffect(() => {
    if (filesMain && !useEditorWorkspace.getState().visible) useEditorWorkspace.setState({ visible: true });
  }, [filesMain]);
  // ファイルで別のタスクのファイルに移ったら、チャットと左の欄もそのタスクに合わせる
  useEffect(() => {
    if (useLayout.getState().main === 'files' && fileTask) select(fileTask);
  }, [fileTask, select]);
  // 自由配置から「開いたファイル」に戻す時は、その前の並べ方（分割なし・左右・上下）に戻す
  const lastFlat = useRef<EditorLayout>(editorLayout === 'desk' ? 'single' : editorLayout);
  useEffect(() => {
    if (editorLayout !== 'desk') lastFlat.current = editorLayout;
  }, [editorLayout]);
  const chooseSegment = (v: Segment) => {
    autoFiles.current = false;
    setTab('list');
    if (v !== 'files' && v !== 'desk') return setMain(v);
    setMain('files');
    const ed = useEditorWorkspace.getState();
    if (v === 'desk' && ed.layout !== 'desk') ed.split('desk');
    if (v === 'files' && ed.layout === 'desk') ed.split(lastFlat.current);
  };
  // 編集領域へ渡すので作り直さない（タスクの知らせのたびに編集領域を描き直さないように）
  const leaveFiles = useCallback(() => setMain(useLayout.getState().returnTo ?? 'cards'), [setMain]);
  const showInbox = () => useLayout.getState().showInbox();

  const list = useMemo(
    () => {
      // 報告で判断を求めて止まっているもの（idle）も、許可・質問と同じく先頭へ。報告が「完了」のものは終わったものと同じ所へ
      const rank = (s: Session) => (needsYou(s) ? 0 : s.status === 'idle' && isFinished(s) ? ORDER.done : ORDER[s.status]);
      return Object.values(sessions).sort((a, b) => rank(a) - rank(b) || b.updatedAt - a.updatedAt);
    },
    [sessions],
  );
  const waiting = list.filter(needsYou).length;
  const working = list.filter((s) => s.status === 'running' || s.status === 'starting').length;

  // 終わったもの（完了・エラー、報告が完了のもの）を隠して一覧を軽くする。停止は続きができるので隠さない。消すわけではないので「使った量」の集計はそのまま
  const [hideDone, setHideDone] = useState(() => loadLocal('tower.hideDone') === '1');
  useEffect(() => saveLocal('tower.hideDone', hideDone ? '1' : '0'), [hideDone]);
  const finishedCount = list.filter(isFinished).length;

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
    if (words.length === 0) return hideDone ? candidates.filter((s) => !isFinished(s)) : candidates;
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
      // Ctrl+B で左の欄、Ctrl+Alt+B でチャットを出し入れする（VS Code の横の欄と同じキー）
      if (!e.defaultPrevented && !e.isComposing && (e.ctrlKey || e.metaKey) && !e.shiftKey && e.code === 'KeyB') {
        e.preventDefault();
        const l = useLayout.getState();
        if (e.altKey) l.setChat(!l.chat);
        else l.setSidebar(!l.sidebar);
        return;
      }
      if (e.defaultPrevented || e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return;
      if (target?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]')) return;
      // 押した「n」が、開いた画面の指示欄に入らないようにする
      if (e.key === 'n' && !dialog) { e.preventDefault(); setDialog(true); }
      if (e.key === 'f' && !dialog) {
        e.preventDefault();
        setFeedback(true);
      }
      if (e.key === '/' && !dialog && useLayout.getState().main !== 'files') {
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
        ? `詳細「${s.project.name} / ${title}」（${stateBadge(s).label}）`
        : window.innerWidth < 768 && tab === 'inbox'
          ? '判断待ち'
          : q
            ? `一覧（「${q}」で検索中）`
            : '一覧';
    const layout = describeLayout(useLayout.getState(), useEditorWorkspace.getState().layout);
    return {
      view: window.innerWidth < 768 ? view : `${view} · 構成「${layout}」`,
      width: window.innerWidth,
      client: /Electron/i.test(navigator.userAgent) ? 'desktop' : 'browser',
    };
  };

  // 狭い画面のカード・コンパクトは、タスクを選ぶと詳細を画面いっぱいに重ねる（チャットを横に並べる場所が無い）
  const overlayId = !wide && (main === 'cards' || main === 'compact') && showDetail && selectedId && sessions[selectedId] ? selectedId : null;
  const narrowNote = chat && !chatShown ? (panesMain ? '画面が狭いので、チャットは出さずに各パネルから指示します。' : 'タスクを押すと、詳細を画面いっぱいに出します。') : '';

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
          作業中 <b className={working ? 'text-sky-300' : 'text-zinc-200'}>{working}</b> ·{' '}
          <button type="button" onClick={showInbox} title="判断待ちの一覧を左の欄に出します" className="rounded hover:text-zinc-100 hover:underline">
            判断待ち <b className={waiting ? 'text-amber-300' : 'text-zinc-200'}>{waiting}</b>
          </button>{' '}
          · 全 {list.length}
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
      {/* 画面の構成: [左の欄] 中央 [開いたファイル|自由配置|カード|…] [チャット]。並びを画面の左・中央・右に合わせてある */}
      <div role="toolbar" aria-label="画面の構成" className="shrink-0 border-b border-zinc-800 bg-[#10141b] flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <PanelToggle side="left" on={sidebar} label="左の欄" title={`判断待ち・ファイル・検索・Git・設定の欄を${sidebar ? '隠します' : '出します'}（Ctrl+B）`} onClick={() => setSidebar(!sidebar)} />
          <nav aria-label="中央の表示" className="flex flex-wrap items-center gap-0.5 rounded-lg border border-zinc-800 bg-black/20 p-0.5">
            <span aria-hidden="true" className="hidden md:inline px-1.5 text-[11px] text-zinc-500">中央</span>
            {SEGMENTS.map((v) => (
              <button
                key={v.value}
                type="button"
                aria-pressed={segment === v.value}
                title={v.hint}
                onClick={() => chooseSegment(v.value)}
                className={`shrink-0 whitespace-nowrap px-2.5 py-1 rounded-md text-xs ${segment === v.value ? 'bg-sky-400/15 text-sky-200' : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'}`}
              >
                {v.label}
                {v.value === 'files' && openFiles > 0 && <span className="ml-1 rounded-full bg-zinc-700 px-1.5 text-[10px] text-zinc-200"> {openFiles}</span>}
              </button>
            ))}
          </nav>
          <PanelToggle side="right" on={chat} label="チャット" title={`選んだタスクのやりとりと指示欄を右に${chat ? '並べるのをやめます' : '並べます'}（Ctrl+Alt+B）`} onClick={() => setChat(!chat)} />
        </div>
        <p className="min-w-0 text-[11px] text-zinc-500">
          <span className="hidden md:inline">
            いまの画面: <span className="text-zinc-300">{describeLayout({ sidebar, main, chat }, editorLayout)}</span>
            <span aria-hidden="true" className="mx-1.5 text-zinc-700">|</span>
          </span>
          {SEGMENTS.find((v) => v.value === segment)?.hint}
          {narrowNote && <span className="hidden md:inline text-amber-200/70"> {narrowNote}</span>}
        </p>
      </div>

      <div data-resizable-root className="flex-1 flex overflow-hidden">
        {/* スマホ（md 未満）では「判断待ち」と「セッション」をタブで切り替える。PC では「左の欄」で出し入れする */}
        <WorkspaceSidebar className={`${!filesMain && tab === 'inbox' ? 'block' : 'hidden'} ${sidebar ? 'md:block' : 'md:hidden'}`} />

        <div className={`${filesMain ? 'editor-chat-layout flex' : tab === 'list' ? 'flex' : 'hidden md:flex'} layout-center flex-1 min-h-0 min-w-0`}>
          <main style={filesMain ? { display: 'none' } : undefined} className="task-list flex-1 min-w-0 overflow-y-auto p-3 md:p-4">
            {panesMain && list.length > 0 ? <MultiSessionView key={main} sessions={list} single={main === 'focus'} chatShown={chatShown} /> : list.length === 0 ? (
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
                      title="完了・エラーで終わったものを一覧から隠します（消しません。検索と「使った量」には残ります）。停止したものは続きができるので隠しません"
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
                        <div className={main === 'compact' ? 'grid gap-2' : 'grid gap-3 grid-cols-[repeat(auto-fill,minmax(min(100%,300px),1fr))]'}>
                          {tasks.map((s) => (
                            <SessionCard key={s.id} s={s} compact={main === 'compact'} selected={s.id === selectedId} onClick={() => { openTask(s.id); setShowDetail(true); }} />
                          ))}
                        </div>
                      </section>
                    ))}
                  </div>
                )}
              </>
            )}
          </main>

          <EditorWorkspace forceVisible={filesMain} onReturn={leaveFiles} />
          {chatShown && <WorkspaceChat sessions={list} />}
        </div>
        {overlayId && <SessionDetail key={overlayId} id={overlayId} onShowWorkspace={() => { setShowDetail(false); setTab('inbox'); }} />}
      </div>

      <nav className="md:hidden h-12 shrink-0 border-t border-zinc-800 flex bg-[#0c0e12]">
        {selectedId && !showDetail && <button onClick={() => setShowDetail(true)} className="px-3 text-sm text-sky-300">詳細に戻る</button>}
        <button
          onClick={() => { setTab('inbox'); if (filesMain) leaveFiles(); }}
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
