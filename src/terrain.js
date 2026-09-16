// D1/D2: terrain is authored by algorithm in deliberate passes, then validated
// and thrown away if it does not produce the tactical shape the prototype needs.

import { MAP, T, PASSABLE, MOVE_COST, ELEV_BANDS, GEN, VALID, ROAD, TOWER,
         BLOCKS_SIGHT_ALWAYS, BLOCKS_SIGHT_UNLESS_ABOVE } from './config.js';
import { hashString, makeRng, makeNoise2D, fbm, randInt, shuffle } from './rng.js';
import { findCostPath } from './flowfield.js';

export const idx = (x, y) => y * MAP.w + x;
export const inBounds = (x, y) => x >= 0 && y >= 0 && x < MAP.w && y < MAP.h;

export function kindAt(map, x, y) {
  if (!inBounds(x, y)) return T.CLIFF;
  return map.kind[idx(x, y)];
}

export function elevAt(map, x, y) {
  if (!inBounds(x, y)) return 0;
  return map.elev[idx(x, y)];
}

export function isPassable(map, x, y) {
  if (!inBounds(x, y)) return false;
  return PASSABLE[map.kind[idx(x, y)]];
}

export function moveCostAt(map, x, y) {
  if (!inBounds(x, y)) return Infinity;
  return MOVE_COST[map.kind[idx(x, y)]];
}

/**
 * D3: cliffs block sight outright; forest blocks it unless the shooter stands
 * at least one elevation band above the forest tile it is looking through.
 */
export function hasLineOfSight(map, x0, y0, x1, y1) {
  const shooterElev = elevAt(map, Math.floor(x0), Math.floor(y0));
  let cx = Math.floor(x0);
  let cy = Math.floor(y0);
  const tx = Math.floor(x1);
  const ty = Math.floor(y1);
  const dx = Math.abs(tx - cx);
  const dy = Math.abs(ty - cy);
  const sx = cx < tx ? 1 : -1;
  const sy = cy < ty ? 1 : -1;
  let err = dx - dy;

  // Walk the line, ignoring the endpoints themselves.
  for (let guard = 0; guard < MAP.w + MAP.h; guard++) {
    if (cx === tx && cy === ty) return true;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; cx += sx; }
    if (e2 < dx) { err += dx; cy += sy; }
    if (cx === tx && cy === ty) return true;
    const k = kindAt(map, cx, cy);
    if (BLOCKS_SIGHT_ALWAYS[k]) return false;
    if (BLOCKS_SIGHT_UNLESS_ABOVE[k] && shooterElev <= elevAt(map, cx, cy)) return false;
  }
  return false;
}

