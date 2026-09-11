import { useEffect, useMemo, useRef, useState } from 'react';
import type { FeedbackContext, Session, SessionStatus } from '@tower/shared';
import { BridgeMenu } from './components/BridgeMenu';
import { FeedbackMenu } from './components/FeedbackMenu';
import { Inbox } from './components/Inbox';
import { NewSessionDialog } from './components/NewSessionDialog';
import { SessionCard } from './components/SessionCard';
import { SessionDetail } from './components/SessionDetail';
import { UsageMenu } from './components/UsageMenu';
import { STATUS, btn, useTick } from './lib';
import { useStore } from './store';

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

function notify(s: Session) {
  if (!('Notification' in window) || Notification.permission !== 'granted' || !s.pending) return;
  const p = s.pending;
  const title = `${s.project.name}: ${p.kind === 'permission' ? '許可待ち' : '質問があります'}`;
  const body = p.kind === 'permission' ? p.headline : (p.questions[0]?.question ?? '');
  try {
    new Notification(title, { body, tag: p.id });
  } catch {
    /* ブラウザによっては投げる */
  }
}

export default function App() {
  const sessions = useStore((s) => s.sessions);
  const selectedId = useStore((s) => s.selectedId);
  const select = useStore((s) => s.select);
  const connected = useStore((s) => s.connected);
  const [dialog, setDialog] = useState(false);
  /** 「気づいたこと」の書き込み欄 */
  const [feedback, setFeedback] = useState(false);
  /** スマホ表示のタブ（PC では両方見えるので関係ない） */
  const [tab, setTab] = useState<'inbox' | 'list'>('inbox');
  const [notifPerm, setNotifPerm] = useState<NotificationPermission>(
    'Notification' in window ? Notification.permission : 'denied',
  );
  useTick(15000);

  const list = useMemo(
    () => Object.values(sessions).sort((a, b) => ORDER[a.status] - ORDER[b.status] || b.updatedAt - a.updatedAt),
    [sessions],
  );
  const waiting = list.filter((s) => s.pending).length;
  const working = list.filter((s) => s.status === 'running' || s.status === 'starting').length;

  // 終わったもの（停止・完了・エラー）を隠して一覧を軽くする。消すわけではないので「使った量」の集計はそのまま
  const [hideDone, setHideDone] = useState(() => localStorage.getItem('tower.hideDone') === '1');
  useEffect(() => localStorage.setItem('tower.hideDone', hideDone ? '1' : '0'), [hideDone]);
  const finishedCount = list.filter((s) => FINISHED.includes(s.status)).length;

  // 履歴検索: プロジェクト名・依頼文・報告の言葉で絞り込む（空白区切りは AND）。検索中は隠しているものも対象
  const [q, setQ] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const shown = useMemo(() => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) return hideDone ? list.filter((s) => !FINISHED.includes(s.status)) : list;
    const text = (s: Session) =>
      [s.project.name, s.title, s.prompt, s.model ?? '', s.agent, s.workspace?.branch ?? '', s.report?.raw ?? '', s.report?.summary.join(' ') ?? '']
        .join('\n')
        .toLowerCase();
    return list.filter((s) => {
      const t = text(s);
      return words.every((w) => t.includes(w));
    });
  }, [list, q, hideDone]);

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
  const seen = useRef(new Set<string>());
  useEffect(() => {
    for (const s of list) {
      if (s.pending && !seen.current.has(s.pending.id)) {
        seen.current.add(s.pending.id);
        notify(s);
      }
    }
  }, [list]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.key === 'n' && !dialog) setDialog(true);
      if (e.key === 'f' && !dialog) {
        e.preventDefault();
        setFeedback(true);
      }
      if (e.key === '/' && !dialog) {
        e.preventDefault();
        setTab('list');
        searchRef.current?.focus();
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
          作業中 <b className="text-zinc-200">{working}</b> · 判断待ち{' '}
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

      <div className="flex-1 flex overflow-hidden">
        {/* スマホ（md 未満）では「判断待ち」と「セッション」をタブで切り替える。PC では横に並べる */}
        <Inbox className={tab === 'inbox' ? 'block' : 'hidden md:block'} />

        <main className={`${tab === 'list' ? 'block' : 'hidden'} md:block flex-1 overflow-y-auto p-3 md:p-4`}>
          {list.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-zinc-500 gap-3">
              <div className="text-lg">まだセッションがありません</div>
              <button onClick={() => setDialog(true)} className={`${btn.base} ${btn.primary}`}>
                最初のタスクを任せる
              </button>
            </div>
          ) : (
            <>
              <div className="mb-3 flex items-center gap-2">
                <input
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
                  className="flex-1 max-w-[520px] bg-zinc-900 border border-zinc-800 rounded-md px-3 py-1.5 text-sm placeholder:text-zinc-600 focus:outline-none focus:border-sky-600"
                />
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
                  {q ? `「${q}」に一致するセッションはありません` : '動いているものも、指示待ちのものもありません。終わったものは隠しています。'}
                </div>
              ) : (
                <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(300px,1fr))]">
                  {shown.map((s) => (
                    <SessionCard key={s.id} s={s} selected={s.id === selectedId} onClick={() => select(s.id)} />
                  ))}
                </div>
              )}
            </>
          )}
        </main>

        {selectedId && sessions[selectedId] && <SessionDetail id={selectedId} />}
      </div>

      <nav className="md:hidden h-12 shrink-0 border-t border-zinc-800 flex bg-[#0c0e12]">
        <button
          onClick={() => setTab('inbox')}
          className={`flex-1 text-sm flex items-center justify-center gap-2 ${tab === 'inbox' ? 'text-zinc-100 border-t-2 border-sky-500' : 'text-zinc-500'}`}
        >
          判断待ち
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
