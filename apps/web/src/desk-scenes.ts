// Desk backgrounds drawn on a canvas instead of CSS gradients.
// Each scene builds its still layers once per size (build) and paints per frame (paint).
// Animated scenes keep a little state; still scenes only paint their cached layer.
import { seededRandom } from './aquarium-simulation';

export const SCENE_THEMES = ['dots', 'plain', 'wood', 'circuit', 'blueprint', 'paper', 'night', 'forest', 'slate'] as const;
export type SceneTheme = typeof SCENE_THEMES[number];
export const ANIMATED_THEMES = ['aquarium', 'night', 'forest', 'circuit', 'blueprint'] as const;
export const isSceneTheme = (theme: string): theme is SceneTheme => (SCENE_THEMES as readonly string[]).includes(theme);
export const isAnimatedTheme = (theme: string) => (ANIMATED_THEMES as readonly string[]).includes(theme);

// parallax: where the viewport sits on the desk, -1..1 on each axis.
export type Frame = { ctx: CanvasRenderingContext2D; w: number; h: number; time: number; dt: number; parallax: { x: number; y: number } };
export type Scene = { animated: boolean; build(w: number, h: number): void; paint(f: Frame): void };

type Layer = HTMLCanvasElement;
const layer = (w: number, h: number): [Layer, CanvasRenderingContext2D] => {
  const c = document.createElement('canvas'); c.width = Math.max(1, Math.ceil(w)); c.height = Math.max(1, Math.ceil(h));
  return [c, c.getContext('2d')!];
};
const clamp = (v: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));
const smooth = (t: number) => t * t * (3 - 2 * t);

// Value noise with fractal sum, seeded so a scene looks the same until the seed changes.
export function makeNoise(random: () => number) {
  const size = 256, values = Float32Array.from({ length: size * size }, () => random());
  const at = (x: number, y: number) => values[((y & 255) << 8) | (x & 255)];
  const noise = (x: number, y: number) => {
    const ix = Math.floor(x), iy = Math.floor(y), fx = smooth(x - ix), fy = smooth(y - iy);
    const a = at(ix, iy), b = at(ix + 1, iy), c = at(ix, iy + 1), d = at(ix + 1, iy + 1);
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  };
  const fbm = (x: number, y: number, octaves = 4) => {
    let sum = 0, amp = .5, total = 0;
    for (let i = 0; i < octaves; i++) { sum += noise(x, y) * amp; total += amp; x *= 2.03; y *= 1.97; amp *= .5; }
    return sum / total;
  };
  return { noise, fbm };
}

// Fills a half-resolution layer pixel by pixel; cheap enough once per resize.
function shade(w: number, h: number, pixel: (x: number, y: number) => [number, number, number]): Layer {
  const scale = .5, [c, ctx] = layer(w * scale, h * scale);
  const image = ctx.createImageData(c.width, c.height), data = image.data;
  for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
    const [r, g, b] = pixel(x / scale, y / scale), i = (y * c.width + x) * 4;
    data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  return c;
}
const vignette = (ctx: CanvasRenderingContext2D, w: number, h: number, strength: number) => {
  const g = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * .3, w / 2, h / 2, Math.hypot(w, h) * .6);
  g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, `rgba(0,0,0,${strength})`);
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
};

function wood(random: () => number): Scene {
  const { fbm } = makeNoise(random);
  let still: Layer | null = null;
  return {
    animated: false,
    build(w, h) {
      const plank = 150, offsets = Array.from({ length: Math.ceil(h / plank) + 1 }, () => random() * 900);
      const tone = offsets.map(() => .85 + random() * .3);
      const grain = shade(w, h, (x, y) => {
        const row = Math.floor(y / plank), off = offsets[row], local = y - row * plank;
        const rings = fbm(x * .0022 + off, y * .014 + off, 3) * 16 + local * .06 + x * .0015;
        const ring = Math.abs(((rings % 1) + 1) % 1 - .5) * 2;
        const streak = fbm(x * .05 + off, y * .9, 2);
        const seam = local < 2 || local > plank - 2 ? .55 : local < 6 ? .85 : 1;
        const v = (.62 + ring * .2 + streak * .18) * tone[row] * seam;
        return [clamp(v * 126, 0, 255), clamp(v * 84, 0, 255), clamp(v * 54, 0, 255)];
      });
      const [c, ctx] = layer(w, h);
      ctx.imageSmoothingEnabled = true; ctx.drawImage(grain, 0, 0, w, h);
      // Fine open pores and broken fibres follow the grain, rather than a flat noise overlay.
      for (let i = 0; i < w * h / 100; i++) {
        const x = random() * w, y = random() * h, len = 2 + random() * 24;
        ctx.strokeStyle = random() < .7 ? 'rgba(37,19,10,.14)' : 'rgba(244,200,141,.12)';
        ctx.lineWidth = .35 + random() * .55; ctx.beginPath(); ctx.moveTo(x, y);
        ctx.quadraticCurveTo(x + len * .5, y + .7, x + len, y + .2); ctx.stroke();
      }
      for (let row = 0; row < offsets.length; row++) {
        const x = (row % 2 ? .68 : .27) * w, y = row * plank;
        ctx.fillStyle = '#26160d60'; ctx.fillRect(x, y, 1, plank);
        ctx.fillStyle = '#e9bb7530'; ctx.fillRect(x + 1, y, 1, plank);
        // A small knot with irregular, nested growth rings.
        ctx.save(); ctx.translate((.18 + random() * .64) * w, y + plank * .55); ctx.scale(3.8, 1);
        for (let ring = 15; ring > 0; ring--) {
          ctx.strokeStyle = `rgba(43,23,12,${.09 + (16 - ring) * .006})`; ctx.lineWidth = .45;
          ctx.beginPath(); ctx.ellipse(0, 0, ring * 1.3, ring * .62, .04, 0, Math.PI * 2); ctx.stroke();
        }
        ctx.restore();
      }
      // Desk lamp from the upper right, and a soft shadow under the edges.
      const lamp = ctx.createRadialGradient(w * .72, -h * .1, 0, w * .72, -h * .1, Math.max(w, h) * .9);
      lamp.addColorStop(0, 'rgba(255,214,150,.26)'); lamp.addColorStop(.5, 'rgba(255,200,130,.08)'); lamp.addColorStop(1, 'rgba(60,30,10,.25)');
      ctx.fillStyle = lamp; ctx.fillRect(0, 0, w, h);
      vignette(ctx, w, h, .5);
      still = c;
    },
    paint({ ctx }) { if (still) ctx.drawImage(still, 0, 0); },
  };
}

