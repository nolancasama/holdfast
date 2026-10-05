// D101: pure 3D-space math for the first-person shell. No Three.js and no DOM,
// so every function here runs (and is tested) in Node.
//
// Convention: simulation tile coordinates (x, y) map to world metres
// (X = x * S, Z = y * S) with S = WORLD3D.tileMeters; world Y is height.
// North is -Z (decreasing tile y), east is +X.

import { MAP, T, WORLD3D } from '../config.js';

const S = WORLD3D.tileMeters;
const VW = MAP.w + 1; // height-field vertices per row
const VH = MAP.h + 1;

export const tileToWorld = (x, y) => ({ x: x * S, z: y * S });
export const worldToTile = (wx, wz) => ({ x: wx / S, y: wz / S });

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/** Pre-depression ground height of one tile from its elevation band. */
function bandHeight(map, i) {
  return map.elev[i] * WORLD3D.elevStep;
}

/**
 * Vertex heights for the (w+1) x (h+1) corner grid.
 * - `surface`: smoothed band height, ignoring water depression and cliffs. Water
 *   surfaces sit on this.
 * - `ground`: the visible, walkable terrain: surface minus water depth, plus
 *   cliff relief where every touching tile is cliff (a ridge interior) and
 *   partial relief at its rim, so cliffs read as steep rock faces.
 */
export function buildHeightField(map) {
  const raw = new Float32Array(VW * VH);
  for (let vy = 0; vy < VH; vy++) {
    for (let vx = 0; vx < VW; vx++) {
      let sum = 0;
      let n = 0;
      for (const [ox, oy] of [[-1, -1], [0, -1], [-1, 0], [0, 0]]) {
        const tx = vx + ox;
        const ty = vy + oy;
        if (tx < 0 || ty < 0 || tx >= MAP.w || ty >= MAP.h) continue;
        sum += bandHeight(map, ty * MAP.w + tx);
        n++;
      }
      raw[vy * VW + vx] = n ? sum / n : 0;
    }
  }
  let surface = raw;
  for (let pass = 0; pass < WORLD3D.smoothPasses; pass++) {
    const next = new Float32Array(VW * VH);
    for (let vy = 0; vy < VH; vy++) {
      for (let vx = 0; vx < VW; vx++) {
        let sum = 0;
        let n = 0;
        for (let oy = -1; oy <= 1; oy++) {
          for (let ox = -1; ox <= 1; ox++) {
            const x = vx + ox;
            const y = vy + oy;
            if (x < 0 || y < 0 || x >= VW || y >= VH) continue;
            sum += surface[y * VW + x];
            n++;
          }
        }
        next[vy * VW + vx] = sum / n;
      }
    }
    surface = next;
  }

  const ground = new Float32Array(VW * VH);
  for (let vy = 0; vy < VH; vy++) {
    for (let vx = 0; vx < VW; vx++) {
      let cliff = 0;
      let deep = 0;
      let shallow = 0;
      let n = 0;
      for (const [ox, oy] of [[-1, -1], [0, -1], [-1, 0], [0, 0]]) {
        const tx = vx + ox;
        const ty = vy + oy;
        if (tx < 0 || ty < 0 || tx >= MAP.w || ty >= MAP.h) continue;
        const kind = map.kind[ty * MAP.w + tx];
        if (kind === T.CLIFF) cliff++;
        else if (kind === T.DEEP) deep++;
        else if (kind === T.SHALLOW) shallow++;
        n++;
      }
      const i = vy * VW + vx;
      let h = surface[i];
      if (n) {
        // A vertex dips only when water touches it, so banks stay crisp.
        h -= (deep / n) * WORLD3D.deepDepth + (shallow / n) * WORLD3D.shallowDepth;
        if (cliff) {
          const share = cliff / n;
          // Deterministic jitter keeps ridges from looking extruded.
          const jitter = (hash2(vx, vy) - 0.5) * 1.6;
          h += share === 1 ? WORLD3D.cliffHeight + jitter : share * WORLD3D.cliffHeight * 0.55;
        }
      }
      ground[i] = h;
    }
  }
  return { ground, surface, vw: VW, vh: VH };
}

