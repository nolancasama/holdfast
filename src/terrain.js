// D1/D2: terrain is authored by algorithm in deliberate passes, then validated
// and thrown away if it does not produce the tactical shape the prototype needs.

import { MAP, T, PASSABLE, MOVE_COST, ELEV_BANDS, GEN, VALID, ROAD, TOWER, EXPOSURE_GEN, READABILITY, richnessTierForRate,
         BLOCKS_SIGHT_ALWAYS, BLOCKS_SIGHT_UNLESS_ABOVE } from './config.js';
import { hashString, makeRng, makeNoise2D, fbm, randInt, shuffle } from './rng.js';
import { findCostPath } from './flowfield.js';
import {
  analyseRoadKnots, analyseRoadReadability, findExposureFeatures, measureSiteExposure,
} from './roadexposure.js';

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
  const add = (cx, cy, radius, peak, apply = true) => {
    const deposit = { x: cx, y: cy, r: radius, peak };
    deposits.push(deposit);
    if (!apply) return deposit;
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
    return deposit;
  };

  const n = randInt(rng, GEN.deposits.min, GEN.deposits.max);
  // Consume the same seeded centre rolls before the remote seams, but defer
  // this blob until every other deposit and the ambient floor are present.
  const startDeposit = add(
    start.x + (rng() - 0.5) * 6,
    start.y + (rng() - 0.5) * 6,
    5,
    0,
    false,
  );
  startDeposit.start = true;

  let placed = 0;
  let tries = 0;
  while (placed < n && tries++ < n * 40) {
    const x = randInt(rng, 4, MAP.w - 5);
    const y = randInt(rng, 3, MAP.h - 4);
    if (!isPassable(map, x, y)) continue;
    // Keep the safe starting area mediocre; richer authored seams begin where
    // expansion exposes the player to real travel and defence tradeoffs.
    const fromStart = Math.hypot(x - start.x, y - start.y);
    if (fromStart < GEN.deposits.startExclusionRadius
        || (fromStart < GEN.deposits.startBufferRadius && rng() < GEN.deposits.startBufferRejectChance)) continue;
    const centreDistance = Math.min(1, fromStart / (MAP.w * GEN.deposits.distanceMapFraction));
    let nearestRoad = GEN.deposits.roadDistanceNormalizer;
    for (let oy = -GEN.deposits.roadSearchRadius; oy <= GEN.deposits.roadSearchRadius; oy++) {
      for (let ox = -GEN.deposits.roadSearchRadius; ox <= GEN.deposits.roadSearchRadius; ox++) {
        const nx = x + ox;
        const ny = y + oy;
        if (inBounds(nx, ny) && map.road[idx(nx, ny)]) nearestRoad = Math.min(nearestRoad, Math.hypot(ox, oy));
      }
    }
    // Rich seams skew away from the safe centre and obvious road chokepoints.
    // This creates economic temptation without manufacturing a defensible site.
    const awkward = Math.min(1, centreDistance * GEN.deposits.distanceWeight
      + (nearestRoad / GEN.deposits.roadDistanceNormalizer) * GEN.deposits.roadDistanceWeight);
    const peakSpan = GEN.deposits.peakMax - GEN.deposits.peakMin;
    const peak = GEN.deposits.peakMin + peakSpan * Math.min(1,
      awkward * GEN.deposits.awkwardnessWeight + rng() * GEN.deposits.randomWeight);
    add(x, y, randInt(rng, GEN.deposits.radiusMin, GEN.deposits.radiusMax), peak);
    placed++;
  }

  // Ambient floor: poor ground still pays a trickle, so the economic choice is
  // "how good is this site" rather than "is there anything here at all".
  for (let i = 0; i < map.res.length; i++) {
    if (PASSABLE[map.kind[i]]) map.res[i] = Math.min(1.8, map.res[i] + GEN.ambientResource);
  }

  // D68: deterministically solve the deferred start blob against the actual
  // generated tower site. The monotone binary search accounts for overlap with
  // remote seams and the per-tile 1.8 cap without moving any rich seam closer.
  const startCells = [];
  for (let y = Math.floor(startDeposit.y - startDeposit.r); y <= Math.ceil(startDeposit.y + startDeposit.r); y++) {
    for (let x = Math.floor(startDeposit.x - startDeposit.r); x <= Math.ceil(startDeposit.x + startDeposit.r); x++) {
      if (!inBounds(x, y)) continue;
      const distance = Math.hypot(x - startDeposit.x, y - startDeposit.y);
      if (distance > startDeposit.r) continue;
      startCells.push({ i: idx(x, y), kernel: (1 - distance / startDeposit.r) ** 1.4 });
    }
  }
  const base = new Float32Array(startCells.length);
  for (let n = 0; n < startCells.length; n++) base[n] = map.res[startCells[n].i];
  const incomeAtStart = (peak) => {
    let sum = 0;
    const radius = TOWER.extraction.radius;
    for (let y = Math.floor(start.y + 0.5 - radius); y <= Math.ceil(start.y + 0.5 + radius); y++) {
      for (let x = Math.floor(start.x + 0.5 - radius); x <= Math.ceil(start.x + 0.5 + radius); x++) {
        if (!inBounds(x, y) || Math.hypot(x - start.x, y - start.y) > radius) continue;
        const cell = startCells.findIndex((entry) => entry.i === idx(x, y));
        sum += cell < 0 ? map.res[idx(x, y)] : Math.min(1.8, base[cell] + peak * startCells[cell].kernel);
      }
    }
    return (sum / TOWER.extraction.normalizer) * TOWER.extraction.baseRate;
  };
  let lo = 0;
  let hi = 1;
  while (incomeAtStart(hi) < GEN.deposits.startIncomeTarget && hi < 16) hi *= 2;
  for (let pass = 0; pass < 32; pass++) {
    const mid = (lo + hi) * 0.5;
    if (incomeAtStart(mid) < GEN.deposits.startIncomeTarget) lo = mid;
    else hi = mid;
  }
  startDeposit.peak = (lo + hi) * 0.5;
  for (let n = 0; n < startCells.length; n++) {
    const cell = startCells[n];
    map.res[cell.i] = Math.min(1.8, base[n] + startDeposit.peak * cell.kernel);
  }
  // The start marker represents the calibrated extraction site, not the
  // jittered kernel centre (whose local preview can differ from the tower).
  startDeposit.markerX = start.x;
  startDeposit.markerY = start.y;

  for (const d of deposits) {
    let sum = 0;
    const radius = TOWER.extraction.radius;
    // The authored start-region marker describes the starting tower site; a
    // jittered blob centroid can otherwise label the same calibrated region Rich.
    const cx = d.markerX ?? d.x;
    const cy = d.markerY ?? d.y;
    for (let y = Math.floor(cy - radius); y <= Math.ceil(cy + radius); y++) {
      for (let x = Math.floor(cx - radius); x <= Math.ceil(cx + radius); x++) {
        if (!inBounds(x, y) || Math.hypot(x - cx, y - cy) > radius) continue;
        sum += map.res[idx(x, y)];
      }
    }
    d.income = (sum / TOWER.extraction.normalizer) * TOWER.extraction.baseRate;
    d.richness = richnessTierForRate(d.income).key;
  }
  return deposits;
}

