// D96: simple roads. A road is a readable transport and invasion route, not a
// tower-exposure device. Each road is routed with a strong turn penalty, pulled
// tight into a few straight segments, validated (no self-crossing, no near
// self-pass, spacing from unrelated roads, a turn budget) and skipped if it
// fails. Every road ends where it first meets the network, so the network is a
// tree: no loops, junctions only where a road joins.

import { MAP, T, PASSABLE, ROAD } from './config.js';

const idx = (x, y) => y * MAP.w + x;
const inBounds = (x, y) => x >= 0 && y >= 0 && x < MAP.w && y < MAP.h;
const N = () => MAP.w * MAP.h;

// Eight directions, clockwise from east; turning by k steps is k x 45 degrees.
const DIRS = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
const STEP_LEN = DIRS.map(([x, y]) => (x && y ? Math.SQRT2 : 1));

class Heap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.k.length; }
  push(v, k) {
    const K = this.k; const V = this.v;
    K.push(k); V.push(v);
    let i = K.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (K[p] <= K[i]) break;
      [K[p], K[i]] = [K[i], K[p]]; [V[p], V[i]] = [V[i], V[p]];
      i = p;
    }
  }
  pop() {
    const K = this.k; const V = this.v;
    const top = V[0];
    const lk = K.pop(); const lv = V.pop();
    if (K.length) {
      K[0] = lk; V[0] = lv;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1; const r = l + 1;
        let m = i;
        if (l < K.length && K[l] < K[m]) m = l;
        if (r < K.length && K[r] < K[m]) m = r;
        if (m === i) break;
        [K[m], K[i]] = [K[i], K[m]]; [V[m], V[i]] = [V[i], V[m]];
        i = m;
      }
    }
    return top;
  }
}

/** Chebyshev distance from every tile to the nearest road tile, capped. */
export function roadDistance(map, cap = ROAD.spacing + 2) {
  const d = new Uint8Array(N()).fill(cap);
  const queue = [];
  for (let i = 0; i < N(); i++) if (map.road[i]) { d[i] = 0; queue.push(i); }
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head];
    if (d[i] + 1 >= cap) continue;
    const x = i % MAP.w; const y = (i / MAP.w) | 0;
    for (const [ox, oy] of DIRS) {
      const nx = x + ox; const ny = y + oy;
      if (!inBounds(nx, ny)) continue;
      const n = idx(nx, ny);
      if (d[n] > d[i] + 1) { d[n] = d[i] + 1; queue.push(n); }
    }
  }
  return d;
}

function edgeBand(x, y) {
  return x <= 1 || y <= 1 || x >= MAP.w - 2 || y >= MAP.h - 2;
}

/** Terrain cost of laying road on tile i arriving from tile j (no turn cost). */
function tileCost(map, ctx, i, j) {
  const base = ROAD.carveCost[map.kind[i]];
  if (!Number.isFinite(base)) return Infinity;
  const x = i % MAP.w; const y = (i / MAP.w) | 0;
  let cost = base + Math.abs(map.elev[i] - map.elev[j]) * ROAD.elevationCrossingCost;
  if (edgeBand(x, y) && !ctx.entry.has(i)) cost += ROAD.edgeCost;
  const near = ctx.dist[i];
  if (near < ROAD.spacing && !ctx.goal[i]) cost += (ROAD.spacing - near) * ROAD.proximityCost;
  return cost;
}

/**
 * Direction-aware Dijkstra from `start` (heading `dir0`) to any goal tile.
 * Existing road is impassable except at goal tiles, so a road can only meet
 * the network at its end.
 */
