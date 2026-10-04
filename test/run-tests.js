// Headless behavioral checks for the frozen D77-D83 phase-1 contract.

import {
  MAP, T, PLAYER, TOWER, KEEP, START_RESOURCES, WALL_PATH,
  ENEMIES, WAVE, PASSABLE,
} from '../src/config.js';
import {
  generateMap, validateResourceGeography, idx,
} from '../src/terrain.js';
import { computeField } from '../src/flowfield.js';
import { runPreserved } from './preserved-tests.js';
import { runFortress } from './fortress-tests.js';
import {
  createGame, update, canPlaceAt, tryBuild, tryUpgrade, towerStats,
  spawnGroupAt, isTileExplored, resourceState,
  resourceSitesState, keepState, buildingState, keepFieldState,
  enemyKeepField, endState, playerSpeed,
} from '../src/game.js';

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    const result = fn();
    if (result === false) throw new Error('assertion returned false');
    passed++;
  } catch (error) {
    failures.push(`${name}: ${error?.stack?.split('\n')[0] || error}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function approx(actual, expected, epsilon = 1e-6, message = '') {
  assert(Math.abs(actual - expected) <= epsilon,
    message || `expected ${expected}, got ${actual}`);
}

const SEEDS = ['ALPHA', 'BRAVO', 'CHARLIE', 'DELTA', 'ECHO', 'FOXTROT', 'GOLF', 'HOTEL',
  'INDIA', 'JULIET', 'KILO', 'LIMA', 'MIKE', 'NOVEMBER', 'OSCAR', 'PAPA',
  'QUEBEC', 'ROMEO', 'SIERRA', 'TANGO'];

console.log(`Generating ${SEEDS.length} maps...`);
const generationMs = [];
const maps = SEEDS.map((seed) => {
  const started = performance.now();
  const map = generateMap(seed);
  generationMs.push(performance.now() - started);
  return map;
});

function median(values) {
  const a = [...values].sort((x, y) => x - y);
  return a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2;
}

function flatMap({ corridor = false } = {}) {
  const size = MAP.w * MAP.h;
  const cy = Math.floor(MAP.h / 2);
  const kind = new Uint8Array(size).fill(corridor ? T.DEEP : T.PLAIN);
  if (corridor) {
    for (let y = cy - 1; y <= cy + 1; y++) for (let x = 0; x < MAP.w; x++) kind[idx(x, y)] = T.PLAIN;
  }
  const fertility = new Float32Array(size);
  const start = { x: Math.floor(MAP.w / 2), y: cy };
  const stoneSites = [{ id: 'stone-test', type: 'stone', x: start.x + 6.5, y: start.y + 0.5, tier: 'normal', mult: 1 }];
  const goldSites = [{ id: 'gold-test', type: 'gold', x: start.x + 32.5, y: start.y + 0.5, tier: 'normal', mult: 1 }];
  return {
    w: MAP.w, h: MAP.h, kind,
    elev: new Uint8Array(size).fill(1),
    road: new Uint8Array(size), waterDist: new Uint8Array(size),
    fertility, farmland: [], stoneSites, goldSites,
    sites: [...stoneSites, ...goldSites],
    start, terrainVersion: 0, barriers: [], roadRoutes: [],
    spawns: { west: [{ x: 1, y: cy }], east: [{ x: MAP.w - 2, y: cy }] },
    roadCenter: { ...start },
  };
}

function gameOn(map = flatMap(), archetype = 'gunner') {
  const g = createGame('TEST', archetype, map);
  g.phase = 'prep';
  g.phaseLeft = 1e9;
  return g;
}

function rich(g) {
  g.res.food = 10000;
  g.res.stone = 10000;
  g.res.gold = 10000;
}

function buildAt(g, x, y, type = 'tower') {
  g.player.x = x;
  g.player.y = y;
  const result = tryBuild(g, x, y, type);
  assert(result.ok, `${type} refused: ${result.reasons?.join('; ')}`);
  return result.structure;
}

function run(g, seconds, step = 0.05) {
  for (let t = 0; t < seconds && g.status === 'playing'; t += step) update(g, step);
}

for (let n = 0; n < maps.length; n++) {
  const seed = SEEDS[n];
  const map = maps[n];
  check(`${seed}: 208x104 dimensions`, () => {
    assert(map.w === 208 && map.h === 104 && map.kind.length === 208 * 104, 'wrong dimensions');
  });
  check(`${seed}: D2 validation remains meaningful`, () => {
    assert(map.report.ok, map.report.problems.join('; '));
    assert(map.report.barriers.length >= 5, 'larger map has too few barriers');
    assert(map.spawns.west.length >= 4 && map.spawns.east.length >= 4, 'not enough spawn mouths');
  });
  check(`${seed}: D80 resource geography`, () => {
    const report = validateResourceGeography(map);
    assert(report.ok, report.problems.join('; '));
    assert(map.goldSites.every((s) => Math.hypot(s.x - (map.start.x + 0.5), s.y - (map.start.y + 0.5)) >= 27.5), 'gold too near Keep');
    assert(map.fertility.some((v) => v === 1) && map.fertility.some((v) => v === 1.5), 'both fertility tiers required');
  });
}

check('D77 Keep identity, HP and radius', () => {
  const g = gameOn();
  const keep = g.towers[0];
  assert(keep.keep === true, 'start tower is not Keep');
  assert(keep.maxHp === KEEP.maxHp && keep.radius === KEEP.radius, 'Keep stats wrong');
  assert(keepState(g).id === keep.id, 'Keep acceptance state wrong');
});

check('D77 Keep destruction loses with keep reason', () => {
  const g = gameOn(); rich(g);
  const keep = g.towers[0];
  buildAt(g, keep.x + 9, keep.y, 'tower');
  g.player.x = 10; g.player.y = 10;
  keep.hp = -1;
  update(g, 0.01);
  assert(g.status === 'lost' && g.lossCause === 'keep', JSON.stringify(endState(g)));
});

check('D77 player death has priority over Keep destruction', () => {
  const g = gameOn();
  g.phase = 'combat';
  g.player.x = 10; g.player.y = 10; g.player.hp = -1;
  g.towers[0].hp = -1;
  update(g, 0.01);
  assert(g.status === 'lost' && g.lossCause === 'died', JSON.stringify(endState(g)));
});

check('D77 secondary towers may all fall while Keep lives', () => {
  const g = gameOn(); rich(g);
  const keep = g.towers[0];
  const t = buildAt(g, keep.x + 9, keep.y, 'tower');
  g.player.x = 10; g.player.y = 10; t.hp = -1;
  update(g, 0.01);
  assert(g.status === 'playing' && g.towers.length === 1 && g.towers[0].keep, 'secondary loss ended run');
});

check('D80 g.res replaces Materials and tower extraction', () => {
  const g = gameOn();
  assert(g.materials === undefined, 'legacy materials remains');
  assert(JSON.stringify(g.res) === JSON.stringify(START_RESOURCES), 'start resources wrong');
  const stats = towerStats(g, g.towers[0]);
  assert(!('income' in stats) && !('extractRadius' in stats), 'tower extraction stats remain');
});

check('D80 Farm requires fertility and produces Food only after construction', () => {
  const map = flatMap();
  const g = gameOn(map); rich(g);
  const x = map.start.x + 4.5; const y = map.start.y + 4.5;
  assert(!canPlaceAt(g, x, y, 'farm').ok, 'farm accepted barren ground');
  for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) map.fertility[idx(Math.floor(x) + ox, Math.floor(y) + oy)] = 1;
  const farm = buildAt(g, x, y, 'farm');
  const before = { ...g.res };
  update(g, 0.5);
  approx(g.res.food, before.food, 1e-9, 'unfinished farm produced');
  run(g, 12);
  assert(farm.built && g.res.food > before.food, 'built farm did not produce Food');
  approx(g.res.stone, before.stone, 1e-6, 'farm produced Stone');
  approx(g.res.gold, before.gold, 1e-6, 'farm produced Gold');
});

check('D80 Quarry requires a stone site and produces Stone', () => {
  const map = flatMap(); const g = gameOn(map); rich(g);
  assert(!canPlaceAt(g, 20.5, 20.5, 'quarry').ok, 'quarry accepted no-site placement');
  const site = map.stoneSites[0];
  const quarry = buildAt(g, site.x, site.y, 'quarry');
  const before = g.res.stone;
  run(g, 14);
  assert(quarry.built && g.res.stone > before, 'quarry did not produce');
});

check('D80 Gold Mine requires gold and produces Gold', () => {
  const map = flatMap(); const g = gameOn(map); rich(g);
  assert(!canPlaceAt(g, 20.5, 20.5, 'mine').ok, 'mine accepted no-site placement');
  const site = map.goldSites[0];
  const mine = buildAt(g, site.x, site.y, 'mine');
  const before = g.res.gold;
  run(g, 16);
  assert(mine.built && g.res.gold > before, 'mine did not produce');
});

check('D80 one building per site; destruction stops production and frees site', () => {
  const map = flatMap(); const g = gameOn(map); rich(g);
  const site = map.stoneSites[0];
  const quarry = buildAt(g, site.x, site.y, 'quarry');
  assert(!canPlaceAt(g, site.x + 1, site.y, 'quarry').ok, 'claimed site accepted twice');
  run(g, 14);
  quarry.hp = -1;
  update(g, 0.01);
  const stoppedAt = g.res.stone;
  run(g, 2);
  approx(g.res.stone, stoppedAt, 1e-6, 'destroyed quarry still produced');
  assert(canPlaceAt(g, site.x, site.y, 'quarry').ok, 'destroyed quarry did not free site');
});

check('D80 Steward discounts and accelerates economic buildings', () => {
  const map = flatMap();
  const normal = gameOn(structuredClone(map), 'gunner'); const steward = gameOn(structuredClone(map), 'prospector');
  rich(normal); rich(steward);
  const s = map.stoneSites[0];
  assert(canPlaceAt(steward, s.x, s.y, 'quarry').cost.food < canPlaceAt(normal, s.x, s.y, 'quarry').cost.food, 'no Steward discount');
  const a = buildAt(normal, s.x, s.y, 'quarry'); const b = buildAt(steward, s.x, s.y, 'quarry');
  update(normal, 1); update(steward, 1);
  assert(b.progress > a.progress, 'no Steward build-speed bonus');
});

check('D83 repair is refused remotely and works within 2.5 tiles of edge', () => {
  const g = gameOn(); rich(g); const keep = g.towers[0];
  const tower = buildAt(g, keep.x + 9, keep.y, 'tower');
  tower.built = true; tower.progress = 1; tower.hp = 200; g.selected = tower.id;
  g.player.x = 10; g.player.y = 10; g.input.repair = true;
  const remoteHp = tower.hp; const remoteStone = g.res.stone;
  update(g, 1);
  approx(tower.hp, remoteHp); approx(g.res.stone, remoteStone);
  g.player.x = tower.x + tower.radius + 2; g.player.y = tower.y; g.input.repair = true;
  update(g, 1);
  assert(tower.hp > remoteHp && g.res.stone < remoteStone, 'near repair did not work');
});

check('D83 weapon upgrade is refused outside tower presence and works nearby', () => {
  const g = gameOn(); rich(g); const keep = g.towers[0];
  g.player.x = 10; g.player.y = 10;
  assert(!tryUpgrade(g, keep, 'weapon'), 'remote upgrade accepted');
  g.player.x = keep.x + PLAYER.presenceRadius - 0.1; g.player.y = keep.y;
  assert(tryUpgrade(g, keep, 'weapon'), 'near upgrade refused');
  assert(!tryUpgrade(g, keep, 'extraction'), 'obsolete extraction upgrade accepted');
});

check('D78 far exposed player is not the strategic target', () => {
  const g = gameOn(); const keep = g.towers[0];
  g.player.x = keep.x + 40; g.player.y = keep.y + 20;
  spawnGroupAt(g, keep.x + 15, keep.y, 'runner', 1);
  const e = g.enemies[0]; e.x = keep.x + 15; e.y = keep.y;
  update(g, 0.05);
  assert(Math.hypot(e.x - g.player.x, e.y - g.player.y) > 20, 'precondition: player not far');
  assert(e.targetId === keep.id && e.strategicTargetId === keep.id, 'enemy abandoned Keep at long range');
});

check('D78 Runner diverts within aggro range then returns after leash/range', () => {
  const g = gameOn(); const keep = g.towers[0];
  g.player.x = keep.x + 28; g.player.y = keep.y;
  spawnGroupAt(g, g.player.x - 5, g.player.y, 'runner', 1);
  const e = g.enemies[0]; e.x = g.player.x - 5; e.y = g.player.y;
  update(g, 0.05);
  assert(e.targetId === 'player', 'Runner did not divert');
  g.player.x += 20;
  update(g, 0.05);
  assert(e.targetId === keep.id, 'Runner did not return to Keep field');
});

check('D78 unfinished economic buildings are non-producing, attackable and destructible', () => {
  const map = flatMap(); const g = gameOn(map); rich(g);
  const x = map.start.x + 12.5; const y = map.start.y + 4.5;
  for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) map.fertility[idx(Math.floor(x) + ox, Math.floor(y) + oy)] = 1;
  const farm = buildAt(g, x, y, 'farm');
  const food = g.res.food;
  spawnGroupAt(g, x + 2, y, 'heavy', 1);
  const e = g.enemies[0]; e.x = x + 2; e.y = y; g.player.x = g.towers[0].x; g.player.y = g.towers[0].y;
  const hp = farm.hp;
  update(g, 0.5);
  approx(g.res.food, food, 1e-6, 'unfinished farm produced');
  assert(farm.hp < hp, 'unfinished farm was not attacked');
  farm.hp = 0; update(g, 0.01);
  assert(farm.destroyed, 'unfinished farm was not destructible');
});

check('D78 economy target is local: near building attacked, far building ignored', () => {
  const g = gameOn(); const keep = g.towers[0];
  const near = { id: 1, type: 'farm', x: keep.x + 20, y: keep.y, hp: 100, maxHp: 160, built: true, progress: 1, rate: 0.55, destroyed: false };
  const far = { id: 2, type: 'farm', x: keep.x + 20, y: keep.y + 12, hp: 100, maxHp: 160, built: true, progress: 1, rate: 0.55, destroyed: false };
  g.buildings.push(near, far); g.player.x = keep.x; g.player.y = keep.y;
  spawnGroupAt(g, near.x + 2, near.y, 'swarm', 1);
  const e = g.enemies[0]; e.x = near.x + 2; e.y = near.y;
  update(g, 0.5);
  assert(near.hp < 100, 'near economy building ignored');
  approx(far.hp, 100, 1e-6, 'far economy building attacked');
});

check('D82 blocker field cost is finite and a corridor-blocking tower is attacked', () => {
  const map = flatMap({ corridor: true }); const g = gameOn(map); rich(g); const keep = g.towers[0];
  const tower = buildAt(g, keep.x + 16, keep.y, 'tower');
  tower.built = true; tower.progress = 1; tower.hp = tower.maxHp;
  g.player.x = keep.x; g.player.y = keep.y;
  const field = enemyKeepField(g, 'heavy');
  assert(Number.isFinite(field[idx(Math.floor(keep.x + 24), Math.floor(keep.y))]), 'blocker made field impassable');
  spawnGroupAt(g, keep.x + 23, keep.y, 'heavy', 2);
  for (const [n, e] of g.enemies.entries()) { e.x = keep.x + 22 + n * 0.3; e.y = keep.y; }
  const hp = tower.hp;
  run(g, 5);
  assert(tower.hp < hp, 'blocking tower was not attacked');
});

check('D82 fields stay cached when geometry is unchanged', () => {
  const g = gameOn();
  const first = enemyKeepField(g, 'swarm');
  const count = keepFieldState(g).recomputes;
  for (let i = 0; i < 120; i++) update(g, 1 / 60);
  const second = enemyKeepField(g, 'swarm');
  assert(first === second, 'field object changed without geometry change');
  assert(keepFieldState(g).recomputes === count, 'field recomputed per frame');
});

check('D82 tower geometry invalidates each per-type field exactly once on demand', () => {
  const g = gameOn(); rich(g); const keep = g.towers[0];
  enemyKeepField(g, 'runner'); const before = keepFieldState(g).recomputes;
  buildAt(g, keep.x + 9, keep.y, 'tower');
  enemyKeepField(g, 'runner');
  assert(keepFieldState(g).recomputes === before + 1, 'geometry did not invalidate field once');
  enemyKeepField(g, 'runner');
  assert(keepFieldState(g).recomputes === before + 1, 'cached field recomputed twice');
});

check('D82 break-cost mutation guard: Heavy pays less than Swarm', () => {
  const heavy = WALL_PATH.breakBias * (TOWER.maxHp / ENEMIES.heavy.structDps) * ENEMIES.heavy.speed;
  const swarm = WALL_PATH.breakBias * (TOWER.maxHp / ENEMIES.swarm.structDps) * ENEMIES.swarm.speed;
  assert(Number.isFinite(heavy) && Number.isFinite(swarm) && heavy < swarm / 10, 'per-type break-time cost lost');
});

check('D63/D65/D66 stuck recovery still recovers onto the Keep field', () => {
  const map = flatMap(); const g = gameOn(map); const keep = g.towers[0];
  spawnGroupAt(g, keep.x + 20, keep.y, 'swarm', 1);
  const e = g.enemies[0]; e.x = keep.x + 20.5; e.y = keep.y + 0.5;
  const ex = Math.floor(e.x); const ey = Math.floor(e.y);
  for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) map.kind[idx(ex + ox, ey + oy)] = T.CLIFF;
  g.player.x = 10; g.player.y = 10;
  run(g, 4.5);
  assert(g.stats.stuckRecoveries > 0, 'no recovery recorded');
  assert(PASSABLE[map.kind[idx(Math.floor(e.x), Math.floor(e.y))]], 'enemy remained embedded');
});

check('D79/D80 unexplored resource sites stay hidden from acceptance state', () => {
  const map = flatMap(); const g = gameOn(map);
  const gold = map.goldSites[0];
  assert(!isTileExplored(g, Math.floor(gold.x), Math.floor(gold.y)), 'gold pre-explored');
  assert(!resourceSitesState(g).some((s) => s.id === gold.id), 'unexplored site leaked');
  g.player.x = gold.x; g.player.y = gold.y; update(g, 0.01);
  assert(resourceSitesState(g).some((s) => s.id === gold.id), 'explored site remained hidden');
});

check('D83 pressure rises through budget, Heavies and structure damage, never speed', () => {
  assert(MAP.w === 208 && MAP.h === 104, 'map size mutation');
  assert(playerSpeed(gameOn()) === PLAYER.speed, 'player speed changed');
  assert(ENEMIES.swarm.speed === 3.8 && ENEMIES.runner.speed === 5.8 && ENEMIES.heavy.speed === 1.7, 'enemy speed changed');
  assert(WAVE.totalToSurvive === 10, 'run is not ten waves');
  const budget = (w) => WAVE.budgetBase + WAVE.budgetPerWave * (w - 1) + WAVE.budgetAccel * (w - 1) ** 2;
  assert(budget(10) > budget(5) * 2 && budget(2) - budget(1) < budget(10) - budget(9), 'budget does not accelerate');
  assert(WAVE.structScalePerWave > 0 && WAVE.heavyBiasPerWave > 0.3, 'late structural pressure missing');
  // Early waves are Swarm-led: nothing heavier than a Swarm on wave 1.
  const g = gameOn();
  g.phase = 'prep'; g.phaseLeft = 0; update(g, 0.01);
  assert(g.pendingSpawns.length && g.pendingSpawns.every((s) => s.type === 'swarm'), 'wave 1 is not all Swarm');
  // Later-wave enemies hit structures harder.
  g.wave = 9; g.phase = 'combat'; g.pendingSpawns = [{ type: 'heavy', side: 'east', point: 0, at: 0 }]; g.combatT = 0;
  update(g, 0.01);
  const heavy = g.enemies.find((e) => e.type === 'heavy');
  assert(heavy && heavy.structMult > 1.4 && heavy.speed === undefined && heavy.def.speed === 1.7, 'late Heavy not structurally scaled');
});

check('flow-field obstacle layer remains optional and finite', () => {
  const map = flatMap();
  const seed = idx(map.start.x, map.start.y);
  const base = computeField(map, [seed], 'lane');
  const obstacle = new Float32Array(MAP.w * MAP.h);
  obstacle[idx(map.start.x + 2, map.start.y)] = 100;
  const changed = computeField(map, [seed], 'lane', obstacle);
  const sample = idx(map.start.x + 4, map.start.y);
  assert(Number.isFinite(base[sample]) && Number.isFinite(changed[sample]), 'obstacle became impassable');
  assert(changed[sample] >= base[sample], 'obstacle cost reduced the field');
});

check('read-only building/resource states are detached summaries', () => {
  const g = gameOn();
  const resources = resourceState(g); resources.totals.food = -1;
  assert(g.res.food === START_RESOURCES.food, 'resource state mutated game');
  assert(Array.isArray(buildingState(g)), 'building state missing');
});

// Phase-2 walls, break-cost pathing and wall repair (D81-D83).
runFortress({ check, assert, gameOn, flatMap, rich, run });

// Preserved-system checks (roads, fog, LOS, upgrades, stuck recovery, audio...).
const preserved = runPreserved(maps, SEEDS);
passed += preserved.passed;
failures.push(...preserved.failures);

const sortedTimes = [...generationMs].sort((a, b) => a - b);
console.log(`Generation ms: min ${sortedTimes[0].toFixed(1)}, median ${median(sortedTimes).toFixed(1)}, p90 ${sortedTimes[Math.floor(sortedTimes.length * 0.9)].toFixed(1)}, max ${sortedTimes.at(-1).toFixed(1)}`);

if (failures.length) {
  console.error(`\n${passed} passed, ${failures.length} failed`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`\n${passed} passed, 0 failed`);
}
