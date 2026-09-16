// Headless checks for the parts that can be checked without a browser:
// the D2 terrain guarantees, pathing reachability, line of sight, and a long
// scripted simulation run. Feel is judged by playing it, not by this file.

import { MAP, T, VALID, PLAYER, TOWER, WAVE, PASSABLE } from '../src/config.js';
import { generateMap, validateMap, idx, isPassable, hasLineOfSight, kindAt, elevAt } from '../src/terrain.js';
import { computeField } from '../src/flowfield.js';
import { createGame, update, canPlaceAt, tryBuild, towerStats } from '../src/game.js';

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    const problem = fn();
    if (problem) failures.push(`${name}: ${problem}`);
    else passed++;
  } catch (err) {
    failures.push(`${name}: threw ${err && err.stack ? err.stack.split('\n')[0] : err}`);
  }
}

const SEEDS = ['ALPHA', 'BRAVO', 'CHARLIE', 'DELTA', 'ECHO', 'FOXTROT', 'GOLF', 'HOTEL',
               'INDIA', 'JULIET', 'KILO', 'LIMA', 'MIKE', 'NOVEMBER', 'OSCAR', 'PAPA',
               'QUEBEC', 'ROMEO', 'SIERRA', 'TANGO'];

console.log(`Generating ${SEEDS.length} maps...`);
const maps = SEEDS.map((s) => generateMap(s));

// --- D2: the validation gate actually holds on accepted maps -----------------

check('every map is accepted without relaxing the rules', () => {
  const relaxed = maps.filter((m) => m.relaxed).map((m) => m.seed);
  return relaxed.length ? `relaxed on ${relaxed.join(', ')}` : null;
});

check('accepted maps re-validate cleanly', () => {
  for (const m of maps) {
    const r = validateMap(m, false);
    if (!r.ok) return `${m.seed}: ${r.problems.join('; ')}`;
  }
  return null;
});

check('every barrier has at least two routes at least 3 tiles wide', () => {
  for (const m of maps) {
    for (const b of m.report.barriers) {
      if (b.routes < VALID.minRoutesPerBarrier) {
        return `${m.seed} ${b.type}@${b.cx} has ${b.routes} route(s)`;
      }
      if (b.narrowest < VALID.minGapTiles) {
        return `${m.seed} ${b.type}@${b.cx} narrowest gap ${b.narrowest}t`;
      }
    }
  }
  return null;
});

check('maps are neither mazes nor featureless fields', () => {
  for (const m of maps) {
    const f = m.report.openFrac;
    if (f < VALID.openFracMin || f > VALID.openFracMax) return `${m.seed} open fraction ${f.toFixed(2)}`;
  }
  return null;
});

check('every map actually produces chokepoints (2+ barriers)', () => {
  const thin = maps.filter((m) => m.report.barriers.length < 2).map((m) => m.seed);
  return thin.length ? `only one barrier on ${thin.join(', ')}` : null;
});

check('every map has cliffs, water and forest', () => {
  for (const m of maps) {
    const counts = { cliff: 0, water: 0, forest: 0, marsh: 0 };
    for (const k of m.kind) {
      if (k === T.CLIFF) counts.cliff++;
      else if (k === T.DEEP || k === T.SHALLOW) counts.water++;
      else if (k === T.FOREST) counts.forest++;
      else if (k === T.MARSH) counts.marsh++;
    }
    for (const [name, n] of Object.entries(counts)) {
      if (n === 0) return `${m.seed} has no ${name}`;
    }
  }
  return null;
});

// --- D8: determinism ---------------------------------------------------------

check('the same seed regenerates an identical map', () => {
  const a = generateMap('REPEATABLE');
  const b = generateMap('REPEATABLE');
  for (let i = 0; i < a.kind.length; i++) {
    if (a.kind[i] !== b.kind[i]) return `kind differs at ${i}`;
    if (a.elev[i] !== b.elev[i]) return `elevation differs at ${i}`;
    if (a.road[i] !== b.road[i]) return `road differs at ${i}`;
    if (Math.abs(a.res[i] - b.res[i]) > 1e-9) return `resources differ at ${i}`;
  }
  return null;
});