function paper(random: () => number): Scene {
  const { fbm } = makeNoise(random);
  let still: Layer | null = null;
  return {
    animated: false,
    build(w, h) {
      const fiber = shade(w, h, (x, y) => {
        const v = .92 + (fbm(x * .03, y * .03, 2) - .5) * .05 + (fbm(x * .35, y * .35, 2) - .5) * .06 + (fbm(x * 1.3, y * 1.3, 1) - .5) * .05;
        return [clamp(v * 236, 0, 255), clamp(v * 230, 0, 255), clamp(v * 210, 0, 255)];
      });
      const [c, ctx] = layer(w, h);
      ctx.drawImage(fiber, 0, 0, w, h);
      for (let i = 0; i < w * h / 75; i++) {
        const x = random() * w, y = random() * h;
        ctx.strokeStyle = random() < .5 ? '#fffdf433' : '#82776216'; ctx.lineWidth = .45;
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + random() * 5, y + random() * 2); ctx.stroke();
      }
      const cell = 24, major = 5;
      for (let x = 0; x <= w; x += cell) {
        const big = Math.round(x / cell) % major === 0;
        ctx.strokeStyle = big ? 'rgba(96,122,110,.5)' : 'rgba(110,138,124,.26)'; ctx.lineWidth = big ? 1.1 : .8;
        ctx.beginPath(); ctx.moveTo(x + .5, 0); ctx.lineTo(x + .5, h); ctx.stroke();
      }
      for (let y = 0; y <= h; y += cell) {
        const big = Math.round(y / cell) % major === 0;
        ctx.strokeStyle = big ? 'rgba(96,122,110,.5)' : 'rgba(110,138,124,.26)'; ctx.lineWidth = big ? 1.1 : .8;
        ctx.beginPath(); ctx.moveTo(0, y + .5); ctx.lineTo(w, y + .5); ctx.stroke();
      }
      // Sunlight from a window on the left, and slightly darker edges as on a real sheet.
      ctx.fillStyle = '#7d665525'; ctx.font = '9px monospace';
      for (let x = 120; x < w - 24; x += 120) ctx.fillText(String(x / 24), x + 4, 14);
      for (let y = 120; y < h - 24; y += 120) ctx.fillText(String(y / 24), 5, y - 5);
      const light = ctx.createLinearGradient(0, 0, w, h * .4);
      light.addColorStop(0, 'rgba(255,250,225,.35)'); light.addColorStop(.6, 'rgba(255,250,225,0)');
      ctx.fillStyle = light; ctx.fillRect(0, 0, w, h);
      vignette(ctx, w, h, .16);
      still = c;
    },
    paint({ ctx }) { if (still) ctx.drawImage(still, 0, 0); },
  };
}

function slate(random: () => number): Scene {
  const { fbm } = makeNoise(random);
  let still: Layer | null = null;
  return {
    animated: false,
    build(w, h) {
      const board = shade(w, h, (x, y) => {
        const v = .9 + (fbm(x * .02, y * .02, 4) - .5) * .35 + (fbm(x * .6, y * .6, 1) - .5) * .08;
        return [clamp(v * 36, 0, 255), clamp(v * 54, 0, 255), clamp(v * 50, 0, 255)];
      });
      const [c, ctx] = layer(w, h);
      ctx.drawImage(board, 0, 0, w, h);
      // Eraser sweeps: wide, soft, slightly tilted strokes of leftover chalk.
      for (let i = 0; i < 14; i++) {
        const x = random() * w, y = random() * h * .85, len = 120 + random() * 320, wide = 40 + random() * 60, angle = (random() - .5) * .5;
        ctx.save(); ctx.translate(x, y); ctx.rotate(angle); ctx.scale(len / wide, 1);
        const g = ctx.createRadialGradient(0, 0, 0, 0, 0, wide / 2);
        g.addColorStop(0, `rgba(255,255,255,${.035 + random() * .045})`); g.addColorStop(.7, `rgba(255,255,255,${.015 + random() * .02})`); g.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, wide / 2, 0, Math.PI * 2); ctx.fill(); ctx.restore();
      }
      // Chalk dust.
      ctx.save(); ctx.strokeStyle = '#d7e5d00c'; ctx.lineWidth = .65;
      for (let i = 0; i < 180; i++) {
        const x = random() * w, y = random() * h;
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 20 + random() * 160, y + (random() - .5) * 8); ctx.stroke();
      }
      ctx.restore(); vignette(ctx, w, h, .32);
      for (let i = 0; i < w * h / 260; i++) {
        ctx.fillStyle = `rgba(255,255,255,${.03 + random() * .1})`;
        ctx.fillRect(random() * w, random() * h * .96, .6 + random() * 1.2, .6 + random() * 1.2);
      }
      // Wooden tray with two chalks and a felt eraser.
      const tray = 26, top = h - tray;
      const shadow = ctx.createLinearGradient(0, top - 18, 0, top); shadow.addColorStop(0, 'rgba(0,0,0,0)'); shadow.addColorStop(1, 'rgba(0,0,0,.45)');
      ctx.fillStyle = shadow; ctx.fillRect(0, top - 18, w, 18);
      const woodTone = ctx.createLinearGradient(0, top, 0, h); woodTone.addColorStop(0, '#8a6238'); woodTone.addColorStop(.3, '#6e4a29'); woodTone.addColorStop(1, '#4a301a');
      ctx.fillStyle = woodTone; ctx.fillRect(0, top, w, tray);
      ctx.fillStyle = 'rgba(255,220,180,.25)'; ctx.fillRect(0, top, w, 1.5);
      const chalk = (x: number, color: string) => { ctx.fillStyle = color; ctx.beginPath(); ctx.roundRect(x, top + 5, 58, 9, 4); ctx.fill(); ctx.fillStyle = 'rgba(0,0,0,.25)'; ctx.fillRect(x, top + 11, 58, 3); };
      chalk(w * .18, '#f2f0e8'); chalk(w * .18 + 74, '#efe0a0');
      ctx.fillStyle = '#2d2a33'; ctx.beginPath(); ctx.roundRect(w * .62, top + 2, 88, 16, 3); ctx.fill();
      ctx.fillStyle = '#c9c4b6'; ctx.fillRect(w * .62 + 4, top + 12, 80, 6);
      still = c;
    },
    paint({ ctx }) { if (still) ctx.drawImage(still, 0, 0); },
  };
}