/** Is the straight line between two points walkable end to end? */
export function hasClearWalk(map, x0, y0, x1, y1) {
  let cx = Math.floor(x0);
  let cy = Math.floor(y0);
  const tx = Math.floor(x1);
  const ty = Math.floor(y1);
  const dx = Math.abs(tx - cx);
  const dy = Math.abs(ty - cy);
  const sx = cx < tx ? 1 : -1;
  const sy = cy < ty ? 1 : -1;
  let err = dx - dy;

  for (let guard = 0; guard < MAP.w + MAP.h; guard++) {
    if (cx === tx && cy === ty) return true;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; cx += sx; }
    if (e2 < dx) { err += dx; cy += sy; }
    if (!isPassable(map, cx, cy)) return false;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

function wanderingLine(rng, cx, wander) {
  const xs = new Float32Array(MAP.h);
  let x = cx;
  let v = 0;
  for (let y = 0; y < MAP.h; y++) {
    v = Math.max(-1.3, Math.min(1.3, v + (rng() - 0.5) * 0.95));
    x += v + (cx - x) * 0.035;
    x = Math.max(cx - wander, Math.min(cx + wander, x));
    xs[y] = x;
  }
  return xs;
}

/** Non-overlapping y-ranges, spread across the map height. */
function spreadRanges(rng, count, minH, maxH, minSep) {
  const ranges = [];
  let tries = 0;
  while (ranges.length < count && tries++ < 200) {
    const height = randInt(rng, minH, maxH);
    const y0 = randInt(rng, 3, MAP.h - height - 4);
    const y1 = y0 + height;
    if (ranges.some((r) => y0 < r.y1 + minSep && r.y0 - minSep < y1)) continue;
    ranges.push({ y0, y1 });
  }
  return ranges.sort((a, b) => a.y0 - b.y0);
}

function chooseBarrierColumns(rng) {
  // Spread across the map but never through the centre, where the start tower sits.
  const fractions = [0.13, 0.20, 0.27, 0.34, 0.66, 0.73, 0.80, 0.87];
  const candidates = shuffle(rng, fractions).map((f) => Math.round(f * MAP.w));

  // The river is claimed first so every map reliably has one; ridges then keep
  // clear of it, so a ridge never seals the fords.
  const river = candidates[0];
  const ridgeCount = randInt(rng, GEN.ridges.min, GEN.ridges.max);
  const ridges = [];
  for (const c of candidates.slice(1)) {
    if (ridges.length >= ridgeCount) break;
    if (Math.abs(c - river) < 14) continue;
    if (ridges.every((r) => Math.abs(r - c) >= 11)) ridges.push(c);
  }
  return { ridges, river };
}

function stampRidges(map, rng, columns) {
  const barriers = [];
  for (const cx of columns) {
    const xs = wanderingLine(rng, cx, GEN.ridges.wander);
    const thickness = randInt(rng, GEN.ridges.thicknessMin, GEN.ridges.thicknessMax);
    // Deliberate gaps: at least two, so the ridge is a chokepoint and not a wall.
    const gapCount = rng() < 0.28 ? 3 : 2;
    const gaps = spreadRanges(rng, gapCount, GEN.ridgeGap.min, GEN.ridgeGap.max, GEN.ridgeGap.minSeparation);

    for (let y = 0; y < MAP.h; y++) {
      const inGap = gaps.some((g) => y >= g.y0 && y < g.y1);
      const half = thickness / 2;
      for (let x = Math.floor(xs[y] - half - 3); x <= Math.ceil(xs[y] + half + 3); x++) {
        if (!inBounds(x, y)) continue;
        const d = Math.abs(x - xs[y]);
        const i = idx(x, y);
        if (d <= half && !inGap) {
          map.kind[i] = T.CLIFF;
          map.elev[i] = ELEV_BANDS - 1;
        } else if (d <= half + 3) {
          // Ground beside a ridge rises: a gap is an elevated pass with a view.
          map.elev[i] = Math.max(map.elev[i], 2);
        }
      }
    }
    barriers.push({ type: 'ridge', cx, xs, gaps });
  }
  return barriers;
}

function stampRiver(map, rng, cx) {
  const xs = wanderingLine(rng, cx, GEN.river.wander);
  const width = randInt(rng, GEN.river.widthMin, GEN.river.widthMax);
  const fords = spreadRanges(rng, randInt(rng, GEN.fords.min, GEN.fords.max),
                             GEN.fords.heightMin, GEN.fords.heightMax, 6);

  for (let y = 0; y < MAP.h; y++) {
    const isFord = fords.some((f) => y >= f.y0 && y < f.y1);
    const half = width / 2;
    for (let x = Math.floor(xs[y] - half - 2); x <= Math.ceil(xs[y] + half + 2); x++) {
      if (!inBounds(x, y)) continue;
      const i = idx(x, y);
      if (map.kind[i] === T.CLIFF) continue; // the river runs through a gorge
      const d = Math.abs(x - xs[y]);
      if (d <= half) {
        map.kind[i] = isFord ? T.SHALLOW : T.DEEP;
        map.elev[i] = 0;
      } else if (d <= half + 1.6) {
        map.kind[i] = T.SHALLOW;
        map.elev[i] = 0;
      }
    }
  }
  return { type: 'river', cx, xs, gaps: fords };
}

/** Multi-source BFS distance from every water tile, capped for speed. */
function waterDistance(map, cap) {
  const dist = new Int16Array(MAP.w * MAP.h).fill(cap + 1);
  const queue = [];
  for (let i = 0; i < map.kind.length; i++) {
    if (map.kind[i] === T.DEEP || map.kind[i] === T.SHALLOW) {
      dist[i] = 0;
      queue.push(i);
    }
  }
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head];
    if (dist[i] >= cap) continue;
    const x = i % MAP.w;
    const y = (i / MAP.w) | 0;
    for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + ox;
      const ny = y + oy;
      if (!inBounds(nx, ny)) continue;
      const ni = idx(nx, ny);
      if (dist[ni] > dist[i] + 1) {
        dist[ni] = dist[i] + 1;
        queue.push(ni);
      }
    }
  }
  return dist;
}

