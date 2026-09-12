import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useEditorWorkspace, type OpenFile } from '../editor-workspace';
import { Aquarium } from './Aquarium';
import { DeskScene } from './DeskScene';
import { isAnimatedTheme, isSceneTheme } from '../desk-scenes';
import { DESK_ORIGIN, deskBounds, scaleText, textScale } from '../desk-geometry';
import { loadDesk, saveDesk } from '../editor-persist';
import { useStore } from '../store';
import { DeskWindowControls, type DeskRect } from './DeskWindowControls';
const FileEditor = lazy(() => import('./FileEditor').then((m) => ({ default: m.FileEditor })));

function Document({ file, active, windowed, fontScale }: { file: OpenFile; active: boolean; windowed: boolean; fontScale: number }) {
  const session = useStore((s) => s.sessions[file.sessionId]);
  const dirty = useEditorWorkspace((s) => s.dirty);
  const onDirty = useCallback((value: boolean) => dirty(file.id, value), [dirty, file.id]);
  return <FileEditor sessionId={file.sessionId} path={file.path} active={active} onDirty={onDirty} windowed={windowed} fontScale={fontScale} reveal={file.reveal} focusRequest={file.focusRequest}
    readOnly={!session || ['starting', 'running', 'waiting_permission', 'waiting_question'].includes(session.status)}
    onClose={() => useEditorWorkspace.getState().close(file.id)} onSaved={file.onSaved} />;
}

