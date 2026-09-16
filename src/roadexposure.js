// D49 road-exposure and road-knot measurement. Read-only: terrain generation
// calls it to judge knot fixes and exposure features (D51/D52) but it edits nothing.

import { MAP, T, TOWER, EXPOSURE, PASSABLE } from './config.js';
import { computeField } from './flowfield.js';
import { idx, inBounds, hasLineOfSight, isTerrainBuildable } from './terrain.js';

const DIAG = Math.SQRT2;
const NEIGHBOURS = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, DIAG], [1, -1, DIAG], [-1, 1, DIAG], [-1, -1, DIAG],
];
const CARDINAL = [[1, 0], [-1, 0], [0, 1], [0, -1]];

export function straightRoadBaseline(range = TOWER.weapon.range) {
  const squared = range * range - EXPOSURE.straightOffset * EXPOSURE.straightOffset;
  return squared > 0 ? 2 * Math.sqrt(squared) : 0;
}

export function pathExposure(map, x, y, points, range = TOWER.weapon.range) {
  let length = 0;
  const counted = [];
  let runStart = -1;
  for (let k = 0; k + 1 < points.length; k++) {
    const a = points[k];
    const b = points[k + 1];
    const mx = (a.x + b.x) * 0.5;
    const my = (a.y + b.y) * 0.5;
    const visible = Math.hypot(mx - x, my - y) <= range
      && hasLineOfSight(map, x, y, mx, my);
    if (visible) {
      length += Math.hypot(b.x - a.x, b.y - a.y);
      if (runStart < 0) runStart = k;
    } else if (runStart >= 0) {
      counted.push([runStart, k - 1]);
      runStart = -1;
    }
  }
  if (runStart >= 0) counted.push([runStart, points.length - 2]);
  return { length, counted };
}

function descendLane(map, fromIndex, toIndex, field) {
  if (!Number.isFinite(field[fromIndex])) return [];
  const indices = [fromIndex];
  const seen = new Uint8Array(MAP.w * MAP.h);
  seen[fromIndex] = 1;
  let current = fromIndex;
  for (let guard = 0; guard < MAP.w * MAP.h && current !== toIndex; guard++) {
    const x = current % MAP.w;
    const y = (current / MAP.w) | 0;
    let best = -1;
    let bestDist = field[current];
    for (const [ox, oy] of NEIGHBOURS) {
      const nx = x + ox;
      const ny = y + oy;
      if (!inBounds(nx, ny)) continue;
      const ni = idx(nx, ny);
      if (!PASSABLE[map.kind[ni]]) continue;
      if (ox && oy
          && (!PASSABLE[map.kind[idx(x + ox, y)]] || !PASSABLE[map.kind[idx(x, y + oy)]])) continue;
      const d = field[ni];
      if (d < bestDist) { bestDist = d; best = ni; }
    }
    if (best < 0 || seen[best]) return [];
    current = best;
    seen[current] = 1;
    indices.push(current);
  }
  if (current !== toIndex) return [];
  return indices.map((i) => ({ x: i % MAP.w + 0.5, y: ((i / MAP.w) | 0) + 0.5 }));
}

export function walkLane(map, fromIndex, toIndex) {
  return descendLane(map, fromIndex, toIndex, computeField(map, [toIndex], 'lane'));
}

function routePoints(route) {
  return route.path.map((i) => ({ x: i % MAP.w + 0.5, y: ((i / MAP.w) | 0) + 0.5 }));
}

