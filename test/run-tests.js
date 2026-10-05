// Headless behavioral checks for the frozen D77-D83 phase-1 contract.

import {
  MAP, T, PLAYER, TOWER, KEEP, START_RESOURCES, WALL_PATH,
  ENEMIES, WAVE, PASSABLE, GARRISON, NEST, POPULATION,
} from '../src/config.js';
import {
  generateMap, validateResourceGeography, idx,
} from '../src/terrain.js';
import { computeField } from '../src/flowfield.js';
import { runPreserved } from './preserved-tests.js';
import { runFortress } from './fortress-tests.js';
import { runFirstPerson } from './fp-tests.js';
import { runSight } from './sight-tests.js';
import { runWorld } from './world-tests.js';
import {
  createGame, update, canPlaceAt, tryBuild, tryUpgrade, towerStats,
  spawnGroupAt, isTileExplored, resourceState,
  resourceSitesState, keepState, buildingState, keepFieldState,
  enemyKeepField, flushKeepFieldRecomputes, endState, playerSpeed,
  foodSupport, garrisonState, assignGarrison, assignWorkers, populationState, addNest, nestState, towerCanHitNest, towerMinRange,
  assaultIn, startWaveEarly, setPaused,
} from '../src/game.js';

let passed = 0;
const failures = [];
// TEST_FILTER=<regex> runs only matching checks (and skips the preserved suite
// unless the filter names it) for fast iteration; npm test runs everything.
const FILTER = process.env.TEST_FILTER ? new RegExp(process.env.TEST_FILTER, 'i') : null;

function check(name, fn) {
  if (FILTER && !FILTER.test(name)) return;
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
    // D96: enemies enter only where roads do - one or two mouths per side.
    for (const side of ['west', 'east']) {
      const n = map.spawns[side].length;
      assert(n >= 1 && n <= 2, `${side} has ${n} spawn mouths`);
    }
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

check('D80/D110 Farm requires fertility and adds Food support only once built and staffed', () => {
  const map = flatMap();
  const g = gameOn(map); rich(g);
  const base = foodSupport(g);
  assert(base === POPULATION.keepFoodSupport, `Keep stores feed ${base}`);
  const x = map.start.x + 4.5; const y = map.start.y + 4.5;
  assert(!canPlaceAt(g, x, y, 'farm').ok, 'farm accepted barren ground');
  for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) map.fertility[idx(Math.floor(x) + ox, Math.floor(y) + oy)] = 1;
  const farm = buildAt(g, x, y, 'farm');
  const before = { ...g.res };
  update(g, 0.5);
  assert(foodSupport(g) === base, 'unfinished farm added support');
  run(g, 12);
  assert(farm.built && farm.workers === 1, `built farm auto-staffed (${farm.workers})`);
  assert(foodSupport(g) === base + GARRISON.supportPerFarm, `staffed farm feeds ${foodSupport(g) - base}`);
  assert(assignWorkers(g, farm, -1).ok && foodSupport(g) === base, 'unstaffed farm still feeds');
  assert(!('food' in g.res), 'Food became a stockpile again');
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
  assert(canPlaceAt(steward, s.x, s.y, 'quarry').cost.stone < canPlaceAt(normal, s.x, s.y, 'quarry').cost.stone, 'no Steward discount');
  assert(foodSupport(steward) === foodSupport(normal) + 2, 'Steward does not feed two extra soldiers');
  const a = buildAt(normal, s.x, s.y, 'quarry'); const b = buildAt(steward, s.x, s.y, 'quarry');
  update(normal, 1); update(steward, 1);
  assert(b.progress > a.progress, 'no Steward build-speed bonus');
});

// --- D110 population: workers and garrison are the same people ---------------

function fedGame(farms = 1) {
  const map = flatMap();
  const g = gameOn(map); rich(g);
  for (let k = 0; k < farms; k++) {
    const x = map.start.x - 6.5 - k * 4; const y = map.start.y + 5.5;
    for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) map.fertility[idx(Math.floor(x) + ox, Math.floor(y) + oy)] = 1;
    const farm = buildAt(g, x, y, 'farm');
    farm.built = true; farm.progress = 1; farm.hp = farm.maxHp; farm.workers = 1;
  }
  return g;
}

