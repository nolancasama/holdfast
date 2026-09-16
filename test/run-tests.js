// Headless checks for the parts that can be checked without a browser:
// the D2 terrain guarantees, pathing reachability, line of sight, and a long
// scripted simulation run. Feel is judged by playing it, not by this file.

import { MAP, T, VALID, PLAYER, TOWER, WAVE } from '../src/config.js';
import { generateMap, validateMap, idx, isPassable, hasLineOfSight, kindAt, elevAt } from '../src/terrain.js';
import { computeField } from '../src/flowfield.js';
import { createGame, update, canPlaceAt, tryBuild, objectiveHeld, towerStats } from '../src/game.js';

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
    if (Math.abs(a.res[i] - b.res[i]) > 1e-9) return `resources differ at ${i}`;
  }
  if (a.objective.x !== b.objective.x || a.objective.side !== b.objective.side) return 'objective differs';
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

check('the player can walk from the start tower to the objective zone', () => {
  for (const m of maps) {
    const field = computeField(m, [idx(m.start.x, m.start.y)]);
    if (!Number.isFinite(field[idx(m.objective.x, m.objective.y)])) {
      return `${m.seed}: objective zone is unreachable on foot`;
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
  update(g, 0.01);
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
    update(g, 0.01);
    const here = towerStats(g, t);
    const dps = (here.damage * here.fireRate) / (away.damage * away.fireRate);
    const inc = here.income / away.income;
    if (dps < 1.3 && inc < 1.3) return `${key}: occupancy changed almost nothing (dps x${dps.toFixed(2)}, income x${inc.toFixed(2)})`;
  }
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

check('the objective only counts once a tower there is finished and alive', () => {
  const g = createGame('OBJECTIVE', 'engineer');
  g.materials = 9999;
  if (objectiveHeld(g)) return 'objective reported held before anything was built';
  const o = g.map.objective;
  const r = tryBuild(g, o.x + 0.5, o.y + 0.5);
  if (!r.ok) return `could not build in the objective zone: ${r.reasons.join(', ')}`;
  const t = g.towers[g.towers.length - 1];
  if (!t.isObjective) return 'tower in the objective zone was not flagged as the objective';
  if (objectiveHeld(g)) return 'unfinished objective tower counted as held';
  t.built = true;
  t.progress = 1;
  if (!objectiveHeld(g)) return 'finished objective tower did not count';
  return null;
});

// ---------------------------------------------------------------------------

console.log('');
for (const f of failures) console.log(`  FAIL  ${f}`);
console.log(`\n${passed} passed, ${failures.length} failed`);

if (failures.length) process.exit(1);