check('different seeds produce different maps', () => {
  const a = generateMap('SEED-ONE');
  const b = generateMap('SEED-TWO');
  let same = 0;
  for (let i = 0; i < a.kind.length; i++) if (a.kind[i] === b.kind[i]) same++;
  return same === a.kind.length ? 'identical grids' : null;
});

// --- D4: pathing -------------------------------------------------------------

check('enemies from both edges can always reach the start tower', () => {
  for (const m of maps) {
    const field = computeField(m, [idx(m.start.x, m.start.y)]);
    for (const side of ['west', 'east']) {
      for (const p of m.spawns[side]) {
        if (!Number.isFinite(field[idx(p.x, p.y)])) {
          return `${m.seed}: ${side} spawn (${p.x},${p.y}) cannot reach the start tower`;
        }
      }
    }
  }
  return null;
});

check('slow terrain really costs more to cross than open ground', () => {
  const m = maps[0];
  const field = computeField(m, [idx(m.start.x, m.start.y)]);
  let openSum = 0;
  let openN = 0;
  let marshSum = 0;
  let marshN = 0;
  for (let y = 0; y < MAP.h; y++) {
    for (let x = 0; x < MAP.w; x++) {
      const d = field[idx(x, y)];
      if (!Number.isFinite(d) || d === 0) continue;
      const straight = Math.hypot(x - m.start.x, y - m.start.y);
      if (straight < 6) continue;
      const ratio = d / straight;
      if (kindAt(m, x, y) === T.PLAIN) { openSum += ratio; openN++; }
      else if (kindAt(m, x, y) === T.MARSH) { marshSum += ratio; marshN++; }
    }
  }
  if (!marshN) return null; // this map has no marsh worth measuring
  const open = openSum / openN;
  const marsh = marshSum / marshN;
  return marsh > open ? null : `marsh (${marsh.toFixed(2)}) is not costlier than open ground (${open.toFixed(2)})`;
});

// --- D20-D22: road network and two movement cost modes ---------------------

function floodRoad(map) {
  const start = idx(map.roadCenter.x, map.roadCenter.y);
  const seen = new Uint8Array(map.road.length);
  const queue = map.road[start] ? [start] : [];
  if (queue.length) seen[start] = 1;
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head];
    const x = i % MAP.w;
    const y = (i / MAP.w) | 0;
    for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + ox;
      const ny = y + oy;
      if (nx < 0 || ny < 0 || nx >= MAP.w || ny >= MAP.h) continue;
      const ni = idx(nx, ny);
      if (!seen[ni] && map.road[ni]) { seen[ni] = 1; queue.push(ni); }
    }
  }
  return seen;
}

check('roads form one network from both spawn sides to the centre', () => {
  for (const m of maps) {
    const roadCount = m.road.reduce((n, v) => n + v, 0);
    if (!roadCount) return `${m.seed}: no road tiles`;
    if (m.roadConnectors < 1 || m.roadConnectors > 2) {
      return `${m.seed}: expected 1-2 lateral connectors, got ${m.roadConnectors}`;
    }
    const seen = floodRoad(m);
    if (!seen[idx(m.roadCenter.x, m.roadCenter.y)]) return `${m.seed}: centre is not road`;
    for (const side of ['west', 'east']) {
      for (const p of m.spawns[side]) {
        if (!seen[idx(p.x, p.y)]) return `${m.seed}: ${side} mouth (${p.x},${p.y}) is disconnected`;
      }
    }
    for (let i = 0; i < m.road.length; i++) {
      if (m.road[i] && !seen[i]) return `${m.seed}: detached road tile ${i}`;
    }
  }
  return null;
});

check('roads never make or cross impassable terrain', () => {
  for (const m of maps) {
    for (let i = 0; i < m.road.length; i++) {
      if (m.road[i] && !PASSABLE[m.kind[i]]) return `${m.seed}: road crosses tile ${i} kind ${m.kind[i]}`;
    }
  }
  return null;
});

check('road layouts vary by seed', () => {
  const a = generateMap('ROAD-VARIANT-A');
  const b = generateMap('ROAD-VARIANT-B');
  let different = 0;
  for (let i = 0; i < a.road.length; i++) if (a.road[i] !== b.road[i]) different++;
  return different > MAP.w ? null : `only ${different} road tiles differ`;
});