type Stroke = { kind: 'line'; x1: number; y1: number; x2: number; y2: number; dash?: boolean } | { kind: 'arc'; x: number; y: number; r: number; a: number; b: number };
function blueprint(random: () => number): Scene {
  const { fbm } = makeNoise(random);
  let still: Layer | null = null, W = 1, H = 1;
  // Each figure draws itself over 14 s, rests 18 s, fades in 4 s, then a new one starts elsewhere.
  type Figure = { strokes: Stroke[]; lengths: number[]; total: number; born: number };
  const figures: Figure[] = [];
  const figure = (time: number): Figure => {
    const cx = 120 + random() * (W - 240), cy = 100 + random() * (H - 200), s = 60 + random() * 70, strokes: Stroke[] = [];
    const kind = Math.floor(random() * 3);
    if (kind === 0) { // flange: circles, bolt holes, center lines
      strokes.push({ kind: 'arc', x: cx, y: cy, r: s, a: 0, b: Math.PI * 2 }, { kind: 'arc', x: cx, y: cy, r: s * .42, a: 0, b: Math.PI * 2 });
      for (let i = 0; i < 6; i++) { const a = i / 6 * Math.PI * 2; strokes.push({ kind: 'arc', x: cx + Math.cos(a) * s * .72, y: cy + Math.sin(a) * s * .72, r: s * .09, a: 0, b: Math.PI * 2 }); }
      strokes.push({ kind: 'line', x1: cx - s * 1.25, y1: cy, x2: cx + s * 1.25, y2: cy, dash: true }, { kind: 'line', x1: cx, y1: cy - s * 1.25, x2: cx, y2: cy + s * 1.25, dash: true });
      strokes.push({ kind: 'line', x1: cx - s, y1: cy + s * 1.45, x2: cx + s, y2: cy + s * 1.45 }, { kind: 'line', x1: cx - s, y1: cy + s * 1.3, x2: cx - s, y2: cy + s * 1.55 }, { kind: 'line', x1: cx + s, y1: cy + s * 1.3, x2: cx + s, y2: cy + s * 1.55 });
    } else if (kind === 1) { // bracket: rectangle with rounded corner, slots, dimensions
      const w = s * 2.4, h = s * 1.4;
      strokes.push({ kind: 'line', x1: cx - w / 2, y1: cy - h / 2, x2: cx + w / 2 - s * .5, y2: cy - h / 2 }, { kind: 'arc', x: cx + w / 2 - s * .5, y: cy - h / 2 + s * .5, r: s * .5, a: -Math.PI / 2, b: 0 },
        { kind: 'line', x1: cx + w / 2, y1: cy - h / 2 + s * .5, x2: cx + w / 2, y2: cy + h / 2 }, { kind: 'line', x1: cx + w / 2, y1: cy + h / 2, x2: cx - w / 2, y2: cy + h / 2 }, { kind: 'line', x1: cx - w / 2, y1: cy + h / 2, x2: cx - w / 2, y2: cy - h / 2 });
      for (let i = 0; i < 2; i++) { const x = cx - w / 4 + i * w / 2; strokes.push({ kind: 'arc', x, y: cy, r: s * .16, a: 0, b: Math.PI * 2 }, { kind: 'line', x1: x - s * .3, y1: cy, x2: x + s * .3, y2: cy, dash: true }, { kind: 'line', x1: x, y1: cy - s * .3, x2: x, y2: cy + s * .3, dash: true }); }
      strokes.push({ kind: 'line', x1: cx + w / 2 + s * .35, y1: cy - h / 2, x2: cx + w / 2 + s * .35, y2: cy + h / 2 }, { kind: 'line', x1: cx + w / 2 + s * .2, y1: cy - h / 2, x2: cx + w / 2 + s * .5, y2: cy - h / 2 }, { kind: 'line', x1: cx + w / 2 + s * .2, y1: cy + h / 2, x2: cx + w / 2 + s * .5, y2: cy + h / 2 });
    } else { // gear: tooth outline and pitch circle
      const teeth = 12 + Math.floor(random() * 6), inner = s * .82;
      for (let i = 0; i < teeth; i++) {
        const a0 = i / teeth * Math.PI * 2, a1 = (i + .5) / teeth * Math.PI * 2, a2 = (i + 1) / teeth * Math.PI * 2;
        strokes.push({ kind: 'arc', x: cx, y: cy, r: s, a: a0, b: a0 + (a1 - a0) * .7 }, { kind: 'line', x1: cx + Math.cos(a0 + (a1 - a0) * .7) * s, y1: cy + Math.sin(a0 + (a1 - a0) * .7) * s, x2: cx + Math.cos(a1) * inner, y2: cy + Math.sin(a1) * inner },
          { kind: 'arc', x: cx, y: cy, r: inner, a: a1, b: a1 + (a2 - a1) * .7 }, { kind: 'line', x1: cx + Math.cos(a1 + (a2 - a1) * .7) * inner, y1: cy + Math.sin(a1 + (a2 - a1) * .7) * inner, x2: cx + Math.cos(a2) * s, y2: cy + Math.sin(a2) * s });
      }
      strokes.push({ kind: 'arc', x: cx, y: cy, r: s * .91, a: 0, b: Math.PI * 2 }, { kind: 'arc', x: cx, y: cy, r: s * .2, a: 0, b: Math.PI * 2 });
      strokes.push({ kind: 'line', x1: cx - s * 1.2, y1: cy, x2: cx + s * 1.2, y2: cy, dash: true }, { kind: 'line', x1: cx, y1: cy - s * 1.2, x2: cx, y2: cy + s * 1.2, dash: true });
    }
    const lengths = strokes.map((k) => k.kind === 'line' ? Math.hypot(k.x2 - k.x1, k.y2 - k.y1) : k.r * Math.abs(k.b - k.a));
    return { strokes, lengths, total: lengths.reduce((a, b) => a + b, 0), born: time };
  };
  return {
    animated: true,
    build(w, h) {
      W = w; H = h;
      const sheet = shade(w, h, (x, y) => {
        const v = .92 + (fbm(x * .05, y * .05, 3) - .5) * .12;
        return [clamp(v * 24, 0, 255), clamp(v * 60, 0, 255), clamp(v * 96, 0, 255)];
      });
      const [c, ctx] = layer(w, h);
      ctx.drawImage(sheet, 0, 0, w, h);
      const cell = 24, major = 5;
      for (let x = 0; x <= w; x += cell) { const big = Math.round(x / cell) % major === 0; ctx.strokeStyle = big ? 'rgba(200,228,255,.28)' : 'rgba(200,228,255,.11)'; ctx.beginPath(); ctx.moveTo(x + .5, 0); ctx.lineTo(x + .5, h); ctx.stroke(); }
      for (let y = 0; y <= h; y += cell) { const big = Math.round(y / cell) % major === 0; ctx.strokeStyle = big ? 'rgba(200,228,255,.28)' : 'rgba(200,228,255,.11)'; ctx.beginPath(); ctx.moveTo(0, y + .5); ctx.lineTo(w, y + .5); ctx.stroke(); }
      // Sheet border and a title block in the corner.
      ctx.strokeStyle = 'rgba(220,238,255,.55)'; ctx.lineWidth = 1.5; ctx.strokeRect(30.5, 30.5, w - 61, h - 61);
      ctx.lineWidth = .8; ctx.strokeRect(36.5, 36.5, w - 73, h - 73);
      const bw = 260, bh = 70, bx = w - 36 - bw, by = h - 36 - bh;
      ctx.fillStyle = 'rgba(10,40,70,.5)'; ctx.fillRect(bx, by, bw, bh);
      ctx.strokeStyle = 'rgba(220,238,255,.6)'; ctx.strokeRect(bx + .5, by + .5, bw, bh);
      ctx.beginPath(); ctx.moveTo(bx, by + 24); ctx.lineTo(bx + bw, by + 24); ctx.moveTo(bx + 140, by + 24); ctx.lineTo(bx + 140, by + bh); ctx.moveTo(bx, by + 47); ctx.lineTo(bx + bw, by + 47); ctx.stroke();
      ctx.fillStyle = 'rgba(220,238,255,.7)'; ctx.font = '11px system-ui, sans-serif';
      ctx.fillText('設計図', bx + 8, by + 16); ctx.fillText('尺度 1:1', bx + 8, by + 40); ctx.fillText('図番 A-01', bx + 148, by + 40); ctx.fillText('用紙 A3', bx + 8, by + 63); ctx.fillText('作業机', bx + 148, by + 63);
      ctx.font = '9px monospace'; ctx.fillStyle = '#cee8ff70';
      for (let x = 72; x < w - 40; x += 96) {
        ctx.fillText(String(Math.round(x / 24)).padStart(2, '0'), x, 24);
        ctx.beginPath(); ctx.moveTo(x + .5, 31); ctx.lineTo(x + .5, 37); ctx.stroke();
      }
      for (let y = 72; y < h - 40; y += 96) ctx.fillText(String(Math.round(y / 24)).padStart(2, '0'), 12, y);
      vignette(ctx, w, h, .3);
      still = c;
      figures.length = 0;
      for (let i = 0; i < 3; i++) figures.push({ ...figure(0), born: -i * 12 });
    },
    paint({ ctx, time }) {
      if (still) ctx.drawImage(still, 0, 0);
      ctx.lineCap = 'round'; ctx.lineWidth = 1.3;
      figures.forEach((fig, index) => {
        const age = time - fig.born, draw = 14, rest = 18, fade = 4;
        if (age > draw + rest + fade) { figures[index] = figure(time); return; }
        const budget = clamp(age / draw) * fig.total, alpha = age > draw + rest ? 1 - (age - draw - rest) / fade : 1;
        ctx.strokeStyle = `rgba(232,244,255,${.85 * alpha})`;
        let used = 0;
        for (let i = 0; i < fig.strokes.length && used < budget; i++) {
          const k = fig.strokes[i], part = clamp((budget - used) / Math.max(1e-6, fig.lengths[i]));
          used += fig.lengths[i];
          ctx.setLineDash(k.kind === 'line' && k.dash ? [10, 5, 2, 5] : []);
          ctx.beginPath();
          if (k.kind === 'line') { ctx.moveTo(k.x1, k.y1); ctx.lineTo(k.x1 + (k.x2 - k.x1) * part, k.y1 + (k.y2 - k.y1) * part); }
          else ctx.arc(k.x, k.y, k.r, k.a, k.a + (k.b - k.a) * part);
          ctx.stroke();
        }
        // The pen tip glows at the working end.
        if (age < draw) {
          let acc = 0;
          for (let i = 0; i < fig.strokes.length; i++) {
            if (acc + fig.lengths[i] < budget) { acc += fig.lengths[i]; continue; }
            const k = fig.strokes[i], part = (budget - acc) / Math.max(1e-6, fig.lengths[i]);
            const x = k.kind === 'line' ? k.x1 + (k.x2 - k.x1) * part : k.x + Math.cos(k.a + (k.b - k.a) * part) * k.r;
            const y = k.kind === 'line' ? k.y1 + (k.y2 - k.y1) * part : k.y + Math.sin(k.a + (k.b - k.a) * part) * k.r;
            const g = ctx.createRadialGradient(x, y, 0, x, y, 9); g.addColorStop(0, 'rgba(255,255,255,.9)'); g.addColorStop(1, 'rgba(255,255,255,0)');
            ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, 9, 0, Math.PI * 2); ctx.fill();
            break;
          }
        }
      });
      ctx.setLineDash([]);
    },
  };
}

