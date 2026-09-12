import type { DeskRect } from './components/DeskWindowControls';

// Logical (0, 0) sits in the middle, leaving room on every side.
export const DESK_ORIGIN = { x: 24000, y: 18000 };
// Text size inside a window (the frame keeps its size; only the editor font grows).
export const TEXT_MIN = .6, TEXT_MAX = 2.5;
export const textScale = (rect: DeskRect) => rect.text ?? 1;
export const scaleText = (rect: DeskRect, value: number): DeskRect => ({ ...rect, text: Math.max(TEXT_MIN, Math.min(TEXT_MAX, value)) });
export function rotateDesk(rect: DeskRect, angle: number): DeskRect {
  const a = rect.angle * Math.PI / 180, b = angle * Math.PI / 180;
  return { ...rect, angle,
    x: rect.x + (rect.w * (Math.cos(a) - Math.cos(b)) - rect.h * (Math.sin(a) - Math.sin(b))) / 2,
    y: rect.y + (rect.w * (Math.sin(a) - Math.sin(b)) + rect.h * (Math.cos(a) - Math.cos(b))) / 2 };
}
/**
 * 自由配置のホイールの意味。置いた場所で意味を変えない:
 * Ctrl / ⌘ + ホイール（タッチパッドのピンチも ctrlKey 付きで届く）= 作業場の拡大縮小（どこでも）。
 * それに Alt も押していてファイルの上なら、そのウィンドウの文字の大きさ。ふつうのホイール = 指している物をスクロール
 */
export function deskWheelAction(e: { ctrlKey: boolean; metaKey: boolean; altKey: boolean }, overWindow: boolean): 'zoom' | 'text' | 'scroll' {
  if (!e.ctrlKey && !e.metaKey) return 'scroll';
  return e.altKey && overWindow ? 'text' : 'zoom';
}
/** ホイール 1 回分の倍率。マウスの 1 目盛りで約 1.22 倍、ピンチ（小さな量が続けて届く）は細かく。行・ページ単位もならす */
export function wheelZoomFactor(deltaY: number, deltaMode = 0): number {
  const px = deltaMode === 1 ? deltaY * 40 : deltaMode === 2 ? deltaY * 800 : deltaY;
  return Math.exp(-Math.max(-50, Math.min(50, px)) * .004);
}
/** 倍率を from → to に変えた時、画面上の点 at（作業場の左上からの位置）が同じ所に留まるスクロール位置 */
export function zoomScroll(scroll: { left: number; top: number }, at: { x: number; y: number }, from: number, to: number) {
  return { left: (scroll.left + at.x) * to / from - at.x, top: (scroll.top + at.y) * to / from - at.y };
}
export function deskBounds(rects: DeskRect[]) {
  const points = rects.flatMap((r) => {
    const a = r.angle * Math.PI / 180;
    return [[0, 0], [r.w, 0], [0, r.h], [r.w, r.h]].map(([x, y]) => ({
      x: r.x + x * Math.cos(a) - y * Math.sin(a),
      y: r.y + x * Math.sin(a) + y * Math.cos(a),
    }));
  });
  if (!points.length) return { x: 0, y: 0, w: 520, h: 440 };
  const left = Math.min(...points.map((p) => p.x)), top = Math.min(...points.map((p) => p.y));
  return { x: left, y: top, w: Math.max(...points.map((p) => p.x)) - left, h: Math.max(...points.map((p) => p.y)) - top };
}