check('lane fields discount roads while direct fields ignore the road bitfield', () => {
  for (const m of maps.slice(0, 5)) {
    const target = idx(m.roadCenter.x, m.roadCenter.y);
    const direct = computeField(m, [target], 'direct');
    const lane = computeField(m, [target], 'lane');
    const noRoad = { ...m, road: new Uint8Array(m.road.length) };
    const directWithoutRoad = computeField(noRoad, [target], 'direct');
    let discounted = false;
    for (let i = 0; i < m.road.length; i++) {
      if (Math.abs(direct[i] - directWithoutRoad[i]) > 1e-4) return `${m.seed}: direct mode changed with road bits`;
      if (m.road[i] && lane[i] + 0.1 < direct[i]) discounted = true;
    }
    if (!discounted) return `${m.seed}: lane field never became cheaper on roads`;
  }
  return null;
});

// --- D3: line of sight -------------------------------------------------------

check('cliffs block sight and open ground does not', () => {
  const m = maps[0];
  let testedCliff = false;
  let testedOpen = false;
  for (let y = 2; y < MAP.h - 2 && !(testedCliff && testedOpen); y++) {
    for (let x = 2; x < MAP.w - 6; x++) {
      if (kindAt(m, x, y) === T.CLIFF && kindAt(m, x - 2, y) === T.PLAIN && kindAt(m, x + 2, y) === T.PLAIN) {
        if (hasLineOfSight(m, x - 2.5, y + 0.5, x + 2.5, y + 0.5)) return 'sight passed straight through a cliff';
        testedCliff = true;
      }
      if (!testedOpen && kindAt(m, x, y) === T.PLAIN && kindAt(m, x + 1, y) === T.PLAIN
          && kindAt(m, x + 2, y) === T.PLAIN && kindAt(m, x + 3, y) === T.PLAIN) {
        if (!hasLineOfSight(m, x + 0.5, y + 0.5, x + 3.5, y + 0.5)) return 'open ground blocked sight';
        testedOpen = true;
      }
    }
  }
  if (!testedCliff) return 'found no cliff to test';
  if (!testedOpen) return 'found no open lane to test';
  return null;
});

check('forest blocks sight from level ground but not from above it', () => {
  const m = maps.find((mm) => {
    for (let y = 1; y < MAP.h - 1; y++) {
      for (let x = 1; x < MAP.w - 4; x++) {
        if (kindAt(mm, x + 1, y) === T.FOREST) return true;
      }
    }
    return false;
  });
  if (!m) return 'no forest generated anywhere';

  for (let y = 1; y < MAP.h - 1; y++) {
    for (let x = 1; x < MAP.w - 4; x++) {
      if (kindAt(m, x + 1, y) !== T.FOREST) continue;
      const fe = elevAt(m, x + 1, y);
      // Same band as the trees: blocked. One band above: sees over them.
      const blockedFromLevel = !hasLineOfSightAtElev(m, x, y, x + 2, y, fe);
      const clearFromAbove = hasLineOfSightAtElev(m, x, y, x + 2, y, fe + 1);
      if (!blockedFromLevel) return `forest at (${x + 1},${y}) did not block level sight`;
      if (!clearFromAbove) return `forest at (${x + 1},${y}) still blocked sight from higher ground`;
      return null;
    }
  }
  return 'no usable forest sample';
});

/** Same rule as hasLineOfSight, with the shooter's elevation supplied directly. */
function hasLineOfSightAtElev(map, x0, y0, x1, y1, shooterElev) {
  const saved = map.elev[idx(x0, y0)];
  map.elev[idx(x0, y0)] = shooterElev;
  const r = hasLineOfSight(map, x0 + 0.5, y0 + 0.5, x1 + 0.5, y1 + 0.5);
  map.elev[idx(x0, y0)] = saved;
  return r;
}

// --- placement ---------------------------------------------------------------