type Trace = { points: { x: number; y: number }[]; length: number };
function circuit(random: () => number): Scene {
  const { fbm } = makeNoise(random);
  let still: Layer | null = null;
  const traces: Trace[] = [];
  const pulses: { trace: number; at: number; speed: number; hue: number }[] = [];
  const leds: { x: number; y: number; phase: number; speed: number; color: string }[] = [];
  return {
    animated: true,
    build(w, h) {
      traces.length = 0; pulses.length = 0; leds.length = 0;
      const board = shade(w, h, (x, y) => {
        const v = .92 + (fbm(x * .03, y * .03, 3) - .5) * .18 + (fbm(x * .5, y * .04, 1) - .5) * .05;
        return [clamp(v * 18, 0, 255), clamp(v * 58, 0, 255), clamp(v * 46, 0, 255)];
      });
      const [c, ctx] = layer(w, h);
      ctx.drawImage(board, 0, 0, w, h);
      const cell = 18, cols = Math.floor(w / cell), rows = Math.floor(h / cell);
      const used = new Uint8Array(cols * rows);
      const take = (x: number, y: number) => { if (x < 1 || y < 1 || x >= cols - 1 || y >= rows - 1 || used[y * cols + x]) return false; used[y * cols + x] = 1; return true; };
      // Chips: dark packages with pins; their cells are reserved first.
      const chips: { x: number; y: number; w: number; h: number; label: string }[] = [];
      for (let i = 0; i < Math.max(3, Math.round(w * h / 300000)); i++) {
        const cw = 3 + Math.floor(random() * 3), ch = 4 + Math.floor(random() * 4);
        const x = 2 + Math.floor(random() * (cols - cw - 4)), y = 2 + Math.floor(random() * (rows - ch - 4));
        let free = true;
        for (let yy = y - 1; yy <= y + ch && free; yy++) for (let xx = x - 1; xx <= x + cw; xx++) if (used[yy * cols + xx]) { free = false; break; }
        if (!free) continue;
        for (let yy = y - 1; yy <= y + ch; yy++) for (let xx = x - 1; xx <= x + cw; xx++) used[yy * cols + xx] = 1;
        chips.push({ x, y, w: cw, h: ch, label: `U${chips.length + 1}` });
      }
      const dirs = [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]];
      for (let attempt = 0; attempt < cols * rows / 9 && traces.length < 150; attempt++) {
        let x = Math.floor(random() * cols), y = Math.floor(random() * rows);
        if (!take(x, y)) continue;
        const points = [{ x, y }];
        let dir = Math.floor(random() * 4), ok = true;
        for (let seg = 0, segs = 2 + Math.floor(random() * 4); seg < segs; seg++) {
          const run = 2 + Math.floor(random() * 9);
          for (let i = 0; i < run; i++) {
            const nx = x + dirs[dir][0], ny = y + dirs[dir][1];
            if (!take(nx, ny)) { ok = i > 0 || seg > 0; break; }
            x = nx; y = ny;
          }
          points.push({ x, y });
          if (!ok) break;
          const turn = random() < .5 ? 1 : -1;
          dir = dir < 4 ? (random() < .5 ? (dir + turn + 4) % 4 : 4 + Math.floor(random() * 4)) : Math.floor(random() * 4);
        }
        if (points.length < 2 || (points.length === 2 && points[0].x === points[1].x && points[0].y === points[1].y)) continue;
        const px = points.map((p) => ({ x: p.x * cell + cell / 2, y: p.y * cell + cell / 2 }));
        let length = 0;
        for (let i = 1; i < px.length; i++) length += Math.hypot(px[i].x - px[i - 1].x, px[i].y - px[i - 1].y);
        if (length > 40) traces.push({ points: px, length });
      }
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      for (const pass of [[6, 'rgba(0,0,0,.35)'], [3, 'rgba(196,166,84,.62)'], [1, 'rgba(240,214,130,.35)']] as const) {
        ctx.lineWidth = pass[0]; ctx.strokeStyle = pass[1];
        for (const t of traces) { ctx.beginPath(); t.points.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)); ctx.stroke(); }
      }
      for (const t of traces) for (const p of [t.points[0], t.points[t.points.length - 1]]) {
        ctx.fillStyle = '#c9a955'; ctx.beginPath(); ctx.arc(p.x, p.y, 4.2, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#12261f'; ctx.beginPath(); ctx.arc(p.x, p.y, 1.7, 0, Math.PI * 2); ctx.fill();
      }
      for (const chip of chips) {
        const x = chip.x * cell, y = chip.y * cell, cw = chip.w * cell, ch = chip.h * cell;
        ctx.fillStyle = '#00000040'; ctx.fillRect(x + 3, y + 4, cw + 3, ch + 3);
        ctx.strokeStyle = '#d9e9cc55'; ctx.lineWidth = .8; ctx.strokeRect(x - 10, y - 5, cw + 20, ch + 10);
        ctx.fillStyle = '#b89c52';
        for (let i = 1; i < chip.h; i++) { ctx.fillRect(x - 6, y + i * cell - 2, 8, 4); ctx.fillRect(x + cw - 2, y + i * cell - 2, 8, 4); }
        ctx.fillStyle = '#131516'; ctx.beginPath(); ctx.roundRect(x, y, cw, ch, 3); ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,.08)'; ctx.fillRect(x, y, cw, 2);
        ctx.fillStyle = 'rgba(220,220,220,.55)'; ctx.font = '10px system-ui, sans-serif'; ctx.fillText(chip.label, x + 6, y + 14);
        ctx.beginPath(); ctx.arc(x + 8, y + ch - 8, 2.5, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#adb4ae55'; ctx.font = '7px monospace'; ctx.fillText('24W • 0831', x + 6, y + 27);
      }
      // Metallised solder joints catch the same overhead light as the packages.
      traces.filter((_, i) => i % 4 === 0).forEach((trace) => {
        const p = trace.points[0];
        const metal = ctx.createLinearGradient(p.x - 5, p.y - 3, p.x + 5, p.y + 3);
        metal.addColorStop(0, '#59695e'); metal.addColorStop(.35, '#e0e5c2'); metal.addColorStop(1, '#6a7759');
        ctx.fillStyle = metal; ctx.fillRect(p.x - 6, p.y - 3, 12, 6);
        ctx.fillStyle = '#28312b'; ctx.fillRect(p.x - 3, p.y - 3, 6, 6);
      });
      // Silkscreen labels near a few pads, and LEDs on some pad ends.
      ctx.fillStyle = 'rgba(230,236,230,.5)'; ctx.font = '9px system-ui, sans-serif';
      traces.slice(0, 40).forEach((t, i) => { if (i % 3 === 0) ctx.fillText(`${['R', 'C', 'L', 'D'][i % 4]}${10 + i}`, t.points[0].x + 6, t.points[0].y - 6); });
      traces.forEach((t, i) => { if (i % 11 === 5) leds.push({ x: t.points[t.points.length - 1].x, y: t.points[t.points.length - 1].y, phase: random() * 9, speed: .4 + random() * 1.4, color: ['255,110,80', '110,230,130', '110,200,255'][i % 3] }); });
      vignette(ctx, w, h, .45);
      still = c;
      for (let i = 0; i < Math.min(10, traces.length); i++) pulses.push({ trace: Math.floor(random() * traces.length), at: random() * traces[0].length, speed: 100 + random() * 160, hue: random() });
    },
    paint({ ctx, time, dt }) {
      if (still) ctx.drawImage(still, 0, 0);
      if (!traces.length) return;
      ctx.lineCap = 'round';
      for (const pulse of pulses) {
        const trace = traces[pulse.trace];
        pulse.at += pulse.speed * dt;
        if (pulse.at > trace.length + 40) { pulse.trace = Math.floor(random() * traces.length); pulse.at = -20 - random() * 300; pulse.speed = 100 + random() * 160; continue; }
        // Position along the polyline; the tail is the last 60 px brightened.
        const locate = (d: number) => {
          let acc = 0;
          for (let i = 1; i < trace.points.length; i++) {
            const a = trace.points[i - 1], b = trace.points[i], len = Math.hypot(b.x - a.x, b.y - a.y);
            if (d <= acc + len || i === trace.points.length - 1) { const t = clamp((d - acc) / Math.max(1e-6, len)); return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }; }
            acc += len;
          }
          return trace.points[0];
        };
        if (pulse.at < 0) continue;
        const head = locate(Math.min(pulse.at, trace.length)), color = pulse.hue < .5 ? '140,240,255' : '255,235,150';
        ctx.strokeStyle = `rgba(${color},.55)`; ctx.lineWidth = 2; ctx.beginPath();
        for (let k = 0; k <= 6; k++) { const p = locate(clamp(pulse.at - 60 + k * 10, 0, trace.length)); if (k) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y); }
        ctx.stroke();
        const g = ctx.createRadialGradient(head.x, head.y, 0, head.x, head.y, 10);
        g.addColorStop(0, 'rgba(255,255,255,.95)'); g.addColorStop(.3, `rgba(${color},.6)`); g.addColorStop(1, `rgba(${color},0)`);
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(head.x, head.y, 10, 0, Math.PI * 2); ctx.fill();
      }
      for (const led of leds) {
        const on = Math.pow(Math.max(0, Math.sin(time * led.speed + led.phase)), 2) * .9 + .1;
        const g = ctx.createRadialGradient(led.x, led.y, 0, led.x, led.y, 14);
        g.addColorStop(0, `rgba(${led.color},${on})`); g.addColorStop(.25, `rgba(${led.color},${on * .5})`); g.addColorStop(1, `rgba(${led.color},0)`);
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(led.x, led.y, 14, 0, Math.PI * 2); ctx.fill();
      }
    },
  };
}