/** D69: towers grade only nearby forest; every other map layer is immutable. */
export function clearTowerForest(map, x, y, radius = TOWER.forestClearRadius) {
  let changed = 0;
  for (let ty = Math.floor(y - radius); ty <= Math.ceil(y + radius); ty++) {
    for (let tx = Math.floor(x - radius); tx <= Math.ceil(x + radius); tx++) {
      if (!inBounds(tx, ty)) continue;
      if (Math.hypot(tx + 0.5 - x, ty + 0.5 - y) > radius + 1e-9) continue;
      const i = idx(tx, ty);
      if (map.kind[i] !== T.FOREST) continue;
      map.kind[i] = T.PLAIN;
      changed++;
    }
  }
  if (changed) map.terrainVersion = (map.terrainVersion || 0) + 1;
  return changed;
}

/** The terrain-only half of tower placement (D49).
 * Passing an array is used by canPlaceAt to retain its exact refusal strings.
 */
export function isTerrainBuildable(map, x, y, reasons = null) {
  const failures = reasons || [];
  const r = TOWER.radius;
  let minE = 9;
  let maxE = -1;
  for (let ty = Math.floor(y - r); ty <= Math.ceil(y + r); ty++) {
    for (let tx = Math.floor(x - r); tx <= Math.ceil(x + r); tx++) {
      if (Math.hypot(tx + 0.5 - x, ty + 0.5 - y) > r + 0.3) continue;
      if (!inBounds(tx, ty)) { failures.push('off the map'); continue; }
      const k = kindAt(map, tx, ty);
      if (k === T.CLIFF) failures.push('cliff');
      else if (k === T.DEEP) failures.push('deep water');
      if (map.road[idx(tx, ty)]) failures.push('on the road');
      const e = elevAt(map, tx, ty);
      minE = Math.min(minE, e);
      maxE = Math.max(maxE, e);
    }
  }
  if (maxE - minE > 1) failures.push('ground too steep');
  return failures.length === 0;
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
      // A diagonal step needs one corner tile to read as continuous road. D55:
      // pick it the same way whichever direction the road is walked; a
      // direction-dependent corner painted BOTH corners wherever two routes
      // shared a diagonal in opposite directions - a solid band four tiles wide.
      if (x !== px && y !== py) {
        const upper = y < py ? { x, y } : { x: px, y: py };
        const lower = y < py ? { x: px, y: py } : { x, y };
        const corner = idx(lower.x, upper.y);
        mark(PASSABLE[map.kind[corner]] ? corner : idx(upper.x, lower.y));
      }
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

function nearestPassable(map, x, y) {
  const cx = Math.max(1, Math.min(MAP.w - 2, Math.round(x)));
  const cy = Math.max(1, Math.min(MAP.h - 2, Math.round(y)));
  for (let r = 0; r <= 8; r++) {
    for (let oy = -r; oy <= r; oy++) {
      for (let ox = -r; ox <= r; ox++) {
        if (Math.max(Math.abs(ox), Math.abs(oy)) !== r) continue;
        if (isPassable(map, cx + ox, cy + oy)) return idx(cx + ox, cy + oy);
      }
    }
  }
  return -1;
}

function routeWaypoints(map, rng, mouth, side) {
  if (rng() >= ROAD.waypointChance) return [];
  const direction = side === 'west' ? 1 : -1;
  const distance = Math.abs(map.roadCenter.x - mouth.x);
  const x = mouth.x + direction * distance * (0.34 + rng() * 0.28);
  const sign = rng() < 0.5 ? -1 : 1;
  const offset = ROAD.waypointYOffsetMin
    + rng() * (ROAD.waypointYOffsetMax - ROAD.waypointYOffsetMin);
  const y = Math.max(3, Math.min(MAP.h - 4, mouth.y + sign * offset));
  const waypoint = nearestPassable(map, x, y);
  return waypoint >= 0 ? [waypoint] : [];
}

/**
 * Keep an alternate approach out of the first road's corridor before it merges.
 * D55: the corridor must be wide. A narrow ring priced the alternate just
 * outside it, so it ran alongside the first road 3-4 tiles away - the
 * near-parallel strands that read as one tangled band at full-map scale.
 * The ground around the branch point stays free so the fork can leave cleanly.
 */
function markRoadAvoidance(map, side, branch = -1) {
  const avoid = new Uint8Array(MAP.w * MAP.h);
  const radius = ROAD.parallelRoadAvoidRadius;
  const bx = branch % MAP.w;
  const by = (branch / MAP.w) | 0;
  for (let y = 0; y < MAP.h; y++) {
    for (let x = 0; x < MAP.w; x++) {
      if (!map.road[idx(x, y)]) continue;
      for (let oy = -radius; oy <= radius; oy++) {
        for (let ox = -radius; ox <= radius; ox++) {
          const nx = x + ox;
          const ny = y + oy;
          if (!inBounds(nx, ny) || Math.abs(ox) + Math.abs(oy) > radius) continue;
          if (branch >= 0 && Math.hypot(nx - bx, ny - by) <= ROAD.branchClearRadius) continue;
          if ((side === 'west' && nx < map.roadCenter.x)
              || (side === 'east' && nx > map.roadCenter.x)) avoid[idx(nx, ny)] = 1;
        }
      }
    }
  }
  return avoid;
}

/** D54: every boundary tile except the entry tiles beside each spawn mouth. */
function boundaryAvoidance(map) {
  // Two tiles deep: a road one column in reads as running along the edge too.
  const avoid = new Uint8Array(MAP.w * MAP.h);
  for (let x = 0; x < MAP.w; x++) {
    for (const y of [0, 1, MAP.h - 2, MAP.h - 1]) avoid[idx(x, y)] = 1;
  }
  for (let y = 0; y < MAP.h; y++) {
    for (const x of [0, 1, MAP.w - 2, MAP.w - 1]) avoid[idx(x, y)] = 1;
  }
  for (const side of ['west', 'east']) {
    const columns = side === 'west' ? [0, 1] : [MAP.w - 1, MAP.w - 2];
    for (const mouth of map.spawns[side]) {
      for (const x of columns) {
        for (const oy of [-1, 0, 1]) if (inBounds(x, mouth.y + oy)) avoid[idx(x, mouth.y + oy)] = 0;
      }
    }
  }
  return avoid;
}

/**
 * D54: the visible start of an entry road - the boundary tile on the mouth's
 * row, then the mouth itself. Enemies still spawn at the mouth, one tile in.
 */
function entryPath(map, mouth, side) {
  const edgeX = side === 'west' ? 0 : MAP.w - 1;
  const mouthI = idx(mouth.x, mouth.y);
  for (const oy of [0, -1, 1]) {
    const y = mouth.y + oy;
    if (inBounds(edgeX, y) && isPassable(map, edgeX, y)) return [idx(edgeX, y), mouthI];
  }
  return [mouthI];
}

function parallelWaypoint(map, mouth, side, ordinal) {
  const direction = side === 'west' ? 1 : -1;
  const distance = Math.abs(map.roadCenter.x - mouth.x);
  const x = mouth.x + direction * distance * ROAD.parallelRouteFraction;
  const sign = ordinal % 2 ? 1 : -1;
  const y = Math.max(3, Math.min(MAP.h - 4,
    mouth.y + sign * (ROAD.parallelRouteYOffsetMin + ordinal * 3)));
  return nearestPassable(map, x, y);
}

/** D20/D33: terrain physics, seeded waypoints, and cheap reuse shape the roads. */
function buildRoadNetwork(map, rng) {
  const centreI = idx(map.roadCenter.x, map.roadCenter.y);
  map.roadRoutes = [];
  map.roadConnectorPaths = [];
  // D54: roads meet the map boundary only where they enter it. Everywhere
  // else the boundary is priced like an alternate's avoided corridor.
  const edgeAvoid = boundaryAvoidance(map);
  for (const side of ['west', 'east']) {
    const mouths = map.spawns[side];
    // Three west and two east approaches make 3+ road-run columns a normal
    // outcome, while still keeping the whole network to five main routes.
    const routeCount = Math.max(side === 'west' ? 3 : 2, mouths.length);
    const primaryPaths = [];
    for (let routeIndex = 0; routeIndex < routeCount; routeIndex++) {
      const mouthIndex = routeIndex % mouths.length;
      const mouth = mouths[mouthIndex];
      const alternate = routeIndex >= mouths.length;
      const forcedWaypoint = alternate ? parallelWaypoint(map, mouth, side, routeIndex - mouths.length + 1) : -1;
      const stops = [...routeWaypoints(map, rng, mouth, side), centreI];
      if (forcedWaypoint >= 0) stops.unshift(forcedWaypoint);
      // D54/D55: a primary route enters from the boundary; an alternate from
      // the same mouth shares that entry trunk and forks off a few tiles in,
      // so the edge shows one road that splits rather than a splay of strands.
      const route = alternate
        ? primaryPaths[mouthIndex].slice(0, ROAD.entryTrunkLength + 1)
        : entryPath(map, mouth, side);
      carveRoadPath(map, route);
      let from = route[route.length - 1];
      for (let legIndex = 0; legIndex < stops.length; legIndex++) {
        const to = stops[legIndex];
        map.roadAvoid = alternate && legIndex === 0
          ? markRoadAvoidance(map, side, from).map((v, i) => v | edgeAvoid[i]) : edgeAvoid;
        const leg = findCostPath(map, from, to);
        map.roadAvoid = null;
        if (!leg.length) continue;
        carveRoadPath(map, leg);
        route.push(...leg.slice(1));
        from = to;
      }
      if (!alternate) primaryPaths[mouthIndex] = route;
      map.roadRoutes.push({ side, mouth: { ...mouth }, path: route });
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
    map.roadAvoid = edgeAvoid;
    const path = findCostPath(map, from, to);
    map.roadAvoid = null;
    if (path.length) { carveRoadPath(map, path); map.roadConnectorPaths.push(path); made++; }
  }
  map.roadConnectors = made;
  cleanRoadNetwork(map);
}

/**
 * D51: a route that visits a waypoint and comes back along its own road keeps
 * the out-and-back tiles in its path and on the map as a dead-end stub. Erase
 * those revisits, rebuild the road layer from what enemies can actually follow,
 * then prune any dead end that is still left.
 */
function eraseLoops(path) {
  const out = [];
  const at = new Map();
  for (const i of path) {
    if (at.has(i)) {
      const keep = at.get(i);
      for (let k = keep + 1; k < out.length; k++) at.delete(out[k]);
      out.length = keep + 1;
    } else {
      at.set(i, out.length);
      out.push(i);
    }
  }
  return out;
}

function rebuildRoadLayer(map) {
  map.road.fill(0);
  for (const route of map.roadRoutes) carveRoadPath(map, route.path);
  for (const path of map.roadConnectorPaths) carveRoadPath(map, path);
}

function roadDegree(map, x, y) {
  let n = 0;
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      if ((ox || oy) && inBounds(x + ox, y + oy) && map.road[idx(x + ox, y + oy)]) n++;
    }
  }
  return n;
}

