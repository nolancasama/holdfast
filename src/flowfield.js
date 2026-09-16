// D4: one shared Dijkstra distance field per target, not per-enemy A*.
// Every enemy targeting the same tower reads the same field, which is what makes
// them funnel through the passes instead of each solving the map alone.

import { MAP, MOVE_COST, PASSABLE } from './config.js';
import { idx, inBounds } from './terrain.js';

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
export function computeField(map, seeds) {
  const dist = new Float32Array(MAP.w * MAP.h).fill(Infinity);
  const heap = new MinHeap();
  for (const s of seeds) {
    if (dist[s] !== 0) { dist[s] = 0; heap.push(s, 0); }
  }

  while (heap.size) {
    const i = heap.pop();
    const d = dist[i];
    const x = i % MAP.w;
    const y = (i / MAP.w) | 0;

    for (const [ox, oy, mult] of NEIGHBOURS) {
      const nx = x + ox;
      const ny = y + oy;
      if (!inBounds(nx, ny)) continue;
      const ni = idx(nx, ny);
      const cost = MOVE_COST[map.kind[ni]];
      if (!Number.isFinite(cost)) continue;
      // No corner cutting through a cliff or river bend.
      if (ox !== 0 && oy !== 0) {
        if (!PASSABLE[map.kind[idx(x + ox, y)]] || !PASSABLE[map.kind[idx(x, y + oy)]]) continue;
      }
      const nd = d + cost * mult;
      if (nd < dist[ni] - 1e-6) {
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