export function measureSiteExposure(map, x, y, options = {}) {
  const range = options.range ?? TOWER.weapon.range;
  const baseline = straightRoadBaseline(range);
  const empty = { exposure: 0, ratio: 0, routeIndex: -1, walked: [], counted: [], buildable: false };
  if (!isTerrainBuildable(map, x, y)) return empty;
  const fieldCache = options.fieldCache || new Map();
  let best = { ...empty, buildable: true };
  const nearRadius = range + EXPOSURE.windowMargin;
  for (let routeIndex = 0; routeIndex < (map.roadRoutes || []).length; routeIndex++) {
    const route = map.roadRoutes[routeIndex];
    let first = -1;
    let last = -1;
    for (let k = 0; k < route.path.length; k++) {
      const i = route.path[k];
      const px = i % MAP.w + 0.5;
      const py = ((i / MAP.w) | 0) + 0.5;
      if (Math.hypot(px - x, py - y) <= nearRadius) {
        if (first < 0) first = k;
        last = k;
      }
    }
    if (first < 0 || first === last) continue;
    first = Math.max(0, first - EXPOSURE.windowMargin);
    last = Math.min(route.path.length - 1, last + EXPOSURE.windowMargin);
    const from = route.path[first];
    const to = route.path[last];
    let field = fieldCache.get(to);
    if (!field) {
      field = computeField(map, [to], 'lane');
      fieldCache.set(to, field);
    }
    const walked = descendLane(map, from, to, field);
    if (walked.length < 2) continue;
    const score = pathExposure(map, x, y, walked, range);
    if (score.length > best.exposure) {
      best = {
        exposure: score.length,
        ratio: baseline ? score.length / baseline : 0,
        routeIndex,
        walked,
        counted: score.counted,
        buildable: true,
      };
    }
  }
  return best;
}

function angleDelta(a, b) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

function segmentIsCounted(k, counted) {
  return counted.some(([a, b]) => k >= a && k <= b);
}

function obstacleBetween(map, a, b) {
  const steps = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) * 2);
  for (let n = 1; n < steps; n++) {
    const t = n / steps;
    const x = Math.floor(a.x + (b.x - a.x) * t);
    const y = Math.floor(a.y + (b.y - a.y) * t);
    const kind = map.kind[idx(x, y)];
    if (kind === T.CLIFF || kind === T.DEEP) return true;
  }
  return false;
}

function classifyFeature(map, site, walked, counted) {
  const segments = [];
  const headings = [];
  for (let k = 0; k + 1 < walked.length; k++) {
    if (!segmentIsCounted(k, counted)) continue;
    const a = walked[k];
    const b = walked[k + 1];
    segments.push({ k, a, b, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2,
      dx: b.x - a.x, dy: b.y - a.y });
    headings.push(Math.atan2(b.y - a.y, b.x - a.x));
  }
  let totalTurn = 0;
  let signedPositive = 0;
  let signedNegative = 0;
  for (let k = 1; k < headings.length; k++) {
    const d = angleDelta(headings[k - 1], headings[k]);
    totalTurn += Math.abs(d);
    if (d > 0) signedPositive += d;
    else signedNegative -= d;
  }

  let legSeparation = null;
  let antiparallel = false;
  let obstacle = false;
  for (let a = 0; a < segments.length; a++) {
    const sa = segments[a];
    const al = Math.hypot(sa.dx, sa.dy) || 1;
    for (let b = a + 1; b < segments.length; b++) {
      const sb = segments[b];
      if (Math.abs(sb.k - sa.k) < 8) continue;
      const separation = Math.hypot(sb.mx - sa.mx, sb.my - sa.my);
      legSeparation = legSeparation === null ? separation : Math.min(legSeparation, separation);
      if (!obstacle && obstacleBetween(map, { x: sa.mx, y: sa.my }, { x: sb.mx, y: sb.my })) {
        obstacle = true;
      }
      const bl = Math.hypot(sb.dx, sb.dy) || 1;
      const dot = (sa.dx * sb.dx + sa.dy * sb.dy) / (al * bl);
      if (dot <= Math.cos(150 * Math.PI / 180)) {
        antiparallel = true;
      }
    }
  }

  const degrees = totalTurn * 180 / Math.PI;
  const oppositeTurns = signedPositive >= Math.PI / 3 && signedNegative >= Math.PI / 3;
  const netTurn = Math.abs(signedPositive - signedNegative) * 180 / Math.PI;
  const radii = segments.map((s) => Math.hypot(s.mx - site.x, s.my - site.y));
  const meanRadius = radii.reduce((sum, r) => sum + r, 0) / Math.max(1, radii.length);
  const radiusSpread = Math.sqrt(radii.reduce((sum, r) => sum + (r - meanRadius) ** 2, 0)
    / Math.max(1, radii.length));

  // Count separated near-reversals in a local eight-segment tangent window.
  let reversals = 0;
  let lastReversal = -99;
  for (let k = 4; k + 4 < segments.length; k++) {
    const a = segments[k - 4];
    const b = segments[k + 4];
    const dot = (a.dx * b.dx + a.dy * b.dy)
      / ((Math.hypot(a.dx, a.dy) || 1) * (Math.hypot(b.dx, b.dy) || 1));
    if (dot <= Math.cos(150 * Math.PI / 180) && k - lastReversal >= 8) {
      reversals++;
      lastReversal = k;
    }
  }

  let kind = 'bend';
  if (reversals >= 2) kind = 'switchback';
  else if (degrees >= 150 && antiparallel && meanRadius > 0 && radiusSpread / meanRadius <= 0.28) kind = 'horseshoe';
  else if (degrees >= 150 && antiparallel) kind = 'hairpin';
  else if (oppositeTurns && netTurn < 90) kind = 's-bend';
  else if (degrees >= 90 && obstacle) kind = 'terrain-loop';
  return { kind, legSeparation };
}

