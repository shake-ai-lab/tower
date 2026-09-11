import { useEffect, useRef } from 'react';
import { createScene } from '../desk-scenes';

// One viewport-sized canvas behind the desk. Still scenes paint once per size;
// animated ones run at up to 30 fps while the desk is visible and not paused.
export function DeskScene({ theme, active, paused }: { theme: string; active: boolean; paused: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const playback = useRef({ active, paused });
  const refresh = useRef<() => void>(() => {});
  playback.current = { active, paused };
  useEffect(() => refresh.current(), [active, paused]);
  useEffect(() => {
    const el = canvas.current!, ctx = el.getContext('2d');
    const scene = createScene(theme, crypto.getRandomValues(new Uint32Array(1))[0]);
    if (!ctx || !scene) return;
    const host = el.parentElement!;
    const region = host.querySelector<HTMLElement>('.desk-region');
    let frame = 0, previous = 0, w = 1, h = 1, time = 0, disposed = false;
    const paint = (dt: number) => {
      // Where the viewport sits on the desk, -1..1 on each axis, independent of the desk zoom.
      const spot = (at: number, size: number, total: number) => Math.max(-1, Math.min(1, ((at + size / 2) / Math.max(1, total) - .5) * 2));
      const parallax = region ? { x: spot(region.scrollLeft, region.clientWidth, region.scrollWidth), y: spot(region.scrollTop, region.clientHeight, region.scrollHeight) } : { x: 0, y: 0 };
      scene.paint({ ctx, w, h, time, dt, parallax });
      el.dataset.sceneReady = 'true'; el.dataset.sceneTime = time.toFixed(3);
    };
    const tick = (stamp: number) => {
      if (stamp - previous >= 33) {
        const dt = previous ? Math.min(.08, (stamp - previous) / 1000) : 0;
        time += dt; previous = stamp; paint(dt);
      }
      frame = requestAnimationFrame(tick);
    };
    const sync = () => {
      if (disposed) return;
      cancelAnimationFrame(frame); previous = 0; paint(0);
      if (scene.animated && playback.current.active && !playback.current.paused && !document.hidden) frame = requestAnimationFrame(tick);
    };
    refresh.current = sync;
    const resize = new ResizeObserver(() => {
      const rect = el.getBoundingClientRect(), dpr = Math.min(devicePixelRatio || 1, 1.5);
      w = Math.max(1, rect.width); h = Math.max(1, rect.height);
      el.width = Math.round(w * dpr); el.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      scene.build(w, h); sync();
    });
    const scroll = () => { if (scene.animated && playback.current.paused) paint(0); };
    resize.observe(el); document.addEventListener('visibilitychange', sync); region?.addEventListener('scroll', scroll);
    return () => { disposed = true; cancelAnimationFrame(frame); resize.disconnect(); document.removeEventListener('visibilitychange', sync); region?.removeEventListener('scroll', scroll); refresh.current = () => {}; };
  }, [theme]);
  return <canvas ref={canvas} aria-hidden="true" className="desk-scene absolute inset-0 w-full h-full pointer-events-none" />;
}