function protectedRoadEnd(map, x, y) {
  if (x <= 2 || y <= 2 || x >= MAP.w - 3 || y >= MAP.h - 3) return true;
  if (Math.hypot(x - map.roadCenter.x, y - map.roadCenter.y) <= 2) return true;
  return [...map.spawns.west, ...map.spawns.east].some((m) => Math.hypot(x - m.x, y - m.y) <= 2);
}

function pruneDeadEnds(map) {
  for (let changed = true; changed;) {
    changed = false;
    for (let y = 0; y < MAP.h; y++) {
      for (let x = 0; x < MAP.w; x++) {
        const i = idx(x, y);
        if (!map.road[i] || roadDegree(map, x, y) > 1 || protectedRoadEnd(map, x, y)) continue;
        map.road[i] = 0;
        changed = true;
      }
    }
  }
  // Paths must stay on road: drop connector paths that pruning emptied.
  const onRoad = (path) => path.every((i) => map.road[i]);
  map.roadConnectorPaths = map.roadConnectorPaths.filter(onRoad);
}

/** Shortest 8-neighbour walk that stays on road tiles and avoids `forbidden`. */
function roadOnlyPath(map, from, to, forbidden, onPath = null) {
  const dist = new Float32Array(MAP.w * MAP.h).fill(Infinity);
  const prev = new Int32Array(MAP.w * MAP.h).fill(-1);
  const open = [from];
  dist[from] = 0;
  while (open.length) {
    let bi = 0;
    for (let k = 1; k < open.length; k++) if (dist[open[k]] < dist[open[bi]]) bi = k;
    const i = open[bi];
    open[bi] = open[open.length - 1];
    open.pop();
    if (i === to) break;
    const x = i % MAP.w;
    const y = (i / MAP.w) | 0;
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        if (!ox && !oy) continue;
        const nx = x + ox;
        const ny = y + oy;
        if (!inBounds(nx, ny)) continue;
        const ni = idx(nx, ny);
        if (!map.road[ni] || forbidden.has(ni)) continue;
        // D55: walk another path's own tiles, not the corner fills beside them;
        // cutting corner to corner would lay a fresh strand next to the road.
        const nd = dist[i] + (ox && oy ? Math.SQRT2 : 1) + (onPath && !onPath.has(ni) ? 0.6 : 0);
        if (nd < dist[ni]) {
          if (dist[ni] === Infinity) open.push(ni);
          dist[ni] = nd;
          prev[ni] = i;
        }
      }
    }
  }
  if (!Number.isFinite(dist[to])) return null;
  const out = [to];
  for (let i = to; i !== from; i = prev[i]) out.push(prev[i]);
  return out.reverse();
}

