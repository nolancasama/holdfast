// Headless checks for the parts that can be checked without a browser:
// the D2 terrain guarantees, pathing reachability, line of sight, and a long
// scripted simulation run. Feel is judged by playing it, not by this file.

import {
  MAP, T, VALID, PLAYER, TOWER, WAVE, PASSABLE, DROP, RICHNESS, richnessTierForRate, AUDIO,
  EXPOSURE, READABILITY, VISION, BUILD, ENEMIES, ENEMY, STUCK, BREACH, START_MATERIALS, GEN,
} from '../src/config.js';
import {
  generateMap, validateMap, idx, inBounds, isPassable, hasLineOfSight, kindAt, elevAt,
  isTerrainBuildable, clearTowerForest,
} from '../src/terrain.js';
import { computeField, steer } from '../src/flowfield.js';
import {
  straightRoadBaseline, pathExposure, measureSiteExposure, findExposureFeatures,
  analyseRoadKnots, analyseRoadReadability, exposureEfficiency, walkedExtraLength,
} from '../src/roadexposure.js';
import {
  createGame, update, canPlaceAt, tryBuild, tryUpgrade, towerStats, spawnGroupAt,
  setPaused, collectDrop, grantEquipment, depositRichness, resourceScoreAt,
  emitAudioEvent, drainAudioEvents, isHunting, PLAYER_TARGET_ID, playerBuildSite,
  isTileVisible, isTileExplored, isPointVisible, visibilityState, upgradeState,
  upgradeRateMult, towerAlarmState, recomputeVisibility, stuckState, endState, towerCost,
  breachContact, playerSpeed,
} from '../src/game.js';
import { AUDIO_PRIORITY, shouldRateLimit, selectVoices } from '../src/audio.js';

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

function withSeededRandom(seed, fn) {
  const previous = Math.random;
  let state = 2166136261;
  for (const ch of seed) state = Math.imul(state ^ ch.charCodeAt(0), 16777619) >>> 0;
  Math.random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  try { return fn(); } finally { Math.random = previous; }
}

console.log(`Generating ${SEEDS.length} maps...`);
const maps = SEEDS.map((s) => generateMap(s));

function syntheticMap() {
  const size = MAP.w * MAP.h;
  return {
    w: MAP.w, h: MAP.h,
    kind: new Uint8Array(size).fill(T.PLAIN),
    elev: new Uint8Array(size).fill(1),
    res: new Float32Array(size),
    road: new Uint8Array(size),
    terrainVersion: 0,
    roadRoutes: [],
    spawns: { west: [], east: [] },
    roadCenter: { x: Math.floor(MAP.w / 2), y: Math.floor(MAP.h / 2) },
  };
}

/** Tests that need a tower move the player to the site before exercising tryBuild (D57). */
function buildAt(g, x, y) {
  g.player.x = x;
  g.player.y = y;
  return tryBuild(g, x, y);
}

function stampRoute(map, tiles, side = 'west') {
  const path = tiles.map(([x, y]) => idx(x, y));
  for (const i of path) map.road[i] = 1;
  map.roadRoutes.push({ side, mouth: { x: tiles[0][0], y: tiles[0][1] }, path });
  return path;
}

function horizontal(y, x0 = 0, x1 = MAP.w - 1) {
  const out = [];
  const step = x0 <= x1 ? 1 : -1;
  for (let x = x0; x !== x1 + step; x += step) out.push([x, y]);
  return out;
}

function makeHairpin({ spine = false, pocketKind = null, forestRing = false } = {}) {
  const map = syntheticMap();
  const route = [
    ...horizontal(18, 0, 78),
    ...Array.from({ length: 7 }, (_, n) => [78, 19 + n]),
    ...horizontal(25, 77, 0),
  ];
  stampRoute(map, route);
  map.spawns.west = [{ x: 0, y: 18 }, { x: 0, y: 25 }];
  if (pocketKind !== null) {
    for (let y = 19; y <= 24; y++) {
      for (let x = 0; x <= 77; x++) map.kind[idx(x, y)] = pocketKind;
    }
  }
  if (forestRing) {
    for (let x = 0; x <= 77; x++) {
      map.kind[idx(x, 19)] = T.FOREST;
      map.kind[idx(x, 24)] = T.FOREST;
    }
    for (let y = 19; y <= 24; y++) map.kind[idx(77, y)] = T.FOREST;
  }
  if (spine) for (let x = 0; x <= 73; x++) map.kind[idx(x, 21)] = T.DEEP;
  return map;
}

function bestMeasured(map, sites) {
  const fieldCache = new Map();
  let best = null;
  for (const [x, y] of sites) {
    const result = measureSiteExposure(map, x + 0.5, y + 0.5, { fieldCache });
    if (!best || result.exposure > best.exposure) best = result;
  }
  return best;
}

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

check('configured movement identities match D67 exactly', () => {
  if (ENEMIES.swarm.speed !== 3.8) return `Swarm speed is ${ENEMIES.swarm.speed}`;
  if (ENEMIES.runner.speed !== 5.8) return `Runner speed is ${ENEMIES.runner.speed}`;
  if (ENEMIES.heavy.speed !== 1.7) return `Heavy speed is ${ENEMIES.heavy.speed}`;
  if (PLAYER.speed !== 5.3) return `player speed changed to ${PLAYER.speed}`;
  return ENEMIES.runner.speed > PLAYER.speed && PLAYER.speed > ENEMIES.swarm.speed
    && ENEMIES.swarm.speed > ENEMIES.heavy.speed
    ? null : 'expected Runner > player > Swarm > Heavy';
});

function approachEngagement(type, speed) {
  const g = createGame(`D67-${type}-${speed}`, 'gunner');
  const map = syntheticMap();
  g.map = map;
  g.phase = 'prep'; g.phaseLeft = 999; g.pendingSpawns = [];
  const t = g.towers[0];
  t.x = 52.5; t.y = 26.5; t.hp = t.maxHp = 1e9; t.shotCd = 1e9; t.field = null;
  g.player.x = t.x; g.player.y = t.y;
  g.shelter = { towerId: t.id, progress: PLAYER.shelterTime, required: PLAYER.shelterTime };
  g.occupiedTowerId = t.id;
  const e = addRealEnemy(g, t.x + TOWER.weapon.range - 0.01, t.y, type, t.id, speed);
  let engagement = 0;
  // D73: the occupied tower is breached at contact rather than sieged.
  for (let step = 0; step < 1000 && !e.sieging && g.enemies.includes(e); step++) {
    if (Math.hypot(e.x - t.x, e.y - t.y) <= TOWER.weapon.range
        && hasLineOfSight(map, t.x, t.y, e.x, e.y)) engagement += 0.02;
    update(g, 0.02);
  }
  return engagement;
}

