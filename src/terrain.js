// D1/D2: terrain is authored by algorithm in deliberate passes, then validated
// and thrown away if it does not produce the tactical shape the prototype needs.

import { MAP, T, PASSABLE, MOVE_COST, ELEV_BANDS, GEN, RESOURCE_GEN, NEST, VALID, ROAD, TOWER, KEEP,
         BLOCKS_SIGHT_ALWAYS, BLOCKS_SIGHT_UNLESS_ABOVE } from './config.js';
import { hashString, makeRng, makeNoise2D, fbm, randInt, shuffle } from './rng.js';
import { analyseRoadKnots, analyseRoadReadability } from './roadexposure.js';
import { buildSimpleRoads, analyseRoadNetwork } from './roads.js';

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
  const fractions = [0.09, 0.17, 0.25, 0.33, 0.41, 0.59, 0.67, 0.75, 0.83, 0.91];
  const candidates = shuffle(rng, fractions).map((f) => Math.round(f * MAP.w));

  // The river is claimed first so every map reliably has one; ridges then keep
  // clear of it, so a ridge never seals the fords.
  const river = candidates[0];
  const ridgeCount = randInt(rng, GEN.ridges.min, GEN.ridges.max);
  const ridges = [];
  for (const c of candidates.slice(1)) {
    if (ridges.length >= ridgeCount) break;
    if (Math.abs(c - river) < 22) continue;
    if (ridges.every((r) => Math.abs(r - c) >= 17)) ridges.push(c);
  }
  return { ridges, river };
}

function stampRidges(map, rng, columns) {
  const barriers = [];
  for (const cx of columns) {
    const xs = wanderingLine(rng, cx, GEN.ridges.wander);
    const thickness = randInt(rng, GEN.ridges.thicknessMin, GEN.ridges.thicknessMax);
    // Deliberate gaps: at least two, so the ridge is a chokepoint and not a wall.
    const gapCount = rng() < 0.58 ? 4 : 3;
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
                             GEN.fords.heightMin, GEN.fords.heightMax, GEN.fords.minSeparation);

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

/** D80: a Farm uses the mean of its complete 3x3, and needs a majority fertile. */
export function farmSiteInfo(map, x, y) {
  const cx = Math.floor(x);
  const cy = Math.floor(y);
  let fertileTiles = 0;
  let sum = 0;
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      if (!inBounds(cx + ox, cy + oy)) continue;
      const fertility = map.fertility?.[idx(cx + ox, cy + oy)] || 0;
      if (fertility > 0) fertileTiles++;
      sum += fertility;
    }
  }
  return { valid: fertileTiles >= 5, fertileTiles, mean: sum / 9 };
}

function resourceDistance(map, x, y) {
  return Math.hypot(x - (map.start.x + 0.5), y - (map.start.y + 0.5));
}

function resourceTileOK(map, x, y) {
  return inBounds(x, y) && PASSABLE[map.kind[idx(x, y)]] && !map.road[idx(x, y)];
}

function farmCentreOK(map, x, y) {
  let usable = 0;
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      const tx = x + ox;
      const ty = y + oy;
      if (inBounds(tx, ty) && map.kind[idx(tx, ty)] === T.PLAIN && !map.road[idx(tx, ty)]) usable++;
    }
  }
  return usable >= 7;
}

function findResourceTile(map, rng, predicate, separatedFrom = [], minSeparation = 0) {
  const margin = RESOURCE_GEN.siteEdgeMargin;
  const separated = (x, y) => separatedFrom.every((s) => Math.hypot(x + 0.5 - s.x, y + 0.5 - s.y) >= minSeparation);
  for (let tries = 0; tries < 700; tries++) {
    const x = randInt(rng, margin, MAP.w - margin - 1);
    const y = randInt(rng, margin, MAP.h - margin - 1);
    if (separated(x, y) && predicate(x, y)) return { x, y };
  }
  // Deterministic fallback means geography guarantees do not depend on lucky
  // rejection sampling in a crowded map.
  const candidates = [];
  for (let y = margin; y < MAP.h - margin; y++) {
    for (let x = margin; x < MAP.w - margin; x++) {
      if (separated(x, y) && predicate(x, y)) candidates.push({ x, y });
    }
  }
  return candidates.length ? candidates[Math.floor(rng() * candidates.length)] : null;
}