/**
 * D51: small loops and braids appear where two separately carved paths run a
 * tile or two apart. Near each remaining knot, try moving one path onto road
 * another path already provides, dropping the tiles only it was using. Keep the
 * change only if the knot count falls.
 */
function mergeKnottedPaths(map) {
  const paths = () => [...map.roadRoutes.map((r) => r.path), ...map.roadConnectorPaths];
  const setPath = (n, path) => {
    if (n < map.roadRoutes.length) map.roadRoutes[n].path = path;
    else map.roadConnectorPaths[n - map.roadRoutes.length] = path;
  };
  // D55: readability defects (strands laid side by side, near-passes) are
  // repaired the same way; a merge is kept only if knots do not rise, the
  // combined count falls, and the D44 parallel-approach gate is not broken.
  const score = () => {
    const k = analyseRoadKnots(map);
    const r = analyseRoadReadability(map);
    // A side-by-side strand runs further than a knot; repair the whole run.
    const sites = [...k.knots.map((p) => ({ ...p, reach: 7 })), ...r.defects.map((p) => ({ ...p, reach: 13 }))];
    return { k, r, total: k.count + r.count, parallel: parallelOk(map), sites };
  };
  let knots = score();
  for (let pass = 0; pass < 16 && knots.total; pass++) {
    let improved = false;
    for (const knot of knots.sites) {
      const all = paths();
      const usage = new Map();
      for (const p of all) for (const i of new Set(p)) usage.set(i, (usage.get(i) || 0) + 1);
      const near = (i) => Math.hypot(i % MAP.w + 0.5 - knot.x, ((i / MAP.w) | 0) + 0.5 - knot.y) <= knot.reach;
      for (let n = 0; n < all.length && !improved; n++) {
        const p = all[n];
        let k0 = -1;
        let k1 = -1;
        for (let k = 0; k < p.length; k++) if (near(p[k])) { if (k0 < 0) k0 = k; k1 = k; }
        if (k0 < 0 || k1 - k0 < 2) continue;
        k0 = Math.max(0, k0 - 2);
        k1 = Math.min(p.length - 1, k1 + 2);
        const forbidden = new Set();
        for (let k = k0 + 1; k < k1; k++) if (usage.get(p[k]) === 1) forbidden.add(p[k]);
        if (!forbidden.size) continue;
        const detour = roadOnlyPath(map, p[k0], p[k1], forbidden, usage);
        if (!detour) continue;
        const saved = snapshotRoads(map);
        setPath(n, eraseLoops([...p.slice(0, k0), ...detour, ...p.slice(k1 + 1)]));
        rebuildRoadLayer(map);
        pruneDeadEnds(map);
        const after = score();
        if (after.total < knots.total && after.k.count <= knots.k.count && (after.parallel || !knots.parallel)) {
          knots = after;
          improved = true;
        } else restoreRoads(map, saved);
      }
      if (improved) break;
    }
    if (!improved) break;
  }
}