check('D110 the Keep founds the settlement with free people its stores can feed', () => {
  const g = gameOn();
  const p = populationState(g);
  assert(p.total === POPULATION.start && p.free === POPULATION.start, `start ${JSON.stringify(p)}`);
  assert(p.support >= p.total && !p.shortage, 'founding settlement is fed');
});

check('D110 garrison draws from free people; Keep has 4 slots, a tower 1 (2 at W2)', () => {
  const g = fedGame(0);
  const keep = g.towers[0];
  for (let k = 0; k < GARRISON.slots.keep; k++) assert(assignGarrison(g, keep, 1).ok, `Keep slot ${k} refused`);
  assert(!assignGarrison(g, keep, 1).ok, 'Keep took a fifth soldier');
  const t = buildAt(g, keep.x + 8, keep.y);
  assert(!assignGarrison(g, t, 1).ok, 'unfinished tower garrisoned');
  t.built = true; t.progress = 1;
  assert(assignGarrison(g, t, 1).ok && !assignGarrison(g, t, 1).ok, 'basic tower is not one slot');
  t.wLevel = GARRISON.upgradedFromLevel;
  assert(assignGarrison(g, t, 1).ok, 'W2 tower has no second slot');
  assert(garrisonState(g).assigned === GARRISON.slots.keep + 2, 'assigned count wrong');
  // Every person is now a soldier or free; with no free people nobody else enlists.
  const p = populationState(g);
  assert(p.garrison + p.free === p.total, 'people do not add up');
  g.pop.total = p.garrison;
  t.wLevel = 3; g.towers.push({ ...t, id: 777, garrison: 0 });
  assert(!assignGarrison(g, 777, 1).ok, 'garrisoned with nobody free');
});

check('D110 a worker cannot also garrison: pulling miners into a Tower stops Gold', () => {
  const map = flatMap(); const g = gameOn(map); rich(g);
  const mine = buildAt(g, map.goldSites[0].x, map.goldSites[0].y, 'mine');
  run(g, 16);
  assert(mine.built && mine.workers === 2, `mine staffed ${mine.workers}`);
  const keep = g.towers[0];
  // Occupy free people in the Keep; the rest of the settlement is away.
  while (populationState(g).free > 0 && assignGarrison(g, keep, 1).ok);
  g.pop.total = populationState(g).workers + populationState(g).garrison;
  const full = populationState(g);
  assert(full.free === 0 && full.workers === 2, `pool ${JSON.stringify(full)}`);
  const t = buildAt(g, keep.x + 9, keep.y); t.built = true; t.progress = 1;
  assert(!assignGarrison(g, t, 1).ok, 'a worker garrisoned without leaving work');
  assert(assignWorkers(g, mine, -1).ok && assignWorkers(g, mine, -1).ok, 'could not withdraw miners');
  assert(assignGarrison(g, t, 1).ok, 'freed miner could not garrison');
  const gold = g.res.gold;
  run(g, 3);
  approx(g.res.gold, gold, 1e-9, 'unstaffed mine still produced');
});

check('D110 production scales with workers: Quarry 0 / 50% / 100%', () => {
  const map = flatMap(); const g = gameOn(map); rich(g);
  const q = buildAt(g, map.stoneSites[0].x, map.stoneSites[0].y, 'quarry');
  q.built = true; q.progress = 1; q.hp = q.maxHp;
  const rate = (w) => { q.workers = w; const s = g.res.stone; run(g, 4); return (g.res.stone - s) / 4; };
  approx(rate(0), 0, 1e-9, 'idle quarry produced');
  approx(rate(1), q.rate * 0.5, q.rate * 0.03, 'one worker is not half');
  approx(rate(2), q.rate, q.rate * 0.03, 'two workers are not full');
});

