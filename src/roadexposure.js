// D49/D55 road-knot and readability measurement. Read-only. D96: map
// validation requires zero knots; exposure measurement was removed with the
// authored exposure features it served.

import { MAP, EXPOSURE, READABILITY } from './config.js';
import { idx, inBounds } from './terrain.js';

const DIAG = Math.SQRT2;
const NEIGHBOURS = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, DIAG], [1, -1, DIAG], [-1, 1, DIAG], [-1, -1, DIAG],
];
const CARDINAL = [[1, 0], [-1, 0], [0, 1], [0, -1]];

function angleDelta(a, b) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
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

// ---------------------------------------------------------------------------
// D55: road readability. A knot (D49) is a topological defect; these measure
// what makes a connected, knot-free road still hard to follow at full-map scale.
// ---------------------------------------------------------------------------

function roadTiles(map) {
  const out = [];
  for (let i = 0; i < map.road.length; i++) if (map.road[i]) out.push(i);
  return out;
}

/** Road tiles with an unrelated strand close by: near in space, far along the road. */
function findNearPasses(map, tiles) {
  const R = READABILITY;
  const reach = Math.ceil(R.nearPassDistance);
  const r2 = R.nearPassDistance * R.nearPassDistance;
  const W = MAP.w;
  // Generation-stamped visits: no per-tile clearing or neighbour arrays.
  const seenAt = new Int32Array(map.road.length);
  const depth = new Int16Array(map.road.length);
  const queue = new Int32Array(map.road.length);
  const hits = [];
  let stamp = 0;
  for (const start of tiles) {
    const sx = start % W;
    const sy = (start / W) | 0;
    const near = [];
    for (let oy = -reach; oy <= reach; oy++) {
      for (let ox = -reach; ox <= reach; ox++) {
        if ((!ox && !oy) || ox * ox + oy * oy > r2 || !inBounds(sx + ox, sy + oy)) continue;
        const j = idx(sx + ox, sy + oy);
        if (map.road[j]) near.push(j);
      }
    }
    if (!near.length) continue;
    stamp++;
    seenAt[start] = stamp;
    depth[start] = 0;
    queue[0] = start;
    let tail = 1;
    let found = 0;
    for (let head = 0; head < tail && found < near.length; head++) {
      const i = queue[head];
      if (depth[i] >= R.nearPassGraphMin) continue;
      const x = i % W;
      const y = (i / W) | 0;
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          const nx = x + ox;
          const ny = y + oy;
          if ((!ox && !oy) || nx < 0 || ny < 0 || nx >= W || ny >= MAP.h) continue;
          const n = ny * W + nx;
          if (!map.road[n] || seenAt[n] === stamp) continue;
          seenAt[n] = stamp;
          depth[n] = depth[i] + 1;
          queue[tail++] = n;
          if (Math.abs(nx - sx) <= reach && Math.abs(ny - sy) <= reach) found = near.filter((j) => seenAt[j] === stamp).length;
        }
      }
    }
    if (near.some((j) => seenAt[j] !== stamp)) hits.push({ x: sx + 0.5, y: sy + 0.5 });
  }
  return clusterPoints(hits, R.nearPassClusterRadius)
    .filter((group) => group.length >= R.nearPassMinTiles).map(centroid);
}

/** Solid 2x2 road blocks in a run: diagonal strands laid side by side. */
function findThickBands(map) {
  const blocks = [];
  for (let y = 0; y + 1 < MAP.h; y++) {
    for (let x = 0; x + 1 < MAP.w; x++) {
      if (map.road[idx(x, y)] && map.road[idx(x + 1, y)] && map.road[idx(x, y + 1)] && map.road[idx(x + 1, y + 1)]) {
        blocks.push({ x: x + 1, y: y + 1 });
      }
    }
  }
  // Knight-move reach: a band that shifts sideways by a tile is still one band.
  return clusterPoints(blocks, 2.3).filter((group) => group.length >= READABILITY.thickBandMinBlocks).map(centroid);
}

/** Separate road branches leaving a tile, read round its eight neighbours. */
function branchCount(map, i) {
  const x = i % MAP.w;
  const y = (i / MAP.w) | 0;
  const ring = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]]
    .map(([ox, oy]) => inBounds(x + ox, y + oy) && map.road[idx(x + ox, y + oy)] ? 1 : 0);
  let runs = 0;
  for (let k = 0; k < 8; k++) if (ring[k] && !ring[(k + 7) % 8]) runs++;
  return runs || (ring.some(Boolean) ? 1 : 0);
}

