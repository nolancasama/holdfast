// D109: height-aware Tower sight for the first-person build. Pure maths (no
// Three.js, no DOM) so the simulation, the renderer and Node tests share it.
//
// The 2D model (terrain.js hasLineOfSight) treats every Forest tile as a solid
// wall unless the shooter stands on a higher band, and ignores hills entirely.
// In first person that disagrees with the scene: a 9 m Tower plainly sees over
// sparse trees, and a ridge plainly hides a low target. Here a sight line runs
// from the turret muzzle to the target's upper body through the rendered height
// field and the rendered trees.

import { MAP, T, WORLD3D, SIGHT } from '../config.js';
import { heightAt, hash2 } from './space.js';

/**
 * The tree the renderer draws on a tile, or null. terrain3d.js builds the
 * instanced forest from this, so sight and scene can never disagree.
 */
export function treeAt(map, tx, ty) {
  if (tx < 0 || ty < 0 || tx >= MAP.w || ty >= MAP.h) return null;
  if (map.kind[ty * MAP.w + tx] !== T.FOREST) return null;
  // About half the forest tiles carry one tree (D101 brief §9).
  if (hash2(tx, ty, 11) > 0.5) return null;
  const height = 7 + hash2(tx, ty, 14) * 4;
  const crownBase = Math.max(2.8, height * 0.36);
  return {
    x: tx + 0.25 + hash2(tx, ty, 12) * 0.5,
    y: ty + 0.25 + hash2(tx, ty, 13) * 0.5,
    height, crownBase,
    crownRadius: 0.8 + hash2(tx, ty, 15) * 0.45,
  };
}

/** Turret yaw (Three.js, barrel along local -Z) that points a Tower at a target. */
export function turretYaw(t, target) {
  return Math.atan2(-(target.x - t.x), -(target.y - t.y));
}

/** Metres above the Tower's ground where its shots leave the barrel. */
export function muzzleHeight(t) {
  return t.keep ? WORLD3D.keepHeight + 0.6 + 0.7 : WORLD3D.towerHeight + 0.55;
}

/** Metres above the ground of the point a Tower aims at (upper body). */
export function targetHeight(target) {
  if (!target) return SIGHT.targetHeight.swarm;
  if (target.nest) return SIGHT.targetHeight.nest;
  return SIGHT.targetHeight[target.type] ?? SIGHT.targetHeight.swarm;
}

/**
 * Trace a straight sight line between two points (tile x/y, absolute metres z).
 * Terrain blocks when the ground rises above the line. Trees are crowns (cones):
 * a line may pass through `SIGHT.canopyHitsToBlock - 1` crowns and still see -
 * gaps between sparse trees are real - but thick woods block.
 * Returns { clear, blockedBy: null | 'terrain' | 'canopy', at, canopy }.
 */
export function traceSight(map, field, x0, y0, z0, x1, y1, z1) {
  const dist = Math.hypot(x1 - x0, y1 - y0);
  const steps = Math.max(2, Math.ceil(dist / SIGHT.step));
  const clearance = SIGHT.endClearance;
  const crowns = new Set();
  for (let i = 1; i < steps; i++) {
    const f = i / steps;
    const along = f * dist;
    if (along < clearance || dist - along < clearance) continue;
    const x = x0 + (x1 - x0) * f;
    const y = y0 + (y1 - y0) * f;
    const z = z0 + (z1 - z0) * f;
    const ground = heightAt(field, x, y);
    if (ground > z) return { clear: false, blockedBy: 'terrain', at: { x, y, z }, canopy: crowns.size };
    // A crown can overhang the neighbouring tile, so test the 3x3 around the sample.
    const tx = Math.floor(x);
    const ty = Math.floor(y);
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        const key = (ty + oy) * MAP.w + tx + ox;
        if (crowns.has(key)) continue;
        const tree = treeAt(map, tx + ox, ty + oy);
        if (!tree) continue;
        const base = heightAt(field, tree.x, tree.y);
        const rise = z - base;
        if (rise < tree.crownBase || rise > tree.height) continue;
        const k = 1 - (rise - tree.crownBase) / (tree.height - tree.crownBase);
        const r = tree.crownRadius * k; // metres; the cone narrows upwards
        if (Math.hypot(x - tree.x, y - tree.y) * WORLD3D.tileMeters > r) continue;
        crowns.add(key);
        if (crowns.size >= SIGHT.canopyHitsToBlock) {
          return { clear: false, blockedBy: 'canopy', at: { x, y, z }, canopy: crowns.size };
        }
      }
    }
  }
  return { clear: true, blockedBy: null, at: null, canopy: crowns.size };
}

/**
 * The `g.rules.towerSight` hook the first-person shell installs. The returned
 * function answers "can this Tower physically see that point?" and keeps the
 * last trace on the Tower for the debug LOS ray.
 */
export function createTowerSight(field) {
  return function towerSight(g, t, x, y, target) {
    const z0 = heightAt(field, t.x, t.y) + muzzleHeight(t);
    const z1 = heightAt(field, x, y) + targetHeight(target);
    return traceSight(g.map, field, t.x, t.y, z0, x, y, z1).clear;
  };
}

/** Full trace for debug drawing: muzzle and target points plus the result. */
export function debugTowerSight(map, field, t, x, y, target) {
  const z0 = heightAt(field, t.x, t.y) + muzzleHeight(t);
  const z1 = heightAt(field, x, y) + targetHeight(target);
  return { from: { x: t.x, y: t.y, z: z0 }, to: { x, y, z: z1 }, ...traceSight(map, field, t.x, t.y, z0, x, y, z1) };
}