/** The D44 parallel-approach part of the validation gate, on its own. */
function parallelOk(map) {
  const p = measureParallelRoadRoutes(map);
  return p.west.median >= VALID.parallelRouteMedianMin && p.east.median >= VALID.parallelRouteMedianMin
    && p.west.columnsWithThree + p.east.columnsWithThree >= VALID.parallelRouteColumnsWithThreeMin;
}

function cleanRoadNetwork(map) {
  for (const route of map.roadRoutes) route.path = eraseLoops(route.path);
  map.roadConnectorPaths = map.roadConnectorPaths.map(eraseLoops);
  rebuildRoadLayer(map);
  pruneDeadEnds(map);
  mergeKnottedPaths(map);
}

function measureParallelRoadRoutes(map) {
  const halves = {
    west: { max: 0, runs: [], columnsWithThree: 0 },
    east: { max: 0, runs: [], columnsWithThree: 0 },
  };
  for (const side of ['west', 'east']) {
    const from = side === 'west' ? 4 : map.roadCenter.x + 1;
    const to = side === 'west' ? map.roadCenter.x : MAP.w - 4;
    const half = halves[side];
    for (let x = from; x < to; x++) {
      let runs = 0;
      let inRun = false;
      for (let y = 0; y < MAP.h; y++) {
        if (map.road[idx(x, y)]) {
          if (!inRun) { runs++; inRun = true; }
        } else inRun = false;
      }
      half.runs.push(runs);
      half.max = Math.max(half.max, runs);
      if (runs >= 3) half.columnsWithThree++;
    }
    const sorted = [...half.runs].sort((a, b) => a - b);
    half.median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
    delete half.runs;
  }
  return halves;
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
    terrainVersion: 0,
  };

  const elevNoise = makeNoise2D(rng);
  const elevCont = new Float32Array(size);
  for (let y = 0; y < MAP.h; y++) {
    for (let x = 0; x < MAP.w; x++) {
      const e = fbm(elevNoise, x * 0.032, y * 0.05, 5);
      const i = idx(x, y);
      elevCont[i] = e;
      map.elev[i] = e < GEN.elevationCuts[0] ? 0 : e < GEN.elevationCuts[1] ? 1 : 2;
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
  map.waterDist = waterDistance(map, ROAD.riverCheapRadius);
  buildRoadNetwork(map, rng);
  keepStartTowerOffRoad(map, start);
  return map;
}

/**
 * D52: exposure features are authored only onto a network that already
 * validates, so a failed feature is undone locally instead of costing a whole
 * regenerated map. D55: this runs only for the map generateMap keeps, with that
 * attempt's own rng, so judging several candidate networks stays cheap.
 */
function finishMap(map, rng) {
  map.exposureFeatures = [];
  if (validateMap(map).ok) authorExposureFeatures(map, rng);
  map.deposits = placeDeposits(map, rng, map.start);
  return map;
}

function snapshotRoads(map) {
  return {
    kind: map.kind.slice(), elev: map.elev.slice(), road: map.road.slice(),
    routes: map.roadRoutes.map((r) => r.path), connectors: [...map.roadConnectorPaths],
  };
}

function restoreRoads(map, s) {
  map.kind.set(s.kind); map.elev.set(s.elev); map.road.set(s.road);
  map.roadRoutes.forEach((r, n) => { r.path = s.routes[n]; });
  map.roadConnectorPaths = [...s.connectors];
}

const tileXY = (i) => ({ x: i % MAP.w, y: (i / MAP.w) | 0 });

/** Candidate spots: straight, single-use stretches of a route, away from the start and mouths. */
function featureCandidates(map, rng) {
  const usage = new Map();
  for (const p of [...map.roadRoutes.map((r) => r.path), ...map.roadConnectorPaths]) {
    for (const i of new Set(p)) usage.set(i, (usage.get(i) || 0) + 1);
  }
  const reach = EXPOSURE_GEN.segmentHalf;
  const out = [];
  map.roadRoutes.forEach((route, n) => {
    const p = route.path;
    for (let k = reach; k + reach < p.length; k += 2) {
      const c = tileXY(p[k]);
      const a = tileXY(p[k - 6]);
      const b = tileXY(p[k + 6]);
      if (c.x < 10 || c.x > MAP.w - 11 || c.y < 6 || c.y > MAP.h - 7) continue;
      if (Math.hypot(c.x - map.start.x, c.y - map.start.y) < EXPOSURE_GEN.minFromStart) continue;
      const h1 = Math.atan2(c.y - a.y, c.x - a.x);
      const h2 = Math.atan2(b.y - c.y, b.x - c.x);
      let turn = Math.abs(h2 - h1);
      if (turn > Math.PI) turn = Math.PI * 2 - turn;
      if (turn > 0.8) continue;
      out.push({ route: n, k });
    }
  });
  return shuffle(rng, out);
}

/** 8-connected tile line between two tile-space points (Bresenham). */
function rasterLine(a, b) {
  const out = [];
  let x = Math.round(a.x);
  let y = Math.round(a.y);
  const x1 = Math.round(b.x);
  const y1 = Math.round(b.y);
  const dx = Math.abs(x1 - x);
  const dy = Math.abs(y1 - y);
  const sx = x < x1 ? 1 : -1;
  const sy = y < y1 ? 1 : -1;
  let err = dx - dy;
  for (;;) {
    out.push(inBounds(x, y) ? idx(x, y) : -1);
    if (x === x1 && y === y1) return out;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x += sx; }
    if (e2 < dx) { err += dx; y += sy; }
  }
}