/** Deterministic 0..1 hash for decoration placement. */
export function hash2(x, y, salt = 0) {
  let h = (x * 374761393 + y * 668265263 + salt * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/**
 * Height (metres) at tile coordinates, matching the rendered triangles: each
 * tile quad is split along the (0,0)-(1,1) diagonal.
 */
export function heightAt(field, x, y, which = 'ground') {
  const data = field[which];
  const fx = clamp(x, 0, MAP.w - 1e-6);
  const fy = clamp(y, 0, MAP.h - 1e-6);
  const vx = Math.floor(fx);
  const vy = Math.floor(fy);
  const u = fx - vx;
  const v = fy - vy;
  const h00 = data[vy * VW + vx];
  const h10 = data[vy * VW + vx + 1];
  const h01 = data[(vy + 1) * VW + vx];
  const h11 = data[(vy + 1) * VW + vx + 1];
  if (u >= v) return h00 + (h10 - h00) * u + (h11 - h10) * v;
  return h00 + (h11 - h01) * u + (h01 - h00) * v;
}

export const groundHeightAtWorld = (field, wx, wz) => heightAt(field, wx / S, wz / S);

/**
 * March a ray against the height field. Origin and direction are in world
 * metres. Returns the first ground hit as { x, y } tile coords plus world
 * point and distance, or null within maxDist metres.
 */
export function raycastTerrain(field, origin, dir, maxDist = 80, step = 0.35) {
  const len = Math.hypot(dir.x, dir.y, dir.z) || 1;
  const dx = dir.x / len;
  const dy = dir.y / len;
  const dz = dir.z / len;
  let prevT = 0;
  let prevAbove = origin.y - groundHeightAtWorld(field, origin.x, origin.z);
  if (prevAbove < 0) return null;
  for (let t = step; t <= maxDist; t += step) {
    const px = origin.x + dx * t;
    const pz = origin.z + dz * t;
    if (px < 0 || pz < 0 || px > MAP.w * S || pz > MAP.h * S) return null;
    const above = origin.y + dy * t - groundHeightAtWorld(field, px, pz);
    if (above <= 0) {
      // Bisect between the last point above ground and this one.
      let lo = prevT;
      let hi = t;
      for (let k = 0; k < 10; k++) {
        const mid = (lo + hi) / 2;
        const m = origin.y + dy * mid - groundHeightAtWorld(field, origin.x + dx * mid, origin.z + dz * mid);
        if (m > 0) lo = mid; else hi = mid;
      }
      const hx = origin.x + dx * hi;
      const hz = origin.z + dz * hi;
      return {
        distance: hi,
        world: { x: hx, y: origin.y + dy * hi, z: hz },
        x: hx / S,
        y: hz / S,
      };
    }
    prevT = t;
    prevAbove = above;
  }
  return null;
}

/** Snap a ground hit to the tile centre the simulation builds on. */
export function snapToTile(hit) {
  return { x: Math.floor(hit.x) + 0.5, y: Math.floor(hit.y) + 0.5 };
}

/**
 * Ray versus vertical cylinder (world metres). Returns the entry distance or
 * Infinity. `base` and `top` are world heights.
 */
export function rayCylinder(origin, dir, cx, cz, radius, base, top) {
  const len = Math.hypot(dir.x, dir.y, dir.z) || 1;
  const dx = dir.x / len;
  const dy = dir.y / len;
  const dz = dir.z / len;
  const ox = origin.x - cx;
  const oz = origin.z - cz;
  const a = dx * dx + dz * dz;
  const b = 2 * (ox * dx + oz * dz);
  const c = ox * ox + oz * oz - radius * radius;
  const candidates = [];
  // A ray starting inside a target (standing in a postern, perched on a Tower)
  // never picks that target; the crosshair is about what you look AT.
  if (c <= 0 && origin.y >= base && origin.y <= top) return Infinity;
  if (a > 1e-9) {
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const sq = Math.sqrt(disc);
      for (const t of [(-b - sq) / (2 * a), (-b + sq) / (2 * a)]) {
        if (t < 0) continue;
        const y = origin.y + dy * t;
        if (y >= base && y <= top) candidates.push(t);
      }
    }
  }
  if (Math.abs(dy) > 1e-9) {
    for (const plane of [top, base]) {
      const t = (plane - origin.y) / dy;
      if (t < 0) continue;
      const x = ox + dx * t;
      const z = oz + dz * t;
      if (x * x + z * z <= radius * radius) candidates.push(t);
    }
  }
  return candidates.length ? Math.min(...candidates) : Infinity;
}

/**
 * Pick the nearest simulation object the centre-screen ray meets, before the
 * ground. `targets` are { kind, ref, x, y, radius, height } in tile x/y and
 * metres of height above the local ground. Returns { kind, ref, distance } or
 * null. Hits beyond `terrainDistance` (the ground hit) are hidden by terrain.
 */
export function pickTarget(field, origin, dir, targets, maxDist, terrainDistance = Infinity) {
  let best = null;
  let bestT = Math.min(maxDist, terrainDistance + 0.6);
  for (const target of targets) {
    const { x: cx, z: cz } = tileToWorld(target.x, target.y);
    const base = heightAt(field, target.x, target.y) - 0.5;
    const t = rayCylinder(origin, dir, cx, cz, target.radius * S, base, base + 0.5 + target.height);
    if (t < bestT) { bestT = t; best = { kind: target.kind, ref: target.ref, distance: t }; }
  }
  return best;
}

/**
 * D99/D101: a Wall anchor is a finished, standing, non-Keep Tower. Given the
 * object under the crosshair, report whether it can anchor a wall and why not.
 */
export function wallAnchorFromPick(pick) {
  if (!pick || pick.kind !== 'tower') return { ok: false, reason: null };
  const t = pick.ref;
  if (t.keep) return { ok: false, reason: 'Walls must connect two Towers.' };
  if (!t.built) return { ok: false, reason: 'Tower is still under construction.' };
  if (t.hp <= 0 || t.destroyed) return { ok: false, reason: 'Tower is destroyed.' };
  return { ok: true, tower: t };
}

/** Compass heading (degrees, 0 = north, 90 = east) of a facing vector in tiles. */
export function headingDegrees(fx, fy) {
  const deg = Math.atan2(fx, -fy) * 180 / Math.PI;
  return (deg + 360) % 360;
}

/** Facing vector in tile space (x east, y south) for a camera yaw (radians). */
export function facingFromYaw(yaw) {
  return { x: -Math.sin(yaw), y: -Math.cos(yaw) };
}

/**
 * Movement intent in tile space from WASD axes and yaw. forward/strafe are
 * -1..1; the simulation normalises the vector, so only direction matters.
 */
export function moveIntent(forward, strafe, yaw) {
  const f = facingFromYaw(yaw);
  const r = { x: -f.y, y: f.x }; // facing rotated 90 degrees clockwise = right
  return { mx: f.x * forward + r.x * strafe, my: f.y * forward + r.y * strafe };
}
