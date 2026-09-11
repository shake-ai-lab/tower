import { rotateDesk, scaleText, textScale, TEXT_MAX, TEXT_MIN } from '../desk-geometry';
import { useEffect, useRef, type PointerEvent } from 'react';

export type DeskRect = { x: number; y: number; w: number; h: number; angle: number; z: number; text?: number };
const rotate = (x: number, y: number, degrees: number) => {
  const a = degrees * Math.PI / 180;
  return { x: x * Math.cos(a) - y * Math.sin(a), y: x * Math.sin(a) + y * Math.cos(a) };
};

export function resizeDesk(start: DeskRect, edge: string, dx: number, dy: number): DeskRect {
  const local = rotate(dx, dy, -start.angle);
  const w = Math.max(300, start.w + (edge.includes('e') ? local.x : edge.includes('w') ? -local.x : 0));
  const h = Math.max(220, start.h + (edge.includes('s') ? local.y : edge.includes('n') ? -local.y : 0));
  const offset = rotate(edge.includes('w') ? start.w - w : 0, edge.includes('n') ? start.h - h : 0, start.angle);
  return { ...start, x: start.x + offset.x, y: start.y + offset.y, w, h };
}

export function DeskWindowControls({ name, project, rect, zoom, onChange, onActivate, onMaximize, onClose, maximized }: {
  name: string; project?: string; rect: DeskRect; zoom: number;
  onChange: (rect: Partial<DeskRect>) => void; onActivate: () => void; onMaximize: () => void; onClose: () => void; maximized: boolean;
}) {
  const gesture = useRef<{ mode: string; start: DeskRect; x: number; y: number; centerX: number; centerY: number; initialAngle: number; target: HTMLElement; pointerId: number } | null>(null);
  const finish = () => { const g = gesture.current; gesture.current = null; if (g?.target.hasPointerCapture(g.pointerId)) g.target.releasePointerCapture(g.pointerId); };
  useEffect(() => {
    const cancel = (e: KeyboardEvent) => { if (e.key === 'Escape' && gesture.current) { onChange(gesture.current.start); finish(); } };
    window.addEventListener('keydown', cancel);
    return () => window.removeEventListener('keydown', cancel);
  }, [onChange]);
  const begin = (e: PointerEvent<HTMLElement>, mode: string) => {
    if (e.button !== 0 || (maximized && mode !== 'rotate')) return;
    e.preventDefault(); e.stopPropagation(); onActivate();
    const box = e.currentTarget.closest('[role="tabpanel"]')!.getBoundingClientRect();
    const centerX = box.x + box.width / 2, centerY = box.y + box.height / 2;
    gesture.current = { mode, start: rect, x: e.clientX, y: e.clientY, centerX, centerY, initialAngle: Math.atan2(e.clientY - centerY, e.clientX - centerX), target: e.currentTarget, pointerId: e.pointerId };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const move = (e: PointerEvent) => {
    const g = gesture.current;
    if (!g) return;
    const dx = (e.clientX - g.x) / zoom, dy = (e.clientY - g.y) / zoom;
    if (g.mode === 'move') onChange({ x: g.start.x + dx, y: g.start.y + dy });
    else if (g.mode === 'rotate') {
      let angle = g.start.angle + (Math.atan2(e.clientY - g.centerY, e.clientX - g.centerX) - g.initialAngle) * 180 / Math.PI;
      if (e.shiftKey) angle = Math.round(angle / 15) * 15;
      const before = rotate(g.start.w / 2, g.start.h / 2, g.start.angle), after = rotate(g.start.w / 2, g.start.h / 2, angle);
      onChange({ angle, x: g.start.x + before.x - after.x, y: g.start.y + before.y - after.y });
    } else { const { z: _, ...resized } = resizeDesk(g.start, g.mode, dx, dy); onChange(resized); }
  };
  return <div className="desk-window-controls" onPointerMove={move} onPointerUp={finish} onPointerCancel={() => { if (gesture.current) onChange(gesture.current.start); finish(); }}>
    <div className="desk-titlebar" onDoubleClick={onMaximize}>
      <button aria-label={`${name}を移動`} className="desk-window-title" onPointerDown={(e) => begin(e, 'move')} onKeyDown={(e) => {
        if (e.key.startsWith('Arrow')) { e.preventDefault(); onChange({ x: rect.x + (e.key === 'ArrowRight' ? 20 : e.key === 'ArrowLeft' ? -20 : 0), y: rect.y + (e.key === 'ArrowDown' ? 20 : e.key === 'ArrowUp' ? -20 : 0) }); }
      }} title="ドラッグで移動・ダブルクリックで最大化">{name}<span>{project}</span></button>
      <button disabled={textScale(rect) <= TEXT_MIN} aria-label={`${name}の文字を小さく`} title="このウィンドウの文字を小さく（Ctrl+Alt+−）" className="desk-text-button" onClick={() => onChange(scaleText(rect, textScale(rect) / 1.15))}>A−</button>
      <button aria-label={`${name}の文字の大きさを戻す`} title="文字の大きさを100%に戻す（Ctrl+Alt+0）" className="desk-scale-label" onClick={() => onChange(scaleText(rect, 1))}>{Math.round(textScale(rect) * 100)}%</button>
      <button disabled={textScale(rect) >= TEXT_MAX} aria-label={`${name}の文字を大きく`} title="このウィンドウの文字を大きく（Ctrl+Alt+＋）" className="desk-text-button" onClick={() => onChange(scaleText(rect, textScale(rect) * 1.15))}>A＋</button>
      <button aria-label={`${name}の回転を戻す`} title="回転を戻す" onDoubleClick={(e) => e.stopPropagation()} onClick={() => onChange(rotateDesk(rect, 0))}>↺</button>
      <button aria-label={`${name}を${maximized ? '元の大きさに戻す' : '最大化'}`} title={maximized ? '元の大きさに戻す' : '最大化'} onDoubleClick={(e) => e.stopPropagation()} onClick={onMaximize}>{maximized ? '❐' : '□'}</button>
      <button aria-label={`${name}を閉じる`} className="desk-window-close" onDoubleClick={(e) => e.stopPropagation()} onClick={onClose}>×</button>
    </div>
    {!maximized && <>
      <button className="desk-rotate-handle" aria-label={`${name}を回転`} title="ドラッグで回転・Shiftで15°刻み・ダブルクリックで戻す" onPointerDown={(e) => begin(e, 'rotate')} onDoubleClick={() => onChange(rotateDesk(rect, 0))} onKeyDown={(e) => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); onChange(rotateDesk(rect, rect.angle + (e.key === 'ArrowRight' ? 5 : -5))); } }}>↻</button>
      {['n', 'e', 's', 'w', 'ne', 'se', 'sw', 'nw'].map((edge) => <div key={edge} role="separator" tabIndex={0} aria-label={`${name}のサイズ変更 ${edge}`} className={`desk-resize desk-resize-${edge}`} onPointerDown={(e) => begin(e, edge)} onKeyDown={(e) => { if (e.key.startsWith('Arrow')) { e.preventDefault(); onChange(resizeDesk(rect, edge, e.key === 'ArrowRight' ? 20 : e.key === 'ArrowLeft' ? -20 : 0, e.key === 'ArrowDown' ? 20 : e.key === 'ArrowUp' ? -20 : 0)); } }} />)}
    </>}
  </div>;
}