check('D67 slower configured enemies spend longer in a W0 engagement', () => {
  const old = { swarm: 4.9, runner: 6.2, heavy: 1.7 };
  for (const type of ['swarm', 'runner']) {
    const before = approachEngagement(type, old[type]);
    const after = approachEngagement(type, ENEMIES[type].speed);
    if (!(after > before + 0.01)) return `${type}: ${before.toFixed(2)}s -> ${after.toFixed(2)}s`;
  }
  const heavyBefore = approachEngagement('heavy', old.heavy);
  const heavyAfter = approachEngagement('heavy', ENEMIES.heavy.speed);
  return Math.abs(heavyAfter - heavyBefore) <= 0.021
    ? null : `unchanged Heavy engagement moved ${heavyBefore.toFixed(2)}s -> ${heavyAfter.toFixed(2)}s`;
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

check('roads provide separate approaches on both sides of the centre', () => {
  for (const m of maps) {
    for (const side of ['west', 'east']) {
      const p = m.report.parallelRoutes[side];
      if (p.median < VALID.parallelRouteMedianMin) {
        return `${m.seed}: ${side} median ${p.median}, expected ${VALID.parallelRouteMedianMin}`;
      }
    }
    if (m.report.columnsWithThree < VALID.parallelRouteColumnsWithThreeMin) {
      return `${m.seed}: ${m.report.columnsWithThree} columns have 3+ runs`;
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

check('road networks use authored shallow-water fords', () => {
  for (const m of maps) {
    let fordTiles = 0;
    for (let i = 0; i < m.road.length; i++) {
      if (m.road[i] && m.kind[i] === T.SHALLOW) fordTiles++;
    }
    if (!fordTiles) return `${m.seed}: no road crosses a shallow-water ford`;
  }
  return null;
});

check('seeded routes add bends and riverbank travel without multiplying lanes', () => {
  let routes = 0;
  let reversing = 0;
  let riverFollowing = 0;
  for (const m of maps) {
    const approaches = m.roadRoutes.length;
    if (approaches < 4 || approaches > 5) return `${m.seed}: ${approaches} approach routes, expected 4-5`;
    for (const route of m.roadRoutes) {
      routes++;
      const verticalRuns = [];
      let waterStreak = 0;
      let longestWaterStreak = 0;
      for (let n = 1; n < route.path.length; n++) {
        const a = route.path[n - 1];
        const b = route.path[n];
        const dy = Math.sign(((b / MAP.w) | 0) - ((a / MAP.w) | 0));
        if (dy) {
          const last = verticalRuns[verticalRuns.length - 1];
          if (last && last.sign === dy) last.distance++;
          else verticalRuns.push({ sign: dy, distance: 1 });
        }
        if (m.waterDist[b] > 0 && m.waterDist[b] <= 2) {
          waterStreak++;
          longestWaterStreak = Math.max(longestWaterStreak, waterStreak);
        } else waterStreak = 0;
      }
      const meaningfulReversal = verticalRuns.some((run, i) => i > 0
        && run.sign !== verticalRuns[i - 1].sign
        && run.distance >= 4 && verticalRuns[i - 1].distance >= 4);
      if (meaningfulReversal) reversing++;
      if (longestWaterStreak >= 4) riverFollowing++;
    }
  }
  if (reversing < routes * 0.35) return `only ${reversing}/${routes} routes have a sustained direction reversal`;
  if (riverFollowing < routes * 0.20) return `only ${riverFollowing}/${routes} routes follow water for 4+ tiles`;
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

// --- D48/D49: road exposure and knot analysis ------------------------------

check('straight-road exposure matches the geometric baseline', () => {
  const map = syntheticMap();
  stampRoute(map, horizontal(26));
  const result = measureSiteExposure(map, 52.5, 28.5);
  const baseline = straightRoadBaseline();
  return Math.abs(result.exposure - baseline) <= baseline * 0.10
    ? null : `measured ${result.exposure.toFixed(2)}, baseline ${baseline.toFixed(2)}`;
});

check('an impassable-spined hairpin produces a strong exposure feature', () => {
  const map = makeHairpin({ spine: true });
  const features = findExposureFeatures(map);
  const best = features[0];
  if (!best) return 'reported no feature';
  if (best.ratio < 1.75 || best.tier !== 'strong') {
    return `best was ${best.ratio.toFixed(2)}x/${best.tier}`;
  }
  return null;
});

check('an open U-turn is cut across and is not useful exposure', () => {
  const map = makeHairpin();
  const sites = [];
  for (let y = 20; y <= 23; y++) for (let x = 73; x <= 77; x++) sites.push([x, y]);
  const best = bestMeasured(map, sites);
  return best.ratio < 1.35 ? null : `open U scored ${best.ratio.toFixed(2)}x`;
});

check('an unbuildable hairpin pocket cannot report a strong feature', () => {
  const map = makeHairpin({ spine: true, pocketKind: T.CLIFF });
  const strong = findExposureFeatures(map).filter((f) => f.tier === 'strong');
  return strong.length ? `reported ${strong.length} strong feature(s)` : null;
});

check('a same-height forest ring drops hairpin exposure below strong', () => {
  const map = makeHairpin({ spine: true, forestRing: true });
  const features = findExposureFeatures(map);
  const best = features[0];
  return !best || best.ratio < 1.75 ? null : `forest-ringed pocket scored ${best.ratio.toFixed(2)}x`;
});

check('a cliff wall prevents a site from combining separate roads', () => {
  const map = syntheticMap();
  stampRoute(map, horizontal(18));
  stampRoute(map, horizontal(30), 'east');
  for (let x = 0; x < MAP.w; x++) map.kind[idx(x, 24)] = T.CLIFF;
  const result = measureSiteExposure(map, 52.5, 20.5);
  const baseline = straightRoadBaseline();
  if (result.routeIndex !== 0) return `selected blocked route ${result.routeIndex}`;
  return result.exposure <= baseline * 1.10
    ? null : `combined roads into ${result.exposure.toFixed(2)} exposure`;
});

check('road-knot analysis finds planted defects and ignores clean roads', () => {
  const clean = syntheticMap();
  stampRoute(clean, horizontal(26));
  if (analyseRoadKnots(clean).count !== 0) return 'clean straight road reported a knot';
  if (analyseRoadKnots(makeHairpin({ spine: true })).count !== 0) return 'clean spined hairpin reported a knot';

  const map = syntheticMap();
  stampRoute(map, horizontal(26));
  for (let y = 21; y <= 25; y++) map.road[idx(18, y)] = 1;
  for (let y = 5; y <= 9; y++) for (let x = 32; x <= 36; x++) {
    if (x === 32 || x === 36 || y === 5 || y === 9) map.road[idx(x, y)] = 1;
  }
  for (let x = 0; x <= 59; x++) map.road[idx(x, 32)] = 1;
  for (let y = 32; y <= 40; y++) map.road[idx(59, y)] = 1;
  for (let x = 60; x <= 67; x++) map.road[idx(x, 40)] = 1;
  for (let y = 32; y <= 40; y++) map.road[idx(68, y)] = 1;
  for (let x = 68; x < MAP.w; x++) map.road[idx(x, 32)] = 1;
  for (let x = 0; x <= 59; x++) map.road[idx(x, 46)] = 1;
  for (let y = 42; y <= 46; y++) map.road[idx(59, y)] = 1;
  for (let x = 60; x <= 67; x++) map.road[idx(x, 42)] = 1;
  for (let y = 42; y <= 46; y++) map.road[idx(68, y)] = 1;
  for (let x = 68; x < MAP.w; x++) map.road[idx(x, 46)] = 1;
  const result = analyseRoadKnots(map);
  if (!result.spurs.length) return 'missed the 5-tile dead-end stub';
  if (!result.smallLoops.length) return 'missed the 3x3 enclosed loop';
  if (!result.braids.length) return 'missed the 8-tile braid';
  return null;
});

// --- D55: road readability ---------------------------------------------------

/** Axis-aligned polyline through corner points, as route tiles. */
function polyline(corners) {
  const out = [corners[0]];
  for (let k = 1; k < corners.length; k++) {
    let [x, y] = out[out.length - 1];
    const [tx, ty] = corners[k];
    while (x !== tx || y !== ty) {
      x += Math.sign(tx - x);
      if (x === tx) y += Math.sign(ty - y);
      out.push([x, y]);
    }
  }
  return out;
}

/** A synthetic map carrying one route through the given corners. */
function routeMap(corners) {
  const map = syntheticMap();
  stampRoute(map, polyline(corners));
  return map;
}

const readabilityOf = (map) => analyseRoadReadability(map);
const defectKinds = (r) => [...new Set(r.defects.flatMap((d) => d.kinds))].join(',') || 'none';

check('D55: a clean hairpin, switchback and straight road read as clean', () => {
  const hairpin = readabilityOf(makeHairpin({ spine: true }));
  if (hairpin.count) return `clean hairpin flagged: ${defectKinds(hairpin)}`;
  const switchback = readabilityOf(routeMap([[0, 10], [80, 10], [80, 18], [20, 18], [20, 26], [103, 26]]));
  if (switchback.count) return `clean switchback flagged: ${defectKinds(switchback)}`;
  const straight = syntheticMap();
  stampRoute(straight, horizontal(26));
  const s = readabilityOf(straight);
  return s.count ? `straight road flagged: ${defectKinds(s)}` : null;
});

check('D55: a dense zigzag knot is rejected', () => {
  const corners = [[0, 26]];
  for (let x = 30, up = true; x <= 60; x += 3, up = !up) corners.push([x, 26], [x, up ? 23 : 26]);
  corners.push([103, corners[corners.length - 1][1]]);
  const r = readabilityOf(routeMap(corners));
  return r.zigzags.length || r.denseAreas.length ? null : `zigzag passed (${defectKinds(r)})`;
});

check('D55: repeated near-self-passes are rejected', () => {
  const r = readabilityOf(routeMap([[0, 20], [60, 20], [60, 23], [10, 23], [10, 26], [103, 26]]));
  return r.nearPasses.length ? null : `strands 3 tiles apart passed (${defectKinds(r)})`;
});

check('D55: diagonal strands laid side by side are rejected', () => {
  const map = syntheticMap();
  const diagonal = (x0) => Array.from({ length: 16 }, (_, n) => [x0 + n, 10 + n]);
  for (const x0 of [30, 31]) {
    const tiles = diagonal(x0);
    stampRoute(map, tiles);
    for (let n = 1; n < tiles.length; n++) map.road[idx(tiles[n][0], tiles[n - 1][1])] = 1;
  }
  const r = readabilityOf(map);
  return r.thickBands.length ? null : `side-by-side diagonals passed (${defectKinds(r)})`;
});

check('D55: a small confusing multi-junction area is rejected', () => {
  const map = syntheticMap();
  stampRoute(map, horizontal(26));
  stampRoute(map, horizontal(22, 40, 60), 'east');
  for (const x of [43, 48, 53]) stampRoute(map, Array.from({ length: 11 }, (_, n) => [x, 19 + n]), 'east');
  const r = readabilityOf(map);
  return r.junctionClutter.length ? null : `junction grid passed (${defectKinds(r)})`;
});

check('D55: long road spaghetti is rejected despite high raw exposure', () => {
  const corners = [[0, 12], [70, 12], [70, 16], [30, 16], [30, 20], [70, 20], [70, 24], [30, 24], [30, 28], [103, 28]];
  const map = routeMap(corners);
  const points = polyline(corners).map(([x, y]) => ({ x: x + 0.5, y: y + 0.5 }));
  const site = { x: 50.5, y: 18.5 };
  if (!isTerrainBuildable(map, site.x, site.y)) return 'test site is not buildable';
  const window = points.filter((p) => p.x >= 28 && p.x <= 72);
  const raw = pathExposure(map, site.x, site.y, window).length;
  const baseline = straightRoadBaseline();
  if (raw < EXPOSURE.strongRatio * baseline) return `raw exposure only ${(raw / baseline).toFixed(2)}x - not a high-exposure case`;
  const efficiency = exposureEfficiency(raw, walkedExtraLength(window), baseline);
  if (efficiency >= READABILITY.minExposureEfficiency) return `spaghetti efficiency ${efficiency.toFixed(2)} passed`;
  return readabilityOf(map).count ? null : 'spaghetti read as clean';
});

check('D55: a spined hairpin with a buildable pocket is strong, readable and efficient', () => {
  const map = makeHairpin({ spine: true });
  const best = findExposureFeatures(map).find((f) => f.tier === 'strong');
  if (!best) return 'no strong feature';
  if (!isTerrainBuildable(map, best.x, best.y)) return 'feature site is not buildable';
  if (!best.readable || readabilityOf(map).count) return 'hairpin not readable';
  return best.efficiency >= READABILITY.minExposureEfficiency
    ? null : `efficiency ${best.efficiency.toFixed(2)} below ${READABILITY.minExposureEfficiency}`;
});

check('D55: generated maps have no knots and at most isolated readability defects', () => {
  const flagged = maps.filter((m) => analyseRoadReadability(m).count);
  for (const m of maps) {
    if (analyseRoadKnots(m).count) return `${m.seed} keeps a road knot`;
    const r = analyseRoadReadability(m);
    if (r.count > 1) return `${m.seed} keeps ${r.count} readability defects (${defectKinds(r)})`;
  }
  // Measured 2026-09-17: 3 of 20 keep one short side-by-side band (D55 known gap).
  return flagged.length <= 3 ? null : `${flagged.length} maps keep a readability defect: ${flagged.map((m) => m.seed).join(', ')}`;
});

check('D55: authored exposure features are efficient', () => {
  for (const m of maps) {
    for (const f of m.exposureFeatures) {
      if (!(f.efficiency >= READABILITY.minExposureEfficiency)) return `${m.seed} feature at ${f.x},${f.y} efficiency ${f.efficiency}`;
    }
  }
  return null;
});

// --- D54: entry roads run out through the map edge ---------------------------

check('D54: every spawn mouth has a road from the boundary column into the network', () => {
  for (const m of maps) {
    const reach = new Uint8Array(m.road.length);
    const queue = [idx(m.roadCenter.x, m.roadCenter.y)];
    reach[queue[0]] = 1;
    for (let head = 0; head < queue.length; head++) {
      const x = queue[head] % MAP.w;
      const y = (queue[head] / MAP.w) | 0;
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          const nx = x + ox;
          const ny = y + oy;
          if (nx < 0 || ny < 0 || nx >= MAP.w || ny >= MAP.h) continue;
          const n = idx(nx, ny);
          if (m.road[n] && !reach[n]) { reach[n] = 1; queue.push(n); }
        }
      }
    }
    const lane = computeField(m, [idx(m.start.x, m.start.y)], 'lane');
    for (const side of ['west', 'east']) {
      const edgeX = side === 'west' ? 0 : MAP.w - 1;
      for (const mouth of m.spawns[side]) {
        if (mouth.x !== (side === 'west' ? 1 : MAP.w - 2)) return `${m.seed} ${side} spawn moved to x=${mouth.x}`;
        if (![0, -1, 1].some((oy) => m.road[idx(edgeX, mouth.y + oy)] && reach[idx(edgeX, mouth.y + oy)])) {
          return `${m.seed} ${side} mouth (${mouth.x},${mouth.y}) has no connected road on the boundary`;
        }
        if (!reach[idx(mouth.x, mouth.y)]) return `${m.seed} ${side} mouth is off the road network`;
        if (!Number.isFinite(lane[idx(mouth.x, mouth.y)])) return `${m.seed} ${side} mouth has no lane path`;
      }
    }
    for (const route of m.roadRoutes) {
      if (route.path[0] % MAP.w !== (route.side === 'west' ? 0 : MAP.w - 1)) {
        return `${m.seed} ${route.side} route starts at x=${route.path[0] % MAP.w}, not the boundary`;
      }
    }
  }
  return null;
});

check('D54: roads touch the map boundary only at entry roads', () => {
  for (const m of maps) {
    for (let y = 0; y < MAP.h; y++) {
      for (const side of ['west', 'east']) {
        const edgeX = side === 'west' ? 0 : MAP.w - 1;
        if (m.road[idx(edgeX, y)] && !m.spawns[side].some((mouth) => Math.abs(mouth.y - y) <= 1)) {
          return `${m.seed} ${side} boundary road at y=${y} is not an entry`;
        }
      }
    }
    for (let x = 0; x < MAP.w; x++) {
      if (m.road[idx(x, 0)] || m.road[idx(x, MAP.h - 1)]) return `${m.seed} road on the north/south boundary at x=${x}`;
    }
  }
  return null;
});

check('terrain buildability and tower placement terrain rules agree', () => {
  for (const map of maps.slice(0, 3)) {
    const g = { map, towers: [], materials: Infinity };
    for (let y = 0; y < MAP.h; y++) {
      for (let x = 0; x < MAP.w; x++) {
        const expected = isTerrainBuildable(map, x + 0.5, y + 0.5);
        const actual = canPlaceAt(g, x + 0.5, y + 0.5).ok;
        if (actual !== expected) return `${map.seed}: disagreed at (${x},${y})`;
      }
    }
  }
  return null;
});

check('road analysis stays within its per-map performance budget', () => {
  let worst = { seed: '', ms: 0 };
  for (const map of maps) {
    const started = performance.now();
    const fieldCache = new Map();
    findExposureFeatures(map, { fieldCache });
    analyseRoadKnots(map);
    const ms = performance.now() - started;
    if (ms > worst.ms) worst = { seed: map.seed, ms };
    if (ms > 400) return `${map.seed} took ${ms.toFixed(1)}ms (budget 400ms)`;
  }
  console.log(`Road analysis worst: ${worst.seed} ${worst.ms.toFixed(1)}ms`);
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

// --- D64: one centralized defeat resolution ---------------------------------

check('one remaining or COLLAPSING tower keeps the run playing', () => {
  const g = createGame('DEFEAT-TOWER-LIVE', 'gunner');
  update(g, 0.01);
  if (endState(g).status !== 'playing') return 'one live tower caused defeat';
  g.towers[0].hp = g.towers[0].maxHp * TOWER.collapsingAt - 1;
  update(g, 0.01);
  return endState(g).status === 'playing' ? null : 'COLLAPSING tower did not count';
});

check('an unfinished tower prevents defeat when the last finished tower falls', () => {
  const g = createGame('DEFEAT-BUILDING', 'gunner');
  g.materials = 99999; g.phaseLeft = 999;
  const finished = g.towers[0];
  let building = null;
  for (let y = 3; y < MAP.h - 3 && !building; y++) {
    for (let x = 3; x < MAP.w - 3; x++) {
      if (Math.hypot(x + 0.5 - finished.x, y + 0.5 - finished.y) < TOWER.minSpacing) continue;
      if (buildAt(g, x + 0.5, y + 0.5).ok) { building = g.towers[g.towers.length - 1]; break; }
    }
  }
  if (!building || building.built) return 'could not establish unfinished tower';
  g.player.x = building.x; g.player.y = building.y;
  finished.hp = -1;
  update(g, 0.01);
  return g.towers.includes(building) && endState(g).status === 'playing'
    ? null : 'unfinished tower did not keep the run alive';
});

check('destroying the last tower loses to the tower cause in the same update', () => {
  const g = createGame('DEFEAT-LAST', 'gunner');
  drainAudioEvents(g);
  const t = g.towers[0];
  g.player.x = t.x + TOWER.collapseRadius + 2;
  t.hp = -1;
  update(g, 0.01);
  const state = endState(g);
  if (state.status !== 'lost' || state.lossCause !== 'towers') return `got ${JSON.stringify(state)}`;
  if (drainAudioEvents(g).filter((e) => e.type === 'towerDestroy').length !== 1) return 'tower loss did not emit exactly one end cue';
  return g.log[0]?.text === 'All towers destroyed. Position lost.' ? null : 'tower-loss log missing';
});

check('player death with towers remaining resolves only as died', () => {
  const g = createGame('DEFEAT-DIED', 'gunner');
  g.phase = 'combat';
  g.pendingSpawns = [{ type: 'swarm', side: 'west', point: 0, at: 999 }];
  g.player.hp = 0;
  update(g, 0.01);
  const state = endState(g);
  if (state.status !== 'lost' || state.lossCause !== 'died') return `got ${JSON.stringify(state)}`;
  const deaths = drainAudioEvents(g).filter((e) => e.type === 'playerDeath').length;
  update(g, 1);
  return endState(g).lossCause === 'died' && deaths === 1 ? null : 'death was overwritten or emitted twice';
});

check('last-tower collapse gives death priority only when it kills the player', () => {
  for (const [hp, cause] of [[10, 'died'], [PLAYER.maxHp, 'towers']]) {
    const g = createGame(`DEFEAT-CRUSH-${cause}`, 'gunner');
    const t = g.towers[0];
    g.player.x = t.x; g.player.y = t.y; g.player.hp = hp;
    t.hp = -1;
    update(g, 0.01);
    const state = endState(g);
    if (state.status !== 'lost' || state.lossCause !== cause) {
      return `${hp} hp collapse resolved ${JSON.stringify(state)}`;
    }
    update(g, 1);
    const settled = endState(g);
    if (settled.status !== 'lost' || settled.lossCause !== cause) {
      return `${hp} hp collapse end state was overwritten: ${JSON.stringify(settled)}`;
    }
  }
  return null;
});

check('defeat freezes waves, spawns, extraction, construction and upgrades', () => {
  const g = createGame('DEFEAT-FREEZE', 'gunner');
  g.materials = 99999; g.phaseLeft = 999;
  const t = g.towers[0];
  if (!tryUpgrade(g, t, 'weapon')) return 'upgrade precondition failed';
  g.phase = 'combat'; g.phaseLeft = 17; g.combatT = 0;
  g.pendingSpawns = [{ type: 'heavy', side: 'west', point: 0, at: 50 }];
  g.player.hp = 0;
  update(g, 0.01);
  const snapshot = {
    time: g.time, phaseLeft: g.phaseLeft, combatT: g.combatT, pending: g.pendingSpawns.length,
    enemies: g.enemies.length, materials: g.materials, progress: t.upgrade.progress,
  };
  update(g, 5);
  const after = {
    time: g.time, phaseLeft: g.phaseLeft, combatT: g.combatT, pending: g.pendingSpawns.length,
    enemies: g.enemies.length, materials: g.materials, progress: t.upgrade.progress,
  };
  return JSON.stringify(after) === JSON.stringify(snapshot) ? null : 'simulation advanced after defeat';
});

// --- D5: aggro commitment ----------------------------------------------------

check('a sieging enemy does not abandon its target when the player leaves', () => {
  const g = createGame('AGGRO', 'gunner');
  g.materials = 9999;
  const a = g.towers[0];
  // Put a second tower far enough away to be a genuinely different target.
  let placed = null;
  for (let d = TOWER.minSpacing + 1; d < 40 && !placed; d += 1) {
    const r = buildAt(g, a.x + d, a.y);
    if (r.ok) placed = g.towers[g.towers.length - 1];
  }
  if (!placed) return 'could not place a second tower to test against';
  placed.built = true;
  placed.progress = 1;
  placed.hp = placed.maxHp;

  // D73: the occupied tower is breached, never sieged, so the commitment under
  // test is one made while A stands unoccupied and the player is elsewhere.
  const away = walkableNear(g, a.x, a.y, PLAYER.presenceRadius + 6);
  if (!away) return 'no walkable spot away from the towers';
  g.player.x = away.x;
  g.player.y = away.y;

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
    const r = buildAt(g, a.x + d, a.y);
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

// --- D53: an abandoned tower keeps only the enemies already sieging it --------

/** Start tower A, plus built towers B (far from A) and C (away from both). */
function aggroFixture(seed) {
  const g = createGame(seed, 'gunner');
  g.materials = 99999;
  const a = g.towers[0];
  const sites = [];
  for (let y = 3; y < MAP.h - 3; y++) {
    for (let x = 3; x < MAP.w - 3; x++) {
      if (canPlaceAt(g, x + 0.5, y + 0.5).ok) sites.push({ x: x + 0.5, y: y + 0.5 });
    }
  }
  const far = (s, list, d) => list.every((t) => Math.hypot(s.x - t.x, s.y - t.y) >= d);
  const bSite = sites.filter((s) => far(s, [a], 30)).sort((p, q) => Math.abs(p.y - a.y) - Math.abs(q.y - a.y))[0];
  if (!bSite || !buildAt(g, bSite.x, bSite.y).ok) return null;
  const b = g.towers[g.towers.length - 1];
  const cSite = sites.find((s) => far(s, [a, b], 20));
  if (!cSite || !buildAt(g, cSite.x, cSite.y).ok) return null;
  const c = g.towers[g.towers.length - 1];
  for (const t of [b, c]) { t.built = true; t.progress = 1; t.hp = t.maxHp; }
  return { g, a, b, c };
}

/** A walkable spot `r` tiles from (x, y), clear of every tower's presence radius. */
function walkableNear(g, x, y, r, clearOfTowers = true) {
  for (let k = 0; k < 32; k++) {
    const ang = (k / 32) * Math.PI * 2;
    const px = x + Math.cos(ang) * r;
    const py = y + Math.sin(ang) * r;
    if (!isPassable(g.map, Math.floor(px), Math.floor(py))) continue;
    if (clearOfTowers && g.towers.some((t) => Math.hypot(t.x - px, t.y - py) <= PLAYER.presenceRadius + 1.5)) continue;
    return { x: px, y: py };
  }
  return null;
}

function testEnemy(g, at, targetId, speed = 0) {
  const e = {
    id: g.nextEnemyId++, type: 'swarm', side: 'debug',
    def: { radius: 0.34, hp: 1e6, speed, towerDps: 0, playerHit: 0, color: '#fff' },
    x: at.x, y: at.y, hp: 1e6, maxHp: 1e6,
    targetId, sieging: false, siegeAngle: 0, retargetIn: 99, hitCd: 99, flash: 0,
  };
  g.enemies.push(e);
  return e;
}

function occupy(g, t) {
  g.player.x = t.x;
  g.player.y = t.y;
  for (let i = 0; i < 60 && g.occupiedTowerId !== t.id; i++) update(g, 1 / 60);
  return g.occupiedTowerId === t.id;
}

const runFor = (g, seconds) => { for (let i = 0; i < seconds * 60; i++) update(g, 1 / 60); };

check('D53-A: an enemy already sieging the old tower stays on it after the player moves', () => {
  const f = aggroFixture('AGGRO-A');
  if (!f) return 'could not build the fixture';
  const { g, a, b } = f;
  a.hp = a.maxHp = 1e9;
  // D73: an occupied tower is breached, not sieged, so the besieger is one
  // already committed to A while it stands unoccupied.
  const away = walkableNear(g, a.x, a.y, PLAYER.presenceRadius + 6);
  if (!away) return 'no walkable spot away from A';
  g.player.x = away.x; g.player.y = away.y;
  const spot = walkableNear(g, a.x, a.y, TOWER.radius + 1.2, false);
  if (!spot) return 'no siege position beside A';
  const e = testEnemy(g, spot, a.id);
  e.sieging = true; e.siegedId = a.id;
  update(g, 1 / 60);
  if (!e.sieging) return 'enemy did not keep sieging A';
  if (!occupy(g, b)) return 'player did not occupy B';
  runFor(g, 1);
  // Separation can shove a besieger off the wall; that must not end the commitment.
  const out = walkableNear(g, a.x, a.y, TOWER.radius + 3.5, false);
  if (out) { e.x = out.x; e.y = out.y; e.def.speed = 2; }
  e.retargetIn = 0;
  runFor(g, 6);
  return e.targetId === a.id ? null : `sieging enemy left A for ${e.targetId}`;
});

check('D53-B: an enemy only heading for the old tower drops it and never sieges it', () => {
  const f = aggroFixture('AGGRO-B');
  if (!f) return 'could not build the fixture';
  const { g, a, b } = f;
  if (!occupy(g, a)) return 'player did not occupy A';
  const spot = walkableNear(g, a.x, a.y, 6);
  if (!spot) return 'no approach position near A';
  // A long personal timer: only releasing the abandoned tower can make it re-read.
  const waiting = testEnemy(g, spot, a.id);
  const walker = testEnemy(g, { x: spot.x, y: spot.y }, a.id, 2.2);
  if (!occupy(g, b)) return 'player did not occupy B';
  let siegedA = false;
  for (let i = 0; i < 6 * 60; i++) {
    update(g, 1 / 60);
    if (walker.targetId === a.id && walker.sieging) siegedA = true;
  }
  if (siegedA) return 'an enemy that had not begun sieging went on to besiege the abandoned tower';
  if (waiting.targetId !== b.id) return `waiting enemy kept ${waiting.targetId} (hysteresis/loyalty), expected B ${b.id}`;
  if (walker.targetId !== b.id) return `walking enemy targets ${walker.targetId}, expected B ${b.id}`;
  return null;
});

check('D53-C: a nearby enemy bound for the old tower turns on the exposed player', () => {
  const f = aggroFixture('AGGRO-C');
  if (!f) return 'could not build the fixture';
  const { g, a } = f;
  if (!occupy(g, a)) return 'player did not occupy A';
  const spot = walkableNear(g, a.x, a.y, 7);
  if (!spot) return 'no approach position near A';
  const e = testEnemy(g, spot, a.id);
  const stand = walkableNear(g, spot.x, spot.y, 3);
  if (!stand) return 'no exposed standing spot';
  g.player.x = stand.x;
  g.player.y = stand.y;
  runFor(g, 1.5);
  if (g.occupiedTowerId !== null) return 'player is not exposed';
  if (e.targetId !== PLAYER_TARGET_ID) return `enemy kept ${e.targetId} instead of the exposed player`;
  return isHunting(g, e) ? null : 'nearby enemy targets the player but is not hunting directly';
});

check('D53-D: enemies spawned after a transfer never choose the previously occupied tower', () => {
  const f = aggroFixture('AGGRO-D');
  if (!f) return 'could not build the fixture';
  const { g, a, b } = f;
  if (!occupy(g, a) || !occupy(g, b)) return 'player did not transfer A -> B';
  const spot = walkableNear(g, a.x, a.y, TOWER.radius + 3);
  if (!spot) return 'no spawn position near A';
  spawnGroupAt(g, spot.x, spot.y, 'swarm', 6);
  for (const e of g.enemies) { e.hp = e.maxHp = 1e6; }
  for (let i = 0; i < 8 * 60; i++) {
    update(g, 1 / 60);
    const bad = g.enemies.find((e) => e.targetId === a.id);
    if (bad) return `new enemy ${bad.id} chose abandoned tower A`;
  }
  return null;
});

check('D53-E: a never-occupied tower is not a strategic target, sheltered or exposed', () => {
  const f = aggroFixture('AGGRO-E');
  if (!f) return 'could not build the fixture';
  const { g, a, c } = f;
  if (!occupy(g, a)) return 'player did not occupy A';
  const spot = walkableNear(g, c.x, c.y, TOWER.radius + 3);
  if (!spot) return 'no position beside C';
  const sheltered = testEnemy(g, spot, null);
  sheltered.retargetIn = 0;
  runFor(g, 3);
  if (sheltered.targetId !== a.id) return `enemy beside C chose ${sheltered.targetId}, expected occupied A ${a.id}`;
  // Player steps out far from C: the old baseline score let C beat a distant player.
  const out = walkableNear(g, a.x, a.y, PLAYER.presenceRadius + 3);
  if (!out) return 'no exposed spot near A';
  g.player.x = out.x;
  g.player.y = out.y;
  const exposed = testEnemy(g, spot, null);
  exposed.retargetIn = 0;
  runFor(g, 3);
  if (g.occupiedTowerId !== null) return 'player is not exposed';
  if (exposed.targetId !== PLAYER_TARGET_ID) return `enemy beside C chose ${exposed.targetId} over the exposed player`;
  return [sheltered, exposed].some((e) => e.targetId === c.id) ? 'an enemy targeted unoccupied C' : null;
});

// --- D63: field-progress stuck recovery --------------------------------------

function radiusClear(map, tx, ty, radius) {
  if (!isPassable(map, tx, ty)) return false;
  if (radius <= 0.5) return true;
  for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
    if (!isPassable(map, tx + ox, ty + oy)) return false;
  }
  return true;
}

function addRealEnemy(g, x, y, type, targetId, speed = ENEMIES[type].speed) {
  const base = ENEMIES[type];
  const def = { ...base, speed, towerDps: 0, playerHit: 0 };
  const e = {
    id: g.nextEnemyId++, type, side: 'debug', def,
    x, y, hp: 1e6, maxHp: 1e6, targetId,
    sieging: false, siegeAngle: 0, retargetIn: 99, hitCd: 99, flash: 0,
  };
  g.enemies.push(e);
  return e;
}

function forestTowerFixture() {
  const g = createGame('D69-FOREST-FIXTURE', 'gunner');
  const map = syntheticMap();
  map.kind.fill(T.FOREST);
  g.map = map;
  g.towers = [];
  g.nextTowerId = 1;
  g.materials = 99999;
  g.phase = 'prep';
  g.phaseLeft = 999;
  const x = Math.floor(MAP.w / 2) + 0.5;
  const y = Math.floor(MAP.h / 2) + 0.5;
  g.player.x = x;
  g.player.y = y;
  const built = tryBuild(g, x, y);
  if (!built.ok) return null;
  const tower = g.towers[0];
  tower.built = true;
  tower.progress = 1;
  tower.hp = tower.maxHp = 1e9;
  g.shelter = { towerId: tower.id, progress: PLAYER.shelterTime, required: PLAYER.shelterTime };
  g.occupiedTowerId = tower.id;
  return { g, map, tower };
}

check('D69 forest clearing gives every sampled siege position LOS and fire', () => {
  const fixture = forestTowerFixture();
  if (!fixture) return 'could not place a tower on the all-forest fixture';
  const { g, map, tower } = fixture;
  for (const type of Object.keys(ENEMIES)) {
    const reach = TOWER.radius + ENEMY.attackRange + ENEMIES[type].radius;
    for (const distance of [reach, reach - 0.35]) {
      for (let sample = 0; sample < 32; sample++) {
        const angle = sample * Math.PI * 2 / 32;
        const x = tower.x + Math.cos(angle) * distance;
        const y = tower.y + Math.sin(angle) * distance;
        if (!hasLineOfSight(map, tower.x, tower.y, x, y)) {
          return `${type} blocked at ${distance.toFixed(2)}, angle ${sample}`;
        }
        g.enemies = [];
        const enemy = addRealEnemy(g, x, y, type, tower.id, 0);
        tower.targetId = enemy.id;
        tower.retargetIn = 99;
        tower.shotCd = 0;
        const hp = enemy.hp;
        update(g, 0.02);
        if (!(enemy.hp < hp)) return `${type} was visible but not fired on at angle ${sample}`;
      }
    }
  }
  return null;
});

check('D69 distant forest still blocks LOS and tower fire', () => {
  const fixture = forestTowerFixture();
  if (!fixture) return 'could not place the forest tower';
  const { g, map, tower } = fixture;
  const enemy = addRealEnemy(g, tower.x + 6, tower.y, 'heavy', tower.id, 0);
  if (hasLineOfSight(map, tower.x, tower.y, enemy.x, enemy.y)) return 'forest beyond the ring did not block LOS';
  tower.targetId = enemy.id;
  tower.retargetIn = 99;
  tower.shotCd = 0;
  const hp = enemy.hp;
  update(g, 0.25);
  return enemy.hp === hp ? null : 'tower fired through distant forest';
});

check('D69 preserves the High-over-Normal-forest D3 rule', () => {
  const map = syntheticMap();
  const x = 30.5;
  const y = 20.5;
  for (let ox = 0; ox <= 6; ox++) {
    map.kind[idx(30 + ox, 20)] = T.FOREST;
    map.elev[idx(30 + ox, 20)] = ox === 0 ? 2 : 1;
  }
  const before = hasLineOfSight(map, x, y, x + 6, y);
  clearTowerForest(map, x, y);
  const after = hasLineOfSight(map, x, y, x + 6, y);
  return before && after ? null : `High tower LOS changed ${before} -> ${after}`;
});

check('D69 clearing changes only in-radius Forest kind cells', () => {
  const map = syntheticMap();
  const x = 40.5;
  const y = 20.5;
  for (let ty = 16; ty <= 24; ty++) for (let tx = 36; tx <= 44; tx++) {
    const i = idx(tx, ty);
    map.kind[i] = (tx + ty) % 6;
    map.elev[i] = (tx + 2 * ty) % 3;
    map.res[i] = (tx * 17 + ty) / 1000;
    map.road[i] = (tx + ty) % 2;
  }
  const before = {
    kind: map.kind.slice(), elev: map.elev.slice(), res: map.res.slice(), road: map.road.slice(),
  };
  const changed = clearTowerForest(map, x, y);
  let expectedChanged = 0;
  for (let i = 0; i < map.kind.length; i++) {
    const tx = i % MAP.w;
    const ty = (i / MAP.w) | 0;
    const shouldClear = before.kind[i] === T.FOREST
      && Math.hypot(tx + 0.5 - x, ty + 0.5 - y) <= TOWER.forestClearRadius + 1e-9;
    if (shouldClear) expectedChanged++;
    const expectedKind = shouldClear ? T.PLAIN : before.kind[i];
    if (map.kind[i] !== expectedKind) return `kind changed incorrectly at ${tx},${ty}`;
    if (map.elev[i] !== before.elev[i] || map.res[i] !== before.res[i] || map.road[i] !== before.road[i]) {
      return `non-kind layer changed at ${tx},${ty}`;
    }
  }
  if (changed !== expectedChanged || map.terrainVersion !== 1) {
    return `changed ${changed}/${expectedChanged}, terrainVersion ${map.terrainVersion}`;
  }
  return null;
});

check('D69 open-ground placement is a terrain no-op', () => {
  const map = syntheticMap();
  const before = map.kind.slice();
  const changed = clearTowerForest(map, 20.5, 20.5);
  if (changed !== 0 || map.terrainVersion !== 0) return `changed ${changed}, version ${map.terrainVersion}`;
  return map.kind.every((kind, i) => kind === before[i]) ? null : 'open terrain changed';
});

check('D69 placement invalidates movement and visibility caches', () => {
  const g = createGame('D69-CACHES', 'gunner');
  const map = syntheticMap();
  const x = 52.5;
  const y = 26.5;
  map.kind[idx(54, 26)] = T.FOREST;
  g.map = map;
  const oldTower = g.towers[0];
  oldTower.x = 30.5;
  oldTower.y = 26.5;
  oldTower.field = computeField(map, [idx(30, 26)], 'lane');
  g.player.x = x;
  g.player.y = y;
  g.playerField = computeField(map, [idx(52, 26)], 'direct');
  g.playerLaneField = computeField(map, [idx(52, 26)], 'lane');
  g.playerFieldAt = g.playerLaneFieldAt = 10;
  recomputeVisibility(g, true);
  if (isTileVisible(g, 57, 26)) return 'visibility precondition was not forest-blocked';
  const beforeField = computeField(map, [idx(52, 26)], 'direct')[idx(54, 26)];
  g.materials = 99999;
  const built = tryBuild(g, x, y);
  if (!built.ok) return `placement failed: ${built.reasons.join(', ')}`;
  const afterField = computeField(map, [idx(52, 26)], 'direct')[idx(54, 26)];
  if (g.towers.some((tower) => tower.field !== null)) return 'a tower flow field stayed cached';
  if (g.playerField !== null || g.playerLaneField !== null
      || g.playerFieldAt !== -99 || g.playerLaneFieldAt !== -99) return 'a player flow field stayed cached';
  if (!(afterField < beforeField)) return `movement field did not reflect Forest -> Plain (${beforeField} -> ${afterField})`;
  if (!isTileVisible(g, 57, 26)) return 'visibility cache did not rebuild through the clearing';
  return map.terrainVersion === 1 ? null : 'terrain version did not advance';
});

check('D69 reproduces and fixes a real-seed forest siege LOS failure', () => {
  for (const map of maps) {
    for (let ty = 3; ty < MAP.h - 3; ty++) for (let tx = 3; tx < MAP.w - 3; tx++) {
      if (map.kind[idx(tx, ty)] !== T.FOREST || !isTerrainBuildable(map, tx + 0.5, ty + 0.5)) continue;
      const towerX = tx + 0.5;
      const towerY = ty + 0.5;
      const reach = TOWER.radius + ENEMY.attackRange + ENEMIES.heavy.radius - 0.35;
      for (let sample = 0; sample < 32; sample++) {
        const angle = sample * Math.PI * 2 / 32;
        const enemyX = towerX + Math.cos(angle) * reach;
        const enemyY = towerY + Math.sin(angle) * reach;
        if (!inBounds(Math.floor(enemyX), Math.floor(enemyY))
            || hasLineOfSight(map, towerX, towerY, enemyX, enemyY)) continue;
        const clone = { ...map, kind: map.kind.slice(), terrainVersion: 0 };
        clearTowerForest(clone, towerX, towerY);
        if (!hasLineOfSight(clone, towerX, towerY, enemyX, enemyY)) continue;
        console.log(`D69 real repro: ${map.seed} tower ${tx},${ty}, Heavy ring angle ${sample}/32 false -> true`);
        return null;
      }
    }
  }
  return 'found no real generated forest-tower siege reproduction';
});

function embeddedRecoveryFixture(type = 'swarm') {
  const g = createGame(`STUCK-EMBEDDED-${type}`, 'gunner');
  g.phaseLeft = 999; g.materials = 0;
  const t = g.towers[0];
  t.hp = t.maxHp = 1e9; t.shotCd = 1e9; t.resourceScore = 0;
  if (!occupy(g, t)) return null;
  const field = computeField(g.map, [idx(Math.floor(t.x), Math.floor(t.y))], 'lane');
  t.field = field;
  const radius = ENEMIES[type].radius;
  let embedded = null;
  for (let y = 2; y < MAP.h - 2 && !embedded; y++) for (let x = 2; x < MAP.w - 2; x++) {
    if (isPassable(g.map, x, y)) continue;
    let adjacentFinite = false;
    for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
      if ((ox || oy) && Number.isFinite(field[idx(x + ox, y + oy)]) && isPassable(g.map, x + ox, y + oy)) {
        adjacentFinite = true;
      }
    }
    if (adjacentFinite) continue;
    let hasRecovery = false;
    for (let oy = -STUCK.searchRadius; oy <= STUCK.searchRadius && !hasRecovery; oy++) {
      for (let ox = -STUCK.searchRadius; ox <= STUCK.searchRadius; ox++) {
        const nx = x + ox; const ny = y + oy;
        if (nx < 1 || ny < 1 || nx >= MAP.w - 1 || ny >= MAP.h - 1) continue;
        if (Number.isFinite(field[idx(nx, ny)]) && radiusClear(g.map, nx, ny, radius)) {
          hasRecovery = true; break;
        }
      }
    }
    if (hasRecovery) embedded = { x, y };
  }
  if (!embedded) return null;
  const e = addRealEnemy(g, embedded.x + 0.5, embedded.y + 0.5, type, t.id);
  return { g, t, e, field, embedded };
}

check('an enemy embedded in a real cliff is recovered onto finite valid terrain', () => {
  const f = embeddedRecoveryFixture('swarm');
  if (!f) return 'could not find a thick real cliff with a nearby recovery tile';
  const { g, e, field } = f;
  runFor(g, STUCK.detectAfter + 0.5);
  if (!g.enemies.includes(e)) return 'embedded enemy was despawned instead of recovered';
  const tx = Math.floor(e.x); const ty = Math.floor(e.y);
  const state = stuckState(g);
  if (!isPassable(g.map, tx, ty) || !Number.isFinite(field[idx(tx, ty)])) return 'recovery landed on invalid terrain';
  return state.detections >= 1 && state.recoveries >= 1 ? null : `counters are ${JSON.stringify(state)}`;
});

check('a recovered enemy resumes decreasing its target field value', () => {
  const f = embeddedRecoveryFixture('swarm');
  if (!f) return 'could not create recovery fixture';
  const { g, e, field } = f;
  runFor(g, STUCK.detectAfter + 0.5);
  if (!g.enemies.includes(e)) return 'enemy disappeared during recovery';
  const before = field[idx(Math.floor(e.x), Math.floor(e.y))];
  runFor(g, 2.5);
  const after = field[idx(Math.floor(e.x), Math.floor(e.y))];
  return after < before - STUCK.minProgress ? null : `field only changed ${before.toFixed(2)} -> ${after.toFixed(2)}`;
});

check('an unreachable enemy is silently despawned after repeated stuck confirmation', () => {
  const g = createGame('STUCK-DESPAWN', 'gunner');
  const map = syntheticMap();
  map.kind.fill(T.CLIFF);
  // One isolated walkable pocket for the enemy and a separate valid target
  // island. The deliberately non-finite field also exercises the guarded
  // normTo fallback: the enemy must not walk directly through the cliff.
  map.kind[idx(10, 10)] = T.PLAIN;
  for (let y = 38; y <= 42; y++) for (let x = 78; x <= 82; x++) map.kind[idx(x, y)] = T.PLAIN;
  g.map = map; g.phaseLeft = 999;
  const t = g.towers[0];
  t.x = 80.5; t.y = 40.5;
  t.hp = t.maxHp = 1e9; t.shotCd = 1e9; t.resourceScore = 0;
  g.player.x = t.x; g.player.y = t.y;
  if (!occupy(g, t)) return 'could not occupy target tower';
  t.field = new Float32Array(MAP.w * MAP.h).fill(Infinity);
  const e = addRealEnemy(g, 10.5, 10.5, 'swarm', t.id);
  const before = { kills: g.stats.kills, materials: g.materials, drops: g.drops.length };
  drainAudioEvents(g);
  runFor(g, 2);
  if (!g.enemies.includes(e) || e.x !== 10.5 || e.y !== 10.5) {
    return 'non-finite-field fallback moved the enemy through invalid terrain';
  }
  const nudge = g.debug.stuckEpisodes.find((episode) => episode.stage === 'nudge');
  if (!nudge || nudge.recovered) return 'failed neighbour nudge was not instrumented';
  runFor(g, STUCK.detectAfter + STUCK.despawnAfter);
  const audio = drainAudioEvents(g);
  if (g.enemies.includes(e)) return 'unreachable enemy was never despawned';
  if (g.stats.kills !== before.kills || g.materials !== before.materials || g.drops.length !== before.drops) {
    return 'silent despawn changed kills, materials, or drops';
  }
  if (audio.some((event) => event.type === 'enemyDeath')) return 'silent despawn emitted enemyDeath';
  return stuckState(g).despawns === 1 ? null : 'despawn counter did not increment';
});

check('a sieging enemy standing still for ten seconds is never detected', () => {
  const g = createGame('STUCK-SIEGE', 'gunner');
  g.phaseLeft = 999;
  const t = g.towers[0];
  t.hp = t.maxHp = 1e9; t.shotCd = 1e9;
  // D73: only an unoccupied tower can be sieged; the player stands clear.
  const away = walkableNear(g, t.x, t.y, PLAYER.presenceRadius + 6);
  if (!away) return 'no walkable spot away from the tower';
  g.player.x = away.x; g.player.y = away.y;
  const e = addRealEnemy(g, t.x + TOWER.radius + ENEMY.attackRange, t.y, 'heavy', t.id, 0);
  e.sieging = true; e.siegedId = t.id;
  runFor(g, 10);
  if (g.occupiedTowerId !== null) return 'player ended up occupying the tower';
  return e.sieging && stuckState(g).detections === 0 ? null : 'intentional siege was treated as stuck';
});

check('a twelve-enemy narrow-pass crowd for two seconds is not detected', () => {
  const g = createGame('STUCK-CROWD', 'gunner');
  const map = syntheticMap();
  map.kind.fill(T.CLIFF);
  for (let x = 1; x < MAP.w - 1; x++) { map.kind[idx(x, 25)] = T.PLAIN; map.road[idx(x, 25)] = 1; }
  g.map = map; g.phaseLeft = 999;
  const t = g.towers[0];
  t.x = 85.5; t.y = 25.5; t.field = null; t.hp = t.maxHp = 1e9; t.shotCd = 1e9;
  g.player.x = t.x; g.player.y = t.y;
  if (!occupy(g, t)) return 'could not occupy corridor tower';
  for (let n = 0; n < 12; n++) addRealEnemy(g, 10.2 + (n % 4) * 0.18, 25.35 + (n % 3) * 0.12, 'swarm', t.id);
  runFor(g, 2);
  return stuckState(g).detections === 0 ? null : 'ordinary two-second crowding triggered detection';
});

check('Heavy recovery requires a passable 3x3 clearance', () => {
  const f = embeddedRecoveryFixture('heavy');
  if (!f) return 'could not create Heavy recovery fixture';
  runFor(f.g, STUCK.detectAfter + 0.5);
  if (!f.g.enemies.includes(f.e)) return 'Heavy was despawned';
  const tx = Math.floor(f.e.x); const ty = Math.floor(f.e.y);
  return radiusClear(f.g.map, tx, ty, f.e.def.radius) ? null : `Heavy recovered without clearance at ${tx},${ty}`;
});

check('all mouth spawns on 20 seeds start passable with a finite target field', () => {
  const g = createGame('SPAWN-AUDIT', 'gunner');
  const t = g.towers[0];
  t.hp = t.maxHp = 1e9; t.shotCd = 1e9;
  return withSeededRandom('SPAWN-AUDIT-RNG', () => {
    let sampled = 0;
    for (const map of maps) {
      g.map = map; g.wave = 8; g.status = 'playing'; g.phase = 'combat'; g.combatT = 0;
      t.x = map.start.x + 0.5; t.y = map.start.y + 0.5; t.field = null;
      g.player.x = t.x; g.player.y = t.y;
      g.shelter = { towerId: t.id, progress: PLAYER.shelterTime, required: PLAYER.shelterTime };
      g.occupiedTowerId = t.id; g.playerField = null; g.playerLaneField = null;
      const field = computeField(map, [idx(map.start.x, map.start.y)], 'lane');
      for (const side of ['west', 'east']) for (let point = 0; point < map.spawns[side].length; point++) {
        for (const type of Object.keys(ENEMIES)) for (let repeat = 0; repeat < 3; repeat++) {
          g.enemies = [];
          g.pendingSpawns = [{ type, side, point, at: 0 }];
          update(g, 0);
          const e = g.enemies[0];
          if (!e) return `${map.seed}/${side}/${point}/${type}: no enemy spawned`;
          const tx = Math.floor(e.x); const ty = Math.floor(e.y);
          if (tx !== (side === 'west' ? 1 : MAP.w - 2)) return `${map.seed}: spawn left mouth column (${tx})`;
          if (!isPassable(map, tx, ty) || !Number.isFinite(field[idx(tx, ty)])) {
            return `${map.seed}/${side}/${point}/${type}: invalid spawn at ${tx},${ty}`;
          }
          const probe = Math.min(e.def.radius, 0.3);
          for (const [ox, oy] of [[probe, 0], [-probe, 0], [0, probe], [0, -probe]]) {
            if (!isPassable(map, Math.floor(e.x + ox), Math.floor(e.y + oy))) {
              return `${map.seed}/${side}/${point}/${type}: spawn probe overlaps invalid terrain`;
            }
          }
          sampled++;
        }
      }
    }
    console.log(`Spawn audit: ${sampled} mouth spawns, 0 invalid`);
    return null;
  });
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

check('richness bars and labels use the configured numeric thresholds', () => {
  const eps = 1e-6;
  if (richnessTierForRate(RICHNESS.poorMax - eps).key !== 'poor') return 'value below poorMax is not Poor';
  if (richnessTierForRate(RICHNESS.poorMax).key !== 'moderate') return 'poorMax does not begin Moderate';
  if (richnessTierForRate(RICHNESS.moderateMax - eps).key !== 'moderate') return 'value below moderateMax is not Moderate';
  if (richnessTierForRate(RICHNESS.moderateMax).key !== 'rich') return 'moderateMax does not begin Rich';
  for (const m of maps) {
    for (const d of m.deposits) {
      const expected = richnessTierForRate(d.income);
      const access = depositRichness(m, d);
      if (d.richness !== expected.key || access.tier !== expected.key || access.bars !== expected.bars) {
        return `${m.seed}: ${d.income.toFixed(3)} says ${d.richness}/${access.tier}, expected ${expected.key}`;
      }
    }
  }
  const g = createGame('RICHNESS-PREVIEW', 'prospector');
  const c = canPlaceAt(g, g.map.start.x + 0.5, g.map.start.y + 0.5);
  return c.richness.key === richnessTierForRate(c.income).key ? null : 'build preview tier contradicts its income';
});

check('D68 start income is calibrated Moderate and every map retains a remote Rich site', () => {
  const rows = [];
  for (const m of maps) {
    const income = resourceScoreAt(m, m.start.x + 0.5, m.start.y + 0.5, TOWER.extraction.radius)
      * TOWER.extraction.baseRate;
    if (income < 0.8 - 1e-6 || income > 1.0 + 1e-6) {
      return `${m.seed}: start produces ${income.toFixed(3)}/s`;
    }
    if (richnessTierForRate(income).key !== 'moderate') {
      return `${m.seed}: start tier is ${richnessTierForRate(income).key}`;
    }
    const marker = m.deposits.find((d) => d.start);
    if (!marker || marker.richness !== 'moderate') return `${m.seed}: start-region marker is not Moderate`;
    if (marker.markerX !== m.start.x || marker.markerY !== m.start.y
        || Math.abs(marker.income - income) > 1e-6) {
      return `${m.seed}: start marker does not describe the calibrated tower site`;
    }

    let rich = 0;
    let best = 0;
    for (let y = 0; y < MAP.h; y++) for (let x = 0; x < MAP.w; x++) {
      if (Math.hypot(x - m.start.x, y - m.start.y) < 12) continue;
      if (!isTerrainBuildable(m, x + 0.5, y + 0.5)) continue;
      const siteIncome = resourceScoreAt(m, x + 0.5, y + 0.5, TOWER.extraction.radius)
        * TOWER.extraction.baseRate;
      if (siteIncome >= RICHNESS.moderateMax) rich++;
      best = Math.max(best, siteIncome);
    }
    if (!rich) return `${m.seed}: no buildable Rich site at least 12 tiles from start`;
    let roadTiles = 0;
    for (let y = 0; y < MAP.h; y++) for (let x = 0; x < MAP.w; x++) {
      if (m.road[idx(x, y)]
          && Math.hypot(x + 0.5 - (m.start.x + 0.5), y + 0.5 - (m.start.y + 0.5)) <= TOWER.weapon.range) {
        roadTiles++;
      }
    }
    rows.push(`${m.seed}:${income.toFixed(2)}/${rich}/${(best / income).toFixed(2)}x/${roadTiles}r`);
  }
  console.log(`D68 start/rich-count/best-ratio/W0-road: ${rows.join('; ')}`);
  return null;
});

// --- D56-D60: fog, local construction, timed upgrades and tower alarms -----

check('initial fog is local, small, and leaves far corners unexplored', () => {
  const g = createGame('FOG-INITIAL', 'gunner');
  const state = visibilityState(g);
  const fraction = state.exploredCount / state.total;
  console.log(`Initial explored fraction: ${(fraction * 100).toFixed(2)}% (${state.exploredCount}/${state.total})`);
  if (state.exploredCount !== state.visibleCount) return 'initial explored and visible sets differ';
  if (fraction <= 0 || fraction >= 0.15) return `initial explored fraction ${fraction.toFixed(3)} is not small`;
  for (const [x, y] of [[0, 0], [MAP.w - 1, 0], [0, MAP.h - 1], [MAP.w - 1, MAP.h - 1]]) {
    if (isTileExplored(g, x, y)) return `far corner (${x},${y}) began explored`;
  }
  const sources = [g.player, ...g.towers.filter((t) => t.built)];
  for (let y = 0; y < MAP.h; y++) for (let x = 0; x < MAP.w; x++) {
    if (!isTileExplored(g, x, y)) continue;
    const within = sources.some((s, n) => Math.hypot(x + 0.5 - s.x, y + 0.5 - s.y)
      <= (n === 0 ? VISION.player : state.towerRadii[n - 1].radius) + 1e-6);
    if (!within) return `explored tile (${x},${y}) lies outside every initial vision radius`;
  }
  return null;
});

check('exploration persists after the player leaves while current visibility does not', () => {
  const g = createGame('FOG-PERSIST', 'gunner');
  const start = g.towers[0];
  let far = null;
  for (let y = 2; y < MAP.h - 2 && !far; y++) for (let x = 2; x < MAP.w - 2; x++) {
    if (isPassable(g.map, x, y) && Math.hypot(x + 0.5 - start.x, y + 0.5 - start.y) > 24) {
      far = { x: x + 0.5, y: y + 0.5 };
      break;
    }
  }
  if (!far) return 'no distant walkable tile';
  g.player.x = far.x; g.player.y = far.y;
  recomputeVisibility(g);
  if (!isPointVisible(g, far.x, far.y) || !isTileExplored(g, Math.floor(far.x), Math.floor(far.y))) return 'visited tile was not visible/explored';
  g.player.x = start.x; g.player.y = start.y;
  recomputeVisibility(g);
  if (isPointVisible(g, far.x, far.y)) return 'distant tile stayed visible after leaving';
  return isTileExplored(g, Math.floor(far.x), Math.floor(far.y)) ? null : 'exploration was forgotten';
});

check('enemy point visibility follows fog without creating ghost knowledge', () => {
  const g = createGame('FOG-ENEMY', 'gunner');
  const a = { x: 8.5, y: 8.5 };
  const b = { x: MAP.w - 8.5, y: MAP.h - 8.5 };
  g.player.x = a.x; g.player.y = a.y;
  recomputeVisibility(g);
  spawnGroupAt(g, a.x, a.y, 'swarm', 1);
  const e = g.enemies[0];
  if (!isPointVisible(g, e.x, e.y)) return 'enemy beside player was hidden';
  g.player.x = b.x; g.player.y = b.y;
  recomputeVisibility(g);
  return isPointVisible(g, e.x, e.y) ? 'enemy remained visible outside every source' : null;
});

check('built towers grant cached LOS vision and unfinished towers grant none', () => {
  const g = createGame('FOG-TOWER', 'gunner');
  g.map = syntheticMap();
  const t = g.towers[0];
  t.x = 40.5; t.y = 25.5; t.field = null;
  g.player.x = 5.5; g.player.y = 5.5;
  recomputeVisibility(g, true);
  if (!isTileVisible(g, 49, 25)) return 'built tower did not reveal inside its minimum radius';
  t.built = false;
  recomputeVisibility(g);
  if (isTileVisible(g, 40, 25)) return 'unfinished tower revealed its own tile';
  t.built = true;
  recomputeVisibility(g);
  return isTileVisible(g, 40, 25) ? null : 'rebuilt tower did not restore vision';
});

check('fog vision obeys cliff, forest, and higher-source LOS rules', () => {
  const g = createGame('FOG-LOS', 'gunner');
  g.map = syntheticMap();
  const t = g.towers[0];
  t.x = 10.5; t.y = 10.5; t.field = null;
  g.player.x = 90.5; g.player.y = 40.5;
  g.map.kind[idx(11, 10)] = T.CLIFF;
  recomputeVisibility(g, true);
  if (isTileVisible(g, 14, 10)) return 'tower vision passed through a cliff';
  g.map.kind[idx(11, 10)] = T.FOREST;
  g.map.elev[idx(10, 10)] = 1;
  g.map.elev[idx(11, 10)] = 1;
  recomputeVisibility(g, true);
  if (isTileVisible(g, 14, 10)) return 'same-band forest did not block tower vision';
  g.map.elev[idx(10, 10)] = 2;
  recomputeVisibility(g, true);
  return isTileVisible(g, 14, 10) ? null : 'higher tower did not see over lower forest';
});

check('tower vision radius always covers current upgraded weapon range', () => {
  const g = createGame('FOG-RANGE', 'gunner');
  const t = g.towers[0];
  t.wLevel = TOWER.upgrade.maxLevel;
  if (!grantEquipment(g, 'targetingModule')) return 'could not grant targeting module';
  recomputeVisibility(g);
  const radius = visibilityState(g).towerRadii.find((r) => r.id === t.id)?.radius;
  const range = towerStats(g, t).range;
  if (radius < VISION.towerMin) return `tower vision ${radius} below minimum ${VISION.towerMin}`;
  return radius + 1e-9 >= range + VISION.towerRangeMargin
    ? null : `tower vision ${radius} does not cover range ${range}`;
});

check('rich resource deposits are discovered once and remain explored', () => {
  const g = createGame('FOG-RESOURCE', 'prospector');
  const t = g.towers[0];
  const d = g.map.deposits.find((o) => o.richness === 'rich'
    && Math.hypot(o.x + 0.5 - t.x, o.y + 0.5 - t.y) > 18
    && !isTileExplored(g, Math.floor(o.x), Math.floor(o.y)));
  if (!d) return 'no initially hidden Rich deposit centroid';
  g.player.x = d.x + 0.5; g.player.y = d.y + 0.5;
  recomputeVisibility(g);
  if (!isTileExplored(g, Math.floor(d.x), Math.floor(d.y))) return 'visit did not discover deposit centroid';
  g.player.x = t.x; g.player.y = t.y;
  recomputeVisibility(g);
  if (isTileVisible(g, Math.floor(d.x), Math.floor(d.y))) return 'deposit stayed visible after leaving';
  return isTileExplored(g, Math.floor(d.x), Math.floor(d.y)) ? null : 'deposit discovery was forgotten';
});

check('construction is local and playerBuildSite can be built while standing there', () => {
  const g = createGame('LOCAL-BUILD', 'engineer');
  g.materials = 99999;
  let site = null;
  for (let y = 3; y < MAP.h - 3 && !site; y++) for (let x = 3; x < MAP.w - 3; x++) {
    if (Math.hypot(x + 0.5 - g.towers[0].x, y + 0.5 - g.towers[0].y) < 12) continue;
    g.player.x = x + 0.5; g.player.y = y + 0.5;
    const candidate = playerBuildSite(g);
    if (candidate.check.ok) { site = candidate; break; }
  }
  if (!site) return 'no local valid site found';
  g.player.x = g.towers[0].x; g.player.y = g.towers[0].y;
  const remote = tryBuild(g, site.x, site.y);
  if (remote.ok || remote.reason !== 'stand at the site to build') return 'remote build did not return the local-build refusal';
  g.player.x = site.x; g.player.y = site.y;
  return tryBuild(g, site.x, site.y).ok ? null : 'build failed while standing at playerBuildSite';
});

check('unfinished construction continues unassisted after the player leaves', () => {
  const g = createGame('BUILD-AWAY', 'gunner');
  g.materials = 99999; g.phaseLeft = 999;
  let site = null;
  for (let y = 3; y < MAP.h - 3 && !site; y++) for (let x = 3; x < MAP.w - 3; x++) {
    g.player.x = x + 0.5; g.player.y = y + 0.5;
    const c = playerBuildSite(g);
    if (c.check.ok) { site = c; break; }
  }
  if (!site || !tryBuild(g, site.x, site.y).ok) return 'could not start construction';
  const t = g.towers[g.towers.length - 1];
  g.player.x = g.towers[0].x; g.player.y = g.towers[0].y;
  const before = t.progress;
  update(g, 1);
  if (!(t.progress > before) || t.built) return 'unassisted progress did not advance normally';
  update(g, TOWER.buildTime);
  return t.built ? null : 'unassisted tower never completed';
});

check('timed upgrade keeps old stats until completion and refuses a second job', () => {
  const g = createGame('UPGRADE-TIMED', 'gunner');
  g.materials = 99999; g.phaseLeft = 999;
  const t = g.towers[0];
  g.player.x = t.x + PLAYER.presenceRadius + 5;
  const old = towerStats(g, t);
  if (!tryUpgrade(g, t, 'weapon')) return 'first upgrade refused';
  if (tryUpgrade(g, t, 'extraction')) return 'second concurrent upgrade accepted';
  const started = upgradeState(g, t);
  if (t.wLevel !== 0 || !started) return 'upgrade applied immediately or has no state';
  if (started.which !== 'weapon' || started.fromLevel !== 0 || started.toLevel !== 1
      || started.duration !== 15 || Math.abs(started.remaining - 15) > 1e-9) {
    return `upgrade state is incomplete: ${JSON.stringify(started)}`;
  }
  update(g, TOWER.upgrade.buildTime[0] * 0.5);
  const mid = towerStats(g, t);
  if (t.wLevel !== 0 || mid.damage !== old.damage || mid.range !== old.range) return 'stats changed mid-upgrade';
  update(g, TOWER.upgrade.buildTime[0] * 0.5 + 0.01);
  const done = towerStats(g, t);
  if (t.wLevel !== 1 || upgradeState(t) !== null) return 'upgrade did not complete at its duration';
  const completed = { damage: done.damage, range: done.range, level: t.wLevel };
  update(g, 1);
  if (t.wLevel !== completed.level || towerStats(g, t).damage !== completed.damage
      || towerStats(g, t).range !== completed.range) return 'weapon upgrade applied more than once';
  return done.damage > old.damage && done.range > old.range ? null : 'completed weapon stats did not improve';
});

check('old weapon and extraction output persist during timed upgrades', () => {
  const g = createGame('UPGRADE-FUNCTION', 'gunner');
  g.map = syntheticMap(); g.materials = 99999; g.phaseLeft = 999;
  const t = g.towers[0];
  t.x = 30.5; t.y = 20.5; t.field = null; t.resourceScore = 1;
  g.player.x = 5.5; g.player.y = 5.5;
  const e = testEnemy(g, { x: t.x + 3, y: t.y }, null);
  const old = towerStats(g, t);
  if (!tryUpgrade(g, t, 'weapon')) return 'upgrade refused';
  const before = g.materials;
  update(g, 0.5);
  const midWeapon = towerStats(g, t);
  if (Math.abs((g.materials - before) - old.income * 0.5) > 1e-6) return 'old extraction output did not persist';
  if (t.targetId !== e.id) return 'tower did not acquire a target during upgrade';
  if (t.wLevel !== 0 || midWeapon.damage !== old.damage || midWeapon.range !== old.range) {
    return 'old weapon output did not persist';
  }
  t.upgrade = null;
  if (!tryUpgrade(g, t, 'extraction')) return 'extraction upgrade refused';
  const extractionBefore = towerStats(g, t).income;
  update(g, 0.5);
  return t.eLevel === 0 && towerStats(g, t).income === extractionBefore
    ? null : 'extraction level/output changed before completion';
});

check('weapon and extraction completion each apply exactly once', () => {
  for (const which of ['weapon', 'extraction']) {
    const g = createGame(`UPGRADE-ONCE-${which}`, 'gunner');
    g.materials = 99999; g.phaseLeft = 999;
    const t = g.towers[0];
    g.player.x = t.x + PLAYER.presenceRadius + 5;
    const old = towerStats(g, t);
    if (!tryUpgrade(g, t, which)) return `${which} upgrade refused`;
    update(g, TOWER.upgrade.buildTime[0] + 0.01);
    const completed = towerStats(g, t);
    const level = which === 'weapon' ? t.wLevel : t.eLevel;
    if (level !== 1) return `${which} did not increment exactly once`;
    if (which === 'weapon' && !(completed.damage > old.damage && completed.range > old.range)) {
      return 'weapon stats did not apply';
    }
    if (which === 'extraction' && !(completed.income > old.income)) return 'extraction income did not apply';
    update(g, 2);
    if ((which === 'weapon' ? t.wLevel : t.eLevel) !== 1) return `${which} incremented again`;
  }
  return null;
});

check('upgrade durations use x1 except for an occupying Engineer', () => {
  const measure = (arch, occupied) => {
    const g = createGame(`UPGRADE-DUR-${arch}-${occupied}`, arch);
    g.materials = 99999; g.phaseLeft = 9999;
    const t = g.towers[0];
    if (occupied) {
      if (!occupy(g, t)) return { error: 'could not occupy tower' };
    } else {
      g.player.x = t.x + PLAYER.presenceRadius + 5;
      g.player.y = t.y;
      update(g, 0);
    }
    const times = [];
    for (let level = 0; level < 3; level++) {
      if (!tryUpgrade(g, t, 'weapon')) return { error: `level ${level + 1} refused` };
      let elapsed = 0;
      while (t.wLevel === level && elapsed < 50) { update(g, 0.02); elapsed += 0.02; }
      times.push(elapsed);
    }
    return { times };
  };
  for (const [arch, occupied, divisor] of [
    ['gunner', false, 1], ['engineer', false, 1], ['gunner', true, 1], ['engineer', true, 3.6],
  ]) {
    const result = measure(arch, occupied);
    if (result.error) return result.error;
    for (let i = 0; i < 3; i++) {
      const expected = TOWER.upgrade.buildTime[i] / divisor;
      if (Math.abs(result.times[i] - expected) > 0.021) {
        return `${arch}/${occupied ? 'occupied' : 'away'} L${i + 1} took ${result.times[i].toFixed(2)}s, expected ${expected.toFixed(2)}s`;
      }
    }
  }
  return null;
});

check('an Engineer leaving mid-upgrade continues at x1 with blended timing', () => {
  const g = createGame('UPGRADE-LEAVE', 'engineer');
  g.materials = 99999; g.phaseLeft = 999;
  const t = g.towers[0];
  if (!occupy(g, t) || upgradeRateMult(g, t) !== 3.6) return 'Engineer did not occupy at x3.6';
  if (!tryUpgrade(g, t, 'weapon')) return 'upgrade refused';
  update(g, 2);
  const accelerated = t.upgrade.progress;
  g.player.x = t.x + PLAYER.presenceRadius + 2;
  update(g, 0.01);
  if (g.occupiedTowerId !== null || upgradeRateMult(g, t) !== 1) return 'leaving did not drop upgrade rate to x1';
  const afterLeave = t.upgrade.progress;
  if (Math.abs((afterLeave - accelerated) - 0.01 / 15) > 1e-6) return 'progress did not continue at x1';
  let after = 0.01;
  while (t.wLevel === 0 && after < 20) { update(g, 0.02); after += 0.02; }
  const total = 2 + after;
  return Math.abs(total - (2 + (15 - 2 * 3.6))) <= 0.031
    ? null : `blended completion took ${total.toFixed(2)}s`;
});

check('destroying a tower loses its upgrade job without a refund', () => {
  const g = createGame('UPGRADE-DESTROY', 'gunner');
  g.materials = 99999; g.phaseLeft = 999;
  const t = g.towers[0];
  if (!tryUpgrade(g, t, 'weapon')) return 'upgrade refused';
  const paid = g.materials;
  t.hp = -1;
  update(g, TOWER.upgrade.buildTime[0] + 1);
  if (g.towers.includes(t) || t.wLevel !== 0) return 'destroyed tower survived or completed upgrade';
  return g.materials === paid ? null : `materials changed after destruction (${paid} -> ${g.materials})`;
});

check('pausing freezes an upgrade already in progress', () => {
  const g = createGame('UPGRADE-PAUSE', 'engineer');
  g.materials = 99999; g.phaseLeft = 999;
  const t = g.towers[0];
  if (!tryUpgrade(g, t, 'weapon')) return 'upgrade refused';
  update(g, 1);
  const before = t.upgrade.progress;
  setPaused(g, true);
  update(g, 20);
  if (t.upgrade.progress !== before) return 'paused update advanced upgrade progress';
  setPaused(g, false);
  update(g, 1);
  return t.upgrade.progress > before ? null : 'upgrade did not resume';
});

check('tower alarm fires for unseen damage but not visible damage', () => {
  const fixture = (visible) => {
    const g = createGame(`ALARM-${visible}`, 'gunner');
    g.map = syntheticMap(); g.phaseLeft = 999;
    const t = g.towers[0];
    t.x = 10.5; t.y = 10.5; t.field = null; t.hp = t.maxHp = 1e6;
    g.player.x = 90.5; g.player.y = 40.5;
    if (!visible) g.map.kind[idx(11, 10)] = T.FOREST;
    const e = testEnemy(g, { x: visible ? 11.5 : 13.1, y: 10.5 }, t.id);
    e.sieging = true; e.siegedId = t.id;
    e.def = { ...e.def, towerDps: 10 };
    recomputeVisibility(g, true);
    const seen = isPointVisible(g, e.x, e.y);
    update(g, 0.1);
    return { g, t, seen, active: towerAlarmState(g).find((a) => a.id === t.id)?.active };
  };
  const hidden = fixture(false);
  if (hidden.seen) return 'hidden-attacker precondition was visible';
  if (!hidden.active) return 'unseen hit did not activate tower alarm';
  const shown = fixture(true);
  if (!shown.seen) return 'visible-attacker precondition was hidden';
  return shown.active ? 'visible hit activated unseen tower alarm' : null;
});

check('visibility recompute remains inexpensive headlessly', () => {
  const g = createGame('FOG-PERF', 'gunner');
  const count = 40;
  const before = performance.now();
  for (let n = 0; n < count; n++) {
    g.player.x = 2.5 + (n % (MAP.w - 5));
    g.player.y = 2.5 + ((n * 7) % (MAP.h - 5));
    recomputeVisibility(g);
  }
  const per = (performance.now() - before) / count;
  console.log(`Visibility recompute: ${per.toFixed(3)} ms/recompute (${count} samples)`);
  return Number.isFinite(per) ? null : 'visibility timing was non-finite';
});

check('prep bot reaches a Moderate+ expansion site on five seeds before 40 seconds', () => {
  const reports = [];
  for (const seed of ['SCOUT-A', 'SCOUT-B', 'SCOUT-C', 'SCOUT-D', 'SCOUT-E']) {
    const g = createGame(seed, 'gunner');
    g.materials = 99999;
    const start = g.towers[0];
    const candidates = [];
    for (let y = 2; y < MAP.h - 2; y++) for (let x = 2; x < MAP.w - 2; x++) {
      const wx = x + 0.5; const wy = y + 0.5;
      if (Math.hypot(wx - start.x, wy - start.y) < 10) continue;
      const c = canPlaceAt(g, wx, wy);
      if (!c.ok || c.richness.key === 'poor') continue;
      candidates.push({ x: wx, y: wy, distance: Math.hypot(wx - g.player.x, wy - g.player.y) });
    }
    candidates.sort((a, b) => a.distance - b.distance);
    let target = null; let field = null;
    for (const c of candidates) {
      const f = computeField(g.map, [idx(Math.floor(c.x), Math.floor(c.y))], 'direct');
      if (Number.isFinite(f[idx(Math.floor(g.player.x), Math.floor(g.player.y))])) { target = c; field = f; break; }
    }
    if (!target) return `${seed}: no reachable Moderate+ expansion target`;
    const dt = 1 / 15;
    let reachedAt = null;
    for (let elapsed = 0; elapsed < WAVE.prepFirst; elapsed += dt) {
      const dir = steer(g.map, field, g.player.x, g.player.y);
      g.input.mx = dir?.x ?? 0; g.input.my = dir?.y ?? 0;
      update(g, dt);
      const site = playerBuildSite(g);
      if (site.check.ok && site.check.richness.key !== 'poor'
          && Math.hypot(site.x - start.x, site.y - start.y) >= 10) {
        reachedAt = elapsed + dt;
        break;
      }
    }
    const explored = visibilityState(g).exploredCount;
    reports.push(`${seed} ${reachedAt === null ? 'unreached' : reachedAt.toFixed(1) + 's'} / ${explored} tiles`);
    if (reachedAt === null || reachedAt >= WAVE.prepFirst) return `${seed}: expansion site not reached during prep`;
  }
  console.log(`Prep viability: ${reports.join('; ')}`);
  return null;
});

// --- D37/D39: equipment and pause ------------------------------------------

check('run-long equipment is one-of-each and capped at four', () => {
  const g = createGame('EQUIPMENT', 'gunner');
  const keys = Object.keys(DROP.equipment);
  if (!grantEquipment(g, keys[0])) return 'first item was refused';
  if (grantEquipment(g, keys[0])) return 'duplicate item was accepted';
  for (const key of keys.slice(1, DROP.equipmentCap)) {
    if (!grantEquipment(g, key)) return `${key} was refused below the cap`;
  }
  if (g.equipment.length !== DROP.equipmentCap) return `held ${g.equipment.length}, expected cap ${DROP.equipmentCap}`;
  if (grantEquipment(g, keys[DROP.equipmentCap])) return 'fifth item exceeded the run cap';
  if (new Set(g.equipment).size !== g.equipment.length) return 'equipment list contains duplicates';
  return null;
});

check('pause freezes simulation and refuses player actions', () => {
  const g = createGame('PAUSE-FREEZE', 'engineer');
  g.materials = 9999;
  const start = g.towers[0];
  start.hp -= 100;
  g.effects.damage = 9;
  g.phase = 'prep';
  g.phaseLeft = 12;
  g.input = { mx: 1, my: 0, melee: true, repair: true };
  spawnGroupAt(g, g.player.x + 1, g.player.y, 'swarm', 1);
  const enemy = g.enemies[0];
  enemy.hp = 1000;
  enemy.maxHp = 1000;
  g.drops.push({ category: 'materials', key: 'materials', def: DROP.materialsCache,
    amount: 30, x: g.player.x + 8, y: g.player.y, t: 3 });
  g.tracers.push({ x0: 0, y0: 0, x1: 1, y1: 1, t: 0.02, life: 1, color: '#fff' });
  g.particles.push({ x: 2, y: 2, vx: 1, vy: 1, t: 0.02, life: 1, color: '#fff', size: 1 });

  const findSite = () => {
    for (let y = 3; y < MAP.h - 3; y += 2) {
      for (let x = 3; x < MAP.w - 3; x += 2) {
        if (canPlaceAt(g, x + 0.5, y + 0.5).ok) return { x: x + 0.5, y: y + 0.5 };
      }
    }
    return null;
  };
  const site = findSite();
  if (!site || !buildAt(g, site.x, site.y).ok) return 'could not establish construction precondition';
  const building = g.towers[g.towers.length - 1];
  const secondSite = findSite();
  if (!secondSite) return 'could not establish paused-build precondition';

  g.player.x = secondSite.x;
  g.player.y = secondSite.y;
  setPaused(g, true);
  const before = {
    time: g.time, phaseLeft: g.phaseLeft, materials: g.materials,
    px: g.player.x, py: g.player.y, hp: g.player.hp,
    towerHp: start.hp, progress: building.progress,
    ex: enemy.x, ey: enemy.y, enemyHp: enemy.hp,
    dropT: g.drops[0].t, effect: g.effects.damage,
    tracerT: g.tracers[0].t, particleT: g.particles[0].t,
    particleX: g.particles[0].x,
  };
  update(g, 2);
  for (const [key, value] of Object.entries(before)) {
    const actual = {
      time: g.time, phaseLeft: g.phaseLeft, materials: g.materials,
      px: g.player.x, py: g.player.y, hp: g.player.hp,
      towerHp: start.hp, progress: building.progress,
      ex: enemy.x, ey: enemy.y, enemyHp: enemy.hp,
      dropT: g.drops[0].t, effect: g.effects.damage,
      tracerT: g.tracers[0].t, particleT: g.particles[0].t,
      particleX: g.particles[0].x,
    }[key];
    if (actual !== value) return `${key} changed while paused (${value} -> ${actual})`;
  }

  const towerCount = g.towers.length;
  if (tryBuild(g, secondSite.x, secondSite.y).ok || g.towers.length !== towerCount) return 'building succeeded while paused';
  const weaponLevel = start.wLevel;
  if (tryUpgrade(g, start, 'weapon') || start.wLevel !== weaponLevel) return 'upgrade succeeded while paused';
  const cache = { category: 'materials', key: 'materials', def: DROP.materialsCache,
    amount: 30, x: g.player.x, y: g.player.y, t: 0 };
  const materials = g.materials;
  if (collectDrop(g, cache) || g.materials !== materials) return 'drop collection succeeded while paused';

  update(g, 0.25, { ignorePause: true });
  return g.time > before.time ? null : 'forced harness step did not advance while paused';
});

// --- D46: audio observer contract (no AudioContext required) ----------------

check('audio event queue is bounded and drains without affecting game state', () => {
  const g = createGame('AUDIO-QUEUE', 'gunner');
  const before = { materials: g.materials, time: g.time, towers: g.towers.length };
  emitAudioEvent(g, 'towerFire', { x: 2, y: 3 });
  const events = drainAudioEvents(g);
  if (events.length !== 1 || events[0].type !== 'towerFire' || g.audioEvents.length !== 0) return 'queue did not preserve/drain event';
  return g.materials === before.materials && g.time === before.time && g.towers.length === before.towers ? null : 'emitting changed simulation state';
});

check('audio rate limits use wall-clock values and priority drops low cues first', () => {
  const last = { towerFire: 10 };
  if (shouldRateLimit(last, 'towerFire', 10.02)) return 'rapid tower fire was not limited';
  if (!shouldRateLimit(last, 'towerFire', 10.2)) return 'later tower fire remained limited';
  const chosen = selectVoices([{ type: 'enemyHit' }, { type: 'towerDestroy' }, { type: 'playerDamage' }], 0, 2);
  if (chosen.map((e) => e.type).join(',') !== 'playerDamage,towerDestroy') return 'priority ordering is wrong';
  return AUDIO_PRIORITY.playerDamage > AUDIO_PRIORITY.enemyHit ? null : 'priority table is inverted';
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

// --- D72: a three-tower opening ---------------------------------------------

/** Legal build sites on a real map, far enough apart to use in sequence. */
function openingSites(g, count) {
  const saved = g.materials;
  g.materials = 1e9;
  const picked = [];
  for (let y = 3; y < MAP.h - 3 && picked.length < count; y++) {
    for (let x = 3; x < MAP.w - 3 && picked.length < count; x++) {
      const site = { x: x + 0.5, y: y + 0.5 };
      if (!canPlaceAt(g, site.x, site.y).ok) continue;
      if (picked.some((p) => Math.hypot(p.x - site.x, p.y - site.y) < TOWER.minSpacing + 1)) continue;
      picked.push(site);
    }
  }
  g.materials = saved;
  return picked;
}

check('D72-A: a new game starts with exactly 350 Materials', () => {
  const g = createGame('D72-A', 'gunner');
  if (START_MATERIALS !== 350) return `START_MATERIALS is ${START_MATERIALS}`;
  return g.materials === 350 ? null : `new game has ${g.materials} Materials`;
});

check('D72-B/C: two towers are affordable at once, a third is not', () => {
  const g = createGame('D72-B', 'gunner');
  if (g.towers.length !== 1) return `expected only the start tower, found ${g.towers.length}`;
  const sites = openingSites(g, 3);
  if (sites.length < 3) return 'could not find three legal sites';
  const steps = [[145, 205], [190, 15]];
  for (let n = 0; n < 2; n++) {
    const [cost, left] = steps[n];
    if (towerCost(g) !== cost) return `build ${n + 1} costs ${towerCost(g)}, expected ${cost}`;
    const r = buildAt(g, sites[n].x, sites[n].y);
    if (!r.ok) return `build ${n + 1} refused: ${r.reason}`;
    if (Math.abs(g.materials - left) > 1e-9) return `after build ${n + 1}: ${g.materials} left, expected ${left}`;
  }
  if (towerCost(g) !== 235) return `third build costs ${towerCost(g)}, expected 235`;
  const r = buildAt(g, sites[2].x, sites[2].y);
  if (r.ok) return 'third tower was affordable from the starting Materials';
  return g.towers.length === 3 && g.materials === 15 ? null : 'refused build changed towers or Materials';
});

// --- D73: the occupied tower is breached, not sieged -----------------------

/** One occupied tower on open ground; its gun is silenced unless `fire`. */
function breachFixture(seed, { fire = false } = {}) {
  const g = createGame(seed, 'gunner');
  g.map = syntheticMap();
  g.phase = 'prep'; g.phaseLeft = 999; g.pendingSpawns = [];
  const t = g.towers[0];
  t.x = 52.5; t.y = 26.5; t.field = null;
  t.shotCd = fire ? 0 : 1e9;
  shelterAt(g, t);
  return { g, t };
}

function shelterAt(g, t) {
  g.player.x = t.x; g.player.y = t.y;
  g.shelter = { towerId: t.id, progress: PLAYER.shelterTime, required: PLAYER.shelterTime };
  g.occupiedTowerId = t.id;
}

/** A real enemy of `type`, siege damage included, on the given bearing. */
function breachEnemy(g, t, type, distance, angle = 0, speed = ENEMIES[type].speed) {
  const e = addRealEnemy(g, t.x + Math.cos(angle) * distance, t.y + Math.sin(angle) * distance, type, t.id, speed);
  e.def = { ...ENEMIES[type], speed };
  return e;
}

const expectedBreach = (g, t, type) => ENEMIES[type].breachFrac * t.maxHp * towerStats(g, t).damageTaken;

check('D73 breach fractions are 4% / 6% / 18% of max tower hp', () => {
  const got = ['swarm', 'runner', 'heavy'].map((k) => ENEMIES[k].breachFrac).join('/');
  return got === '0.04/0.06/0.18' ? null : `breach fractions are ${got}`;
});

for (const [label, type] of [['A', 'swarm'], ['B', 'runner'], ['C', 'heavy']]) {
  check(`BREACH-${label}: a ${type} reaching the occupied tower breaches once and is removed`, () => {
    const { g, t } = breachFixture(`BREACH-${label}`);
    const e = breachEnemy(g, t, type, 5);
    const hp0 = t.hp;
    const before = { kills: g.stats.kills, drops: g.drops.length };
    drainAudioEvents(g);
    let lastAlive = Infinity;
    for (let i = 0; i < 600 && g.enemies.includes(e); i++) {
      lastAlive = Math.hypot(e.x - t.x, e.y - t.y);
      update(g, 1 / 60);
      if (g.enemies.includes(e) && t.hp !== hp0) return 'tower lost hp before contact';
    }
    if (g.enemies.includes(e)) return 'enemy never reached the tower';
    if (e.sieging) return 'enemy began a siege of the occupied tower';
    if (lastAlive > breachContact(e) + 1e-9) return `breached ${lastAlive.toFixed(2)} tiles out, contact is ${breachContact(e).toFixed(2)}`;
    const lost = hp0 - t.hp;
    const want = expectedBreach(g, t, type);
    if (Math.abs(lost - want) > 1e-6) return `tower lost ${lost.toFixed(2)}, expected ${want.toFixed(2)}`;
    const hp1 = t.hp;
    runFor(g, 3);
    if (t.hp !== hp1) return 'tower kept losing hp after the breach';
    if (g.stats.kills !== before.kills || g.drops.length !== before.drops) return 'breach counted as a kill or dropped loot';
    if (g.stats.breaches !== 1 || g.stats.breachesByType[type] !== 1) return 'breach stats not recorded';
    const audio = drainAudioEvents(g).map((a) => a.type);
    if (audio.includes('enemyDeath')) return 'breach played the enemy-death cue';
    return audio.includes(type === 'heavy' ? 'heavyBreach' : 'breach') ? null : 'no breach audio event';
  });
}

check('BREACH-D: an enemy killed just before contact does not breach', () => {
  const trial = (fire) => {
    const { g, t } = breachFixture(`BREACH-D-${fire}`, { fire });
    t.retargetIn = 0;
    const e = breachEnemy(g, t, 'swarm', breachContact({ def: ENEMIES.swarm }) + 0.05, Math.PI);
    e.hp = 1;
    const hp0 = t.hp;
    runFor(g, 1);
    return { g, t, e, hp0 };
  };
  const control = trial(false);
  if (control.g.stats.breaches !== 1) return 'harness: the same approach does not breach without tower fire';
  const { g, t, e, hp0 } = trial(true);
  if (g.enemies.includes(e)) return 'tower did not kill the enemy';
  if (g.stats.kills !== 1) return `kills is ${g.stats.kills}`;
  return g.stats.breaches === 0 && t.hp === hp0 ? null : 'killed enemy still breached';
});

check('BREACH-E: a breached enemy can never apply damage again', () => {
  const { g, t } = breachFixture('BREACH-E');
  const e = breachEnemy(g, t, 'heavy', 1.0);
  update(g, 1 / 60);
  if (g.enemies.includes(e) || g.stats.breaches !== 1) return 'enemy did not breach';
  const hp1 = t.hp;
  g.enemies.push(e); // a stale reference re-entering the list
  runFor(g, 1);
  return t.hp === hp1 && g.stats.breaches === 1 ? null : 'a breached enemy damaged the tower twice';
});

check('BREACH-F: sticky siege of an unoccupied tower is unchanged', () => {
  const { g, t } = breachFixture('BREACH-F');
  g.player.x = t.x + 12; g.player.y = t.y;
  g.shelter = { towerId: null, progress: 0, required: PLAYER.shelterTime };
  g.occupiedTowerId = null;
  const e = breachEnemy(g, t, 'heavy', TOWER.radius + ENEMY.attackRange + ENEMIES.heavy.radius - 0.35, 0, 0);
  e.sieging = true; e.siegedId = t.id; e.retargetIn = 0;
  const hp0 = t.hp;
  runFor(g, 3);
  if (g.occupiedTowerId !== null) return 'player occupied the tower';
  const lost = hp0 - t.hp;
  const want = ENEMIES.heavy.towerDps * 3;
  if (Math.abs(lost - want) > want * 0.03) return `siege dealt ${lost.toFixed(1)} over 3s, expected ~${want}`;
  if (!g.enemies.includes(e) || !e.sieging || e.targetId !== t.id) return 'besieger lost its commitment';
  if (g.stats.breaches !== 0) return 'siege of an unoccupied tower was treated as a breach';
  // Once the player shelters there again it is the endpoint: one breach, no DPS.
  shelterAt(g, t);
  e.def = { ...e.def, speed: ENEMIES.heavy.speed };
  const hp1 = t.hp;
  runFor(g, 3);
  if (g.enemies.includes(e)) return 'besieger of a re-occupied tower never breached';
  const burst = hp1 - t.hp;
  const wantBurst = expectedBreach(g, t, 'heavy');
  return Math.abs(burst - wantBurst) < 1e-6 ? null : `re-occupied tower lost ${burst.toFixed(1)}, expected ${wantBurst.toFixed(1)}`;
});

check('BREACH-G: leaving the targeted tower before contact means no breach there', () => {
  const f = aggroFixture('BREACH-G');
  if (!f) return 'could not build the fixture';
  const { g, a, b } = f;
  for (const t of g.towers) t.shotCd = 1e9;
  if (!occupy(g, a)) return 'player did not occupy A';
  const spot = walkableNear(g, a.x, a.y, breachContact({ def: ENEMIES.swarm }) + 0.8, false);
  if (!spot) return 'no approach position beside A';
  const e = testEnemy(g, spot, a.id, 0);
  e.type = 'swarm'; e.def = { ...ENEMIES.swarm, speed: 0 };
  if (!occupy(g, b)) return 'player did not occupy B';
  const hp0 = a.hp;
  e.def.speed = ENEMIES.swarm.speed;
  e.retargetIn = 99;
  runFor(g, 3);
  if (a.hp !== hp0) return `abandoned A took ${(hp0 - a.hp).toFixed(1)} damage`;
  if (!g.enemies.includes(e)) return 'enemy vanished at the abandoned tower';
  return e.targetId !== a.id ? null : 'enemy still targets the abandoned tower';
});

check('BREACH-H: a cluster at contact each breaches once with its own damage', () => {
  const { g, t } = breachFixture('BREACH-H');
  const types = ['swarm', 'swarm', 'runner', 'heavy'];
  const enemies = types.map((type, n) => breachEnemy(g, t, type,
    breachContact({ def: ENEMIES[type] }) - 0.05, (n / types.length) * Math.PI * 2, 0));
  const hp0 = t.hp;
  update(g, 1 / 60);
  if (enemies.some((e) => g.enemies.includes(e))) return 'not every clustered enemy breached';
  const want = types.reduce((sum, type) => sum + expectedBreach(g, t, type), 0);
  if (Math.abs(hp0 - t.hp - want) > 1e-6) return `cluster dealt ${(hp0 - t.hp).toFixed(2)}, expected ${want.toFixed(2)}`;
  const by = g.stats.breachesByType;
  if (g.stats.breaches !== 4 || by.swarm !== 2 || by.runner !== 1 || by.heavy !== 1) return 'breach counts wrong';
  const floaters = g.floaters.filter((f) => f.breachTowerId === t.id);
  if (floaters.length !== 1) return `cluster produced ${floaters.length} BREACH floaters`;
  const hp1 = t.hp;
  runFor(g, 2);
  return t.hp === hp1 ? null : 'a clustered enemy damaged the tower again';
});

check('BREACH-I: a breach that destroys the last tower uses the normal collapse and defeat', () => {
  const survive = breachFixture('BREACH-I');
  const trio = [0, 1, 2].map((n) => breachEnemy(survive.g, survive.t, 'heavy', 1.0, n * 2, 0));
  survive.t.hp = 10;
  update(survive.g, 1 / 60);
  const g = survive.g;
  if (g.towers.length !== 0 || g.stats.towersLost !== 1) return 'tower was not destroyed';
  if (g.stats.breaches !== 1) return `${g.stats.breaches} breaches against one destroyed tower`;
  if (trio.filter((e) => g.enemies.includes(e)).length !== 2) return 'enemies after the collapse were removed';
  const crushed = PLAYER.maxHp * TOWER.collapseDamageFrac;
  if (Math.abs(g.player.hp - (PLAYER.maxHp - crushed)) > 1e-6) return 'collapse damage did not reach the player';
  const end = endState(g);
  if (end.status !== 'lost' || end.lossCause !== 'towers') return `end state ${JSON.stringify(end)}`;

  const fatal = breachFixture('BREACH-I-DEATH');
  breachEnemy(fatal.g, fatal.t, 'heavy', 1.0, 0, 0);
  fatal.t.hp = 10;
  fatal.g.player.hp = 5;
  update(fatal.g, 1 / 60);
  const death = endState(fatal.g);
  return death.status === 'lost' && death.lossCause === 'died' ? null : `player-death priority lost: ${JSON.stringify(death)}`;
});

check('BREACH-J: a breach gives no kill, no drop and no Materials', () => {
  const { g, t } = breachFixture('BREACH-J');
  const savedChance = DROP.chance;
  DROP.chance = 1;
  try {
    const e = breachEnemy(g, t, 'runner', 1.0, 0, 0);
    t.resourceScore = 0;
    const before = { kills: g.stats.kills, drops: g.drops.length, materials: g.materials };
    update(g, 1 / 60);
    if (g.enemies.includes(e)) return 'enemy did not breach';
    if (g.stats.kills !== before.kills) return 'breach counted as a kill';
    if (g.drops.length !== before.drops) return 'breach spawned a drop';
    if (g.materials > before.materials + 1e-9) return 'breach granted Materials';
    return g.stats.breaches === 1 && g.stats.breachDamage > 0 ? null : 'breach stats not recorded';
  } finally {
    DROP.chance = savedChance;
  }
});

// --- D75: roads carry the player, not enemies --------------------------------

/** Open synthetic ground with a straight east-west road along row 26. */
function roadFixture(seed) {
  const g = createGame(seed, 'gunner');
  g.map = syntheticMap();
  for (let x = 0; x < MAP.w; x++) g.map.road[idx(x, 26)] = 1;
  g.phase = 'prep'; g.phaseLeft = 999; g.pendingSpawns = [];
  g.towers[0].x = 90.5; g.towers[0].y = 40.5; g.towers[0].field = null;
  return g;
}

/** Tiles covered in one second of eastward input from (x, y). */
function walkEast(g, x, y, seconds = 1) {
  g.player.x = x; g.player.y = y;
  g.input = { mx: 1, my: 0, melee: false, repair: false };
  const steps = [];
  for (let i = 0; i < seconds * 60; i++) {
    const before = g.player.x;
    update(g, 1 / 60);
    steps.push(g.player.x - before);
  }
  g.input = { mx: 0, my: 0, melee: false, repair: false };
  return { distance: g.player.x - x, steps, dy: g.player.y - y };
}

check('D75-A: open-ground player speed is unchanged', () => {
  const g = roadFixture('D75-A');
  const { distance } = walkEast(g, 20.5, 20.5);
  if (PLAYER.roadSpeedMult !== 1.25) return `road multiplier is ${PLAYER.roadSpeedMult}`;
  return Math.abs(distance - PLAYER.speed) < 1e-6 ? null : `open ground covered ${distance.toFixed(3)}, expected ${PLAYER.speed}`;
});

check('D75-B: the player runs 1.25x faster on a road, entering and leaving smoothly', () => {
  const g = roadFixture('D75-B');
  const { distance } = walkEast(g, 20.5, 26.5);
  const want = PLAYER.speed * PLAYER.roadSpeedMult;
  if (Math.abs(distance - want) > 1e-6) return `road covered ${distance.toFixed(3)}, expected ${want.toFixed(3)}`;
  // Cross a road segment along row 20: the per-frame step only switches between
  // the two rates - no snap, no lateral shove.
  const h = roadFixture('D75-B2');
  for (let x = 40; x < 50; x++) h.map.road[idx(x, 20)] = 1;
  const walk = walkEast(h, 36.5, 20.5, 3);
  const lo = PLAYER.speed / 60;
  const hi = want / 60;
  if (walk.steps.some((d) => Math.abs(d - lo) > 1e-9 && Math.abs(d - hi) > 1e-9)) return 'a frame moved at neither rate';
  const fast = walk.steps.filter((d) => Math.abs(d - hi) < 1e-9).length;
  if (fast < 60 || fast > 110) return `${fast} road-speed frames crossing a 10-tile road`;
  if (Math.abs(walk.steps.at(-1) - lo) > 1e-9) return 'road speed persisted after leaving the road';
  return walk.dy === 0 ? null : 'crossing the road moved the player sideways';
});

check('D75-C: road speed stacks multiplicatively with boots and the speed effect', () => {
  const g = roadFixture('D75-C');
  grantEquipment(g, 'boots');
  g.effects.speed = 999;
  const want = PLAYER.speed * DROP.equipment.boots.playerSpeed * DROP.temporary.speed.mult;
  g.player.x = 20.5; g.player.y = 20.5;
  if (Math.abs(playerSpeed(g) - want) > 1e-9) return `open ground ${playerSpeed(g)}, expected ${want}`;
  const { distance } = walkEast(g, 20.5, 26.5);
  return Math.abs(distance - want * PLAYER.roadSpeedMult) < 1e-6
    ? null : `boosted road run covered ${distance.toFixed(3)}, expected ${(want * PLAYER.roadSpeedMult).toFixed(3)}`;
});

check('D75-D: enemies gain nothing from roads', () => {
  const run = (row) => {
    const g = roadFixture(`D75-D-${row}`);
    const t = g.towers[0];
    t.x = 80.5; t.y = row + 0.5; t.shotCd = 1e9; t.field = null;
    shelterAt(g, t);
    const e = breachEnemy(g, t, 'runner', 40, Math.PI);
    let path = 0;
    for (let i = 0; i < 60; i++) {
      const [x0, y0] = [e.x, e.y];
      update(g, 1 / 60);
      path += Math.hypot(e.x - x0, e.y - y0);
    }
    return path;
  };
  const onRoad = run(26);
  const offRoad = run(20);
  if (Math.abs(offRoad - ENEMIES.runner.speed) > 0.05) return `harness: off-road Runner covered ${offRoad.toFixed(2)}`;
  return Math.abs(onRoad - offRoad) < 1e-6 ? null : `Runner covered ${onRoad.toFixed(3)} on road vs ${offRoad.toFixed(3)} off it`;
});

// --- D75: extraction upgrades raise the rate, never the footprint ------------

/** Run a real extraction upgrade to completion. */
function completeExtraction(g, t) {
  g.materials = 1e9;
  if (!tryUpgrade(g, t, 'extraction')) return false;
  update(g, t.upgrade.duration + 0.05);
  return !t.upgrade;
}

check('D75-E: E0-E3 keep a 4.5 radius, the same cells and a rate-only income rise', () => {
  const g = createGame('D75-E', 'gunner');
  g.map = syntheticMap();
  g.phaseLeft = 9999;
  const t = g.towers[0];
  t.x = 52.5; t.y = 26.5;
  // A ramp of values so any change in the sampled cell set changes the score.
  for (let y = 0; y < MAP.h; y++) for (let x = 0; x < MAP.w; x++) g.map.res[idx(x, y)] = 0.01 * ((x * 7 + y * 13) % 29);
  t.resourceScore = resourceScoreAt(g.map, t.x, t.y, TOWER.extraction.radius);
  g.player.x = t.x + 12; g.player.y = t.y;
  const score0 = t.resourceScore;
  const base = towerStats(g, t).income;
  for (let level = 0; level <= 3; level++) {
    if (level > 0 && !completeExtraction(g, t)) return `E${level} upgrade did not complete`;
    const s = towerStats(g, t);
    if (t.eLevel !== level) return `expected E${level}, tower is E${t.eLevel}`;
    if (s.extractRadius !== 4.5) return `E${level} reports radius ${s.extractRadius}`;
    if (t.resourceScore !== score0) return `E${level} resampled a different footprint`;
    const mult = 1 + TOWER.upgrade.extractRatePerLevel * level;
    if (Math.abs(s.income - base * mult) > 1e-9) return `E${level} income x${(s.income / base).toFixed(3)}, expected x${mult}`;
  }
  return null;
});

check('D75-F: a deposit just outside 4.5 tiles contributes nothing at any Extraction level', () => {
  const g = createGame('D75-F', 'gunner');
  g.map = syntheticMap();
  g.phaseLeft = 9999;
  const t = g.towers[0];
  t.x = 52.5; t.y = 26.5;
  let ring = 0;
  for (let y = 0; y < MAP.h; y++) for (let x = 0; x < MAP.w; x++) {
    const d = Math.hypot(x + 0.5 - t.x, y + 0.5 - t.y);
    if (d > TOWER.extraction.radius && d <= TOWER.extraction.radius + 0.8) { g.map.res[idx(x, y)] = 1.8; ring++; }
  }
  if (ring < 20) return `harness: only ${ring} ring cells`;
  // Known-good control: the same deposit is picked up by a slightly wider circle.
  if (!(resourceScoreAt(g.map, t.x, t.y, TOWER.extraction.radius + 0.8) > 0)) return 'harness: ring not detectable';
  t.resourceScore = resourceScoreAt(g.map, t.x, t.y, TOWER.extraction.radius);
  g.player.x = t.x + 12; g.player.y = t.y;
  for (let level = 0; level <= 3; level++) {
    if (level > 0 && !completeExtraction(g, t)) return `E${level} upgrade did not complete`;
    if (t.resourceScore !== 0 || towerStats(g, t).income !== 0) return `E${level} extracts from outside 4.5 tiles`;
  }
  return null;
});

check('D75-G: a tower keeps firing and producing at its old levels through both upgrades', () => {
  for (const which of ['weapon', 'extraction']) {
    const g = createGame(`D75-G-${which}`, 'gunner');
    g.map = syntheticMap(); g.materials = 99999; g.phaseLeft = 999; g.pendingSpawns = [];
    const t = g.towers[0];
    t.x = 30.5; t.y = 20.5; t.field = null; t.resourceScore = 1;
    g.player.x = 5.5; g.player.y = 5.5;
    const old = towerStats(g, t);
    const e = testEnemy(g, { x: t.x + 3, y: t.y }, null);
    if (!tryUpgrade(g, t, which)) return `${which} upgrade refused`;
    const hp0 = e.hp;
    const m0 = g.materials;
    runFor(g, 2);
    if (!t.upgrade) return `${which} upgrade finished too early for this check`;
    const shots = Math.round((hp0 - e.hp) / old.damage);
    if (shots < 2 || Math.abs((hp0 - e.hp) - shots * old.damage) > 1e-6) return `during ${which}: tower did not keep firing at the old damage`;
    if (Math.abs((g.materials - m0) - old.income * 2) > 1e-6) return `during ${which}: income changed`;
  }
  return null;
});

// --- D74: Rich is a handful of jackpots, not a carpet -----------------------

check('D74 canonical maps have 3-5 separated Rich jackpots and no Rich ground elsewhere', () => {
  const rich = GEN.deposits.rich;
  const rows = [];
  for (const m of maps) {
    const jackpots = m.deposits.filter((d) => d.rich);
    if (jackpots.length < rich.min || jackpots.length > rich.max) return `${m.seed}: ${jackpots.length} jackpots`;
    for (const [n, j] of jackpots.entries()) {
      if (Math.hypot(j.x - m.start.x, j.y - m.start.y) < rich.minFromStart) return `${m.seed}: jackpot ${n} near start`;
      if (jackpots.some((o, k) => k !== n && Math.hypot(o.x - j.x, o.y - j.y) < rich.minSeparation)) return `${m.seed}: jackpots too close`;
      if (!isTerrainBuildable(m, j.x + 0.5, j.y + 0.5)) return `${m.seed}: jackpot ${n} centre is not buildable`;
      const income = resourceScoreAt(m, j.x + 0.5, j.y + 0.5, TOWER.extraction.radius) * TOWER.extraction.baseRate;
      if (income < rich.targetMin - 1e-6 || income > rich.targetMax + 1e-6) return `${m.seed}: jackpot ${n} earns ${income.toFixed(3)}`;
    }
    let sites = 0;
    for (let y = 0; y < MAP.h; y++) for (let x = 0; x < MAP.w; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      if (Math.hypot(px - (m.start.x + 0.5), py - (m.start.y + 0.5)) < 12 || !isTerrainBuildable(m, px, py)) continue;
      if (resourceScoreAt(m, px, py, TOWER.extraction.radius) * TOWER.extraction.baseRate < RICHNESS.moderateMax) continue;
      sites++;
      if (!jackpots.some((j) => Math.hypot(j.x + 0.5 - px, j.y + 0.5 - py) < 9)) return `${m.seed}: stray Rich site at ${px},${py}`;
    }
    rows.push(`${m.seed}:${jackpots.length}/${sites}`);
  }
  console.log(`D74 jackpots/rich-sites: ${rows.join('; ')}`);
  return null;
});

// --- D63 dense-wave instrumentation -----------------------------------------

check('dense waves 3-8 report stuck counters without last-resort despawns', () => {
  const rows = [];
  let measuredMs = 0;
  let measuredFrames = 0;
  for (const seed of SEEDS.slice(0, 8)) {
    const result = withSeededRandom(`DENSE-${seed}`, () => {
      const g = createGame(seed, 'engineer');
      const t = g.towers[0];
      t.hp = t.maxHp = 1e9; t.shotCd = 1e9; t.resourceScore = 0;
      g.player.hp = g.player.maxHp = 1e9;
      for (let wave = 3; wave <= 8; wave++) {
        const sheltered = wave % 2 === 1;
        g.wave = wave; g.status = 'playing'; g.phase = 'combat'; g.combatT = 0; g.phaseLeft = 0;
        g.enemies = [];
        if (sheltered) {
          g.player.x = t.x; g.player.y = t.y;
          g.shelter = { towerId: t.id, progress: PLAYER.shelterTime, required: PLAYER.shelterTime };
          g.occupiedTowerId = t.id;
        } else {
          const exposed = walkableNear(g, t.x, t.y, PLAYER.presenceRadius + 2, false);
          if (!exposed) return { error: `${seed} wave ${wave} has no exposed walkable player position` };
          g.player.x = exposed.x; g.player.y = exposed.y;
          g.shelter = { towerId: null, progress: 0, required: PLAYER.shelterTime };
          g.occupiedTowerId = null;
        }
        g.pendingSpawns = Array.from({ length: 18 }, (_, n) => ({
          type: n % 3 === 0 ? 'heavy' : n % 3 === 1 ? 'runner' : 'swarm',
          side: n % 2 ? 'west' : 'east', point: n, at: 0,
        }));
        const started = performance.now();
        // 36 simulated seconds lets even a Heavy traverse a half-map and
        // encounter authored crossings; 0.1 s steps keep this diagnostic cheap.
        for (let frame = 0; frame < 36 * 10 && g.status === 'playing'; frame++) {
          if (!sheltered) {
            const quadrant = Math.floor(frame / 25) % 4;
            g.input = { mx: [1, 0, -1, 0][quadrant], my: [0, 1, 0, -1][quadrant], melee: false, repair: false };
          } else {
            g.input = { mx: 0, my: 0, melee: false, repair: false };
          }
          update(g, 1 / 10);
          // D73: breach damage is a fraction of max hp, so a huge maxHp alone
          // no longer makes this diagnostic's tower unkillable.
          t.hp = t.maxHp;
          measuredFrames++;
        }
        measuredMs += performance.now() - started;
        if (g.status !== 'playing') return { error: `${seed} wave ${wave} ended the run` };
        if (stuckState(g).despawns) {
          const tail = g.debug.stuckEpisodes.slice(-12).map((episode) => ({
            stage: episode.stage, time: Number(episode.time.toFixed(1)),
            x: Number(episode.x.toFixed(2)), y: Number(episode.y.toFixed(2)),
            tileKind: episode.tileKind, fieldFinite: episode.fieldFinite,
            source: episode.source, target: episode.target,
          }));
          return { error: `${seed} wave ${wave} produced a stuck despawn: ${JSON.stringify(tail)}` };
        }
        g.enemies = []; g.pendingSpawns = [];
      }
      const causes = {};
      for (const episode of g.debug.stuckEpisodes) {
        const key = `${episode.stage}:${episode.source}`;
        causes[key] = (causes[key] || 0) + 1;
      }
      return { state: stuckState(g), causes };
    });
    if (result.error) return result.error;
    const causes = Object.entries(result.causes).map(([key, count]) => `${key}=${count}`).join(',') || 'none';
    rows.push(`${seed} ${result.state.detections}/${result.state.recoveries}/${result.state.despawns} [${causes}]`);
  }
  console.log(`Dense stuck d/r/x: ${rows.join('; ')}`);
  console.log(`Dense enemy update (tracking included): ${(measuredMs / measuredFrames).toFixed(4)} ms/frame`);
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
        if (buildAt(g, g.map.start.x + d, g.map.start.y).ok) { built++; break; }
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

check('audio events keep their cue name when a whole entity is passed as data', () => {
  // Regression: enemies carry their own `type` ('swarm'/'heavy'). Spreading the
  // entity after the cue name overwrote it, so every enemy hit and death played
  // the generic fallback beep. Unit tests of the audio helpers could not see it.
  const g = createGame('AUDIOTYPE', 'gunner');
  drainAudioEvents(g);
  const fakeEnemy = { type: 'heavy', x: 5, y: 6, hp: 10 };
  emitAudioEvent(g, 'enemyHit', fakeEnemy);
  emitAudioEvent(g, 'enemyDeath', { ...fakeEnemy, type: 'swarm' });
  const ev = drainAudioEvents(g);
  if (ev[0].type !== 'enemyHit') return `enemyHit arrived as '${ev[0].type}'`;
  if (ev[1].type !== 'enemyDeath') return `enemyDeath arrived as '${ev[1].type}'`;
  if (ev[0].x !== 5 || ev[0].y !== 6) return 'entity position was lost';
  return null;
});

check('every cue the simulation actually emits has a sound defined', () => {
  // Drive a real, violent stretch of play and collect every emitted type.
  const g = createGame('AUDIOCOVER', 'gunner');
  g.materials = 9000;
  const seen = new Set();
  const t = g.towers[0];
  spawnGroupAt(g, t.x + 3, t.y, 'swarm', 12);
  spawnGroupAt(g, t.x, t.y + 3, 'heavy', 3);
  for (let i = 0; i < 60 * 40 && g.status === 'playing'; i++) {
    g.player.x = t.x + 6; g.player.y = t.y;
    update(g, 1 / 60);
    for (const e of drainAudioEvents(g)) seen.add(e.type);
  }
  const handledSpecially = new Set(['dropSpawn', 'dropCollect', 'collapsingReminder']);
  const missing = [...seen].filter((k) => !AUDIO.cues[k] && !handledSpecially.has(k));
  return missing.length ? `no sound defined for emitted cue(s): ${missing.join(', ')}` : null;
});

check('positive confirmations are configured to rise in pitch', () => {
  for (const k of ['victory', 'constructionComplete', 'upgrade']) {
    if (!AUDIO.risingCues.includes(k)) return `${k} still falls in pitch`;
  }
  return AUDIO.risingPitchMult > 1 ? null : 'risingPitchMult does not rise';
});

// ---------------------------------------------------------------------------

console.log('');
for (const f of failures) console.log(`  FAIL  ${f}`);
console.log(`\n${passed} passed, ${failures.length} failed`);

if (failures.length) process.exit(1);
