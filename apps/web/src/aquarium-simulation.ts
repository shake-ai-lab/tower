export function seededRandom(seed: number) {
  return () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
// facing: -1 (left) .. 1 (right) for the head; tail follows it late, so a turn bends the body.
// turn: +1 when the fish rotates its head toward the viewer, -1 when away.
export type Fish = { x: number; y: number; z: number; vx: number; vy: number; facing: number; tail: number; turn: number; heading: number; species: number; size: number; phase: number; goalX: number; goalY: number; goalZ: number; timer: number; wander: boolean };
export type Bubble = { x: number; y: number; z: number; radius: number; speed: number; phase: number };
export function createAquarium(seed: number) {
  const random = seededRandom(seed);
  return {
    random, time: 0,
    schools: [0, 1].map(() => ({ x: .2 + random() * .6, y: .2 + random() * .35, timer: 0 })),
    fish: Array.from({ length: 30 }, (_, i): Fish => {
      const facing = random() < .5 ? -1 : 1;
      return {
      x: .06 + random() * .88, y: .15 + random() * .6, z: .12 + random() * .88,
      vx: (random() - .5) * .06, vy: (random() - .5) * .01, facing, tail: facing, turn: 1, heading: facing,
      species: i < 17 ? 0 : i < 26 ? 1 : 2, size: .8 + random() * .4, phase: random() * Math.PI * 2,
      goalX: random(), goalY: .12 + random() * .65, goalZ: random(), timer: random() * 5, wander: random() < .25,
      };
    }),
    bubbles: Array.from({ length: 45 }, (): Bubble => ({ x: random(), y: random(), z: random(), radius: 1 + random() * 3.5, speed: .025 + random() * .07, phase: random() * 20 })),
    particles: Array.from({ length: 85 }, () => ({ x: random(), y: random(), z: random(), phase: random() * 20 })),
  };
}
export type AquariumState = ReturnType<typeof createAquarium>;
export function stepAquarium(s: AquariumState, elapsed: number) {
  const dt = Math.max(0, Math.min(.08, elapsed));
  if (!dt) return;
  s.time += dt;
  for (const school of s.schools) {
    school.timer -= dt;
    if (school.timer <= 0) { school.x = .12 + s.random() * .76; school.y = .15 + s.random() * .5; school.timer = 5 + s.random() * 12; }
  }
  const previous = s.fish.map((f) => ({ ...f }));
  s.fish.forEach((f, index) => {
    f.timer -= dt;
    if (f.timer <= 0) {
      f.goalX = .04 + s.random() * .92; f.goalY = .1 + s.random() * .72; f.goalZ = s.random();
      f.timer = 2 + s.random() * 9; f.wander = s.random() < .28;
    }
    const school = s.schools[f.species % 2];
    let dx = (f.species === 2 || f.wander ? f.goalX : school.x) - f.x;
    let dy = (f.species === 2 || f.wander ? f.goalY : school.y) - f.y;
    for (let i = 0; i < previous.length; i++) {
      if (i === index) continue;
      const other = previous[i], x = f.x - other.x, y = f.y - other.y;
      const distance = Math.hypot(x, y);
      if (distance > .001 && distance < .06 && Math.abs(f.z - other.z) < .35) {
        dx += x / distance * (.06 - distance) * 5; dy += y / distance * (.06 - distance) * 5;
      } else if (!f.wander && other.species === f.species && distance < .2) {
        dx += other.vx * .3; dy += other.vy * .3;
      }
    }
    dx += Math.sin(s.time * .4 + f.phase) * .02; dy += Math.sin(s.time * .65 + f.phase) * .015;
    const length = Math.max(.03, Math.hypot(dx, dy));
    const speed = (f.species === 2 ? .018 : .035) * (.7 + .3 * Math.sin(s.time * .55 + f.phase) + f.z * .35);
    const blend = 1 - Math.exp(-dt * .9);
    f.vx += (dx / length * speed - f.vx) * blend;
    f.vy += (dy / length * speed * .65 - f.vy) * blend;
    f.x = Math.max(.025, Math.min(.975, f.x + f.vx * dt));
    f.y = Math.max(.07, Math.min(.87, f.y + f.vy * dt));
    f.z += (f.goalZ - f.z) * dt * .04;
    const heading = f.vx >= 0 ? 1 : -1;
    if (heading !== f.heading) { f.heading = heading; f.turn = s.random() < .6 ? 1 : -1; }
    f.facing += (heading - f.facing) * (1 - Math.exp(-dt * 2.6));
    f.tail += (f.facing - f.tail) * (1 - Math.exp(-dt * 3.4));
    f.phase += dt * (3 + Math.hypot(f.vx, f.vy) * 100);
  });
  for (const b of s.bubbles) {
    b.y -= b.speed * dt;
    if (b.y < -.03) { b.y = 1 + s.random() * .2; b.x = s.random() < .65 ? .82 + s.random() * .05 : s.random(); b.radius = 1 + s.random() * 3.5; }
  }
}