check('placement refuses cliffs, deep water and crowding', () => {
  const g = createGame('PLACEMENT', 'engineer');
  g.materials = 99999;
  const m = g.map;

  let cliff = null;
  let deep = null;
  for (let y = 1; y < MAP.h - 1 && !(cliff && deep); y++) {
    for (let x = 1; x < MAP.w - 1; x++) {
      if (!cliff && kindAt(m, x, y) === T.CLIFF) cliff = [x, y];
      if (!deep && kindAt(m, x, y) === T.DEEP) deep = [x, y];
    }
  }
  if (cliff && canPlaceAt(g, cliff[0] + 0.5, cliff[1] + 0.5).ok) return 'allowed a tower on a cliff';
  if (deep && canPlaceAt(g, deep[0] + 0.5, deep[1] + 0.5).ok) return 'allowed a tower in deep water';

  const start = g.towers[0];
  const tooClose = canPlaceAt(g, start.x + TOWER.minSpacing * 0.5, start.y);
  if (tooClose.ok) return 'allowed two towers inside the minimum spacing';
  return null;
});

check('tower footprints refuse road tiles', () => {
  const g = createGame('ROAD-PLACEMENT', 'engineer');
  g.materials = 99999;
  const start = g.towers[0];
  for (let y = Math.floor(start.y - TOWER.radius); y <= Math.ceil(start.y + TOWER.radius); y++) {
    for (let x = Math.floor(start.x - TOWER.radius); x <= Math.ceil(start.x + TOWER.radius); x++) {
      if (Math.hypot(x + 0.5 - start.x, y + 0.5 - start.y) <= TOWER.radius + 0.3
          && g.map.road[idx(x, y)]) return 'starting tower overlaps a road';
    }
  }
  for (let y = 2; y < MAP.h - 2; y++) {
    for (let x = 2; x < MAP.w - 2; x++) {
      if (!g.map.road[idx(x, y)]) continue;
      const result = canPlaceAt(g, x + 0.5, y + 0.5);
      return result.reasons.includes('on the road') ? null : `road at (${x},${y}) was not named as a refusal`;
    }
  }
  return 'no interior road tile found';
});

check('a site on rich ground reports more income than a barren one', () => {
  const g = createGame('ECONOMY', 'prospector');
  const m = g.map;
  let best = { v: -1 };
  let worst = { v: 1e9 };
  for (let y = 4; y < MAP.h - 4; y += 3) {
    for (let x = 4; x < MAP.w - 4; x += 3) {
      if (!isPassable(m, x, y)) continue;
      const c = canPlaceAt(g, x + 0.5, y + 0.5);
      if (c.income > best.v) best = { v: c.income, x, y };
      if (c.income < worst.v) worst = { v: c.income, x, y };
    }
  }
  if (!(best.v > worst.v * 3 + 0.05)) {
    return `resource terrain barely varies (best ${best.v.toFixed(2)} vs worst ${worst.v.toFixed(2)})`;
  }
  return null;
});

// --- D6: collapse ------------------------------------------------------------

check('a tower collapsing on the player is near-lethal', () => {
  const g = createGame('COLLAPSE', 'gunner');
  const t = g.towers[0];
  g.player.x = t.x;
  g.player.y = t.y;
  g.player.hp = g.player.maxHp;
  t.hp = -1;
  update(g, 1 / 60);
  const taken = g.player.maxHp - g.player.hp;
  const expected = PLAYER.maxHp * TOWER.collapseDamageFrac;
  if (Math.abs(taken - expected) > 0.5) return `took ${taken}, expected ${expected}`;
  if (g.towers.length !== 0) return 'tower survived being destroyed';
  return null;
});

check('standing clear of a collapsing tower is safe', () => {
  const g = createGame('COLLAPSE', 'gunner');
  const t = g.towers[0];
  g.player.x = t.x + TOWER.collapseRadius + 2;
  g.player.y = t.y;
  const before = g.player.hp;
  t.hp = -1;
  update(g, 1 / 60);
  return g.player.hp === before ? null : `lost ${before - g.player.hp} hp while clear`;
});

// --- D5: aggro commitment ----------------------------------------------------

