// Headless checks for the parts that can be checked without a browser:
// the D2 terrain guarantees, pathing reachability, line of sight, and a long
// scripted simulation run. Feel is judged by playing it, not by this file.

import {
  MAP, T, VALID, PLAYER, TOWER, WAVE, PASSABLE, DROP, RICHNESS, richnessTierForRate, AUDIO,
  EXPOSURE, READABILITY,
} from '../src/config.js';
import {
  generateMap, validateMap, idx, isPassable, hasLineOfSight, kindAt, elevAt,
  isTerrainBuildable,
} from '../src/terrain.js';
import { computeField } from '../src/flowfield.js';
import {
  straightRoadBaseline, pathExposure, measureSiteExposure, findExposureFeatures,
  analyseRoadKnots, analyseRoadReadability, exposureEfficiency, walkedExtraLength,
} from '../src/roadexposure.js';
import {
  createGame, update, canPlaceAt, tryBuild, tryUpgrade, towerStats, spawnGroupAt,
  setPaused, collectDrop, grantEquipment, depositRichness, resourceScoreAt,
  emitAudioEvent, drainAudioEvents, isHunting, PLAYER_TARGET_ID,
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
    roadRoutes: [],
    spawns: { west: [], east: [] },
    roadCenter: { x: Math.floor(MAP.w / 2), y: Math.floor(MAP.h / 2) },
  };
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
  if (!bSite || !tryBuild(g, bSite.x, bSite.y).ok) return null;
  const b = g.towers[g.towers.length - 1];
  const cSite = sites.find((s) => far(s, [a, b], 20));
  if (!cSite || !tryBuild(g, cSite.x, cSite.y).ok) return null;
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
  if (!occupy(g, a)) return 'player did not occupy A';
  const spot = walkableNear(g, a.x, a.y, TOWER.radius + 1.2, false);
  if (!spot) return 'no siege position beside A';
  const e = testEnemy(g, spot, a.id);
  update(g, 1 / 60);
  if (!e.sieging) return 'enemy did not begin sieging A';
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

check('the central starting area is never a rich extraction site', () => {
  for (const m of maps) {
    const income = resourceScoreAt(m, m.start.x + 0.5, m.start.y + 0.5, TOWER.extraction.radius)
      * TOWER.extraction.baseRate;
    if (richnessTierForRate(income).key === 'rich') return `${m.seed}: start produces ${income.toFixed(2)}/s`;
  }
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
  if (!site || !tryBuild(g, site.x, site.y).ok) return 'could not establish construction precondition';
  const building = g.towers[g.towers.length - 1];
  const secondSite = findSite();
  if (!secondSite) return 'could not establish paused-build precondition';

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
