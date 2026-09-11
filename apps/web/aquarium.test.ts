import test from 'node:test';
import assert from 'node:assert/strict';
import { createAquarium, stepAquarium, LOOKS, TANK } from './src/aquarium-simulation';

test('new seeds vary the scene while identical seeds reproduce movement for diagnosis', () => {
  const a = createAquarium(102), b = createAquarium(102), c = createAquarium(103);
  assert.notDeepEqual(a.fish, c.fish);
  for (let i = 0; i < 300; i++) { stepAquarium(a, 1 / 30); stepAquarium(b, 1 / 30); }
  assert.deepEqual(a.fish, b.fish);
});

test('fish change goals and direction, remain finite, and stay within the tank over five minutes', () => {
  const state = createAquarium(734);
  const initial = structuredClone(state.fish);
  const turns = new Set<number>();
  for (let frame = 0; frame < 9000; frame++) {
    const directions = state.fish.map((f) => Math.sign(f.vx));
    stepAquarium(state, 1 / 30);
    state.fish.forEach((f, i) => {
      if (Math.sign(f.vx) !== directions[i]) turns.add(i);
      assert.ok(Number.isFinite(f.x + f.y + f.vx + f.vy + f.z));
      assert.ok(f.x >= TANK.left && f.x <= TANK.right && f.y >= TANK.top && f.y <= TANK.bottom);
      assert.ok(f.z >= 0 && f.z <= 1);
    });
  }
  assert.ok(turns.size >= state.fish.length * .8);
  assert.notDeepEqual(state.fish.map((f) => f.goalX), initial.map((f) => f.goalX));
  const paused = structuredClone(state.fish), time = state.time;
  stepAquarium(state, 0);
  assert.deepEqual(state.fish, paused); assert.equal(state.time, time);
  stepAquarium(state, 30); // A suspended tab must not teleport fish on resume.
  assert.ok(state.time - time < .081);
});

test('each launch stocks a different mix, and fish sprint, pause and use the whole tank', () => {
  const seen = new Set<number>();
  for (let seed = 1; seed <= 12; seed++) {
    const tank = createAquarium(seed);
    assert.ok(new Set(tank.fish.map((f) => f.look)).size >= 5);
    tank.fish.forEach((f) => seen.add(f.look));
  }
  assert.equal(seen.size, LOOKS.length);
  const state = createAquarium(734), modes = new Set<string>();
  let fastest = 0, highest = 1, lowest = 0, leftView = false;
  for (let frame = 0; frame < 9000; frame++) {
    stepAquarium(state, 1 / 30);
    for (const f of state.fish) {
      assert.ok(f.vx * f.facing >= 0, 'a fish never drifts tail first');
      modes.add(f.mode); fastest = Math.max(fastest, Math.hypot(f.vx, f.vy));
      highest = Math.min(highest, f.y); lowest = Math.max(lowest, f.y);
      if (f.x < -.05 || f.x > 1.05) leftView = true;
    }
  }
  assert.deepEqual([...modes].sort(), ['cruise', 'dart', 'rest']);
  assert.ok(fastest > .04 && fastest < .09, `fastest ${fastest}`); // a spurt stands out but never zips across the view
  assert.ok(highest < .1 && lowest > .85, `depths ${highest}..${lowest}`);
  assert.ok(leftView);
});

test('plant mask picks green leaves, ignores teal water, rocks and the surface band', async () => {
  const { plantMask } = await import('./src/aquarium-water');
  const w = 24, h = 24, px = new Uint8ClampedArray(w * h * 4);
  const paint = (x: number, y: number, r: number, g: number, b: number) => { const i = (y * w + x) * 4; px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = 255; };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (x < 8) paint(x, y, 70, 160, 60);          // leaves
    else if (x < 16) paint(x, y, 40, 150, 160);   // teal water
    else paint(x, y, 120, 118, 110);              // stone
  }
  const mask = plantMask(px, w, h);
  assert.ok(mask[20 * w + 3] > 200);
  assert.ok(mask[1 * w + 3] <= 2); // surface band never sways
  assert.ok(mask[20 * w + 12] < 20);
  assert.equal(mask[20 * w + 21], 0);
});