check('a sieging enemy does not abandon its target when the player leaves', () => {
  const g = createGame('AGGRO', 'gunner');
  g.materials = 9999;
  const a = g.towers[0];
  // Put a second tower far enough away to be a genuinely different target.
  let placed = null;
  for (let d = TOWER.minSpacing + 1; d < 40 && !placed; d += 1) {
    const r = tryBuild(g, a.x + d, a.y);
    if (r.ok) placed = g.towers[g.towers.length - 1];
  }
  if (!placed) return 'could not place a second tower to test against';
  placed.built = true;
  placed.progress = 1;
  placed.hp = placed.maxHp;

  g.player.x = a.x;
  g.player.y = a.y;
  for (let i = 0; i < 60; i++) update(g, 1 / 60);
  if (g.occupiedTowerId !== a.id) return 'player did not occupy the first tower';

  // An enemy that has arrived and started chewing on tower A.
  const e = {
    id: 999, type: 'swarm', def: { ...g.map && {}, radius: 0.34, hp: 30, speed: 2.2,
      towerDps: 6, playerHit: 8, color: '#fff' },
    side: 'west', x: a.x + 1.4, y: a.y, hp: 1e6, maxHp: 1e6,
    targetId: a.id, sieging: true, siegeAngle: 0, retargetIn: 0, hitCd: 99, flash: 0,
  };
  g.enemies.push(e);
  update(g, 0.05);
  if (!e.sieging) return 'enemy did not settle into a siege';

  // Player abandons A for B; the sieging enemy must stay on A.
  g.player.x = placed.x;
  g.player.y = placed.y;
  for (let i = 0; i < 400; i++) update(g, 1 / 60); // ~6.7s, well past the retarget timer
  if (g.occupiedTowerId !== placed.id) return 'player did not occupy the second tower';
  if (!g.towers.some((t) => t.id === a.id)) return null; // tower A died; nothing left to commit to
  if (e.targetId !== a.id) return 'sieging enemy instantly switched to the newly occupied tower';
  return null;
});

check('an enemy that is not yet sieging does eventually re-prioritise', () => {
  const g = createGame('AGGRO2', 'gunner');
  g.materials = 9999;
  const a = g.towers[0];
  let b = null;
  for (let d = TOWER.minSpacing + 1; d < 40 && !b; d += 1) {
    const r = tryBuild(g, a.x + d, a.y);
    if (r.ok) b = g.towers[g.towers.length - 1];
  }
  if (!b) return 'could not place a second tower';
  b.built = true; b.progress = 1; b.hp = b.maxHp;

  const e = {
    id: 998, type: 'swarm', def: { radius: 0.34, hp: 30, speed: 0, towerDps: 0, playerHit: 0, color: '#fff' },
    side: 'west', x: (a.x + b.x) / 2, y: a.y, hp: 1e6, maxHp: 1e6,
    targetId: a.id, sieging: false, siegeAngle: 0, retargetIn: 0.1, hitCd: 99, flash: 0,
  };
  g.enemies.push(e);
  g.player.x = b.x;
  g.player.y = b.y;
  for (let i = 0; i < 600; i++) update(g, 1 / 60); // 10s
  return e.targetId === b.id ? null : `stayed on tower ${e.targetId} despite the player occupying ${b.id}`;
});

// --- occupancy is actually a large bonus -------------------------------------

check('occupying a tower is a large, visible upgrade', () => {
  for (const key of ['engineer', 'prospector', 'gunner']) {
    const g = createGame('OCCUPY', key);
    const t = g.towers[0];
    g.player.x = t.x + 40;
    update(g, 0.01);
    const away = towerStats(g, t);
    g.player.x = t.x;
    g.player.y = t.y;
    for (let i = 0; i < 60; i++) update(g, 1 / 60);
    const here = towerStats(g, t);
    const dps = (here.damage * here.fireRate) / (away.damage * away.fireRate);
    const inc = here.income / away.income;
    if (dps < 1.3 && inc < 1.3) return `${key}: occupancy changed almost nothing (dps x${dps.toFixed(2)}, income x${inc.toFixed(2)})`;
  }
  return null;
});