function stampFarmland(map, cx, cy, radius, tier, mult) {
  const site = {
    id: `farmland-${map.farmland.length}`, type: 'farmland',
    x: cx + 0.5, y: cy + 0.5, r: radius, tier, mult,
  };
  map.farmland.push(site);
  for (let y = Math.floor(cy - radius); y <= Math.ceil(cy + radius); y++) {
    for (let x = Math.floor(cx - radius); x <= Math.ceil(cx + radius); x++) {
      if (!inBounds(x, y) || Math.hypot(x - cx, y - cy) > radius) continue;
      const i = idx(x, y);
      // Farmland is readable cultivated Plain, never a road or another biome.
      if (map.kind[i] === T.PLAIN && !map.road[i]) map.fertility[i] = Math.max(map.fertility[i], mult);
    }
  }
  return site;
}

function addPointSite(list, type, x, y, tier, mult) {
  const site = { id: `${type}-${list.length}`, type, x: x + 0.5, y: y + 0.5, tier, mult };
  list.push(site);
  return site;
}

/** D80: replace continuous Materials richness with distance-graded features. */
function placeResourceSites(map, rng) {
  map.fertility = new Float32Array(MAP.w * MAP.h);
  map.farmland = [];
  map.stoneSites = [];
  map.goldSites = [];
  const F = RESOURCE_GEN.farmland;
  const S = RESOURCE_GEN.stone;
  const G = RESOURCE_GEN.gold;

  // Two modest, separated fields are guaranteed inside the Keep's local area.
  for (let n = 0; n < F.minNearFarms; n++) {
    const q = findResourceTile(map, rng, (x, y) => {
      const d = resourceDistance(map, x + 0.5, y + 0.5);
      return d >= F.nearCentreMin && d <= RESOURCE_GEN.nearRadius && farmCentreOK(map, x, y);
    }, map.farmland, F.minSeparation);
    if (q) stampFarmland(map, q.x, q.y, 4, 'fertile', F.fertile);
  }

  // The first expansion band always contains a visibly stronger field.
  const middleFarm = findResourceTile(map, rng, (x, y) => {
    const d = resourceDistance(map, x + 0.5, y + 0.5);
    return d >= F.richFrom && d <= RESOURCE_GEN.middleRadius && farmCentreOK(map, x, y);
  }, map.farmland, F.minSeparation);
  if (middleFarm) stampFarmland(map, middleFarm.x, middleFarm.y, 4, 'rich', F.rich);

  const farmTarget = randInt(rng, F.minBlobs, F.maxBlobs);
  while (map.farmland.length < farmTarget) {
    const q = findResourceTile(map, rng, (x, y) => farmCentreOK(map, x, y), map.farmland, F.minSeparation);
    if (!q) break;
    const d = resourceDistance(map, q.x + 0.5, q.y + 0.5);
    const richChance = d >= RESOURCE_GEN.middleRadius ? F.richChanceFar : F.richChanceMiddle;
    const rich = d >= F.richFrom && rng() < richChance;
    stampFarmland(map, q.x, q.y, randInt(rng, F.radiusMin, F.radiusMax),
      rich ? 'rich' : 'fertile', rich ? F.rich : F.fertile);
  }

  // A modest stone outcrop is always reachable from the Keep's opening area.
  for (let n = 0; n < S.minNear; n++) {
    const q = findResourceTile(map, rng, (x, y) => {
      const d = resourceDistance(map, x + 0.5, y + 0.5);
      return d >= S.nearCentreMin && d <= RESOURCE_GEN.nearRadius && resourceTileOK(map, x, y);
    }, map.stoneSites, S.minSeparation);
    if (q) addPointSite(map.stoneSites, 'stone', q.x, q.y, 'normal', S.normal);
  }
  const stoneTarget = randInt(rng, S.min, S.max);
  const middleStone = findResourceTile(map, rng, (x, y) => {
    const d = resourceDistance(map, x + 0.5, y + 0.5);
    return d > RESOURCE_GEN.nearRadius && d <= RESOURCE_GEN.middleRadius && resourceTileOK(map, x, y);
  }, map.stoneSites, S.minSeparation);
  if (middleStone) addPointSite(map.stoneSites, 'stone', middleStone.x, middleStone.y, 'normal', S.normal);
  // Seed the far band with the best stone before filling intermediate sites.
  const farStone = findResourceTile(map, rng, (x, y) => resourceTileOK(map, x, y)
    && resourceDistance(map, x + 0.5, y + 0.5) >= RESOURCE_GEN.farRadius,
  map.stoneSites, S.minSeparation);
  if (farStone) addPointSite(map.stoneSites, 'stone', farStone.x, farStone.y, 'rich', S.rich);
  while (map.stoneSites.length < stoneTarget) {
    const q = findResourceTile(map, rng, (x, y) => resourceTileOK(map, x, y), map.stoneSites, S.minSeparation);
    if (!q) break;
    const rich = resourceDistance(map, q.x + 0.5, q.y + 0.5) >= S.richFrom && rng() < 0.72;
    addPointSite(map.stoneSites, 'stone', q.x, q.y, rich ? 'rich' : 'normal', rich ? S.rich : S.normal);
  }

  const goldTarget = randInt(rng, G.min, G.max);
  // The first gold is in the middle band; another rich site is guaranteed far
  // away. No gold exists in the Keep's 28-tile safety region.
  const middleGold = findResourceTile(map, rng, (x, y) => {
    const d = resourceDistance(map, x + 0.5, y + 0.5);
    return d >= RESOURCE_GEN.goldExclusionRadius && d <= RESOURCE_GEN.middleRadius && resourceTileOK(map, x, y);
  }, map.goldSites, G.minSeparation);
  if (middleGold) addPointSite(map.goldSites, 'gold', middleGold.x, middleGold.y, 'normal', G.normal);
  const farGold = findResourceTile(map, rng, (x, y) => resourceTileOK(map, x, y)
    && resourceDistance(map, x + 0.5, y + 0.5) >= RESOURCE_GEN.farRadius,
  map.goldSites, G.minSeparation);
  if (farGold) addPointSite(map.goldSites, 'gold', farGold.x, farGold.y, 'rich', G.rich);
  while (map.goldSites.length < goldTarget) {
    const q = findResourceTile(map, rng, (x, y) => resourceTileOK(map, x, y)
      && resourceDistance(map, x + 0.5, y + 0.5) >= RESOURCE_GEN.goldExclusionRadius,
    map.goldSites, G.minSeparation);
    if (!q) break;
    const rich = resourceDistance(map, q.x + 0.5, q.y + 0.5) >= G.richFrom && rng() < 0.78;
    addPointSite(map.goldSites, 'gold', q.x, q.y, rich ? 'rich' : 'normal', rich ? G.rich : G.normal);
  }
  map.sites = [...map.farmland, ...map.stoneSites, ...map.goldSites];
}