function routeRoad(map, ctx, start, dir0) {
  const S = N() * 8;
  const dist = new Float32Array(S).fill(Infinity);
  const prev = new Int32Array(S).fill(-1);
  const heap = new Heap();
  const s0 = start * 8 + dir0;
  dist[s0] = 0;
  heap.push(s0, 0);
  const turnCost = [0, ROAD.turn45, ROAD.turn90];
  while (heap.size) {
    const s = heap.pop();
    const i = (s / 8) | 0;
    const d = s % 8;
    const here = dist[s];
    if (ctx.goal[i]) {
      const path = [];
      for (let t = s; t >= 0; t = prev[t]) path.push((t / 8) | 0);
      return { path: path.reverse(), cost: here };
    }
    const x = i % MAP.w; const y = (i / MAP.w) | 0;
    for (let nd = 0; nd < 8; nd++) {
      const turn = Math.min((nd - d + 8) % 8, (d - nd + 8) % 8);
      if (turn > 2) continue;
      const [ox, oy] = DIRS[nd];
      const nx = x + ox; const ny = y + oy;
      if (!inBounds(nx, ny)) continue;
      const ni = idx(nx, ny);
      if (map.road[ni] && !ctx.goal[ni]) continue;
      if (ox && oy) {
        const c1 = idx(nx, y); const c2 = idx(x, ny);
        if (!PASSABLE[map.kind[c1]] || !PASSABLE[map.kind[c2]]) continue;
        if ((map.road[c1] && !ctx.goal[c1]) || (map.road[c2] && !ctx.goal[c2])) continue;
      }
      const c = tileCost(map, ctx, ni, i);
      if (!Number.isFinite(c)) continue;
      const ns = ni * 8 + nd;
      const nv = Math.fround(here + c * STEP_LEN[nd] + turnCost[turn]);
      if (nv < dist[ns]) { dist[ns] = nv; prev[ns] = s; heap.push(ns, nv); }
    }
  }
  return null;
}

/** 8-connected raster line between two tiles (inclusive). */
export function rasterSegment(a, b) {
  let x0 = a % MAP.w; let y0 = (a / MAP.w) | 0;
  const x1 = b % MAP.w; const y1 = (b / MAP.w) | 0;
  const dx = Math.abs(x1 - x0); const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1; const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  const out = [idx(x0, y0)];
  while (x0 !== x1 || y0 !== y1) {
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
    out.push(idx(x0, y0));
  }
  return out;
}

/** Cost of a tile run under the router's terrain rules; Infinity if illegal. */
function runCost(map, ctx, tiles, last) {
  let cost = 0;
  let climbs = 0;
  for (let k = 1; k < tiles.length; k++) {
    const i = tiles[k]; const j = tiles[k - 1];
    if (map.road[i] && !(k === tiles.length - 1 && last && ctx.goal[i])) return { cost: Infinity, climbs };
    const xi = i % MAP.w; const yi = (i / MAP.w) | 0;
    const xj = j % MAP.w; const yj = (j / MAP.w) | 0;
    if (xi !== xj && yi !== yj) {
      const c1 = idx(xi, yj); const c2 = idx(xj, yi);
      if (!PASSABLE[map.kind[c1]] || !PASSABLE[map.kind[c2]]) return { cost: Infinity, climbs };
      if ((map.road[c1] && !ctx.goal[c1]) || (map.road[c2] && !ctx.goal[c2])) return { cost: Infinity, climbs };
    }
    const c = tileCost(map, ctx, i, j);
    if (!Number.isFinite(c)) return { cost: Infinity, climbs };
    if (map.elev[i] !== map.elev[j]) climbs++;
    cost += c * (xi !== xj && yi !== yj ? Math.SQRT2 : 1);
  }
  return { cost, climbs };
}

/**
 * Line-of-sight simplification: from each vertex jump to the farthest later
 * raw-path tile whose straight segment is legal, no costlier than the raw
 * stretch it replaces and climbs no more often.
 */
function pullTight(map, ctx, raw) {
  const vertices = [0];
  let i = 0;
  while (i < raw.length - 1) {
    let chosen = i + 1;
    for (let j = raw.length - 1; j > i + 1; j--) {
      const seg = runCost(map, ctx, rasterSegment(raw[i], raw[j]), j === raw.length - 1);
      if (!Number.isFinite(seg.cost)) continue;
      const orig = runCost(map, ctx, raw.slice(i, j + 1), j === raw.length - 1);
      if (seg.cost <= orig.cost * ROAD.pullSlack + 0.5 && seg.climbs <= orig.climbs) { chosen = j; break; }
    }
    vertices.push(chosen);
    i = chosen;
  }
  const points = vertices.map((k) => raw[k]);
  const path = [points[0]];
  for (let k = 1; k < points.length; k++) path.push(...rasterSegment(points[k - 1], points[k]).slice(1));
  return { path, vertices: points };
}