/**
 * D52: a short impassable spine (rock spur or water inlet) is stamped across
 * a straight route stretch, and that stretch is re-laid as a U round the
 * spine's tip: out along one side, across past the tip, back along the other.
 * D48 measured why the spine is essential - without it enemies cut the U's
 * neck. The shape is laid explicitly rather than left to the carve pathfinder,
 * which either ignored the detour (distant cheap road won) or hugged the spine
 * too tightly to leave room for a tower. The result is kept only if the D49
 * measurement finds a strong, readable, buildable site that enemies walk past.
 * Returns 'cheap' for rejections made before anything was changed.
 */
function tryExposureFeature(map, rng, cand, sign, depth) {
  const G = EXPOSURE_GEN;
  const route = map.roadRoutes[cand.route];
  const p = route.path;
  const c = tileXY(p[cand.k]);
  const a = tileXY(p[cand.k - 6]);
  const b = tileXY(p[cand.k + 6]);
  const dl = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const d = { x: (b.x - a.x) / dl, y: (b.y - a.y) / dl };
  const n = { x: -d.y * sign, y: d.x * sign };

  const kind = rng() < G.waterChance ? T.DEEP : T.CLIFF;
  const at = (along, out) => ({ x: c.x + d.x * along + n.x * out, y: c.y + d.y * along + n.y * out });
  const tileAt = (q) => (inBounds(Math.round(q.x), Math.round(q.y)) ? idx(Math.round(q.x), Math.round(q.y)) : -1);
  const inside = (i) => {
    if (i < 0) return false;
    const { x, y } = tileXY(i);
    return x >= 2 && y >= 2 && x <= MAP.w - 3 && y <= MAP.h - 3;
  };

  const spine = new Set();
  for (let s = -G.rootBehind; s <= depth; s += 0.5) {
    for (let w = 0; w < G.spineWidth; w++) {
      const i = tileAt(at(w - (G.spineWidth - 1) / 2, s));
      if (!inside(i)) { return 'cheap'; }
      spine.add(i);
    }
  }

  const bend = depth + G.bendBeyondTip;
  // The re-laid stretch runs from the first route tile clear of the legs on
  // one side to the first clear on the other, however curved the road is.
  const along = (i) => { const q = tileXY(i); return (q.x - c.x) * d.x + (q.y - c.y) * d.y; };
  let kFrom = -1;
  for (let j = cand.k - 1; j >= Math.max(0, cand.k - G.segmentHalf); j--) {
    if (along(p[j]) <= -G.legHalfGap - 2) { kFrom = j; break; }
  }
  let kTo = -1;
  for (let j = cand.k + 1; j <= Math.min(p.length - 1, cand.k + G.segmentHalf); j++) {
    if (along(p[j]) >= G.legHalfGap + 2) { kTo = j; break; }
  }
  if (kFrom < 0 || kTo < 0) { return 'cheap'; }
  const from = p[kFrom];
  const to = p[kTo];
  const corners = [at(-G.legHalfGap, 0), at(-G.legHalfGap, bend), at(G.legHalfGap, bend), at(G.legHalfGap, 0)];
  const points = [tileXY(from), ...corners, tileXY(to)];
  const u = [];
  for (let k = 1; k < points.length; k++) u.push(...rasterLine(points[k - 1], points[k]).slice(k > 1 ? 1 : 0));
  if (new Set(u).size !== u.length) { return 'cheap'; }

  // Find every path that uses this stretch. Each must carry it whole (either
  // direction), or re-laying it would strand a partial overlap.
  const stretch = p.slice(kFrom, kTo + 1);
  const stretchSet = new Set(stretch);
  const handles = [
    ...map.roadRoutes.map((r) => ({ get: () => r.path, set: (v) => { r.path = v; } })),
    ...map.roadConnectorPaths.map((_, m) => ({
      get: () => map.roadConnectorPaths[m], set: (v) => { map.roadConnectorPaths[m] = v; },
    })),
  ];
  const sharers = [];
  for (const h of handles) {
    const q = h.get();
    if (!q.some((i) => stretchSet.has(i))) continue;
    const fwd = q.indexOf(stretch[0]);
    const rev = q.indexOf(stretch[stretch.length - 1]);
    const matches = (start, list) => start >= 0 && list.every((i, m) => q[start + m] === i);
    if (matches(fwd, stretch)) sharers.push({ ...h, start: fwd, reversed: false });
    else if (matches(rev, [...stretch].reverse())) sharers.push({ ...h, start: rev, reversed: true });
    else { return 'cheap'; }
  }

  const oldStretch = new Set();
  // The sharing paths' own road just beyond the stretch is not "another" road.
  const own = G.otherRoadClearance + 2;
  for (const s of sharers) {
    const q = s.get();
    for (const i of q.slice(Math.max(0, s.start - own), s.start + stretch.length + own)) {
      const { x, y } = tileXY(i);
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) if (inBounds(x + ox, y + oy)) oldStretch.add(idx(x + ox, y + oy));
      }
    }
  }
  const clearOfOtherRoad = (i, r) => {
    const { x, y } = tileXY(i);
    for (let oy = -r; oy <= r; oy++) {
      for (let ox = -r; ox <= r; ox++) {
        if (!inBounds(x + ox, y + oy)) continue;
        const j = idx(x + ox, y + oy);
        if (map.road[j] && !oldStretch.has(j)) return false;
      }
    }
    return true;
  };
  for (const i of u) {
    if (!inside(i) || spine.has(i) || !PASSABLE[map.kind[i]]) { return 'blocked'; }
    if (!clearOfOtherRoad(i, G.otherRoadClearance)) { return 'cheap'; }
  }
  for (const i of spine) {
    const { x, y } = tileXY(i);
    if (Math.hypot(x - map.start.x, y - map.start.y) < GEN.startClearRadius + 4) { return 'cheap'; }
    if (!clearOfOtherRoad(i, G.otherRoadClearance)) { return 'cheap'; }
  }

  const before = snapshotRoads(map);
  const readabilityBefore = analyseRoadReadability(map).count;
  const fail = () => { restoreRoads(map, before); return null; };
  for (const i of spine) {
    map.kind[i] = kind;
    if (kind === T.DEEP) map.elev[i] = 0;
  }
  // Road builders clear the inside of a bend: open, level-enough ground where a
  // tower can stand and see both legs.
  const pocketI = tileAt(at(0, depth + G.pocketOffset));
  const pocketElev = map.elev[pocketI];
  for (let along = -G.legHalfGap + 1; along <= G.legHalfGap - 1; along += 0.5) {
    for (let out = 1; out <= bend - 1; out += 0.5) {
      const i = tileAt(at(along, out));
      if (i < 0 || spine.has(i)) continue;
      if (map.kind[i] === T.FOREST || map.kind[i] === T.MARSH) map.kind[i] = T.PLAIN;
      if (out > depth && Math.abs(map.elev[i] - pocketElev) > 1) map.elev[i] = pocketElev;
    }
  }

  // Every path sharing the stretch (a trunk several routes use) takes the U.
  for (const s of sharers) {
    const q = s.get();
    const piece = s.reversed ? [...u].reverse() : u;
    const next = [...q.slice(0, s.start), ...piece, ...q.slice(s.start + stretch.length)];
    if (eraseLoops(next).length !== next.length) return fail();
    for (let k = 1; k < next.length; k++) {
      const q0 = tileXY(next[k - 1]);
      const q1 = tileXY(next[k]);
      if (q0.x !== q1.x && q0.y !== q1.y
          && (!PASSABLE[map.kind[idx(q1.x, q0.y)]] || !PASSABLE[map.kind[idx(q0.x, q1.y)]])) return fail();
    }
    s.set(next);
  }
  rebuildRoadLayer(map);
  pruneDeadEnds(map);

  if (analyseRoadKnots(map).count) return fail();
  // D55: a feature may not make the road network harder to read.
  if (analyseRoadReadability(map).count > readabilityBefore) return fail();
  const pocket = tileXY(pocketI);
  const found = findExposureFeatures(map, { region: { x: pocket.x + 0.5, y: pocket.y + 0.5, r: bend + 2 } })
    .filter((f) => f.tier === 'strong' && f.readable);
  if (!found.length) return fail();
  const best = found[0];
  if (best.efficiency < READABILITY.minExposureEfficiency) return fail();
  const walked = measureSiteExposure(map, best.x, best.y);
  const onRoad = walked.walked.filter((q) => map.road[idx(Math.floor(q.x), Math.floor(q.y))]).length;
  if (onRoad / walked.walked.length < G.minWalkedOnRoad) return fail();
  if (!validateMap(map).ok) return fail();
  return {
    x: best.x, y: best.y, exposure: best.exposure, ratio: best.ratio, kind: best.kind,
    extraLength: best.extraLength, efficiency: best.efficiency,
    spine: kind === T.DEEP ? 'water' : 'rock',
  };
}

