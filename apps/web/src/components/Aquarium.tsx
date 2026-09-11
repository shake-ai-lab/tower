import { useEffect, useRef } from 'react';
import { createAquarium, stepAquarium, type AquariumState, type Fish } from '../aquarium-simulation';
import { createWaterRenderer } from '../aquarium-water';

// Three viewport-sized layers: the live water (WebGL), fish behind the glass, and fine matter in front.
export function Aquarium({ active, paused }: { active: boolean; paused: boolean }) {
  const water = useRef<HTMLCanvasElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const foreground = useRef<HTMLCanvasElement>(null);
  const state = useRef<AquariumState | null>(null);
  const playback = useRef({ active, paused });
  const refresh = useRef<() => void>(() => {});
  playback.current = { active, paused };
  useEffect(() => refresh.current(), [active, paused]);
  useEffect(() => {
    const el = canvas.current!, front = foreground.current!, wet = water.current!;
    const ctx = el.getContext('2d')!, fg = front.getContext('2d')!;
    if (!ctx || !fg) return;
    const gpu = createWaterRenderer(wet);
    wet.hidden = !gpu;
    el.dataset.water = gpu ? 'gpu' : '2d';
    if (!state.current) state.current = createAquarium(crypto.getRandomValues(new Uint32Array(1))[0]);
    const scene = state.current;
    const environment = new Image(), atlas = new Image();
    const mirror = document.createElement('canvas');
    const backdrop = document.createElement('canvas'), bg = backdrop.getContext('2d')!;
    let frame = 0, previous = 0, w = 1, h = 1, ready = false, disposed = false;
    const host = el.parentElement!;
    // Still photo for machines without WebGL.
    const photo = () => {
      if (gpu) { gpu.setPhoto(environment); ready = environment.complete && environment.naturalWidth > 0; return; }
      backdrop.width = Math.ceil(w + 48); backdrop.height = Math.ceil(h + 48);
      const gradient = bg.createLinearGradient(0, 0, 0, h); gradient.addColorStop(0, '#155962'); gradient.addColorStop(1, '#071e25');
      bg.fillStyle = gradient; bg.fillRect(0, 0, backdrop.width, backdrop.height);
      if (!environment.complete || !environment.naturalWidth) return;
      const scale = Math.max(backdrop.width / environment.naturalWidth, backdrop.height / environment.naturalHeight);
      const dw = environment.naturalWidth * scale, dh = environment.naturalHeight * scale;
      bg.drawImage(environment, (backdrop.width - dw) / 2, (backdrop.height - dh) / 2, dw, dh);
      bg.fillStyle = '#03263135'; bg.fillRect(0, 0, backdrop.width, backdrop.height);
      ready = true;
    };
    const flip = () => {
      mirror.width = atlas.naturalWidth; mirror.height = atlas.naturalHeight;
      const m = mirror.getContext('2d')!; m.translate(mirror.width, 0); m.scale(-1, 1); m.drawImage(atlas, 0, 0);
    };
    const drawFish = (target: CanvasRenderingContext2D, fish: Fish) => {
      if (!atlas.complete || !atlas.naturalWidth) return;
      const crops = [[.005, .282], [.289, .283], [.575, .397]];
      const [top, height] = crops[fish.species];
      const sw = atlas.naturalWidth, sh = atlas.naturalHeight * height, sy = top * atlas.naturalHeight;
      const length = (fish.species === 2 ? 145 : fish.species === 1 ? 88 : 65) * fish.size * (.48 + fish.z * .65) * Math.min(1.3, Math.max(.7, w / 1250));
      const tall = length * sh / sw;
      const strips = 22, slice = sw / strips, step = length / strips;
      // A turn is a twist around the fish's spine: the head faces the new way first, the tail follows.
      // Each strip has its own yaw; its width is the cosine, its depth the sine (toward the glass or away).
      const cos: number[] = [], sin: number[] = [], xs = [0], thick = fish.species === 2 ? .11 : .17;
      for (let i = 0; i < strips; i++) {
        const p = i / (strips - 1), ease = p * p * (3 - 2 * p);
        const c = Math.max(-1, Math.min(1, fish.tail + (fish.facing - fish.tail) * ease));
        const depth = (fish.turn * Math.sqrt(Math.max(0, 1 - c * c)));
        cos.push(c); sin.push(depth);
        xs.push(xs[i] + step * (c >= 0 ? 1 : -1) * Math.max(Math.abs(c), thick * Math.abs(depth)));
      }
      // Seen head-on a fish still has a body; keep that much width when a strip is edge-on.
      const shift = -(xs[0] + xs[strips]) / 2, alpha = .42 + fish.z * .5;
      target.save(); target.translate(fish.x * w, fish.y * h);
      target.rotate(Math.atan2(fish.vy, Math.max(.012, Math.abs(fish.vx))) * .32 * (fish.facing < 0 ? -1 : 1));
      for (let i = 0; i < strips; i++) {
        const p = i / (strips - 1), bend = Math.pow(1 - p, 2.8);
        const offset = Math.sin(fish.phase - p * 3.5) * tall * .12 * bend;
        const width = step * Math.max(Math.abs(cos[i]), thick * Math.abs(sin[i])), left = (xs[i] + xs[i + 1]) / 2 + shift - width / 2;
        const size = tall * (1 + sin[i] * .16);
        target.globalAlpha = alpha * (1 - .3 * Math.abs(sin[i]));
        if (cos[i] >= 0) target.drawImage(atlas, i * slice, sy, slice, sh, left, -size / 2 + offset, width + .5, size);
        else target.drawImage(mirror, sw - (i + 1) * slice, sy, slice, sh, left, -size / 2 + offset, width + .5, size);
      }
      target.restore();
    };
    const paint = () => {
      const time = scene.time;
      if (gpu) { gpu.draw(time); ctx.clearRect(0, 0, w, h); }
      else {
        ctx.fillStyle = '#082932'; ctx.fillRect(0, 0, w, h);
        // Low-amplitude scan bands refract the photographic scene without moving the camera.
        for (let y = 0; y < h; y += 24) {
          const offset = Math.sin(y / h * 9 + time * .28) * 1.7 + Math.sin(y / h * 21 - time * .18) * .7;
          const height = Math.min(24, h - y);
          ctx.drawImage(backdrop, 24 + offset, 24 + y, w, height, 0, y, w, height);
        }
      }
      // Moving caustic threads with nonmatching periods, softly mixed into the water.
      ctx.save(); ctx.globalCompositeOperation = 'screen'; ctx.lineWidth = 1;
      for (let row = 0; row < 10; row++) {
        ctx.strokeStyle = `rgba(143,231,214,${.013 + row * .001})`; ctx.beginPath();
        for (let x = 0; x <= w; x += 18) {
          const y = h * (.08 + row * .099) + Math.sin(x * .011 + time * .24 + row * 1.7) * 17 + Math.sin(x * .025 - time * .18) * 5;
          if (!x) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      const glow = ctx.createRadialGradient(w * .19, 0, 0, w * .19, 0, w * .75);
      glow.addColorStop(0, `rgba(179,237,208,${.025 + Math.sin(time * .23) * .012})`); glow.addColorStop(1, '#6cdebf00');
      ctx.fillStyle = glow; ctx.fillRect(0, 0, w, h); ctx.restore();
      const fish = [...scene.fish].sort((a, b) => a.z - b.z);
      for (const f of fish) drawFish(ctx, f);
      fg.clearRect(0, 0, w, h);
      // Protect the readable area of documents while allowing near fish over the glass rims.
      fg.save(); fg.beginPath(); fg.rect(0, 0, w, h);
      const region = host.getBoundingClientRect();
      for (const pane of host.querySelectorAll<HTMLElement>('.desk-window')) {
        const r = pane.getBoundingClientRect();
        fg.rect(r.left - region.left + 14, r.top - region.top + 30, Math.max(0, r.width - 28), Math.max(0, r.height - 44));
      }
      fg.clip('evenodd');
      for (const f of fish) if (f.z > .78) drawFish(fg, f);
      for (const b of scene.bubbles) {
        const x = b.x * w + Math.sin(time * .8 + b.phase + b.y * 7) * (4 + b.z * 12), y = b.y * h;
        const radius = b.radius * (.5 + b.z * .7);
        const target = b.z > .55 ? fg : ctx;
        target.strokeStyle = `rgba(204,247,233,${.12 + b.z * .2})`; target.lineWidth = .65;
        target.beginPath(); target.ellipse(x, y, radius, radius * 1.12, .1 * Math.sin(time + b.phase), 0, Math.PI * 2); target.stroke();
        target.fillStyle = '#e7fff765'; target.beginPath(); target.arc(x - radius * .3, y - radius * .45, Math.max(.35, radius * .18), 0, Math.PI * 2); target.fill();
      }
      for (const p of scene.particles) {
        const x = ((p.x + time * .001 * (.3 + p.z)) % 1) * w;
        const y = p.y * h + Math.sin(time * .15 + p.phase) * 8;
        fg.fillStyle = `rgba(209,240,218,${.1 + p.z * .2})`; fg.beginPath(); fg.arc(x, y, .3 + p.z * .85, 0, Math.PI * 2); fg.fill();
      }
      fg.restore();
      host.style.setProperty('--water-x', `${50 + Math.sin(time * .19) * 35}%`);
      host.style.setProperty('--water-y', `${50 + Math.sin(time * .13 + 2) * 40}%`);
      el.dataset.sceneReady = String(ready && atlas.complete && atlas.naturalWidth > 0);
      el.dataset.simulationTime = time.toFixed(3);
    };
    const tick = (stamp: number) => {
      if (stamp - previous >= 33) {
        if (previous) stepAquarium(scene, (stamp - previous) / 1000);
        previous = stamp; paint();
      }
      frame = requestAnimationFrame(tick);
    };
    const sync = () => {
      if (disposed) return;
      cancelAnimationFrame(frame); previous = 0; paint();
      if (playback.current.active && !playback.current.paused && !document.hidden) frame = requestAnimationFrame(tick);
    };
    refresh.current = sync;
    environment.onload = () => { photo(); sync(); }; atlas.onload = () => { flip(); sync(); };
    environment.onerror = sync; atlas.onerror = sync;
    environment.src = '/aquarium/aquascape.png'; atlas.src = '/aquarium/fish-atlas.png';
    const resize = new ResizeObserver(() => {
      const rect = el.getBoundingClientRect(), dpr = Math.min(devicePixelRatio || 1, 1.5);
      w = Math.max(1, rect.width); h = Math.max(1, rect.height);
      for (const surface of [el, front]) { surface.width = Math.round(w * dpr); surface.height = Math.round(h * dpr); }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); fg.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (gpu) gpu.resize(w, h, dpr); else photo();
      sync();
    });
    const scroll = () => { if (playback.current.paused) paint(); };
    const positions = new MutationObserver((changes) => {
      if (playback.current.paused && changes.some((change) => (change.target as HTMLElement).classList?.contains('desk-window'))) paint();
    });
    positions.observe(host, {subtree: true, attributes: true, attributeFilter: ['style']});
    host.addEventListener('scroll', scroll, true);
    resize.observe(el); document.addEventListener('visibilitychange', sync);
    return () => { disposed = true; cancelAnimationFrame(frame); resize.disconnect(); positions.disconnect(); host.removeEventListener('scroll', scroll, true); document.removeEventListener('visibilitychange', sync); environment.onload = null; atlas.onload = null; refresh.current = () => {}; gpu?.dispose(); };
  }, []);
  return <>
    <canvas ref={water} aria-hidden="true" className="aquarium-water absolute inset-0 w-full h-full pointer-events-none" />
    <canvas ref={canvas} aria-hidden="true" className="aquarium-canvas absolute inset-0 w-full h-full pointer-events-none" />
    <canvas ref={foreground} aria-hidden="true" className="aquarium-foreground absolute inset-0 w-full h-full pointer-events-none z-40" />
  </>;
}