function tileXY(i) { return { x: i % MAP.w, y: (i / MAP.w) | 0 }; }

/**
 * Direction changes along a polyline: `turns` counts real bends (over
 * ROAD.turnDegrees), `gentle` the slight kinks a raster line needs to thread a
 * gap, and `sharpest` the largest.
 */
export function polylineTurns(vertices) {
  let turns = 0;
  let gentle = 0;
  let sharpest = 0;
  for (let k = 1; k + 1 < vertices.length; k++) {
    const a = tileXY(vertices[k - 1]); const b = tileXY(vertices[k]); const c = tileXY(vertices[k + 1]);
    const h1 = Math.atan2(b.y - a.y, b.x - a.x); const h2 = Math.atan2(c.y - b.y, c.x - b.x);
    let delta = Math.abs(h2 - h1);
    if (delta > Math.PI) delta = 2 * Math.PI - delta;
    const deg = delta * 180 / Math.PI;
    if (deg > ROAD.turnDegrees) turns++;
    else if (deg > 5) gentle++;
    sharpest = Math.max(sharpest, deg);
  }
  return { turns, gentle, sharpest };
}

/** Hard per-road rules; returns the first broken rule or null. */
function roadProblem(map, ctx, path, vertices, maxTurns) {
  const seen = new Set();
  for (const i of path) {
    if (seen.has(i)) return 'self-intersection';
    seen.add(i);
  }
  // No near self-pass: two stretches far apart along the road but close on the map.
  const pts = path.map(tileXY);
  for (let a = 0; a < pts.length; a++) {
    for (let b = a + ROAD.selfPassGap; b < pts.length; b++) {
      if (Math.max(Math.abs(pts[a].x - pts[b].x), Math.abs(pts[a].y - pts[b].y)) <= ROAD.selfPassDistance) {
        return 'near self-pass';
      }
    }
  }
  // Spacing: away from its own junction, the road keeps clear of every other road.
  const free = ROAD.spacing + 2;
  for (let k = 0; k < path.length - free; k++) {
    if (ctx.dist[path[k]] < ROAD.minSeparation) return 'too close to another road';
  }
  const { turns, sharpest } = polylineTurns(vertices);
  if (turns > maxTurns) return `too many turns (${turns})`;
  if (sharpest > ROAD.maxTurnDegrees) return `turn too sharp (${Math.round(sharpest)} deg)`;
  if (isHairpin(vertices)) return 'hairpin';
  // Straight stretches, not a jagged run of short segments.
  if (vertices.length - 1 > path.length / ROAD.minTilesPerSegment + 1) return 'too jagged';
  return null;
}

/**
 * A hairpin built from several legal bends: the heading swings by
 * ROAD.hairpinDegrees or more (same direction) within ROAD.hairpinWindow tiles.
 */
export function isHairpin(vertices) {
  const pts = vertices.map(tileXY);
  const heading = [];
  const length = [];
  for (let k = 1; k < pts.length; k++) {
    heading.push(Math.atan2(pts[k].y - pts[k - 1].y, pts[k].x - pts[k - 1].x));
    length.push(Math.hypot(pts[k].x - pts[k - 1].x, pts[k].y - pts[k - 1].y));
  }
  for (let a = 0; a < heading.length; a++) {
    let swing = 0;
    let span = 0;
    for (let b = a + 1; b < heading.length; b++) {
      let d = heading[b] - heading[b - 1];
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      swing += d;
      if (Math.abs(swing) * 180 / Math.PI >= ROAD.hairpinDegrees) return true;
      span += length[b];
      if (span > ROAD.hairpinWindow) break;
    }
  }
  return false;
}