function night(random: () => number): Scene {
  const { fbm } = makeNoise(random);
  let sky: Layer | null = null, hills: Layer | null = null, W = 1, H = 1;
  const stars: { x: number; y: number; r: number; base: number; phase: number; speed: number; color: string; rays: boolean }[] = [];
  const meteors: { x: number; y: number; vx: number; vy: number; age: number; life: number }[] = [];
  let nextMeteor = 4;
  return {
    animated: true,
    build(w, h) {
      W = w; H = h; stars.length = 0; meteors.length = 0;
      const [s, ctx] = layer(w, h);
      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, '#05081a'); g.addColorStop(.55, '#0b1230'); g.addColorStop(1, '#1b2147');
      ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
      // Milky way: a soft diagonal band of haze and thousands of faint points.
      const nebula = shade(w, h, (x, y) => {
        const cross = (y - h * .43 + (x - w * .5) * .55) / (h * .22);
        const cloud = fbm(x * .004, y * .006, 5);
        const lane = fbm(x * .012 + 91, y * .018, 3);
        const density = Math.exp(-cross * cross * 1.7) * Math.max(0, cloud - .28) * (lane < .44 ? .22 : 1);
        return [6 + density * 68, 10 + density * 76, 24 + density * 105];
      });
      ctx.save(); ctx.globalCompositeOperation = 'screen'; ctx.globalAlpha = .7;
      ctx.drawImage(nebula, 0, 0, w, h); ctx.restore();
      ctx.save(); ctx.translate(w * .55, h * .45); ctx.rotate(-.55);
      const band = ctx.createLinearGradient(0, -h * .32, 0, h * .32);
      band.addColorStop(0, 'rgba(120,140,220,0)'); band.addColorStop(.35, 'rgba(150,160,230,.09)'); band.addColorStop(.5, 'rgba(200,190,240,.14)'); band.addColorStop(.65, 'rgba(150,160,230,.09)'); band.addColorStop(1, 'rgba(120,140,220,0)');
      ctx.fillStyle = band; ctx.fillRect(-w * 1.2, -h * .32, w * 2.4, h * .64);
      for (let i = 0; i < w * h / 250; i++) {
        const x = (random() - .5) * w * 2.2, spread = (random() + random() + random() - 1.5) * h * .2;
        const dust = fbm(x * .004 + 30, spread * .01, 2);
        ctx.fillStyle = `rgba(230,225,255,${.05 + dust * .3 * random()})`; ctx.fillRect(x, spread, .8 + random(), .8 + random());
      }
      ctx.restore();
      for (const [x, y, r, color] of [[w * .3, h * .35, w * .35, '108,70,160'], [w * .75, h * .25, w * .3, '60,120,160'], [w * .5, h * .7, w * .25, '150,80,120']] as const) {
        const n = ctx.createRadialGradient(x, y, 0, x, y, r); n.addColorStop(0, `rgba(${color},.13)`); n.addColorStop(1, `rgba(${color},0)`);
        ctx.fillStyle = n; ctx.fillRect(0, 0, w, h);
      }
      sky = s;
      const [hl, hc] = layer(w, h);
      for (let ridge = 0; ridge < 3; ridge++) {
        hc.fillStyle = ['#29334b', '#18243a', '#101a2b'][ridge]; hc.beginPath(); hc.moveTo(0, h);
        for (let x = 0; x <= w + 8; x += 8) hc.lineTo(x, h * (.77 + ridge * .035 - fbm(x * .002 + ridge * 20, 9, 3) * .14));
        hc.lineTo(w, h); hc.closePath(); hc.fill();
      }
      // Rolling hills with a few pine spikes, and thin ground mist above them.
      const height = (x: number) => h * (.86 - fbm(x * .0012 + 5, 3, 3) * .12);
      const mist = hc.createLinearGradient(0, h * .66, 0, h * .9); mist.addColorStop(0, 'rgba(120,140,200,0)'); mist.addColorStop(1, 'rgba(120,140,200,.16)');
      hc.fillStyle = mist; hc.fillRect(0, h * .66, w, h * .24);
      hc.fillStyle = '#04070f'; hc.beginPath(); hc.moveTo(0, h);
      for (let x = 0; x <= w; x += 4) hc.lineTo(x, height(x));
      hc.lineTo(w, h); hc.closePath(); hc.fill();
      for (let i = 0; i < w / 45; i++) {
        const x = random() * w, base = height(x) + 2, t = 14 + random() * 26;
        hc.beginPath(); hc.moveTo(x - t * .28, base); hc.lineTo(x, base - t); hc.lineTo(x + t * .28, base); hc.closePath(); hc.fill();
      }
      hills = hl;
      for (let i = 0; i < 420; i++) {
        const bright = random();
        stars.push({ x: random() * (w + 200), y: random() * h * .9, r: .4 + bright * bright * 1.5, base: .35 + bright * .6, phase: random() * 9, speed: .3 + random() * 2.2,
          color: random() < .12 ? '255,220,190' : random() < .3 ? '190,210,255' : '255,255,255', rays: bright > .93 });
      }
    },
    paint({ ctx, time, dt, parallax }) {
      if (sky) ctx.drawImage(sky, 0, 0);
      const drift = time * .9 - parallax.x * 60, tile = W + 200;
      for (const s of stars) {
        const x = (((s.x + drift) % tile) + tile) % tile - 100, y = s.y - parallax.y * 30;
        const a = s.base * (.65 + .35 * Math.sin(time * s.speed + s.phase));
        ctx.fillStyle = `rgba(${s.color},${a})`; ctx.beginPath(); ctx.arc(x, y, s.r, 0, Math.PI * 2); ctx.fill();
        if (s.rays) {
          ctx.strokeStyle = `rgba(${s.color},${a * .35})`; ctx.lineWidth = .7; const len = s.r * 5;
          ctx.beginPath(); ctx.moveTo(x - len, y); ctx.lineTo(x + len, y); ctx.moveTo(x, y - len); ctx.lineTo(x, y + len); ctx.stroke();
        }
      }
      nextMeteor -= dt;
      if (nextMeteor <= 0) { nextMeteor = 5 + random() * 11; const a = .6 + random() * .5; meteors.push({ x: random() * W * .8, y: random() * H * .4, vx: Math.cos(a) * 640, vy: Math.sin(a) * 640, age: 0, life: .7 + random() * .5 }); }
      for (let i = meteors.length - 1; i >= 0; i--) {
        const m = meteors[i]; m.age += dt; m.x += m.vx * dt; m.y += m.vy * dt;
        if (m.age > m.life) { meteors.splice(i, 1); continue; }
        const fade = Math.sin(m.age / m.life * Math.PI), tail = 110;
        const g = ctx.createLinearGradient(m.x, m.y, m.x - m.vx / 640 * tail, m.y - m.vy / 640 * tail);
        g.addColorStop(0, `rgba(255,255,255,${.95 * fade})`); g.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.strokeStyle = g; ctx.lineWidth = 1.6; ctx.beginPath(); ctx.moveTo(m.x, m.y); ctx.lineTo(m.x - m.vx / 640 * tail, m.y - m.vy / 640 * tail); ctx.stroke();
      }
      if (hills) ctx.drawImage(hills, 0, 0);
    },
  };
}