function stampVegetation(map, rng, elevCont) {
  const moistNoise = makeNoise2D(rng);
  const patchNoise = makeNoise2D(rng);
  const wdist = waterDistance(map, 4);

  for (let y = 0; y < MAP.h; y++) {
    for (let x = 0; x < MAP.w; x++) {
      const i = idx(x, y);
      if (map.kind[i] !== T.PLAIN) continue;
      const moist = fbm(moistNoise, x * 0.055, y * 0.055, 4);
      const patch = fbm(patchNoise, x * 0.13, y * 0.13, 2);

      if (wdist[i] <= 3 && moist > 0.40 && elevCont[i] < 0.44) {
        map.kind[i] = T.MARSH;          // riverbank
      } else if (elevCont[i] < 0.32 && moist > 0.50) {
        map.kind[i] = T.MARSH;          // low wet ground
      } else if (moist > 0.50 && patch > 0.40 && map.elev[i] <= 2) {
        map.kind[i] = T.FOREST;
      }
    }
  }
}

function clearArea(map, cx, cy, r, kind = T.PLAIN, elev = 1) {
  for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
    for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
      if (!inBounds(x, y)) continue;
      if (Math.hypot(x - cx, y - cy) > r) continue;
      const i = idx(x, y);
      map.kind[i] = kind;
      map.elev[i] = elev;
    }
  }
}

/** D9: resource richness is placed as discrete deposits so the player can see it. */
function placeDeposits(map, rng, start) {
  const deposits = [];
  const add = (cx, cy, radius, peak) => {
    deposits.push({ x: cx, y: cy, r: radius, peak });
    for (let y = Math.floor(cy - radius); y <= Math.ceil(cy + radius); y++) {
      for (let x = Math.floor(cx - radius); x <= Math.ceil(cx + radius); x++) {
        if (!inBounds(x, y)) continue;
        const d = Math.hypot(x - cx, y - cy);
        if (d > radius) continue;
        const i = idx(x, y);
        const fall = peak * (1 - d / radius) ** 1.4;
        map.res[i] = Math.min(1.8, map.res[i] + fall);
      }
    }
  };

  const n = randInt(rng, GEN.deposits.min, GEN.deposits.max);
  // Keep the initial tower economically viable without guaranteeing any remote
  // location; expansion value comes from the authored random deposits.
  add(start.x + (rng() - 0.5) * 6, start.y + (rng() - 0.5) * 6, 5, 0.7);

  let placed = 0;
  let tries = 0;
  while (placed < n && tries++ < n * 40) {
    const x = randInt(rng, 4, MAP.w - 5);
    const y = randInt(rng, 3, MAP.h - 4);
    if (!isPassable(map, x, y)) continue;
    // Bias away from dead centre so expansion is rewarded.
    if (Math.abs(x - MAP.w / 2) < 14 && rng() < 0.6) continue;
    add(x, y, randInt(rng, GEN.deposits.radiusMin, GEN.deposits.radiusMax),
        GEN.deposits.peakMin + rng() * (GEN.deposits.peakMax - GEN.deposits.peakMin));
    placed++;
  }

  // Ambient floor: poor ground still pays a trickle, so the economic choice is
  // "how good is this site" rather than "is there anything here at all".
  for (let i = 0; i < map.res.length; i++) {
    if (PASSABLE[map.kind[i]]) map.res[i] = Math.min(1.8, map.res[i] + GEN.ambientResource);
  }
  return deposits;
}

function carveRoadPath(map, path) {
  const mark = (i) => {
    if (!PASSABLE[map.kind[i]]) return;
    map.road[i] = 1;
    if (map.kind[i] === T.FOREST || map.kind[i] === T.MARSH) map.kind[i] = T.PLAIN;
  };
  let previous = -1;
  for (const i of path) {
    if (previous >= 0) {
      const px = previous % MAP.w;
      const py = (previous / MAP.w) | 0;
      const x = i % MAP.w;
      const y = (i / MAP.w) | 0;
      if (x !== px && y !== py) mark(idx(x, py));
    }
    mark(i);
    previous = i;
  }
}

function gapRoadPoint(barrier, gap) {
  const y = Math.max(0, Math.min(MAP.h - 1, Math.floor((gap.y0 + gap.y1) / 2)));
  const x = Math.max(0, Math.min(MAP.w - 1, Math.round(barrier.xs[y])));
  return idx(x, y);
}