function authorExposureFeatures(map, rng) {
  const target = randInt(rng, EXPOSURE_GEN.targetMin, EXPOSURE_GEN.targetMax);
  let tries = 0;
  // Candidates are re-read after every accepted feature, which moves roads.
  let candidates = featureCandidates(map, rng);
  for (let n = 0; n < candidates.length; n++) {
    if (map.exposureFeatures.length >= target || tries >= EXPOSURE_GEN.maxTries) break;
    const cand = candidates[n];
    const c = tileXY(map.roadRoutes[cand.route].path[cand.k]);
    if (map.exposureFeatures.some((f) => Math.hypot(f.x - c.x, f.y - c.y) < EXPOSURE_GEN.minApart)) continue;
    const first = rng() < 0.5 ? 1 : -1;
    const depth = randInt(rng, EXPOSURE_GEN.depthMin, EXPOSURE_GEN.depthMax);
    let made = null;
    for (const sign of [first, -first]) {
      // A U that runs into rock or water may still fit with a shorter spine.
      for (const tryDepth of depth > EXPOSURE_GEN.depthMin ? [depth, EXPOSURE_GEN.depthMin] : [depth]) {
        made = tryExposureFeature(map, rng, cand, sign, tryDepth);
        if (made === 'blocked') continue;
        break;
      }
      if (made === 'cheap' || made === 'blocked') { made = null; continue; }
      tries++;
      if (made) break;
    }
    if (made) {
      map.exposureFeatures.push(made);
      candidates = featureCandidates(map, rng);
      n = -1;
    }
  }
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
  const parallelRoutes = measureParallelRoadRoutes(map);
  for (const side of ['west', 'east']) {
    if (parallelRoutes[side].median < VALID.parallelRouteMedianMin) {
      problems.push(`${side} roads have median ${parallelRoutes[side].median}, need ${VALID.parallelRouteMedianMin} separate runs`);
    }
  }
  const columnsWithThree = parallelRoutes.west.columnsWithThree + parallelRoutes.east.columnsWithThree;
  if (columnsWithThree < VALID.parallelRouteColumnsWithThreeMin) {
    problems.push(`only ${columnsWithThree} road columns have 3+ runs, need ${VALID.parallelRouteColumnsWithThreeMin}`);
  }

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
    parallelRoutes, columnsWithThree,
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
  // D55: a valid map whose roads still carry knots or readability defects is
  // kept, and a few more attempts look for a clean one. The least-defective
  // valid map wins if none turns up; a strict map is never traded for relaxing.
  let fallback = null;
  let extra = 0;
  const finish = (candidate, attempts) => {
    const { map, rng, relaxed } = candidate;
    finishMap(map, rng);
    map.seed = String(seedString);
    map.attempts = attempts;
    map.relaxed = relaxed;
    map.report = validateMap(map, relaxed);
    const knots = analyseRoadKnots(map);
    const readability = analyseRoadReadability(map);
    map.roadDefects = { knots: knots.count, readability: readability.count };
    return map;
  };

  for (let attempt = 0; attempt < GEN.maxRelaxedAttempts; attempt++) {
    const relaxed = attempt >= GEN.maxAttempts;
    if (relaxed && fallback) return finish(fallback, attempt);
    const rng = makeRng((base + attempt * 7919) >>> 0);
    const map = buildMap(rng);
    const report = validateMap(map, relaxed);
    lastMap = { map, rng, relaxed };
    lastReport = report;
    if (report.ok) {
      const defects = analyseRoadKnots(map).count + analyseRoadReadability(map).count;
      const candidate = { map, rng, relaxed, defects };
      if (!defects || relaxed) return finish(candidate, attempt + 1);
      if (!fallback || defects < fallback.defects) fallback = candidate;
      if (++extra > GEN.readableExtraAttempts) return finish(fallback, attempt + 1);
    }
  }

  // Never hand back nothing; the debug panel will show why this one is off-spec.
  finishMap(lastMap.map, lastMap.rng);
  lastMap = lastMap.map;
  lastMap.seed = String(seedString);
  lastMap.attempts = GEN.maxRelaxedAttempts;
  lastMap.relaxed = true;
  lastMap.report = lastReport;
  return lastMap;
}

export function randomSeed() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}