/**
 * D92: a nest sits in open ground near a valuable site: every rich gold site,
 * most normal gold and about half the worthwhile stone. Its 3x3 footprint and
 * the ring around it must be open, so a nest never plugs a pass or a road.
 */
function nestGroundOK(map, x, y) {
  for (let oy = -2; oy <= 2; oy++) {
    for (let ox = -2; ox <= 2; ox++) {
      const tx = x + ox;
      const ty = y + oy;
      if (!inBounds(tx, ty)) return false;
      const kind = map.kind[idx(tx, ty)];
      if (!PASSABLE[kind] || kind === T.SHALLOW) return false;
      if (Math.abs(ox) <= 1 && Math.abs(oy) <= 1 && map.road[idx(tx, ty)]) return false;
    }
  }
  return true;
}

function placeNests(map, rng) {
  map.nests = [];
  const valuable = [];
  // The guaranteed middle-band gold (the first placed) stays unguarded, so a
  // first Gold Mine never requires a siege; the rich far gold is contested.
  for (const s of map.goldSites.slice(1)) {
    if (s.tier === 'rich' || rng() < NEST.normalGoldChance) valuable.push(s);
  }
  for (const s of map.stoneSites) {
    const d = resourceDistance(map, s.x, s.y);
    if ((s.tier === 'rich' || d > RESOURCE_GEN.nearRadius * 2) && rng() < NEST.stoneChance) valuable.push(s);
  }
  // Gold first: the brief's picture is "Gold Deposit + Hostile Nest".
  const target = randInt(rng, NEST.countMin, NEST.countMax);
  const allSites = [...map.stoneSites, ...map.goldSites];
  for (const site of valuable) {
    if (map.nests.length >= target) break;
    if (resourceDistance(map, site.x, site.y) < NEST.minFromKeep) continue;
    let placed = null;
    for (let tries = 0; tries < 40 && !placed; tries++) {
      const a = rng() * Math.PI * 2;
      const r = NEST.siteOffsetMin + rng() * (NEST.siteOffsetMax - NEST.siteOffsetMin);
      const x = Math.floor(site.x + Math.cos(a) * r);
      const y = Math.floor(site.y + Math.sin(a) * r);
      if (x < 3 || y < 3 || x > MAP.w - 4 || y > MAP.h - 4) continue;
      if (resourceDistance(map, x + 0.5, y + 0.5) < NEST.minFromKeep) continue;
      if (!nestGroundOK(map, x, y)) continue;
      if (map.nests.some((n) => Math.hypot(n.x - x - 0.5, n.y - y - 0.5) < NEST.minSeparation)) continue;
      if (allSites.some((s) => Math.hypot(s.x - x - 0.5, s.y - y - 0.5) < 2.5)) continue;
      placed = { x, y };
    }
    if (placed) {
      map.nests.push({ id: `nest-${map.nests.length}`, x: placed.x + 0.5, y: placed.y + 0.5, guards: site.id });
    }
  }
}