function gapHasRoad(map, barrier, gap) {
  for (let y = gap.y0; y < gap.y1; y++) {
    const cx = Math.round(barrier.xs[y]);
    for (let x = cx - 3; x <= cx + 3; x++) {
      if (inBounds(x, y) && map.road[idx(x, y)]) return true;
    }
  }
  return false;
}

function roadPointInGap(map, barrier, gap) {
  const centre = gapRoadPoint(barrier, gap);
  const cx = centre % MAP.w;
  const cy = (centre / MAP.w) | 0;
  let best = -1;
  let bestD = Infinity;
  for (let y = Math.max(0, gap.y0 - 2); y < Math.min(MAP.h, gap.y1 + 2); y++) {
    const bx = Math.round(barrier.xs[y]);
    for (let x = Math.max(0, bx - 5); x <= Math.min(MAP.w - 1, bx + 5); x++) {
      const i = idx(x, y);
      const d = Math.hypot(x - cx, y - cy);
      if (map.road[i] && d < bestD) { best = i; bestD = d; }
    }
  }
  return best;
}

/** D20: paths follow actual terrain and progressively merge onto cheap road. */
function buildRoadNetwork(map, rng) {
  const centreI = idx(map.roadCenter.x, map.roadCenter.y);
  for (const side of ['west', 'east']) {
    for (const mouth of map.spawns[side]) {
      carveRoadPath(map, findCostPath(map, idx(mouth.x, mouth.y), centreI));
    }
  }

  // Add branches from unused authored gaps into the connected main network.
  // Their endpoint is a different gap already used by a main road, so these are
  // true lateral alternatives rather than detached decorative tracks.
  const wanted = randInt(rng, ROAD.connectorsMin, ROAD.connectorsMax);
  let made = 0;
  for (const barrier of shuffle(rng, [...map.barriers])) {
    if (made >= wanted || barrier.gaps.length < 2) break;
    const used = barrier.gaps.filter((gap) => gapHasRoad(map, barrier, gap));
    const unused = barrier.gaps.filter((gap) => !gapHasRoad(map, barrier, gap));
    if (!used.length || !unused.length) continue;
    const from = gapRoadPoint(barrier, unused[Math.floor(rng() * unused.length)]);
    const to = roadPointInGap(map, barrier, used[Math.floor(rng() * used.length)]);
    if (to < 0) continue;
    const path = findCostPath(map, from, to);
    if (path.length) { carveRoadPath(map, path); made++; }
  }
  map.roadConnectors = made;
}

function keepStartTowerOffRoad(map, start) {
  const footprintClear = (cx, cy) => {
    for (let y = Math.floor(cy - TOWER.radius); y <= Math.ceil(cy + TOWER.radius); y++) {
      for (let x = Math.floor(cx - TOWER.radius); x <= Math.ceil(cx + TOWER.radius); x++) {
        if (!inBounds(x, y)) return false;
        if (Math.hypot(x + 0.5 - cx, y + 0.5 - cy) > TOWER.radius + 0.3) continue;
        if (!PASSABLE[map.kind[idx(x, y)]] || map.road[idx(x, y)]) return false;
      }
    }
    return true;
  };
  if (footprintClear(start.x + 0.5, start.y + 0.5)) return;

  for (let radius = 1; radius <= GEN.startClearRadius + 3; radius++) {
    for (let oy = -radius; oy <= radius; oy++) {
      for (let ox = -radius; ox <= radius; ox++) {
        if (Math.max(Math.abs(ox), Math.abs(oy)) !== radius) continue;
        const x = start.x + ox;
        const y = start.y + oy;
        if (footprintClear(x + 0.5, y + 0.5)) { start.x = x; start.y = y; return; }
      }
    }
  }
}