check('shelter grants occupancy only after the transition delay', () => {
  const g = createGame('SHELTER', 'engineer');
  const t = g.towers[0];
  g.player.x = t.x;
  g.player.y = t.y;
  update(g, PLAYER.shelterTime * 0.5);
  if (g.occupiedTowerId !== null) return 'tower became occupied halfway through sheltering';
  if (towerStats(g, t).occupied) return 'occupancy bonuses applied during shelter transition';
  const e = {
    id: 997, type: 'swarm', def: { radius: 0.34, hp: 1e6, speed: 0,
      towerDps: 0, playerHit: 10, color: '#fff' }, side: 'debug',
    x: g.player.x + 0.2, y: g.player.y, hp: 1e6, maxHp: 1e6,
    targetId: null, sieging: false, siegeAngle: 0, retargetIn: 99, hitCd: 0, flash: 0,
  };
  g.enemies.push(e);
  update(g, 0.01);
  if (g.player.hp === g.player.maxHp) return 'player could not be hit during shelter transition';
  update(g, PLAYER.shelterTime * 0.51);
  if (g.occupiedTowerId !== t.id) return 'tower did not become occupied after the full delay';
  if (!towerStats(g, t).occupied) return 'occupancy bonuses did not apply after sheltering';
  const shelteredHp = g.player.hp;
  e.hitCd = 0;
  g.player.hurtCd = 0;
  update(g, 0.01);
  if (g.player.hp < shelteredHp) return 'sheltered player was hit by enemy melee';
  g.player.x += PLAYER.presenceRadius + 1;
  update(g, 0.01);
  if (g.occupiedTowerId !== null || g.shelter.progress !== 0) return 'leaving did not reset shelter';
  return null;
});

// --- long simulation ---------------------------------------------------------

check('a full run simulates for several waves without crashing', () => {
  const g = createGame('LONGRUN', 'prospector');
  g.materials = 4000;
  const dt = 1 / 30;
  let built = 0;

  for (let step = 0; step < 30 * 60 * 6; step++) { // 6 simulated minutes
    // A crude bot: sit in the start tower, and build a couple of extra towers.
    const t = g.towers[0];
    if (t) { g.player.x = t.x; g.player.y = t.y; }
    g.input = { mx: 0, my: 0, melee: false, repair: true };
    update(g, dt);

    if (built < 3 && step % 900 === 400 && g.materials > TOWER.cost) {
      for (let d = TOWER.minSpacing + 1; d < 25; d += 2) {
        if (tryBuild(g, g.map.start.x + d, g.map.start.y).ok) { built++; break; }
      }
    }
    if (g.status !== 'playing') break;
    if (!Number.isFinite(g.materials)) return `materials went non-finite at step ${step}`;
    if (!Number.isFinite(g.player.hp)) return `player hp went non-finite at step ${step}`;
    for (const e of g.enemies) {
      if (!Number.isFinite(e.x) || !Number.isFinite(e.y)) return `enemy position went non-finite at step ${step}`;
      if (!isPassable(g.map, Math.floor(e.x), Math.floor(e.y))) {
        return `enemy stood inside impassable terrain at step ${step}`;
      }
    }
  }
  if (g.stats.wavesCleared < 1) return 'no wave was ever cleared in six minutes';
  if (g.stats.kills === 0) return 'no enemy was ever killed';
  return null;
});

check('waves escalate rather than staying flat', () => {
  const g = createGame('ESCALATE', 'gunner');
  const sizes = [];
  for (let wave = 1; wave <= WAVE.totalToSurvive; wave++) {
    g.wave = wave;
    let total = 0;
    for (let i = 0; i < 12; i++) { // average out the roll
      g.phase = 'prep';
      g.phaseLeft = 0;
      update(g, 0.001);
      total += g.pendingSpawns.length;
      g.pendingSpawns = [];
      g.phase = 'prep';
    }
    sizes.push(total / 12);
  }
  return sizes[sizes.length - 1] > sizes[0] * 1.5
    ? null
    : `wave 1 averages ${sizes[0].toFixed(1)} units, wave ${WAVE.totalToSurvive} averages ${sizes[sizes.length - 1].toFixed(1)}`;
});

// ---------------------------------------------------------------------------

console.log('');
for (const f of failures) console.log(`  FAIL  ${f}`);
console.log(`\n${passed} passed, ${failures.length} failed`);

if (failures.length) process.exit(1);
