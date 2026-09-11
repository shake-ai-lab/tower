import { useEffect, useState } from 'react';
import { useStore } from '../store';
import { useEditorWorkspace } from '../editor-workspace';
import { useDesktop, useResizable } from '../lib';
import { SessionDetail } from './SessionDetail';

export function WorkspaceChat() {
  const sessions = useStore((s) => s.sessions);
  const selected = useStore((s) => s.selectedId);
  const fileTask = useEditorWorkspace((s) => s.files.find((f) => f.id === s.selected[s.pane])?.sessionId);
  const [chosen, setChosen] = useState<string | null>(null);
  const id = chosen && sessions[chosen] ? chosen : fileTask ?? selected ?? Object.keys(sessions)[0];
  useEffect(() => { if (id) useStore.getState().select(id); }, [id]);
  const wide = useDesktop(1200);
  const resize = useResizable('workspace-chat', 380, 300, 700, 'right');
  useEffect(() => setChosen(null), [fileTask]);
  return <aside aria-label="ファイルと並べるチャット" ref={resize.ref} data-resizable-panel
    className="workspace-chat relative flex flex-col min-h-0 min-w-0 border-l border-zinc-700 bg-[#0c0e12]"
    style={wide ? { width: resize.width, minWidth: 300, maxWidth: '45%', flexShrink: 0 } : undefined}>
    {wide && <div role="separator" aria-label="チャットの幅" aria-orientation="vertical" aria-valuemin={300} aria-valuemax={700} aria-valuenow={resize.actualWidth} tabIndex={0}
      onMouseDown={resize.onMouseDown} onDoubleClick={resize.reset} onKeyDown={resize.onKeyDown}
      className="absolute left-0 inset-y-0 w-1.5 z-20 cursor-col-resize hover:bg-sky-500/60 focus:bg-sky-500/60" />}
    <label className="flex items-center gap-2 p-2 text-xs border-b border-zinc-800">チャット
      <select aria-label="チャットのタスク" value={id ?? ''} onChange={(e) => setChosen(e.target.value)} className="flex-1 min-w-0 bg-zinc-900 border border-zinc-700 p-1">
        {!Object.keys(sessions).length && <option value="">タスクがありません</option>}
        {Object.values(sessions).map((s) => <option key={s.id} value={s.id}>{s.project.name} / {s.title}</option>)}
      </select>
    </label>
    <div className="flex-1 min-h-0">{id && sessions[id] ? <SessionDetail key={id} id={id} embedded /> : <p className="p-4 text-sm text-zinc-500">新しいタスクを作成すると、ここから指示を送れます。</p>}</div>
  </aside>;
}