function buildMap(rng) {
  const size = MAP.w * MAP.h;
  const map = {
    w: MAP.w,
    h: MAP.h,
    kind: new Uint8Array(size),
    elev: new Uint8Array(size),
    res: new Float32Array(size),
    road: new Uint8Array(size),
  };

  const elevNoise = makeNoise2D(rng);
  const elevCont = new Float32Array(size);
  for (let y = 0; y < MAP.h; y++) {
    for (let x = 0; x < MAP.w; x++) {
      const e = fbm(elevNoise, x * 0.032, y * 0.05, 5);
      const i = idx(x, y);
      elevCont[i] = e;
      map.elev[i] = e < 0.33 ? 0 : e < 0.55 ? 1 : e < 0.74 ? 2 : 3;
    }
  }

  const columns = chooseBarrierColumns(rng);
  const barriers = stampRidges(map, rng, columns.ridges);
  if (columns.river !== null) barriers.push(stampRiver(map, rng, columns.river));
  stampVegetation(map, rng, elevCont);

  const roadCenter = { x: Math.floor(MAP.w / 2), y: Math.floor(MAP.h / 2) };
  const start = { x: roadCenter.x, y: roadCenter.y + ROAD.startOffset };
  clearArea(map, roadCenter.x, roadCenter.y, 2.5, T.PLAIN, 1);
  clearArea(map, start.x, start.y, GEN.startClearRadius, T.PLAIN, 1);

  map.barriers = barriers;
  map.start = start;
  map.roadCenter = roadCenter;
  const centreReach = floodFrom(map, [idx(roadCenter.x, roadCenter.y)]);
  map.spawns = findSpawns(map, { reachW: centreReach, reachE: centreReach });
  buildRoadNetwork(map, rng);
  keepStartTowerOffRoad(map, start);
  map.deposits = placeDeposits(map, rng, start);
  return map;
}

// ---------------------------------------------------------------------------
// Validation (D2)
// ---------------------------------------------------------------------------

function floodFrom(map, seeds) {
  const seen = new Uint8Array(MAP.w * MAP.h);
  const queue = [];
  for (const i of seeds) {
    if (!seen[i] && PASSABLE[map.kind[i]]) {
      seen[i] = 1;
      queue.push(i);
    }
  }
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head];
    const x = i % MAP.w;
    const y = (i / MAP.w) | 0;
    for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + ox;
      const ny = y + oy;
      if (!inBounds(nx, ny)) continue;
      const ni = idx(nx, ny);
      if (seen[ni] || !PASSABLE[map.kind[ni]]) continue;
      seen[ni] = 1;
      queue.push(ni);
    }
  }
  return seen;
}

function edgeSeeds(map, from, to) {
  const seeds = [];
  for (let x = from; x <= to; x++) {
    for (let y = 0; y < MAP.h; y++) {
      const i = idx(x, y);
      if (PASSABLE[map.kind[i]]) seeds.push(i);
    }
  }
  return seeds;
}

/**
 * Measure the usable passes through one barrier.
 *
 * A barrier wanders by several tiles, so a straight vertical cut can miss it
 * entirely and report one enormous "route". Instead we walk each authored gap
 * along the barrier's OWN line, take the contiguous open run that overlaps the
 * gap, and only count it if it is reachable from both map edges (which throws
 * out dead-end pockets).
 */
function analyseBarrier(map, barrier, reachW, reachE) {
  const col = (y) => Math.max(0, Math.min(MAP.w - 1, Math.round(barrier.xs[y])));
  const openAt = (y) => y >= 0 && y < MAP.h && isPassable(map, col(y), y);
  const passes = [];

  for (const gap of barrier.gaps) {
    const lo = Math.max(0, gap.y0 - 10);
    const hi = Math.min(MAP.h, gap.y1 + 10);
    let best = 0;
    let bestThrough = false;
    let run = 0;
    let runThrough = false;
    let runOverlaps = false;

    for (let y = lo; y <= hi; y++) {
      if (y < hi && openAt(y)) {
        run++;
        if (y >= gap.y0 && y < gap.y1) runOverlaps = true;
        const i = idx(col(y), y);
        if (reachW[i] && reachE[i]) runThrough = true;
      } else {
        if (runOverlaps && run > best) { best = run; bestThrough = runThrough; }
        run = 0;
        runThrough = false;
        runOverlaps = false;
      }
    }
    if (best >= VALID.minGapTiles && bestThrough) passes.push(best);
  }
  return passes;
}