function forest(random: () => number): Scene {
  const { fbm } = makeNoise(random);
  let sky: Layer | null = null, W = 1, H = 1;
  const layers: { canvas: Layer; depth: number }[] = [];
  const flies: { x: number; y: number; phase: number; speed: number; drift: number }[] = [];
  const leaves: { x: number; y: number; r: number; spin: number; phase: number; speed: number }[] = [];
  const motes: { x: number; y: number; phase: number; z: number }[] = [];
  return {
    animated: true,
    build(w, h) {
      W = w; H = h; layers.length = 0; flies.length = 0; leaves.length = 0; motes.length = 0;
      const [s, sc] = layer(w, h);
      // Dusk light behind the trees: a warm glow at the top center fading into deep green.
      const g = sc.createRadialGradient(w * .42, h * .05, 0, w * .42, h * .05, h * 1.25);
      g.addColorStop(0, '#f0e6b8'); g.addColorStop(.25, '#a9c48a'); g.addColorStop(.55, '#4f7a58'); g.addColorStop(.85, '#1d3627'); g.addColorStop(1, '#0c1911');
      sc.fillStyle = g; sc.fillRect(0, 0, w, h);
      sky = s;
      const pad = 160, full = w + pad * 2, lh = h + 80;
      // Four planes of trees; the far ones dissolve into haze, the near ones show bark and leaves.
      const planes = [
        { dark: '#5c8878', lit: '#7ea393', leaf: '#6f9a86', haze: .5, depth: .3, count: 220, width: 14 },
        { dark: '#3b6355', lit: '#537c6a', leaf: '#4d7a62', haze: .3, depth: .5, count: 260, width: 22 },
        { dark: '#1f3d30', lit: '#33584a', leaf: '#2f5a40', haze: .12, depth: .75, count: 330, width: 34 },
        { dark: '#0b1a13', lit: '#1a3024', leaf: '#16301f', haze: 0, depth: 1, count: 460, width: 58 },
      ];
      planes.forEach((plane, index) => {
        const [c, ctx] = layer(full, lh);
        const trees = Math.max(2, Math.round(full / plane.count));
        for (let i = 0; i < trees; i++) {
          const x = (i + .15 + random() * .7) * full / trees, width = plane.width * (.7 + random() * .6), lean = (random() - .5) * .06;
          const top = -lh * .08, base = lh + 10, flare = width * 1.7;
          const bark = ctx.createLinearGradient(x - width / 2, 0, x + width / 2, 0);
          bark.addColorStop(0, plane.lit); bark.addColorStop(.45, plane.dark); bark.addColorStop(1, plane.dark);
          ctx.fillStyle = bark; ctx.beginPath();
          ctx.moveTo(x - flare, base); ctx.quadraticCurveTo(x - width * .55, lh * .82, x - width / 2 + lean * h, top);
          ctx.lineTo(x + width / 2 + lean * h, top); ctx.quadraticCurveTo(x + width * .55, lh * .82, x + flare, base); ctx.closePath(); ctx.fill();
          if (index >= 2) {
            ctx.save(); ctx.clip();
            // Bark relief and lichen stay inside the tapered trunk silhouette.
            for (let k = 0; k < width * lh / 75; k++) {
              const by = random() * lh, bx = x + lean * (lh - by) + (random() - .5) * width * 1.7;
              const rough = fbm(bx * .12, by * .028, 2);
              ctx.fillStyle = rough > .52 ? 'rgba(161,161,107,.13)' : 'rgba(0,8,4,.24)';
              ctx.fillRect(bx, by, .5 + random() * 2.5, 3 + random() * 26);
              if (by > lh * .65 && rough > .56) {
                ctx.fillStyle = 'rgba(109,142,56,.28)'; ctx.beginPath(); ctx.ellipse(bx, by, 2 + random() * 3, 1 + random() * 2, 0, 0, Math.PI * 2); ctx.fill();
              }
            }
            ctx.restore();
            ctx.strokeStyle = `rgba(0,0,0,${index === 3 ? .35 : .2})`; ctx.lineWidth = 1;
            for (let k = 0; k < width / 3; k++) {
              const bx = x - width / 2 + random() * width, by = random() * lh, len = 20 + random() * 90;
              ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(bx + (random() - .5) * 3 + lean * len, by + len); ctx.stroke();
            }
          }
          // Branches carrying leaf clusters; the crown fills the top edge.
          ctx.strokeStyle = plane.dark; ctx.lineCap = 'round';
          for (let b = 0; b < 3 + Math.floor(random() * 3); b++) {
            const y = lh * (.02 + random() * .4), dir = random() < .5 ? -1 : 1, len = (60 + random() * 140) * plane.depth, thick = Math.max(1.5, width * .22);
            const ex = x + dir * len, ey = y - 25 - random() * 70;
            ctx.lineWidth = thick; ctx.beginPath(); ctx.moveTo(x + lean * (lh - y), y); ctx.quadraticCurveTo(x + dir * len * .45, y - 12, ex, ey); ctx.stroke();
            for (let f = 0; f < 10 * plane.depth + 3; f++) {
              const fx = ex + (random() - .5) * len * .8, fy = ey + (random() - .4) * 60 * plane.depth, r = (7 + random() * 12) * (.5 + plane.depth);
              // Individual pointed leaves break up the crown silhouette at every depth.
              for (let leaf = 0; leaf < 9; leaf++) {
                const lx = fx + (random() - .5) * r * 3, ly = fy + (random() - .5) * r * 2;
                const size = r * (.22 + random() * .36);
                ctx.save(); ctx.translate(lx, ly); ctx.rotate(random() * Math.PI);
                ctx.fillStyle = random() < .25 ? plane.lit : plane.leaf;
                ctx.beginPath(); ctx.moveTo(-size, 0); ctx.quadraticCurveTo(0, -size * .65, size, 0);
                ctx.quadraticCurveTo(0, size * .65, -size, 0); ctx.fill();
                if (index > 1) { ctx.strokeStyle = '#b0c79716'; ctx.lineWidth = .5; ctx.beginPath(); ctx.moveTo(-size, 0); ctx.lineTo(size, 0); ctx.stroke(); }
                ctx.restore();
              }
            }
          }
        }
        if (index === 3) {
          // Ground: ferns, grass tufts, and a dark floor.
          for (let i = 0; i < full / 48; i++) {
            const x = random() * full, base = lh - random() * 26, size = 34 + random() * 56;
            ctx.strokeStyle = random() < .5 ? '#122a1c' : '#1c3a28'; ctx.lineWidth = 2.5;
            for (let k = -3; k <= 3; k++) {
              ctx.beginPath(); ctx.moveTo(x, base); ctx.quadraticCurveTo(x + k * size * .3, base - size * .85, x + k * size * .55, base - size * (.3 + Math.abs(k) * .06)); ctx.stroke();
              for (let n = 1; n < 9; n++) {
                const t = n / 10, xx = x + 2 * (1 - t) * t * k * size * .3 + t * t * k * size * .55;
                const yy = base - 2 * (1 - t) * t * size * .85 - t * t * size * (.3 + Math.abs(k) * .06);
                ctx.lineWidth = 1.2; ctx.beginPath(); ctx.moveTo(xx - size * .12 * (1 - t), yy - 5); ctx.lineTo(xx, yy); ctx.lineTo(xx + size * .12 * (1 - t), yy - 5); ctx.stroke();
              }
            }
          }
          ctx.strokeStyle = '#0f2418'; ctx.lineWidth = 1.5;
          for (let i = 0; i < full / 6; i++) { const x = random() * full, base = lh + 2, len = 10 + random() * 30; ctx.beginPath(); ctx.moveTo(x, base); ctx.lineTo(x + (random() - .5) * 16, base - len); ctx.stroke(); }
          const ground = ctx.createLinearGradient(0, lh - 120, 0, lh); ground.addColorStop(0, 'rgba(6,16,10,0)'); ground.addColorStop(1, 'rgba(6,16,10,.95)');
          ctx.fillStyle = ground; ctx.fillRect(0, lh - 120, full, 120);
        } else {
          const hazeColor = ctx.createLinearGradient(0, 0, 0, lh); hazeColor.addColorStop(0, `rgba(196,220,190,${plane.haze * .6})`); hazeColor.addColorStop(1, `rgba(150,190,170,${plane.haze})`);
          ctx.fillStyle = hazeColor; ctx.fillRect(0, 0, full, lh);
        }
        layers.push({ canvas: c, depth: plane.depth });
      });
      for (let i = 0; i < 34; i++) flies.push({ x: random() * w, y: h * (.35 + random() * .6), phase: random() * 9, speed: .6 + random() * 1.6, drift: random() * 9 });
      for (let i = 0; i < 9; i++) leaves.push({ x: random() * w, y: random() * h, r: 4 + random() * 4, spin: random() * 6, phase: random() * 9, speed: 14 + random() * 18 });
      for (let i = 0; i < 90; i++) motes.push({ x: random() * w, y: random() * h, phase: random() * 9, z: random() });
    },
    paint({ ctx, time, dt, parallax }) {
      if (sky) ctx.drawImage(sky, 0, 0);
      const beams = () => {
        ctx.save(); ctx.globalCompositeOperation = 'screen';
        for (let i = 0; i < 6; i++) {
          const x = W * (.02 + i * .17) + Math.sin(time * .07 + i) * 40, a = .07 + .05 * Math.sin(time * .19 + i * 1.7);
          for (let feather = 5; feather > 0; feather--) {
            const width = feather / 5;
            const beam = ctx.createLinearGradient(x, 0, x + W * .25, H);
            beam.addColorStop(0, `rgba(245,240,200,${a * .24})`); beam.addColorStop(1, 'rgba(245,240,200,0)');
            ctx.fillStyle = beam; ctx.beginPath(); ctx.moveTo(x - 32 * width, 0); ctx.lineTo(x + 32 * width, 0);
            ctx.lineTo(x + W * .25 + 110 * width, H); ctx.lineTo(x + W * .25 - 110 * width, H); ctx.closePath(); ctx.fill();
          }
        }
        ctx.restore();
      };
      layers.forEach((l, index) => {
        const sway = Math.sin(time * .25 + index) * 3 * l.depth;
        ctx.drawImage(l.canvas, -160 - parallax.x * 140 * l.depth + sway, -40 - parallax.y * 32 * l.depth);
        if (index === 1) {
          beams();
          const mist = ctx.createLinearGradient(0, H * .5, 0, H * .95); mist.addColorStop(0, 'rgba(190,215,195,0)'); mist.addColorStop(.6, `rgba(190,215,195,${.16 + .05 * Math.sin(time * .11)})`); mist.addColorStop(1, 'rgba(190,215,195,0)');
          ctx.fillStyle = mist; ctx.fillRect(0, H * .5, W, H * .45);
        }
      });
      for (const m of motes) {
        const x = m.x + Math.sin(time * .12 + m.phase) * 30, y = m.y + Math.sin(time * .09 + m.phase * 2) * 20 - time * 2 * m.z;
        const yy = ((y % H) + H) % H;
        ctx.fillStyle = `rgba(255,250,210,${.12 + .2 * m.z * (.5 + .5 * Math.sin(time * .7 + m.phase))})`;
        ctx.beginPath(); ctx.arc(x, yy, .6 + m.z * 1.2, 0, Math.PI * 2); ctx.fill();
      }
      for (const f of flies) {
        const x = f.x + Math.sin(time * .3 + f.drift) * 40 + Math.sin(time * .9 + f.phase) * 8, y = f.y + Math.cos(time * .23 + f.drift) * 25;
        const on = Math.pow(Math.max(0, Math.sin(time * f.speed + f.phase)), 4);
        if (on < .02) continue;
        const g = ctx.createRadialGradient(x, y, 0, x, y, 9); g.addColorStop(0, `rgba(230,255,150,${on})`); g.addColorStop(.3, `rgba(200,255,120,${on * .35})`); g.addColorStop(1, 'rgba(200,255,120,0)');
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, 9, 0, Math.PI * 2); ctx.fill();
      }
      for (const leaf of leaves) {
        leaf.y += leaf.speed * dt; leaf.x += Math.sin(time * .8 + leaf.phase) * 25 * dt; leaf.spin += dt * 1.2;
        if (leaf.y > H + 10) { leaf.y = -10; leaf.x = random() * W; }
        ctx.save(); ctx.translate(leaf.x, leaf.y); ctx.rotate(leaf.spin); ctx.fillStyle = 'rgba(170,150,60,.75)';
        ctx.beginPath(); ctx.ellipse(0, 0, leaf.r, leaf.r * .45, 0, 0, Math.PI * 2); ctx.fill(); ctx.restore();
      }
    },
  };
}

