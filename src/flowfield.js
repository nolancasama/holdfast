// D4: one shared Dijkstra distance field per target, not per-enemy A*.
// Every enemy targeting the same tower reads the same field, which is what makes
// them funnel through the passes instead of each solving the map alone.

import { MAP, MOVE_COST, PASSABLE, ROAD } from './config.js';

const idx = (x, y) => y * MAP.w + x;
const inBounds = (x, y) => x >= 0 && y >= 0 && x < MAP.w && y < MAP.h;

const DIAG = Math.SQRT2;
const NEIGHBOURS = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, DIAG], [1, -1, DIAG], [-1, 1, DIAG], [-1, -1, DIAG],
];

class MinHeap {
  constructor() { this.keys = []; this.vals = []; }
  get size() { return this.keys.length; }
  push(val, key) {
    this.keys.push(key); this.vals.push(val);
    let i = this.keys.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.keys[p] <= this.keys[i]) break;
      this.swap(i, p); i = p;
    }
  }
  pop() {
    const top = this.vals[0];
    const lastV = this.vals.pop();
    const lastK = this.keys.pop();
    if (this.keys.length) {
      this.vals[0] = lastV; this.keys[0] = lastK;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < this.keys.length && this.keys[l] < this.keys[m]) m = l;
        if (r < this.keys.length && this.keys[r] < this.keys[m]) m = r;
        if (m === i) break;
        this.swap(i, m); i = m;
      }
    }
    return top;
  }
  swap(a, b) {
    [this.keys[a], this.keys[b]] = [this.keys[b], this.keys[a]];
    [this.vals[a], this.vals[b]] = [this.vals[b], this.vals[a]];
  }
}

/**
 * Distance-to-target field over walkable terrain.
 * @param {number[]} seeds tile indices to flood out from (usually one tower tile)
 * @returns {Float32Array} cost-to-reach, Infinity where unreachable
 */
// D96: road laying has its own direction-aware router (roads.js); fields here
// are movement only.
function costFor(map, i, mode) {
  const terrain = map.kind[i];
  const base = MOVE_COST[terrain];
  return mode === 'lane' && map.road[i] ? base * ROAD.laneDiscount : base;
}

export function computeField(map, seeds, mode = 'direct', obstacleCosts = null) {
  const dist = new Float32Array(MAP.w * MAP.h).fill(Infinity);
  // D45: each tile is settled exactly once. The heap uses lazy deletion, so a
  // tile can sit in it several times; without this, every stale copy re-relaxed
  // its neighbours. Costs are stored as Float32, and once road costs grew large
  // enough that rounding exceeded the comparison epsilon, those re-relaxations
  // kept "succeeding" on rounding noise and the heap grew without bound.
  const settled = new Uint8Array(MAP.w * MAP.h);
  const heap = new MinHeap();
  for (const s of seeds) {
    if (dist[s] !== 0) { dist[s] = 0; heap.push(s, 0); }
  }

  while (heap.size) {
    const i = heap.pop();
    if (settled[i]) continue;
    settled[i] = 1;
    const d = dist[i];
    const x = i % MAP.w;
    const y = (i / MAP.w) | 0;

    for (const [ox, oy, mult] of NEIGHBOURS) {
      const nx = x + ox;
      const ny = y + oy;
      if (!inBounds(nx, ny)) continue;
      const ni = idx(nx, ny);
      const cost = costFor(map, ni, mode, i);
      if (!Number.isFinite(cost)) continue;
      // No corner cutting through a cliff or river bend, or past the corner of
      // a wall segment / tower footprint (D82: walls must have no diagonal leak).
      if (ox !== 0 && oy !== 0) {
        const c1 = idx(x + ox, y);
        const c2 = idx(x, y + oy);
        if (!PASSABLE[map.kind[c1]] || !PASSABLE[map.kind[c2]]) continue;
        if (obstacleCosts && (obstacleCosts[c1] > 0 || obstacleCosts[c2] > 0)) continue;
      }
      if (settled[ni]) continue;
      // Compare in the same Float32 space the value is stored in, so an equal
      // cost can never register as an improvement through rounding alone.
      // D82: a blocker's break cost belongs to the blocker tile itself, so its
      // own field value includes the break. A neighbour then reads it as
      // expensive and walks round unless breaking really is cheaper.
      const obstacle = obstacleCosts ? obstacleCosts[ni] || 0 : 0;
      const nd = Math.fround(d + cost * mult + obstacle);
      if (nd < dist[ni]) {
        dist[ni] = nd;
        heap.push(ni, nd);
      }
    }
  }
  return dist;
}

/**
 * Unit direction that descends the field fastest from a world position.
 * Returns null when the position is stranded (field never reached it).
 */
export function steer(map, field, x, y, obstacleCosts = null) {
  const tx = Math.floor(x);
  const ty = Math.floor(y);
  if (!inBounds(tx, ty)) return null;

  let best = null;
  let bestDist = field[idx(tx, ty)];
  if (!Number.isFinite(bestDist)) bestDist = Infinity;

  for (const [ox, oy] of NEIGHBOURS) {
    const nx = tx + ox;
    const ny = ty + oy;
    if (!inBounds(nx, ny)) continue;
    const ni = idx(nx, ny);
    if (!PASSABLE[map.kind[ni]]) continue;
    if (ox !== 0 && oy !== 0) {
      const c1 = idx(tx + ox, ty);
      const c2 = idx(tx, ty + oy);
      if (!PASSABLE[map.kind[c1]] || !PASSABLE[map.kind[c2]]) continue;
      if (obstacleCosts && (obstacleCosts[c1] > 0 || obstacleCosts[c2] > 0)) continue;
    }
    const d = field[ni];
    if (d < bestDist) { bestDist = d; best = [nx, ny]; }
  }
  if (!best) return null;

  const dx = best[0] + 0.5 - x;
  const dy = best[1] + 0.5 - y;
  const len = Math.hypot(dx, dy) || 1;
  return { x: dx / len, y: dy / len, tx: best[0], ty: best[1], i: idx(best[0], best[1]) };
}