function carve(map, path) {
  const mark = (i) => {
    if (!PASSABLE[map.kind[i]]) return;
    map.road[i] = 1;
    // Roads grade forest and marsh to open ground (as before D96).
    if (map.kind[i] === T.FOREST || map.kind[i] === T.MARSH) map.kind[i] = T.PLAIN;
  };
  let previous = -1;
  for (const i of path) {
    if (previous >= 0) {
      const p = tileXY(previous); const q = tileXY(i);
      if (p.x !== q.x && p.y !== q.y) {
        const upper = q.y < p.y ? q : p; const lower = q.y < p.y ? p : q;
        const corner = idx(lower.x, upper.y);
        mark(PASSABLE[map.kind[corner]] ? corner : idx(upper.x, lower.y));
      }
    }
    mark(i);
    previous = i;
  }
}

function entryTile(map, mouth, side) {
  const x = side === 'west' ? 0 : MAP.w - 1;
  for (const oy of [0, -1, 1]) {
    const y = mouth.y + oy;
    if (inBounds(x, y) && PASSABLE[map.kind[idx(x, y)]]) return idx(x, y);
  }
  return idx(mouth.x, mouth.y);
}

/**
 * Build the network: one main road per side from its best mouth to the hub,
 * then up to one more road per side that merges into the network away from
 * existing junctions. Spawn mouths become exactly the road mouths.
 */
export function buildSimpleRoads(map, rng) {
  map.road.fill(0);
  map.roadRoutes = [];
  map.roadDebug = { rejected: [], junctions: [] };
  const hub = idx(map.roadCenter.x, map.roadCenter.y);
  const junctions = [];
  const used = { west: [], east: [] };

  const tryRoad = (side, mouth, goalOf, kind) => {
    const start = entryTile(map, mouth, side);
    if (map.road[start]) return null;
    const ctx = { dist: roadDistance(map), entry: new Set([start, idx(mouth.x, mouth.y)]), goal: goalOf() };
    const routed = routeRoad(map, ctx, start, side === 'west' ? 0 : 4);
    if (!routed) { map.roadDebug.rejected.push({ ...mouth, side, reason: 'no route' }); return null; }
    const { path, vertices } = pullTight(map, ctx, routed.path);
    const problem = roadProblem(map, ctx, path, vertices, kind === 'main' ? ROAD.maxTurnsMain : ROAD.maxTurnsBranch);
    if (problem) { map.roadDebug.rejected.push({ ...mouth, side, reason: problem }); return null; }
    return { side, mouth: { ...mouth }, path, vertices, kind, cost: routed.cost };
  };

  const hubGoal = () => { const g = new Uint8Array(N()); g[hub] = 1; return g; };
  const networkGoal = () => {
    const g = new Uint8Array(N());
    for (let i = 0; i < N(); i++) {
      if (!map.road[i]) continue;
      const { x, y } = tileXY(i);
      if (x < ROAD.joinEdgeClear || x >= MAP.w - ROAD.joinEdgeClear) continue;
      if (junctions.some((j) => Math.hypot(j.x - x, j.y - y) < ROAD.junctionSpacing)) continue;
      g[i] = 1;
    }
    return g;
  };

  // Main roads: each side's cheapest mouth to the hub; the two meet as one
  // through-road there.
  for (const side of ['west', 'east']) {
    const options = map.spawns[side].map((mouth) => tryRoad(side, mouth, hubGoal, 'main')).filter(Boolean);
    if (!options.length) continue;
    const best = options.sort((a, b) => a.cost - b.cost)[0];
    carve(map, best.path);
    map.roadRoutes.push(best);
    used[side].push(best.mouth);
  }
  junctions.push(tileXY(hub));

  // Branch roads: another mouth well apart from the main one, merging into the
  // network as a clean T. Skipped (not forced) when no simple road exists.
  for (const side of shuffleSides(rng)) {
    if (map.roadRoutes.length >= ROAD.maxRoads || rng() >= ROAD.branchChance) continue;
    const main = used[side][0];
    const options = map.spawns[side]
      .filter((m) => !main || Math.abs(m.y - main.y) >= ROAD.branchMouthSeparation)
      .map((mouth) => tryRoad(side, mouth, networkGoal, 'branch')).filter(Boolean)
      .filter((r) => r.path.length <= MAP.w * ROAD.branchMaxLengthFrac);
    if (!options.length) continue;
    const best = options.sort((a, b) => a.cost - b.cost)[0];
    carve(map, best.path);
    map.roadRoutes.push(best);
    used[side].push(best.mouth);
    junctions.push(tileXY(best.path[best.path.length - 1]));
  }
  map.roadDebug.junctions = junctions;
  // Enemies enter where roads do, so "Incoming: WEST" names a visible road.
  for (const side of ['west', 'east']) {
    if (used[side].length) map.spawns[side] = used[side].sort((a, b) => a.y - b.y);
  }
}