export function findExposureFeatures(map, options = {}) {
  const range = options.range ?? TOWER.weapon.range;
  const baseline = straightRoadBaseline(range);
  const threshold = EXPOSURE.usefulRatio * baseline;
  const routes = (map.roadRoutes || []).map(routePoints);
  const candidates = [];
  for (let ty = 0; ty < MAP.h; ty++) {
    for (let tx = 0; tx < MAP.w; tx++) {
      const x = tx + 0.5;
      const y = ty + 0.5;
      const region = options.region;
      if (region && Math.hypot(x - region.x, y - region.y) > region.r) continue;
      if (!isTerrainBuildable(map, x, y)) continue;
      let cheap = 0;
      for (const points of routes) cheap = Math.max(cheap, pathExposure(map, x, y, points, range).length);
      if (cheap >= threshold) candidates.push({ x, y, cheap });
    }
  }

  const fieldCache = options.fieldCache || new Map();
  const measured = [];
  for (const candidate of candidates) {
    const result = measureSiteExposure(map, candidate.x, candidate.y, { ...options, fieldCache, range });
    if (result.exposure < threshold) continue;
    const classification = classifyFeature(map, candidate, result.walked, result.counted);
    measured.push({
      x: candidate.x,
      y: candidate.y,
      exposure: result.exposure,
      ratio: result.ratio,
      tier: result.ratio >= EXPOSURE.strongRatio ? 'strong' : 'useful',
      kind: classification.kind,
      legSeparation: classification.legSeparation,
      readable: classification.legSeparation === null
        || classification.legSeparation >= EXPOSURE.readableLegSeparation,
      routeIndex: result.routeIndex,
    });
  }
  measured.sort((a, b) => b.exposure - a.exposure);
  const features = [];
  for (const candidate of measured) {
    if (features.some((f) => Math.hypot(f.x - candidate.x, f.y - candidate.y)
      < EXPOSURE.featureClusterRadius)) continue;
    features.push(candidate);
  }
  return features;
}

function nearProtectedSpurEnd(map, x, y) {
  if (x <= 2 || y <= 2 || x >= MAP.w - 3 || y >= MAP.h - 3) return true;
  if (map.roadCenter && Math.hypot(x - map.roadCenter.x, y - map.roadCenter.y) <= 2) return true;
  for (const side of ['west', 'east']) {
    for (const mouth of (map.spawns && map.spawns[side]) || []) {
      if (Math.hypot(x - mouth.x, y - mouth.y) <= 2) return true;
    }
  }
  return false;
}

function roadNeighbours(map, i) {
  const x = i % MAP.w;
  const y = (i / MAP.w) | 0;
  const out = [];
  for (const [ox, oy] of NEIGHBOURS) {
    const nx = x + ox;
    const ny = y + oy;
    if (inBounds(nx, ny) && map.road[idx(nx, ny)]) out.push(idx(nx, ny));
  }
  return out;
}

