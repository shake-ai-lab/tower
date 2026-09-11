export function seededRandom(seed: number) {
  return () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
const between = (random: () => number, low: number, high: number) => low + random() * (high - low);
const ease = (rate: number, dt: number) => 1 - Math.exp(-dt * rate);

// Where fish may be, as fractions of the view. The sides reach past the edges so fish can swim out of sight and come back.
export const TANK = { left: -.14, right: 1.14, top: .03, bottom: .93 };
const offView = (random: () => number) => random() < .5 ? TANK.left + .02 : TANK.right - .02;
// Seconds a fish needs to get somewhere at an easy pace, so far trips (off screen, surface, sand) are not given up halfway.
// Climbing and diving are slower than swimming along, hence the extra weight on height.
const travel = (dx: number, dy: number, speed: number) => Math.hypot(dx, dy * 1.8) / (speed * .6);

// Behaviour of each photographed species (one row of the sprite atlas). Speeds are view widths per second.
// school: how tightly it keeps with its group (0 = alone). dart / rest: chance that a change of pace is a short spurt or a pause.
// band: the depths it likes, 0 = surface and 1 = sand.
export const SPECIES = [
  { length: 65, speed: .03, school: 1, dart: .15, rest: .1, band: [.1, .82] },     // neon tetra
  { length: 88, speed: .026, school: .7, dart: .1, rest: .15, band: [.07, .88] },  // rasbora
  { length: 145, speed: .016, school: 0, dart: .03, rest: .4, band: [.12, .9] },   // pearl gourami: a loner that hovers and gulps air
];

// Colour and body variants of the three photographs, so each launch stocks a different tank. stretch > 1 is a deeper body.
export const LOOKS = [
  { species: 0, filter: 'none', stretch: 1 },
  { species: 0, filter: 'hue-rotate(35deg)', stretch: 1 },                         // warm red
  { species: 0, filter: 'hue-rotate(-30deg) saturate(1.4)', stretch: 1 },          // pink and green
  { species: 1, filter: 'none', stretch: 1 },
  { species: 1, filter: 'hue-rotate(-25deg) saturate(1.6)', stretch: 1 },          // red
  { species: 1, filter: 'hue-rotate(150deg) saturate(1.2)', stretch: 1 },          // blue-green
  { species: 1, filter: 'none', stretch: 1.25 },                                   // deep-bodied
  { species: 2, filter: 'none', stretch: 1 },
  { species: 2, filter: 'sepia(.6) saturate(2.2) hue-rotate(-5deg)', stretch: 1 }, // gold
  { species: 2, filter: 'hue-rotate(170deg) saturate(1.3)', stretch: 1 },          // blue
  { species: 2, filter: 'hue-rotate(-40deg) saturate(1.8)', stretch: 1 },          // red
  { species: 2, filter: 'saturate(.4) brightness(1.15)', stretch: 1 },             // platinum
];

// heading: the way the fish has decided to go. facing: -1 (left) .. 1 (right) for the head, swinging toward heading;
// tail follows it late, so a turn bends the body. turn: +1 when the head rotates toward the viewer, -1 when away.
// A fish only ever swims where its head points: vx = speed * cos(pitch) * facing, vy = speed * sin(pitch) plus a slight fin lift.
// school: index into schools, -1 for a fish that keeps to itself. pace: its own speed factor. wobble: its own meander offset.
// mode: cruising, a short spurt, or hovering in place.
export type Fish = { x: number; y: number; z: number; vx: number; vy: number; speed: number; pitch: number; facing: number; tail: number; turn: number; heading: number; species: number; look: number; school: number; size: number; pace: number; wobble: number; phase: number; goalX: number; goalY: number; goalZ: number; timer: number; wander: boolean; mode: 'cruise' | 'dart' | 'rest'; modeTimer: number };
export type School = { species: number; x: number; y: number; timer: number; rush: number };
export type Bubble = { x: number; y: number; z: number; radius: number; speed: number; phase: number };
export function createAquarium(seed: number) {
  const random = seededRandom(seed);
  const shuffle = <T>(items: T[]) => {
    for (let i = items.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [items[i], items[j]] = [items[j], items[i]]; }
    return items;
  };
  const looksOf = (species: number) => shuffle(LOOKS.flatMap((look, i) => look.species === species ? [i] : []));
  const schools: School[] = [], fish: Fish[] = [];
  const add = (look: number, school: number) => {
    const species = LOOKS[look].species, [top, bottom] = SPECIES[species].band, facing = random() < .5 ? -1 : 1;
    const pace = between(random, .8, 1.2), speed = SPECIES[species].speed * pace * .8;
    fish.push({
      x: between(random, .06, .94), y: between(random, top, bottom), z: between(random, .12, 1),
      vx: speed * facing, vy: 0, speed, pitch: 0, facing, tail: facing, turn: 1, heading: facing,
      species, look, school, size: between(random, .7, 1.3), pace, wobble: random() * Math.PI * 2, phase: random() * Math.PI * 2,
      goalX: random(), goalY: between(random, top, bottom), goalZ: random(), timer: random() * 5, wander: random() < .25,
      mode: 'cruise', modeTimer: random() * 4,
    });
  };
  // One or two schools of tetras, one or two of rasboras, and a few gouramis of different colours.
  for (const species of [0, 1]) {
    const pair = random() < .5;
    looksOf(species).slice(0, pair ? 2 : 1).forEach((look, k) => {
      const [low, high] = species === 0 ? (pair ? [[8, 11], [6, 9]][k] : [12, 16]) : (pair ? [5, 7] : [7, 10]);
      const [top, bottom] = SPECIES[species].band;
      schools.push({ species, x: between(random, .2, .8), y: between(random, top + .04, bottom - .1), timer: 0, rush: 0 });
      for (let n = low + Math.floor(random() * (high - low + 1)); n > 0; n--) add(look, schools.length - 1);
    });
  }
  const gouramis = looksOf(2);
  for (let i = 0, n = 3 + Math.floor(random() * 3); i < n; i++) add(gouramis[i % gouramis.length], -1);
  return {
    random, time: 0, schools, fish,
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
    school.timer -= dt; school.rush = Math.max(0, school.rush - dt);
    if (school.timer > 0) continue;
    // Now and then the whole school swims out of sight and comes back, or goes down near the sand for a while;
    // sometimes it hurries to the new spot together.
    const [top, bottom] = SPECIES[school.species].band, away = s.random() < .1, low = !away && s.random() < .2;
    const x = away ? offView(s.random) : between(s.random, .1, .9);
    const y = low ? between(s.random, bottom - .08, bottom - .02) : between(s.random, top + .04, bottom - .1);
    school.timer = travel(x - school.x, y - school.y, SPECIES[school.species].speed) + between(s.random, 3, 10);
    school.x = x; school.y = y;
    if (s.random() < .2) school.rush = between(s.random, .6, 1.2);
  }
  const previous = s.fish.map((f) => ({ ...f }));
  s.fish.forEach((f, index) => {
    const kind = SPECIES[f.species], school = f.school >= 0 ? s.schools[f.school] : null;
    f.timer -= dt;
    if (f.timer <= 0) {
      // Loners leave the view more often, gouramis rise to the surface to gulp air, and any fish may go poking about near the sand.
      const away = s.random() < (school ? .03 : .1), breathe = !away && !school && s.random() < .2, low = !away && !breathe && s.random() < .2;
      f.goalX = away ? offView(s.random) : between(s.random, .04, .96);
      f.goalY = breathe ? TANK.top + .01 : low ? between(s.random, kind.band[1] - .06, kind.band[1]) : between(s.random, kind.band[0], kind.band[1]);
      f.goalZ = s.random();
      f.timer = travel(f.goalX - f.x, f.goalY - f.y, kind.speed * f.pace) + between(s.random, 2, 8);
      f.wander = !school || s.random() < .2 + (1 - kind.school) * .5;
    }
    f.modeTimer -= dt;
    if (f.modeTimer <= 0) {
      const roll = s.random();
      f.mode = roll < kind.dart ? 'dart' : roll < kind.dart + kind.rest ? 'rest' : 'cruise';
      f.modeTimer = f.mode === 'dart' ? between(s.random, .4, .8) : f.mode === 'rest' ? between(s.random, 2, 6) : between(s.random, 3, 9);
    }
    const target = school && !f.wander ? school : { x: f.goalX, y: f.goalY };
    let dx = target.x - f.x, dy = target.y - f.y;
    for (let i = 0; i < previous.length; i++) {
      if (i === index) continue;
      const other = previous[i], x = f.x - other.x, y = f.y - other.y;
      const distance = Math.hypot(x, y);
      if (distance > .001 && distance < .06 && Math.abs(f.z - other.z) < .35) {
        dx += x / distance * (.06 - distance) * 3; dy += y / distance * (.06 - distance) * 3;
      } else if (!f.wander && school && other.school === f.school && distance < .2) {
        dx += other.vx * .3; dy += other.vy * .3;
      }
    }
    // Slow meandering, so paths curve instead of running straight at the target.
    dx += Math.sin(s.time * .23 + f.wobble) * .03; dy += Math.sin(s.time * .31 + f.wobble * 1.7) * .02;
    // Turn round only when the target is clearly behind, so small nudges never make it flip back and forth.
    if (dx * f.heading < -.04) { f.heading = -f.heading; f.turn = s.random() < .6 ? 1 : -1; }
    f.facing += (f.heading - f.facing) * ease(2, dt);
    f.tail += (f.facing - f.tail) * ease(3, dt);
    // Spurts come on quickly and fade into a glide; turning round and arriving slow the fish down.
    const hurry = f.mode === 'dart' || (!!school && school.rush > 0 && !f.wander);
    let want = kind.speed * f.pace * (.8 + .2 * Math.sin(s.time * .3 + f.wobble)) * (.85 + f.z * .3);
    if (hurry) want *= 1.8;
    else if (f.mode === 'rest') want *= .15;
    else want *= Math.max(.3, Math.min(1, Math.hypot(dx, dy) / .1));
    if (Math.abs(f.heading - f.facing) > .4) want *= .5;
    f.speed += (want - f.speed) * ease(want > f.speed ? (hurry ? 3 : 1) : .7, dt);
    // Climb and dive at a moderate angle; a resting fish levels out.
    const climb = Math.max(-.55, Math.min(.55, Math.atan2(dy, Math.max(.02, Math.abs(dx))))) * (f.mode === 'rest' ? .3 : 1);
    f.pitch += (climb - f.pitch) * ease(1.2, dt);
    // Fins also lift or sink the fish a little with a level body, the way it rises to the surface or settles.
    const lift = Math.max(-1, Math.min(1, dy / .1)) * .005 * f.pace;
    f.vx = f.speed * Math.cos(f.pitch) * f.facing; f.vy = f.speed * Math.sin(f.pitch) + lift;
    f.x = Math.max(TANK.left, Math.min(TANK.right, f.x + f.vx * dt));
    f.y = Math.max(TANK.top, Math.min(TANK.bottom, f.y + f.vy * dt));
    f.z += (f.goalZ - f.z) * ease(.08, dt);
    f.phase += dt * (3 + f.speed * 110);
  });
  for (const b of s.bubbles) {
    b.y -= b.speed * dt;
    if (b.y < -.03) { b.y = 1 + s.random() * .2; b.x = s.random() < .65 ? .82 + s.random() * .05 : s.random(); b.radius = 1 + s.random() * 3.5; }
  }
}