function shuffleSides(rng) {
  return rng() < 0.5 ? ['west', 'east'] : ['east', 'west'];
}

/** D96 road-quality metrics for validation, tests, reports and debug. */
export function analyseRoadNetwork(map) {
  const routes = map.roadRoutes || [];
  let selfIntersections = 0;
  let maxTurns = 0;
  let turnSum = 0;
  for (const r of routes) {
    if (new Set(r.path).size !== r.path.length) selfIntersections++;
    const t = polylineTurns(r.vertices || r.path).turns;
    maxTurns = Math.max(maxTurns, t);
    turnSum += t;
  }
  // Minimum spacing between different roads away from where they join.
  let minSpacing = Infinity;
  const ends = routes.map((r) => tileXY(r.path[r.path.length - 1]));
  for (let a = 0; a < routes.length; a++) {
    for (let b = a + 1; b < routes.length; b++) {
      const pa = routes[a].path.map(tileXY); const pb = routes[b].path.map(tileXY);
      const nearJoin = (p) => [ends[a], ends[b]].some((e) => Math.hypot(e.x - p.x, e.y - p.y) <= ROAD.spacing + 3);
      for (const p of pa) {
        if (nearJoin(p)) continue;
        for (const q of pb) {
          if (nearJoin(q)) continue;
          minSpacing = Math.min(minSpacing, Math.max(Math.abs(p.x - q.x), Math.abs(p.y - q.y)));
        }
      }
    }
  }
  const junctions = map.roadDebug?.junctions || [];
  let maxJunctionsInRadius = 0;
  for (const j of junctions) {
    maxJunctionsInRadius = Math.max(maxJunctionsInRadius,
      junctions.filter((o) => Math.hypot(o.x - j.x, o.y - j.y) <= ROAD.junctionSpacing).length);
  }
  // Measured, not assumed: a road that touches another road anywhere but at a
  // join closes a loop (or nearly does). Joins are a road's own last tiles or
  // the end tiles of the road it meets.
  let loops = 0;
  const tileOwner = new Map();
  routes.forEach((r, n) => r.path.forEach((i) => { if (!tileOwner.has(i)) tileOwner.set(i, n); }));
  routes.forEach((r, n) => {
    let contacts = 0;
    for (let k = 0; k < r.path.length - 2; k++) {
      const { x, y } = tileXY(r.path[k]);
      for (const [ox, oy] of DIRS) {
        if (!inBounds(x + ox, y + oy)) continue;
        const owner = tileOwner.get(idx(x + ox, y + oy));
        if (owner === undefined || owner === n) continue;
        const other = routes[owner].path;
        const at = other.indexOf(idx(x + ox, y + oy));
        if (at < other.length - 2) contacts++;
      }
    }
    if (contacts) loops++;
  });
  return {
    roads: routes.length,
    junctions: routes.filter((r) => r.kind === 'branch').length,
    maxJunctionsInRadius,
    selfIntersections,
    loops,
    avgTurns: routes.length ? turnSum / routes.length : 0,
    maxTurns,
    minSpacing,
    rejected: (map.roadDebug?.rejected || []).length,
  };
}
