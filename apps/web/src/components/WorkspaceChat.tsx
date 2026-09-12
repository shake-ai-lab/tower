// 右に並べる「チャット」: 選んだタスクのやりとり（報告・経過）と指示欄。中央がファイル・カード・4分割…の何であっても同じものを出す。
// 出し入れは上の「チャット」ボタン・ここの ✕・Ctrl+Alt+B（layout.ts）
import { useEffect, useRef, useState } from 'react';
import type { Session } from '@tower/shared';
import { useStore } from '../store';
import { useEditorWorkspace } from '../editor-workspace';
import { useDesktop, useResizable } from '../lib';
import { CHAT_SIDE_WIDTH, useLayout } from '../layout';
import { SessionDetail } from './SessionDetail';
import { TaskPicker } from './TaskPicker';

export function WorkspaceChat({ sessions }: { sessions: Session[] }) {
  const all = useStore((s) => s.sessions);
  const selected = useStore((s) => s.selectedId);
  const select = useStore((s) => s.select);
  const main = useLayout((s) => s.main);
  const reveal = useLayout((s) => s.reveal);
  const fileTask = useEditorWorkspace((s) => s.files.find((f) => f.id === s.selected[s.pane])?.sessionId);
  const [shown, setShown] = useState<string | null>(selected);
  // 選んだタスクを出す。ただし 4分割・集中のパネルを押して選んだもの（もう中央に見えている）では入れ替えない
  useEffect(() => {
    const l = useLayout.getState();
    const inPanes = !!selected && (l.main === 'quad' ? l.slots.includes(selected) : l.main === 'focus' && l.focusId === selected);
    if (!inPanes) setShown(selected);
  }, [selected]);
  const id = shown && all[shown] ? shown : main === 'files' && fileTask && all[fileTask] ? fileTask : null;
  const [picking, setPicking] = useState(false);
  // ファイルと並べる時は、狭い画面ではファイルの下に回す（index.css の editor-chat-layout）
  const wideFiles = useDesktop(1200);
  const wideOther = useDesktop(CHAT_SIDE_WIDTH);
  const wide = main === 'files' ? wideFiles : wideOther;
  const resize = useResizable('workspace-chat', 420, 300, 1000, 'right');

  // 判断待ちの「答える」で開いた時は、枠を光らせて指示欄にすぐ書けるようにする
  const [flash, setFlash] = useState(false);
  const handled = useRef(0);
  useEffect(() => {
    if (!reveal || reveal.target !== 'chat' || reveal.id !== id || handled.current === reveal.at || Date.now() - reveal.ts > 2000) return;
    handled.current = reveal.at;
    if (!reveal.answer) return;
    setFlash(true);
    requestAnimationFrame(() => resize.ref.current?.querySelector<HTMLTextAreaElement>('footer textarea:not(:disabled)')?.focus());
  }, [reveal, id, resize.ref]);
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(false), 1500);
    return () => clearTimeout(t);
  }, [flash]);

  return <aside aria-label="チャット" ref={resize.ref} data-resizable-panel
    className={`workspace-chat relative flex flex-col min-h-0 min-w-0 border-l border-zinc-700 bg-[#0c0e12] ${flash ? 'reveal-flash' : ''}`}
    style={wide ? { width: resize.width, minWidth: 300, maxWidth: main === 'files' ? '45%' : '60%', flexShrink: 1 } : undefined}>
    {wide && <div role="separator" aria-label="チャットの幅" aria-orientation="vertical" aria-valuemin={300} aria-valuemax={1000} aria-valuenow={resize.actualWidth} tabIndex={0}
      onMouseDown={resize.onMouseDown} onDoubleClick={resize.reset} onKeyDown={resize.onKeyDown}
      className="absolute left-0 inset-y-0 w-1.5 z-20 cursor-col-resize hover:bg-sky-500/60 focus:bg-sky-500/60" />}
    <div className="shrink-0 flex items-center gap-2 border-b border-zinc-800 bg-[#10141b] px-2 py-1.5">
      <span className="shrink-0 text-xs font-semibold text-zinc-300">チャット</span>
      <TaskPicker label="チャットのタスク" sessions={sessions} value={id} open={picking} onOpenChange={setPicking}
        onChange={(next) => { setShown(next); if (next) select(next); }} />
      <button type="button" aria-label="チャットを隠す" title="チャットを隠す（Ctrl+Alt+B）。上の「チャット」でまた出せます"
        onClick={() => useLayout.getState().setChat(false)}
        className="shrink-0 rounded px-1.5 py-0.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100">✕</button>
    </div>
    <div className="flex-1 min-h-0">{id ? <SessionDetail key={id} id={id} embedded /> : (
      <p className="p-4 text-sm leading-relaxed text-zinc-500">
        {sessions.length ? 'タスクを選ぶと、ここにやりとりと指示欄が出ます。カードや判断待ちから開くか、上の欄から選んでください。' : '新しいタスクを作成すると、ここから指示を送れます。'}
      </p>
    )}</div>
  </aside>;
}