// Quiet matte surfaces share the viewport lighting used by the richer scenes.
function matte(random: () => number, dotted: boolean): Scene {
  let still: Layer | null = null;
  return {
    animated: false,
    build(w, h) {
      const [c, ctx] = layer(w, h);
      const light = ctx.createRadialGradient(w * .42, h * .24, 0, w * .42, h * .24, Math.hypot(w, h) * .8);
      light.addColorStop(0, '#242e3c'); light.addColorStop(.55, '#1b2330'); light.addColorStop(1, '#111720');
      ctx.fillStyle = light; ctx.fillRect(0, 0, w, h);
      if (dotted) {
        for (let y = 12; y < h; y += 24) for (let x = 12; x < w; x += 24) {
          ctx.fillStyle = '#070d1666'; ctx.beginPath(); ctx.arc(x, y + .6, 1.2, 0, Math.PI * 2); ctx.fill();
          ctx.fillStyle = '#849ab34a'; ctx.beginPath(); ctx.arc(x, y, .8, 0, Math.PI * 2); ctx.fill();
        }
        for (let y = 12; y < h; y += 120) for (let x = 12; x < w; x += 120) {
          ctx.strokeStyle = '#91aec31c'; ctx.lineWidth = .65; ctx.beginPath();
          ctx.moveTo(x - 3, y); ctx.lineTo(x + 3, y); ctx.moveTo(x, y - 3); ctx.lineTo(x, y + 3); ctx.stroke();
        }
      }
      for (let i = 0; i < w * h / 30; i++) {
        ctx.fillStyle = random() < .5 ? '#ffffff04' : '#0000000a'; ctx.fillRect(random() * w, random() * h, 1, 1);
      }
      still = c;
    },
    paint({ ctx }) { if (still) ctx.drawImage(still, 0, 0); },
  };
}

export function createScene(theme: string, seed: number): Scene | null {
  const random = seededRandom(seed);
  switch (theme) {
    case 'dots': return matte(random, true);
    case 'plain': return matte(random, false);
    case 'wood': return wood(random);
    case 'paper': return paper(random);
    case 'slate': return slate(random);
    case 'blueprint': return blueprint(random);
    case 'circuit': return circuit(random);
    case 'night': return night(random);
    case 'forest': return forest(random);
    default: return null;
  }
}