check('D110 people arrive while Food support has room, never beyond it', () => {
  const g = fedGame(1);
  const p0 = populationState(g);
  assert(p0.support === POPULATION.keepFoodSupport + GARRISON.supportPerFarm, `support ${p0.support}`);
  run(g, POPULATION.growthInterval + 0.5);
  assert(g.pop.total === p0.total + 1, `one newcomer (${g.pop.total})`);
  run(g, POPULATION.growthInterval * 6);
  assert(g.pop.total === p0.support, `growth capped at support (${g.pop.total}/${p0.support})`);
});

check('D110 Food Shortage stops growth, has a grace period, then one person leaves at a time', () => {
  const g = fedGame(1);
  g.pop.total = foodSupport(g);
  const keep = g.towers[0];
  for (let k = 0; k < 3; k++) assignGarrison(g, keep, 1);
  const farm = g.buildings[0];
  farm.hp = 0; update(g, 0.05);
  const total = g.pop.total;
  assert(farm.destroyed && populationState(g).shortage, 'no shortage after losing the farm');
  run(g, POPULATION.shortageGrace - 1);
  assert(g.pop.total === total, 'people vanished during the grace period');
  run(g, 1.5);
  assert(g.pop.total === total - 1, `first departure missing (${g.pop.total})`);
  run(g, POPULATION.leaveInterval * 0.5);
  assert(g.pop.total === total - 1, 'left faster than the interval');
  assert(keep.garrison === 3, 'a soldier left while idle people remained');
  g.arch = { ...g.arch, foodSupportBonus: 10 };
  run(g, POPULATION.leaveInterval * 2);
  assert(!populationState(g).shortage && g.pop.total >= total - 1, 'shortage did not clear on recovery');
});

check('D110 a destroyed Tower loses its garrison; a destroyed building frees its workers', () => {
  const map = flatMap(); const g = gameOn(map); rich(g);
  const keep = g.towers[0];
  const t = buildAt(g, keep.x + 9, keep.y); t.built = true; t.progress = 1; t.hp = t.maxHp;
  assignGarrison(g, t, 1);
  const q = buildAt(g, map.stoneSites[0].x, map.stoneSites[0].y, 'quarry');
  run(g, 14);
  assert(q.workers === 2, 'quarry staffed');
  const total = g.pop.total;
  t.hp = -1; update(g, 0.05);
  assert(g.pop.total === total - 1, `garrison survived the collapse (${g.pop.total})`);
  const free = populationState(g).free;
  q.hp = -1; update(g, 0.05);
  assert(populationState(g).free === free + 2 && g.pop.total === total - 1, 'workers did not return to the free pool');
});

check('D91 garrison raises damage and fire rate but never min range', () => {
  const g = fedGame(1);
  const keep = g.towers[0];
  const before = towerStats(g, keep);
  const minBefore = towerMinRange(g, keep);
  assignGarrison(g, keep, 1); assignGarrison(g, keep, 1);
  const after = towerStats(g, keep);
  approx(after.damage / before.damage, 1 + 2 * GARRISON.damagePerSoldier, 1e-9, 'damage bonus');
  approx(after.fireRate / before.fireRate, 1 + 2 * GARRISON.fireRatePerSoldier, 1e-9, 'fire-rate bonus');
  approx(towerMinRange(g, keep), minBefore, 1e-12, 'garrison changed min range');
});

// --- D92 nests ---------------------------------------------------------------

function nestGame() {
  const map = flatMap();
  const g = gameOn(map); rich(g);
  const n = addNest(g, map.start.x + 40.5, map.start.y + 0.5);
  flushKeepFieldRecomputes(g);
  return { g, n };
}

check('D92 a nest sleeps until the player enters its territory, then spawns defenders', () => {
  const { g, n } = nestGame();
  run(g, 5);
  assert(n.state === 'dormant' && !g.enemies.some((e) => e.wild), 'dormant nest spawned');
  g.player.x = n.x - NEST.territory + 1; g.player.y = n.y;
  run(g, NEST.spawnInterval + 1.5);
  assert(n.state === 'agitated', 'nest did not agitate');
  assert(g.enemies.some((e) => e.wild && e.nestId === n.id), 'agitated nest spawned no ferals');
});