export function validateMap(map, relaxed = false) {
  const reachW = floodFrom(map, edgeSeeds(map, 0, 2));
  const reachE = floodFrom(map, edgeSeeds(map, MAP.w - 3, MAP.w - 1));
  const startI = idx(map.start.x, map.start.y);

  const problems = [];
  if (!reachW[startI]) problems.push('start unreachable from west edge');
  if (!reachE[startI]) problems.push('start unreachable from east edge');
  if (map.roadConnectors < ROAD.connectorsMin) problems.push('road network has no lateral connector');

  const minRoutes = relaxed ? 1 : VALID.minRoutesPerBarrier;
  const barrierReport = [];
  let chokepoints = 0;
  for (const b of map.barriers) {
    const passes = analyseBarrier(map, b, reachW, reachE);
    chokepoints += passes.filter((p) => p <= VALID.chokepointMaxTiles).length;
    barrierReport.push({
      type: b.type, cx: b.cx, routes: passes.length,
      narrowest: passes.length ? Math.min(...passes) : 0,
      passes,
    });
    if (passes.length < minRoutes) {
      problems.push(`${b.type}@${b.cx}: ${passes.length} usable route(s), need ${minRoutes}`);
    }
  }
  if (chokepoints < (relaxed ? 1 : VALID.minChokepoints)) {
    problems.push(`only ${chokepoints} tight pass(es) on the whole map`);
  }

  let passable = 0;
  let open = 0;
  let forest = 0;
  let marsh = 0;
  let water = 0;
  let both = 0;
  for (let i = 0; i < map.kind.length; i++) {
    const k = map.kind[i];
    if (PASSABLE[k]) passable++;
    if (k === T.PLAIN) open++;
    if (k === T.FOREST) forest++;
    if (k === T.MARSH) marsh++;
    if (k === T.DEEP || k === T.SHALLOW) water++;
    if (reachW[i] && reachE[i]) both++;
  }
  const openFrac = open / Math.max(1, passable);
  const forestFrac = forest / map.kind.length;
  const contestedFrac = both / map.kind.length;

  if (openFrac < VALID.openFracMin) problems.push(`too cluttered (open ${openFrac.toFixed(2)})`);
  if (openFrac > VALID.openFracMax) problems.push(`featureless field (open ${openFrac.toFixed(2)})`);
  if (!relaxed && forestFrac < VALID.minForestFrac) problems.push(`not enough cover (forest ${forestFrac.toFixed(2)})`);
  if (marsh === 0) problems.push('no marsh survived road grading');
  if (contestedFrac < 0.30) problems.push(`battlefield too fragmented (${contestedFrac.toFixed(2)})`);

  return {
    ok: problems.length === 0,
    problems,
    barriers: barrierReport,
    openFrac, forestFrac, waterFrac: water / map.kind.length, contestedFrac, chokepoints,
    reachW, reachE,
  };
}

/** Enemy entry points: the mouths of each usable corridor on the two edges. */
function findSpawns(map, report) {
  const gather = (x, reach) => {
    const points = [];
    let run = [];
    for (let y = 0; y <= MAP.h; y++) {
      const ok = y < MAP.h && isPassable(map, x, y) && reach[idx(x, y)];
      if (ok) run.push(y);
      else {
        if (run.length >= 2) points.push({ x, y: run[(run.length / 2) | 0] });
        run = [];
      }
    }
    return points;
  };
  let west = gather(1, report.reachW);
  let east = gather(MAP.w - 2, report.reachE);
  if (!west.length) west = [{ x: 1, y: Math.round(MAP.h / 2) }];
  if (!east.length) east = [{ x: MAP.w - 2, y: Math.round(MAP.h / 2) }];
  return { west, east };
}

/** D2/D8: regenerate until the map is tactically valid, then relax rather than hang. */
export function generateMap(seedString) {
  const base = hashString(String(seedString));
  let lastMap = null;
  let lastReport = null;

  for (let attempt = 0; attempt < GEN.maxRelaxedAttempts; attempt++) {
    const relaxed = attempt >= GEN.maxAttempts;
    const map = buildMap(makeRng((base + attempt * 7919) >>> 0));
    const report = validateMap(map, relaxed);
    lastMap = map;
    lastReport = report;
    if (report.ok) {
      map.seed = String(seedString);
      map.attempts = attempt + 1;
      map.relaxed = relaxed;
      map.report = report;
      return map;
    }
  }

  // Never hand back nothing; the debug panel will show why this one is off-spec.
  lastMap.seed = String(seedString);
  lastMap.attempts = GEN.maxRelaxedAttempts;
  lastMap.relaxed = true;
  lastMap.report = lastReport;
  return lastMap;
}

export function randomSeed() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}