/** Several road junctions crowded into one small area. */
function findJunctionClutter(map, tiles) {
  const R = READABILITY;
  const junctionTiles = tiles.filter((i) => branchCount(map, i) >= 3)
    .map((i) => ({ x: i % MAP.w + 0.5, y: ((i / MAP.w) | 0) + 0.5 }));
  const junctions = clusterPoints(junctionTiles, 2.5).map(centroid);
  const out = [];
  for (const j of junctions) {
    const near = junctions.filter((o) => Math.hypot(o.x - j.x, o.y - j.y) <= R.junctionRadius);
    if (near.length > R.maxJunctionsInRadius) out.push(centroid(near));
  }
  return clusterPoints(out, R.junctionRadius).map(centroid);
}

/** Too much road packed into a small disc. */
function findDenseAreas(map, tiles) {
  const R = READABILITY;
  const r = R.densityRadius;
  const area = Math.PI * r * r;
  const dense = [];
  for (const i of tiles) {
    const x = i % MAP.w;
    const y = (i / MAP.w) | 0;
    let n = 0;
    for (let oy = -r; oy <= r; oy++) {
      for (let ox = -r; ox <= r; ox++) {
        if (ox * ox + oy * oy <= r * r && inBounds(x + ox, y + oy) && map.road[idx(x + ox, y + oy)]) n++;
      }
    }
    if (n / area > R.maxDensity) dense.push({ x: x + 0.5, y: y + 0.5 });
  }
  return clusterPoints(dense, r).map(centroid);
}

/** Many sharp turns within a short stretch of one route: a zigzag. */
function findZigzags(map) {
  const R = READABILITY;
  const out = [];
  const c = R.turnChord;
  for (const route of map.roadRoutes || []) {
    const p = route.path.map((i) => ({ x: i % MAP.w + 0.5, y: ((i / MAP.w) | 0) + 0.5 }));
    const sharp = [];
    for (let k = c; k + c < p.length; k++) {
      const h1 = Math.atan2(p[k].y - p[k - c].y, p[k].x - p[k - c].x);
      const h2 = Math.atan2(p[k + c].y - p[k].y, p[k + c].x - p[k].x);
      if (Math.abs(angleDelta(h1, h2)) * 180 / Math.PI >= R.sharpTurnDegrees
          && (!sharp.length || k - sharp[sharp.length - 1] >= c)) sharp.push(k);
    }
    for (let a = 0; a < sharp.length; a++) {
      let b = a;
      while (b + 1 < sharp.length && sharp[b + 1] - sharp[a] <= R.turnWindow) b++;
      if (b - a + 1 > R.maxSharpTurnsInWindow) out.push(p[sharp[a + ((b - a) >> 1)]]);
    }
  }
  return clusterPoints(out, R.defectClusterRadius).map(centroid);
}

function clusterPoints(points, radius) {
  const groups = [];
  for (const p of points) {
    const touching = groups.filter((g) => g.some((o) => Math.hypot(o.x - p.x, o.y - p.y) <= radius));
    if (!touching.length) groups.push([p]);
    else {
      touching[0].push(p);
      for (const extra of touching.slice(1)) {
        touching[0].push(...extra);
        groups.splice(groups.indexOf(extra), 1);
      }
    }
  }
  return groups;
}

function centroid(group) {
  return {
    x: group.reduce((s, p) => s + p.x, 0) / group.length,
    y: group.reduce((s, p) => s + p.y, 0) / group.length,
  };
}

export function analyseRoadReadability(map) {
  const tiles = roadTiles(map);
  const nearPasses = findNearPasses(map, tiles);
  const thickBands = findThickBands(map);
  const junctionClutter = findJunctionClutter(map, tiles);
  const denseAreas = findDenseAreas(map, tiles);
  const zigzags = findZigzags(map);
  const tagged = [
    ...nearPasses.map((p) => ({ ...p, kind: 'nearPass' })),
    ...thickBands.map((p) => ({ ...p, kind: 'thickBand' })),
    ...junctionClutter.map((p) => ({ ...p, kind: 'junctionClutter' })),
    ...denseAreas.map((p) => ({ ...p, kind: 'dense' })),
    ...zigzags.map((p) => ({ ...p, kind: 'zigzag' })),
  ];
  const defects = clusterPoints(tagged, READABILITY.defectClusterRadius).map((group) => ({
    ...centroid(group),
    kinds: [...new Set(group.map((p) => p.kind))],
  }));
  return { nearPasses, thickBands, junctionClutter, denseAreas, zigzags, defects, count: defects.length };
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
