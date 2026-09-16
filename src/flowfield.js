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
function costFor(map, i, mode, fromI = i) {
  const terrain = map.kind[i];
  if (mode === 'carve') {
    if (map.road[i]) return ROAD.existingCost + (map.roadAvoid && map.roadAvoid[i] ? ROAD.parallelRoadAvoidCost : 0);
    let cost = ROAD.carveCost[terrain];
    if (!Number.isFinite(cost)) return cost;
    if (map.roadAvoid && map.roadAvoid[i]) cost += ROAD.parallelRoadAvoidCost;
    if (map.waterDist && map.waterDist[i] > 0 && map.waterDist[i] <= ROAD.riverCheapRadius) {
      cost *= ROAD.riverbankCostMult;
    }
    cost += Math.abs(map.elev[i] - map.elev[fromI]) * ROAD.elevationCrossingCost;
    return cost;
  }
  const base = MOVE_COST[terrain];
  return mode === 'lane' && map.road[i] ? base * ROAD.laneDiscount : base;
}

export function computeField(map, seeds, mode = 'direct') {
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
      // No corner cutting through a cliff or river bend.
      if (ox !== 0 && oy !== 0) {
        if (!PASSABLE[map.kind[idx(x + ox, y)]] || !PASSABLE[map.kind[idx(x, y + oy)]]) continue;
      }
      if (settled[ni]) continue;
      // Compare in the same Float32 space the value is stored in, so an equal
      // cost can never register as an improvement through rounding alone.
      const nd = Math.fround(d + cost * mult);
      if (nd < dist[ni]) {
        dist[ni] = nd;
        heap.push(ni, nd);
      }
    }
  }
  return dist;
}

/**
 * Recover one minimum-cost tile path using the same Dijkstra implementation as
 * the runtime fields. Terrain generation uses the private `carve` cost mode;
 * gameplay uses only the public lane/direct distinction.
 */
export function findCostPath(map, start, target) {
  const field = computeField(map, [target], 'carve');
  if (!Number.isFinite(field[start])) return [];
  const path = [start];
  let current = start;
  const seen = new Uint8Array(MAP.w * MAP.h);
  seen[current] = 1;

  for (let guard = 0; guard < MAP.w * MAP.h && current !== target; guard++) {
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
      if (ox !== 0 && oy !== 0
          && (!PASSABLE[map.kind[idx(x + ox, y)]] || !PASSABLE[map.kind[idx(x, y + oy)]])) continue;
      if (field[ni] < bestDist - 1e-6) { bestDist = field[ni]; best = ni; }
    }
    if (best < 0 || seen[best]) return [];
    current = best;
    seen[current] = 1;
    path.push(current);
  }
  return current === target ? path : [];
}

/**
 * Unit direction that descends the field fastest from a world position.
 * Returns null when the position is stranded (field never reached it).
 */
export function steer(map, field, x, y) {
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
      if (!PASSABLE[map.kind[idx(tx + ox, ty)]] || !PASSABLE[map.kind[idx(tx, ty + oy)]]) continue;
    }
    const d = field[ni];
    if (d < bestDist) { bestDist = d; best = [nx, ny]; }
  }
  if (!best) return null;

  const dx = best[0] + 0.5 - x;
  const dy = best[1] + 0.5 - y;
  const len = Math.hypot(dx, dy) || 1;
  return { x: dx / len, y: dy / len };
}