check('D92 a tower can hit a nest only inside its annulus', () => {
  const { g, n } = nestGame();
  g.fog.visible.fill(1);
  const at = (d) => ({ id: 999, x: n.x - d, y: n.y, built: true, keep: false, wLevel: 0, radius: TOWER.radius });
  assert(!towerCanHitNest(g, at(TOWER.weapon.minRange - 0.2), n), 'fired inside the blind spot');
  assert(towerCanHitNest(g, at(TOWER.weapon.minRange + 1), n), 'could not fire inside the annulus');
  assert(!towerCanHitNest(g, at(TOWER.weapon.range + n.radius + 0.5), n), 'fired beyond max range');
  g.fog.visible.fill(0);
  assert(!towerCanHitNest(g, at(TOWER.weapon.minRange + 1), n), 'fired at an unseen nest');
});

check('D92 ferals never hold a wave open and never march on the Keep', () => {
  const { g, n } = nestGame();
  g.player.hp = g.player.maxHp = 1e9; // the ferals must not end the run
  g.player.x = n.x - 4; g.player.y = n.y;
  run(g, NEST.spawnInterval * 2);
  const feral = g.enemies.find((e) => e.wild);
  assert(feral, 'no feral to test');
  g.player.x = g.towers[0].x; g.player.y = g.towers[0].y + 2;
  g.phase = 'combat'; g.pendingSpawns = []; g.combatT = 0;
  update(g, 0.05);
  assert(g.phase === 'aftermath', 'ferals held the wave open');
  run(g, 8);
  assert(g.enemies.filter((e) => e.wild).every((e) => Math.hypot(e.x - n.x, e.y - n.y) <= NEST.territory + NEST.leash + 1),
    'a feral left its territory');
});

check('D92 a destroyed nest stops spawning, frees its ground and pays a modest reward', () => {
  const { g, n } = nestGame();
  g.player.hp = g.player.maxHp = 1e9;
  g.player.x = n.x - 4; g.player.y = n.y;
  run(g, 2);
  const stone = g.res.stone; const gold = g.res.gold;
  const version = keepFieldState(g).blockerVersion;
  n.hp = 1; g.fog.visible.fill(1);
  g.player.x = n.x - n.radius - 0.8; g.player.facing = { x: 1, y: 0 }; g.player.meleeCd = 0;
  g.input = { mx: 0, my: 0, melee: true, repair: false };
  update(g, 0.05);
  g.input = { mx: 0, my: 0, melee: false, repair: false };
  assert(n.destroyed, 'nest survived a killing blow');
  approx(g.res.stone - stone, NEST.reward.stone, 1, 'Stone reward'); approx(g.res.gold - gold, NEST.reward.gold, 1, 'Gold reward');
  assert(keepFieldState(g).blockerVersion > version, 'nest removal did not invalidate fields');
  run(g, NEST.feralFadeSeconds + 1);
  run(g, NEST.spawnInterval * 3);
  assert(!g.enemies.some((e) => e.nestId === n.id), 'destroyed nest still has or spawns ferals');
  assert(nestState(g)[0].state === 'destroyed', 'nest state not destroyed');
});