/** The generation-side D80 contract, also useful to tests/debug surfaces. */
export function validateResourceGeography(map) {
  const problems = [];
  if (!map.fertility || !map.stoneSites || !map.goldSites) return { ok: true, problems, skipped: true };
  const sx = map.start.x + 0.5;
  const sy = map.start.y + 0.5;
  const viable = [];
  for (let y = 1; y < MAP.h - 1; y++) {
    for (let x = 1; x < MAP.w - 1; x++) {
      if (Math.hypot(x + 0.5 - sx, y + 0.5 - sy) > RESOURCE_GEN.nearRadius) continue;
      if (!farmSiteInfo(map, x + 0.5, y + 0.5).valid) continue;
      if (viable.every((q) => Math.hypot(q.x - x, q.y - y) >= 3)) viable.push({ x, y });
    }
  }
  const nearStone = map.stoneSites.filter((s) => Math.hypot(s.x - sx, s.y - sy) <= RESOURCE_GEN.nearRadius
    && s.tier === 'normal').length;
  const nearGold = map.goldSites.filter((s) => Math.hypot(s.x - sx, s.y - sy) < RESOURCE_GEN.goldExclusionRadius).length;
  const middleGold = map.goldSites.filter((s) => {
    const d = Math.hypot(s.x - sx, s.y - sy);
    return d >= RESOURCE_GEN.goldExclusionRadius && d <= RESOURCE_GEN.middleRadius;
  }).length;
  const farStone = map.stoneSites.filter((s) => s.tier === 'rich'
    && Math.hypot(s.x - sx, s.y - sy) >= RESOURCE_GEN.farRadius).length;
  const farGold = map.goldSites.filter((s) => s.tier === 'rich'
    && Math.hypot(s.x - sx, s.y - sy) >= RESOURCE_GEN.farRadius).length;
  const middleRichFarmland = map.farmland.filter((s) => {
    const d = Math.hypot(s.x - sx, s.y - sy);
    return s.tier === 'rich' && d >= RESOURCE_GEN.farmland.richFrom && d <= RESOURCE_GEN.middleRadius;
  }).length;
  const middleStone = map.stoneSites.filter((s) => {
    const d = Math.hypot(s.x - sx, s.y - sy);
    return d > RESOURCE_GEN.nearRadius && d <= RESOURCE_GEN.middleRadius;
  }).length;
  if (viable.length < RESOURCE_GEN.farmland.minNearFarms) problems.push(`only ${viable.length} near-Keep farm sites`);
  if (nearStone < RESOURCE_GEN.stone.minNear) problems.push('no modest stone site near the Keep');
  if (nearGold) problems.push(`${nearGold} gold site(s) inside the Keep exclusion`);
  if (!middleRichFarmland) problems.push('no rich farmland in the middle distance');
  if (!middleStone) problems.push('no stone site in the middle distance');
  if (!middleGold) problems.push('no gold site in the middle distance');
  if (!farStone) problems.push('no rich stone in far territory');
  if (!farGold) problems.push('no rich gold in far territory');
  return {
    ok: problems.length === 0, problems, viableNearFarms: viable.length,
    nearStone, nearGold, middleRichFarmland, middleStone, middleGold, farStone, farGold,
  };
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

function keepStartTowerOffRoad(map, start) {
  const footprintClear = (cx, cy) => {
    for (let y = Math.floor(cy - KEEP.radius); y <= Math.ceil(cy + KEEP.radius); y++) {
      for (let x = Math.floor(cx - KEEP.radius); x <= Math.ceil(cx + KEEP.radius); x++) {
        if (!inBounds(x, y)) return false;
        if (Math.hypot(x + 0.5 - cx, y + 0.5 - cy) > KEEP.radius + 0.3) continue;
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
  buildSimpleRoads(map, rng);
  keepStartTowerOffRoad(map, start);
  return map;
}

/**
 * D96: no exposure features or other authored road bends. Resources and nests
 * are placed only on the map generateMap keeps.
 */
function finishMap(map, rng) {
  map.exposureFeatures = [];
  placeResourceSites(map, rng);
  placeNests(map, rng);
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
  // D96: hard road rules. A road per side, no self-crossing, no loops, no knots.
  const roads = analyseRoadNetwork(map);
  for (const side of ['west', 'east']) {
    if (!(map.roadRoutes || []).some((r) => r.side === side && r.kind === 'main')) problems.push(`no ${side} road`);
  }
  if (roads.selfIntersections) problems.push(`${roads.selfIntersections} self-intersecting road(s)`);
  if (roads.loops) problems.push(`${roads.loops} road(s) touching another away from a junction`);
  const knots = analyseRoadKnots(map).count;
  if (knots) problems.push(`${knots} road knot(s)`);

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
  const resources = validateResourceGeography(map);
  if (!resources.ok) problems.push(...resources.problems);

  return {
    ok: problems.length === 0,
    problems,
    barriers: barrierReport,
    openFrac, forestFrac, waterFrac: water / map.kind.length, contestedFrac, chokepoints,
    roads,
    resources,
    reachW, reachE,
  };
}

/** Enemy entry points: the mouths of each usable corridor on the two edges. */
function findSpawns(map, report) {
  const gather = (x, reach) => {
    const points = [];
    // D79: the larger edge gets several authored mouths even when its entire
    // length happens to be one connected passable run.
    for (let n = 0; n < ROAD.mouthsPerSide; n++) {
      const target = Math.round(((n + 0.5) / ROAD.mouthsPerSide) * (MAP.h - 1));
      let best = -1;
      let bestDistance = Infinity;
      for (let y = 2; y < MAP.h - 2; y++) {
        if (!isPassable(map, x, y) || !reach[idx(x, y)]) continue;
        if (points.some((p) => Math.abs(p.y - y) < ROAD.mouthMinSeparation)) continue;
        const distance = Math.abs(y - target);
        if (distance < bestDistance) { best = y; bestDistance = distance; }
      }
      if (best >= 0) points.push({ x, y: best });
    }
    return points.sort((a, b) => a.y - b.y);
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
  // D96: road rules are part of validity, so the first valid map is kept.
  const finish = ({ map, rng, relaxed }, attempts) => {
    finishMap(map, rng);
    map.seed = String(seedString);
    map.attempts = attempts;
    map.relaxed = relaxed;
    map.report = validateMap(map, relaxed);
    map.roadDefects = { knots: analyseRoadKnots(map).count, readability: analyseRoadReadability(map).count };
    return map;
  };

  for (let attempt = 0; attempt < GEN.maxRelaxedAttempts; attempt++) {
    const relaxed = attempt >= GEN.maxAttempts;
    const rng = makeRng((base + attempt * 7919) >>> 0);
    const map = buildMap(rng);
    lastMap = { map, rng, relaxed };
    if (validateMap(map, relaxed).ok) return finish(lastMap, attempt + 1);
  }

  // Never hand back nothing; the debug panel will show why this one is off-spec.
  finishMap(lastMap.map, lastMap.rng);
  lastMap = lastMap.map;
  lastMap.seed = String(seedString);
  lastMap.attempts = GEN.maxRelaxedAttempts;
  lastMap.relaxed = true;
  lastMap.report = validateMap(lastMap, true);
  return lastMap;
}

export function randomSeed() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}