function findSpurs(map) {
  const spurs = [];
  const consumed = new Set();
  for (let i = 0; i < map.road.length; i++) {
    if (!map.road[i] || consumed.has(i) || roadNeighbours(map, i).length !== 1) continue;
    const endX = i % MAP.w;
    const endY = (i / MAP.w) | 0;
    if (nearProtectedSpurEnd(map, endX, endY)) continue;
    const chain = [i];
    let previous = -1;
    let current = i;
    while (chain.length <= map.road.length) {
      const next = roadNeighbours(map, current).filter((n) => n !== previous);
      if (next.length !== 1) break;
      previous = current;
      current = next[0];
      chain.push(current);
      if (roadNeighbours(map, current).length !== 2) break;
    }
    if (chain.length >= 2) {
      for (const tile of chain) consumed.add(tile);
      const middle = chain[Math.floor((chain.length - 1) / 2)];
      spurs.push({ x: middle % MAP.w + 0.5, y: ((middle / MAP.w) | 0) + 0.5 });
    }
  }
  return spurs;
}

function findSmallLoops(map) {
  const seen = new Uint8Array(map.road.length);
  const loops = [];
  for (let start = 0; start < map.road.length; start++) {
    if (map.road[start] || seen[start]) continue;
    const queue = [start];
    seen[start] = 1;
    let border = false;
    let sx = 0;
    let sy = 0;
    for (let head = 0; head < queue.length; head++) {
      const i = queue[head];
      const x = i % MAP.w;
      const y = (i / MAP.w) | 0;
      sx += x + 0.5;
      sy += y + 0.5;
      if (!x || !y || x === MAP.w - 1 || y === MAP.h - 1) border = true;
      for (const [ox, oy] of CARDINAL) {
        const nx = x + ox;
        const ny = y + oy;
        if (!inBounds(nx, ny)) { border = true; continue; }
        const ni = idx(nx, ny);
        if (!map.road[ni] && !seen[ni]) { seen[ni] = 1; queue.push(ni); }
      }
    }
    if (!border && queue.length <= EXPOSURE.smallLoopMaxArea) {
      loops.push({ x: sx / queue.length, y: sy / queue.length });
    }
  }
  return loops;
}

function findBraids(map) {
  const braids = [];
  const scan = (outer, inner, at) => {
    for (let a = 0; a < outer; a++) {
      for (const gap of [1, 2]) {
        let start = -1;
        for (let b = 0; b <= inner; b++) {
          const paired = b < inner && map.road[at(a, b)] && map.road[at(a + gap, b)];
          if (paired && start < 0) start = b;
          if ((!paired || b === inner) && start >= 0) {
            const end = b - 1;
            if (end - start + 1 >= EXPOSURE.braidMinRun) {
              const p0 = at(a, start);
              const p1 = at(a + gap, end);
              braids.push({ x: ((p0 % MAP.w) + (p1 % MAP.w)) / 2 + 0.5,
                y: ((((p0 / MAP.w) | 0) + ((p1 / MAP.w) | 0)) / 2) + 0.5 });
            }
            start = -1;
          }
        }
      }
    }
  };
  scan(MAP.h - 2, MAP.w, (row, col) => idx(col, row));
  scan(MAP.w - 2, MAP.h, (col, row) => idx(col, row));
  return braids;
}

export function analyseRoadKnots(map) {
  const spurs = findSpurs(map);
  const smallLoops = findSmallLoops(map);
  const braids = findBraids(map);
  const defects = [...spurs, ...smallLoops, ...braids];
  const groups = [];
  for (const defect of defects) {
    const touching = groups.filter((g) => g.some((p) => Math.hypot(p.x - defect.x, p.y - defect.y)
      <= EXPOSURE.knotClusterRadius));
    if (!touching.length) groups.push([defect]);
    else {
      touching[0].push(defect);
      for (const extra of touching.slice(1)) {
        touching[0].push(...extra);
        groups.splice(groups.indexOf(extra), 1);
      }
    }
  }
  const knots = groups.map((group) => ({
    x: group.reduce((s, p) => s + p.x, 0) / group.length,
    y: group.reduce((s, p) => s + p.y, 0) / group.length,
  }));
  return { spurs, smallLoops, braids, knots, count: knots.length };
}