check('D92 generated nests guard valuable sites, far from the Keep and unexplored at start', () => {
  for (const map of maps) {
    const g = createGame('NESTCHK', 'gunner', map);
    const nests = g.nests;
    assert(nests.length >= 3 && nests.length <= NEST.countMax, `${nests.length} nests`);
    for (const n of nests) {
      const d = Math.hypot(n.x - map.start.x - 0.5, n.y - map.start.y - 0.5);
      assert(d >= NEST.minFromKeep, `nest ${d.toFixed(1)} tiles from the Keep`);
      const site = [...map.stoneSites, ...map.goldSites].find((s) => s.id === n.guards);
      assert(site && Math.hypot(site.x - n.x, site.y - n.y) <= NEST.siteOffsetMax + 1.5, 'nest is not by its site');
      assert(!map.road[idx(Math.floor(n.x), Math.floor(n.y))], 'nest on a road');
      assert(!isTileExplored(g, Math.floor(n.x), Math.floor(n.y)), 'nest revealed at start');
    }
  }
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
  const support = foodSupport(g);
  spawnGroupAt(g, x + 2, y, 'heavy', 1);
  const e = g.enemies[0]; e.x = x + 2; e.y = y; g.player.x = g.towers[0].x; g.player.y = g.towers[0].y;
  const hp = farm.hp;
  update(g, 0.5);
  assert(foodSupport(g) === support, 'unfinished farm fed soldiers');
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

check('D90 tower geometry defers and coalesces each cached field rebuild', () => {
  const g = gameOn(); rich(g); const keep = g.towers[0];
  const old = enemyKeepField(g, 'runner'); const before = keepFieldState(g).recomputes;
  buildAt(g, keep.x + 9, keep.y, 'tower');
  assert(enemyKeepField(g, 'runner') === old, 'dirty geometry discarded the previous field immediately');
  assert(keepFieldState(g).recomputes === before, 'geometry rebuilt the field synchronously');
  flushKeepFieldRecomputes(g);
  const rebuilt = enemyKeepField(g, 'runner');
  assert(rebuilt !== old && keepFieldState(g).recomputes === before + 1, 'flush did not rebuild the cached type once');
  assert(enemyKeepField(g, 'runner') === rebuilt && keepFieldState(g).recomputes === before + 1,
    'clean cached field recomputed twice');
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

check('D97 expansion totals include the 15-second warning and assaults start automatically', () => {
  const first = createGame('D97-FIRST', 'gunner', flatMap());
  approx(assaultIn(first), 120, 1e-9, 'wave 1 does not begin at 120 seconds');
  assert(first.spawnSides.length && first.pendingSpawns.length, 'wave 1 direction/spawns were not rolled at expansion start');
  run(first, 105, 0.05);
  assert(first.phase === 'warning' && Math.abs(assaultIn(first) - 15) < 0.06, 'warning did not begin at 15 seconds');
  run(first, 15.1, 0.05);
  assert(first.phase === 'combat', 'combat did not begin automatically at zero');

  const later = gameOn();
  later.phase = 'aftermath'; later.phaseLeft = WAVE.aftermath; later.wave = 1;
  run(later, WAVE.aftermath + 0.05, 0.05);
  assert(later.wave === 2 && later.phase === 'prep', 'aftermath did not advance to wave 2 expansion');
  approx(assaultIn(later), 90, 0.06, 'later expansion is not 90 seconds total');
  assert(later.spawnSides.length && later.pendingSpawns.length, 'later wave was not rolled at expansion start');
  run(later, 75, 0.05);
  assert(later.phase === 'warning' && Math.abs(assaultIn(later) - 15) < 0.06, 'later prep did not last 75 seconds');
});

check('D97 Start Next Wave readiness works and rejects invalid states', () => {
  const prep = createGame('D97-EARLY-PREP', 'gunner', flatMap());
  assert(startWaveEarly(prep).ok && prep.phase === 'warning' && assaultIn(prep) <= 4, 'early start failed in prep');
  run(prep, 4.1, 0.05);
  assert(prep.phase === 'combat', 'early prep start did not reach combat within 4 seconds');

  const warning = createGame('D97-EARLY-WARN', 'gunner', flatMap());
  warning.phase = 'warning'; warning.phaseLeft = 12;
  assert(startWaveEarly(warning).ok && assaultIn(warning) === 4, 'early start failed in warning');
  for (const phase of ['combat', 'aftermath']) {
    const g = gameOn(); g.phase = phase;
    assert(!startWaveEarly(g).ok, `early start accepted during ${phase}`);
  }
  const paused = gameOn(); setPaused(paused, true);
  assert(!startWaveEarly(paused).ok, 'early start accepted while paused');
  for (const status of ['won', 'lost']) {
    const g = gameOn(); g.status = status;
    assert(!startWaveEarly(g).ok, `early start accepted after ${status}`);
  }
});

check('D97 expansion income accrues and pause freezes every phase clock and income', () => {
  const g = createGame('D97-INCOME', 'gunner', flatMap());
  g.buildings.push(
    { id: 91, type: 'quarry', x: 20, y: 20, hp: 100, maxHp: 100, built: true, destroyed: false, rate: 0.5, workers: 2 },
    { id: 92, type: 'mine', x: 22, y: 20, hp: 100, maxHp: 100, built: true, destroyed: false, rate: 0.2, workers: 2 },
  );
  const before = { ...g.res };
  run(g, 2, 0.05);
  assert(g.res.stone > before.stone && g.res.gold > before.gold, 'passive income stopped during expansion');
  for (const [phase, left] of [['prep', 30], ['warning', 10], ['aftermath', 3]]) {
    g.phase = phase; g.phaseLeft = left;
    setPaused(g, true);
    const frozen = { left: g.phaseLeft, stone: g.res.stone, gold: g.res.gold };
    update(g, 5);
    assert(g.phaseLeft === frozen.left && g.res.stone === frozen.stone && g.res.gold === frozen.gold,
      `pause advanced ${phase} or passive income`);
    setPaused(g, false);
  }
});

check('D97 distant player does not delay the scheduled assault or Keep march', () => {
  const g = createGame('D97-FAR', 'gunner', flatMap());
  const keep = g.towers[0]; keep.shotCd = 1e9;
  g.player.x = keep.x + 60; g.player.y = keep.y + 30;
  run(g, 122, 0.05);
  assert(g.phase === 'combat' && g.enemies.length, 'far player delayed scheduled spawning');
  const enemy = g.enemies[0];
  const before = Math.hypot(enemy.x - keep.x, enemy.y - keep.y);
  run(g, 1, 0.05);
  assert(Math.hypot(enemy.x - keep.x, enemy.y - keep.y) < before, 'wave enemy did not path toward the Keep');
});

check('D97 victory and defeat stop all later wave scheduling', () => {
  const won = gameOn();
  won.wave = WAVE.totalToSurvive; won.phase = 'aftermath'; won.phaseLeft = 0;
  update(won, 0.01);
  assert(won.status === 'won', 'final aftermath did not produce victory');
  const wonState = [won.wave, won.phase, won.phaseLeft];
  update(won, 300);
  assert(JSON.stringify([won.wave, won.phase, won.phaseLeft]) === JSON.stringify(wonState), 'victory scheduled another wave');

  const lost = gameOn(); lost.player.hp = -100; update(lost, 0.01);
  assert(lost.status === 'lost', 'defeat precondition failed');
  const lostState = [lost.wave, lost.phase, lost.phaseLeft];
  update(lost, 300);
  assert(JSON.stringify([lost.wave, lost.phase, lost.phaseLeft]) === JSON.stringify(lostState), 'defeat advanced wave scheduling');
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
  const resources = resourceState(g); resources.totals.stone = -1;
  assert(g.res.stone === START_RESOURCES.stone, 'resource state mutated game');
  assert(Array.isArray(buildingState(g)), 'building state missing');
});

// Phase-2 walls, break-cost pathing and wall repair (D81-D83).
runFortress({ check, assert, gameOn, flatMap, rich, run });

// D101 first-person shell: 3D-space math and the sim rules it selects.
runFirstPerson({ check, assert, gameOn, flatMap, rich, run, maps, seeds: SEEDS });

// D109 first-person Tower sight and firing.
runSight({ check, assert, gameOn, flatMap, rich, run });

// D111-D113 unannounced assaults, the garrison bell, weather and the crossbow.
runWorld({ check, assert, gameOn, flatMap, rich, run });

// Preserved-system checks (roads, fog, LOS, upgrades, stuck recovery, audio...).
const preserved = FILTER && !FILTER.test('preserved') ? { passed: 0, failures: [] } : runPreserved(maps, SEEDS);
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