export function EditorWorkspace({ forceVisible = false, onReturn }: { forceVisible?: boolean; onReturn?: () => void }) {
  const s = useEditorWorkspace();
  const visible = s.visible || forceVisible;
  const sessions = useStore((s) => s.sessions);
  const activeFile = s.files.find((f) => f.id === s.selected[s.pane]);
  // 分割の比率・自由配置の位置と倍率は前回の続きから（editor-persist）
  const [saved] = useState(() => loadDesk());
  const [ratio, setRatio] = useState(saved?.ratio ?? 50);
  const [zoom, setZoom] = useState(saved?.zoom ?? 1);
  const [deskSelected, setDeskSelected] = useState<string | null>(null);
  const themes = [['dots', 'ドット'], ['wood', '作業机'], ['aquarium', 'アクアリウム'], ['circuit', '電気図面'], ['blueprint', '設計図'], ['paper', '方眼紙'], ['night', '星空'], ['forest', '森'], ['slate', '黒板'], ['plain', '無地']] as const;
  const [theme, setTheme] = useState(() => { try { return localStorage.getItem('tower.desk.theme') ?? 'dots'; } catch { return 'dots'; } });

  const [aquariumMotion, setAquariumMotion] = useState<'auto' | 'playing' | 'paused'>(() => {
    try { const saved = localStorage.getItem('tower.aquarium.motion'); return saved === 'playing' || saved === 'paused' ? saved : 'auto'; } catch { return 'auto'; }
  });
  const [reducedMotion, setReducedMotion] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    const media = matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReducedMotion(media.matches);
    update(); media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  const aquariumPaused = aquariumMotion === 'paused' || (aquariumMotion === 'auto' && reducedMotion);
  const toggleAquarium = () => {
    const next = aquariumPaused ? 'playing' : 'paused';
    setAquariumMotion(next);
    try { localStorage.setItem('tower.aquarium.motion', next); } catch {}
  };
  const [positions, setPositions] = useState<Record<string, DeskRect>>(() => saved?.positions ?? {});
  const desk = s.layout === 'desk';
  const position = (id: string, i: number) => positions[id] ?? { x: -260 + (i % 4) * 70, y: -220 + (i % 4) * 55 + Math.floor(i / 4) * 100, w: 520, h: 440, angle: 0, z: i };
  const changePosition = (id: string, i: number, patch: Partial<ReturnType<typeof position>>) => setPositions((cur) => ({ ...cur, [id]: { ...(cur[id] ?? position(id, i)), ...patch } }));
  const deskSelectedRef = useRef(deskSelected);
  deskSelectedRef.current = deskSelected;
  const region = useRef<HTMLDivElement>(null);
  const center = useRef(saved?.center ?? { x: 0, y: 0 });
  const [restores, setRestores] = useState<Record<string, DeskRect>>(() => saved?.restores ?? {});
  // 並べ方を端末に残す（再起動・入れ直しのあとも戻る）。スクロールのたびに書かないよう少し待つ
  const deskState = useRef({ ratio, zoom, positions, restores });
  deskState.current = { ratio, zoom, positions, restores };
  const persistTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const writeDesk = useCallback(() => {
    clearTimeout(persistTimer.current);
    const ids = new Set(useEditorWorkspace.getState().files.map((f) => f.id));
    const keep = (r: Record<string, DeskRect>) => Object.fromEntries(Object.entries(r).filter(([id]) => ids.has(id)));
    const d = deskState.current;
    saveDesk({ ratio: d.ratio, zoom: d.zoom, positions: keep(d.positions), restores: keep(d.restores), center: center.current });
  }, []);
  const persistDesk = useCallback(() => { clearTimeout(persistTimer.current); persistTimer.current = setTimeout(writeDesk, 300); }, [writeDesk]);
  useEffect(persistDesk, [ratio, zoom, positions, restores, s.files, persistDesk]);
  useEffect(() => { window.addEventListener('pagehide', writeDesk); return () => window.removeEventListener('pagehide', writeDesk); }, [writeDesk]);
  const pan = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const bringForward = (id: string, i: number) => {
    s.activate(id);
    setDeskSelected(id);
    setPositions((cur) => ({ ...cur, [id]: { ...(cur[id] ?? position(id, i)), z: Math.max(s.files.length, ...Object.values(cur).map((p) => p.z)) + 1 } }));
  };
  const maximize = (id: string, i: number) => {
    const el = region.current;
    if (!el) return;
    bringForward(id, i);
    if (restores[id]) {
      const { z: _, ...rect } = restores[id]; changePosition(id, i, rect);
      setRestores((cur) => { const next = { ...cur }; delete next[id]; return next; });
    } else {
      setRestores((cur) => ({ ...cur, [id]: position(id, i) }));
      changePosition(id, i, { x: (el.scrollLeft + 14) / zoom - DESK_ORIGIN.x, y: (el.scrollTop + 14) / zoom - DESK_ORIGIN.y, w: Math.max(300, (el.clientWidth - 28) / zoom), h: Math.max(220, (el.clientHeight - 28) / zoom), angle: 0 });
    }
  };
  const centerAt = (x = 0, y = 0, value = zoom) => {
    center.current = { x, y };
    requestAnimationFrame(() => {
      const el = region.current; if (!el) return;
      el.scrollLeft = (DESK_ORIGIN.x + x) * value - el.clientWidth / 2;
      el.scrollTop = (DESK_ORIGIN.y + y) * value - el.clientHeight / 2;
    });
  };
  useLayoutEffect(() => { if (desk && visible) centerAt(center.current.x, center.current.y); }, [desk, visible]);
  const fit = (rects = s.files.map((f, i) => position(f.id, i))) => {
    const bounds = deskBounds(rects), el = region.current;
    if (!el) return;
    const value = Math.max(.1, Math.min(1, (el.clientWidth - 120) / Math.max(1, bounds.w), (el.clientHeight - 140) / Math.max(1, bounds.h)));
    setZoom(value); centerAt(bounds.x + bounds.w / 2, bounds.y + bounds.h / 2, value);
  };
  const arrange = () => {
    const cols = Math.min(3, s.files.length), rows = Math.ceil(s.files.length / Math.max(1, cols));
    const next = Object.fromEntries(s.files.map((f, i) => [f.id, { x: (i % cols) * 580 - (cols * 580 - 60) / 2, y: Math.floor(i / cols) * 520 - (rows * 520 - 80) / 2, w: 520, h: 440, angle: 0, z: i, text: positions[f.id]?.text }]));
    setPositions(next); setRestores({}); fit(Object.values(next));
  };
  const scaleWindowText = (id: string, i: number, value: number) => changePosition(id, i, scaleText(position(id, i), value));
  const zoomAt = (value: number, clientX?: number, clientY?: number) => {
    const el = region.current;
    if (!el) return;
    const next = Math.max(0.1, Math.min(2, value)), rect = el.getBoundingClientRect();
    const x = clientX === undefined ? el.clientWidth / 2 : clientX - rect.left;
    const y = clientY === undefined ? el.clientHeight / 2 : clientY - rect.top;
    const left = (el.scrollLeft + x) * next / zoom - x, top = (el.scrollTop + y) * next / zoom - y;
    setZoom(next);
    requestAnimationFrame(() => { el.scrollLeft = left; el.scrollTop = top; });
  };
  useEffect(() => {
    const el = region.current;
    if (!desk || !el) return;
    const wheel = (e: WheelEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.altKey) {
        const panel = (e.target as HTMLElement).closest<HTMLElement>('[data-desk-file]');
        const id = panel?.dataset.deskFile, i = s.files.findIndex((f) => f.id === id);
        if (id && i >= 0) { e.preventDefault(); scaleWindowText(id, i, textScale(position(id, i)) * Math.exp(-e.deltaY * .002)); }
        return;
      }
      if (e.ctrlKey || e.metaKey || !(e.target as HTMLElement).closest('[role="tabpanel"]')) { e.preventDefault(); zoomAt(zoom * Math.exp(-e.deltaY * 0.002), e.clientX, e.clientY); }
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, [desk, zoom, positions, restores, s.files]);
  useEffect(() => {
    if (!desk || !visible) return;
    const key = (e: KeyboardEvent) => {
      if (e.isComposing || e.defaultPrevented) return;
      if ((e.ctrlKey || e.metaKey) && ['+', '=', '-', '0'].includes(e.key)) {
        e.preventDefault(); e.stopPropagation();
        if (e.altKey) { const id = deskSelected, i = s.files.findIndex((f) => f.id === id); if (id && i >= 0) scaleWindowText(id, i, e.key === '0' ? 1 : textScale(position(id, i)) * (e.key === '-' ? 1 / 1.15 : 1.15)); }
        else zoomAt(e.key === '0' ? 1 : zoom * (e.key === '-' ? 1 / 1.15 : 1.15));
      }
      if (e.key === 'Escape') setDeskSelected(null);
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [desk, visible, zoom, deskSelected, positions, restores, s.files]);
  const split = s.layout !== 'single' && !desk;
  useEffect(() => {
    if (desk && activeFile) bringForward(activeFile.id, s.files.findIndex((f) => f.id === activeFile.id));
  }, [desk, activeFile?.id]);
  const rows = s.layout === 'rows';
  useEffect(() => {
    const unload = (e: BeforeUnloadEvent) => {
      if (useEditorWorkspace.getState().files.some((f) => f.dirty)) { e.preventDefault(); e.returnValue = ''; }
    };
    const key = (e: KeyboardEvent) => {
      const s = useEditorWorkspace.getState();
      if (!s.visible || e.isComposing || e.defaultPrevented) return;
      if ((e.ctrlKey || e.metaKey) && e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); const i = s.files.findIndex((f) => f.id === s.selected[s.pane]); const next = s.files[(i + (e.shiftKey ? -1 : 1) + s.files.length) % s.files.length]; if (next) { s.activate(next.id); setDeskSelected(next.id); } }
      if ((e.ctrlKey || e.metaKey) && e.key === '\\') { e.preventDefault(); s.split('columns'); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'w') { e.preventDefault(); e.stopPropagation(); const id = s.selected[s.pane]; if (id && (s.layout !== 'desk' || deskSelectedRef.current === id)) s.close(id); }
      if (e.key === 'Escape') { setDeskSelected(null); if (!(e.target as HTMLElement).closest('.monaco-editor')) e.stopPropagation(); }
    };
    window.addEventListener('beforeunload', unload);
    window.addEventListener('keydown', key, true);
    return () => { window.removeEventListener('beforeunload', unload); window.removeEventListener('keydown', key, true); };
  }, []);
  return <section aria-label="ファイルエディタ" className={`${visible ? 'flex' : 'hidden'} flex-1 min-w-0 min-h-0 flex-col bg-[#12151b]`}>
    <header className="flex flex-wrap items-center gap-2 p-2 border-b border-zinc-700 text-xs">
      <span className="text-zinc-400 mr-auto truncate" title={activeFile ? `${sessions[activeFile.sessionId]?.project.path} / ${activeFile.path}` : undefined}>ファイル · {s.files.length} 件{activeFile && ` · ${sessions[activeFile.sessionId]?.project.name ?? '削除されたタスク'} / ${activeFile.path}`}</span>
      {([['single', '分割なし'], ['columns', '左右に分割'], ['rows', '上下に分割'], ['desk', '自由に配置']] as const).map(([layout, label]) => <button key={layout} aria-pressed={s.layout === layout} className={`rounded px-2 py-1 ${s.layout === layout ? 'bg-sky-900 text-sky-200' : 'bg-zinc-800'}`} onClick={() => s.split(layout)}>{label}</button>)}
      <details className="relative"><summary>キー操作</summary><div className="absolute right-0 top-6 z-50 w-72 bg-zinc-900 border border-zinc-600 p-3 leading-6 shadow-xl">Ctrl / ⌘ + S：保存<br />Ctrl / ⌘ + F：ファイル内検索<br />Ctrl / ⌘ + P：ファイル名で開く<br />Ctrl / ⌘ + Shift + F：プロジェクト全体から探す<br />Ctrl / ⌘ + W：閉じる<br />Ctrl / ⌘ + Tab：次のファイル（Shiftで前へ）<br />Ctrl / ⌘ + ＼：左右に分割<br />自由配置：Ctrl / ⌘ + ＋・−：拡大・縮小、0：100%<br />Ctrl / ⌘ + Alt + ＋・−・0：選択ウィンドウの文字の大きさ（Ctrl / ⌘ + Alt + ホイールでも）<br />Esc：配置の選択解除<br />タイトルで矢印キー：移動<br />Ctrl / ⌘ + Shift + E：ファイル一覧<br />Ctrl / ⌘ + Shift + G：Git<br />Ctrl / ⌘ + ,：設定<br />Ctrl / ⌘ + Shift + N：新しいタスク</div></details>
      {desk && <><select aria-label="デスクの背景" className="bg-zinc-800 border border-zinc-700 px-2 py-1" value={theme} onChange={(e) => { setTheme(e.target.value); try { localStorage.setItem('tower.desk.theme', e.target.value); } catch {} }}>{themes.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select><span className="text-zinc-500">辺・角でサイズ変更 · 上の丸で回転 · 余白をドラッグで移動</span><button aria-label="デスクを縮小" onClick={() => zoomAt(zoom / 1.15)}>−</button><button title="100%に戻す" onClick={() => zoomAt(1)}>{Math.round(zoom * 100)}%</button><button aria-label="デスクを拡大" onClick={() => zoomAt(zoom * 1.15)}>＋</button><button onClick={arrange}>整列</button><button onClick={() => fit()}>全体を見る</button><button onClick={() => centerAt()}>中央に戻る</button>{isAnimatedTheme(theme) && <>{aquariumMotion === 'auto' && reducedMotion && <span className="text-zinc-400">OS設定に合わせて静止中</span>}<button aria-pressed={!aquariumPaused} title="背景の動きの再生・静止を選んで保存（OS設定より優先）" onClick={toggleAquarium}>{aquariumPaused ? '背景を動かす' : '背景を静止'}</button></>}</>}
      <button className="px-2 py-1 text-sky-300" onClick={() => { if (onReturn) onReturn(); else useEditorWorkspace.setState({ visible: false }); }}>タスクに戻る</button>
    </header>
    <div className={`relative flex flex-1 min-h-0 min-w-0 overflow-hidden ${desk && theme === 'aquarium' ? 'aquarium-scene' : ''}`}>
    {desk && theme === 'aquarium' && <Aquarium active={visible} paused={aquariumPaused} />}
    {desk && isSceneTheme(theme) && <DeskScene key={theme} theme={theme} active={visible} paused={aquariumPaused} />}
    <div ref={region} aria-label={desk ? '自由配置のデスク' : undefined} className={`desk-region relative flex-1 min-h-0 min-w-0 ${desk ? 'overflow-auto' : 'grid'}`} style={{ gridTemplateColumns: split && !rows ? `${ratio}fr 6px ${100 - ratio}fr` : 'minmax(0, 1fr)', gridTemplateRows: split && rows ? `minmax(0, ${ratio}fr) 6px minmax(0, ${100 - ratio}fr)` : 'minmax(0, 1fr)' }}
      onScroll={(e) => { if (desk) center.current = { x: (e.currentTarget.scrollLeft + e.currentTarget.clientWidth / 2) / zoom - DESK_ORIGIN.x, y: (e.currentTarget.scrollTop + e.currentTarget.clientHeight / 2) / zoom - DESK_ORIGIN.y }; if (desk) persistDesk(); }}
      onPointerDown={(e) => { if (!desk || (e.button !== 1 && (e.button !== 0 || (e.target as HTMLElement).closest('[role="tabpanel"]')))) return; e.preventDefault(); setDeskSelected(null); if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); pan.current = { x: e.clientX, y: e.clientY, left: e.currentTarget.scrollLeft, top: e.currentTarget.scrollTop }; e.currentTarget.setPointerCapture(e.pointerId); e.currentTarget.style.cursor = 'grabbing'; }}
      onPointerMove={(e) => { if (!pan.current) return; e.currentTarget.scrollLeft = pan.current.left - (e.clientX - pan.current.x); e.currentTarget.scrollTop = pan.current.top - (e.clientY - pan.current.y); }}
      onPointerUp={(e) => { if (!pan.current) return; pan.current = null; e.currentTarget.releasePointerCapture(e.pointerId); e.currentTarget.style.cursor = ''; }}
      onPointerCancel={(e) => { pan.current = null; e.currentTarget.style.cursor = ''; }}>
      {desk && <div aria-hidden="true" className={`cursor-grab desk-background ${theme === 'aquarium' || isSceneTheme(theme) ? 'desk-theme-clear' : `desk-theme-${theme}`}`} style={{ width: Math.max(DESK_ORIGIN.x * 2, ...Object.values(positions).map((p) => DESK_ORIGIN.x + p.x + p.w + 4000)) * zoom, height: Math.max(DESK_ORIGIN.y * 2, ...Object.values(positions).map((p) => DESK_ORIGIN.y + p.y + p.h + 4000)) * zoom }} />}
      {(desk ? [] : [0, ...(split ? [1] : [])]).map((pane) => <div key={pane} style={{ gridArea: rows ? `${pane * 2 + 1} / 1` : `1 / ${pane * 2 + 1}` }} className={`min-w-0 min-h-0 border ${s.pane === pane ? 'border-sky-700' : 'border-zinc-800'}`} onPointerDown={() => useEditorWorkspace.setState({ pane })}>
        <div role="tablist" aria-label={`グループ${pane + 1}`} className="relative z-10 flex h-10 overflow-x-auto bg-[#0c0e12]">
          {s.files.filter((f) => f.pane === pane).map((f) => <div key={f.id} className={`flex shrink-0 items-center border-r border-zinc-800 ${s.selected[pane] === f.id ? 'bg-zinc-700 text-white' : 'text-zinc-400'}`}>
            <button role="tab" aria-selected={s.selected[pane] === f.id} title={`${sessions[f.sessionId]?.project.name} · ${sessions[f.sessionId]?.title}\n${sessions[f.sessionId]?.project.path} / ${f.path}`} className="px-3 py-2 text-xs max-w-56 truncate" onClick={() => s.activate(f.id)}>{f.dirty ? '● ' : ''}{f.path}</button>
            <button aria-label={`${f.path}を別グループへ移動`} title="別グループへ移動" className="px-1" onClick={() => s.move(f.id)}>⇄</button>
            <button aria-label={`${f.path}を閉じる`} className="px-2" onClick={() => s.close(f.id)}>×</button>
          </div>)}
        </div>
        {!s.selected[pane] && <button className="p-6 text-sm text-zinc-400 text-left" onClick={() => useEditorWorkspace.setState({ pane })}>このグループを選んで、左のエクスプローラーからファイルを開いてください。</button>}
      </div>)}
      {s.files.map((file, i) => <div key={file.id} data-desk-file={file.id} role="tabpanel" aria-label={file.path} style={desk ? { position: 'absolute', left: (DESK_ORIGIN.x + position(file.id, i).x) * zoom, top: (DESK_ORIGIN.y + position(file.id, i).y) * zoom, width: position(file.id, i).w, height: position(file.id, i).h, transform: `scale(${zoom}) rotate(${position(file.id, i).angle}deg)`, transformOrigin: 'top left', zIndex: position(file.id, i).z } : { gridArea: rows ? `${file.pane * 2 + 1} / 1` : `1 / ${file.pane * 2 + 1}`, display: s.selected[file.pane] === file.id ? undefined : 'none' }} className={`${desk ? `desk-window flex flex-col ${deskSelected === file.id ? 'desk-window-active' : ''}` : 'relative mt-10'} min-h-0 min-w-0`} onFocusCapture={() => { s.activate(file.id); if (desk) setDeskSelected(file.id); }} onPointerDown={() => { if (desk) bringForward(file.id, i); else s.activate(file.id); }}>
        {desk && <DeskWindowControls name={file.path} project={sessions[file.sessionId]?.project.name} rect={position(file.id, i)} zoom={zoom}
          onChange={(patch) => changePosition(file.id, i, patch)} onActivate={() => bringForward(file.id, i)}
          onClose={() => s.close(file.id)} maximized={!!restores[file.id]} onMaximize={() => maximize(file.id, i)} />}

        <div className="h-full flex-1 min-h-0 overflow-hidden rounded-b-md"><Suspense fallback={<p className="p-4 text-sm">エディタを読み込み中…</p>}><Document file={file} windowed={desk} fontScale={desk ? textScale(position(file.id, i)) : 1} active={visible && s.pane === file.pane && s.selected[file.pane] === file.id} /></Suspense></div>
      </div>)}
      {split && <div role="separator" aria-label="エディタの分割幅" aria-orientation={rows ? 'horizontal' : 'vertical'} aria-valuemin={20} aria-valuemax={80} aria-valuenow={Math.round(ratio)} tabIndex={0}
        className={`z-20 bg-zinc-800 hover:bg-sky-600 focus:bg-sky-600 ${rows ? 'cursor-row-resize' : 'cursor-col-resize'}`} style={{ gridArea: rows ? '2 / 1' : '1 / 2', touchAction: 'none' }}
        onDoubleClick={() => setRatio(50)} onKeyDown={(e) => { if (['ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown'].includes(e.key)) { e.preventDefault(); setRatio((r) => Math.max(20, Math.min(80, r + (['ArrowLeft', 'ArrowUp'].includes(e.key) ? -5 : 5)))); } }}
        onPointerDown={(e) => { e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); }}
        onPointerMove={(e) => { if (!e.currentTarget.hasPointerCapture(e.pointerId)) return; const rect = region.current!.getBoundingClientRect(); setRatio(Math.max(20, Math.min(80, 100 * (rows ? (e.clientY - rect.top) / rect.height : (e.clientX - rect.left) / rect.width)))); }}
        onPointerUp={(e) => e.currentTarget.releasePointerCapture(e.pointerId)} />}
    </div>
    {!s.files.length && <p className="absolute inset-0 flex items-center justify-center p-8 text-sm text-zinc-400 pointer-events-none">左のエクスプローラーでファイルを選んでください。</p>}
    </div>
  </section>;
}
