// D101: build-mode and debug overlays drawn into the world: placement ghosts,
// draped range annuli (blind zone + maximum range), wall previews, eligible
// wall anchors, and debug views (all ranges, nest territory, nav blockers,
// flow-field arrows). Overlays read simulation state; they never change it.

import * as THREE from 'three';
import { MAP, WORLD3D, TOWER, NEST } from '../config.js';
import { heightAt } from './space.js';
import { debugTowerSight } from './sight.js';
import { towerStats, towerMinRange, enemyKeepField } from '../game.js';
import { makeTower, makeFarm, makeQuarry, makeMine, setGroupMaterial, ghostMaterial } from './models.js';
import { disposeTree } from './terrain3d.js';

const S = WORLD3D.tileMeters;
const OK = new THREE.Color('#7dff8a');
const BAD = new THREE.Color('#ff5a4a');

/** A disc or annulus draped over the terrain (tile coords and radii). */
export function drapedAnnulus(field, x, y, r0, r1, color, opacity, radial = 64, rings = 4) {
  const pos = [];
  const idx = [];
  for (let k = 0; k <= rings; k++) {
    const r = r0 + (r1 - r0) * (k / rings);
    for (let s = 0; s <= radial; s++) {
      const a = (s / radial) * Math.PI * 2;
      const px = x + Math.cos(a) * r;
      const py = y + Math.sin(a) * r;
      pos.push(px * S, heightAt(field, px, py) + 0.12, py * S);
    }
  }
  for (let k = 0; k < rings; k++) {
    for (let s = 0; s < radial; s++) {
      const a = k * (radial + 1) + s;
      const b = a + radial + 1;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
    color, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
  }));
  mesh.renderOrder = 3;
  return mesh;
}

export function drapedCircle(field, x, y, r, color, opacity = 0.9, segments = 96) {
  const pts = [];
  for (let s = 0; s <= segments; s++) {
    const a = (s / segments) * Math.PI * 2;
    const px = x + Math.cos(a) * r;
    const py = y + Math.sin(a) * r;
    pts.push(new THREE.Vector3(px * S, heightAt(field, px, py) + 0.25, py * S));
  }
  const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts),
    new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false }));
  line.renderOrder = 4;
  return line;
}

/** Blind-zone disc (red) + firing annulus (blue) with outlines (D93/D101). */
export function rangeDisplay(field, x, y, minRange, maxRange) {
  const g = new THREE.Group();
  g.add(drapedAnnulus(field, x, y, 0.05, minRange, '#ff3a2a', 0.28, 48, 2));
  g.add(drapedAnnulus(field, x, y, minRange, maxRange, '#4aa8ff', 0.22, 72, 4));
  g.add(drapedCircle(field, x, y, minRange, '#ff6a50'));
  g.add(drapedCircle(field, x, y, maxRange, '#9cd0ff'));
  return g;
}

export function createOverlays(scene, field) {
  const root = new THREE.Group();
  root.name = 'overlays';
  scene.add(root);

  const ghostMat = ghostMaterial('#7dff8a');
  const ghosts = { tower: makeTower(), farm: makeFarm(), quarry: makeQuarry(), mine: makeMine() };
  for (const gh of Object.values(ghosts)) {
    setGroupMaterial(gh, ghostMat);
    gh.visible = false;
    root.add(gh);
  }
  let range = null;
  let rangeKey = '';
  let footprint = null;
  let footprintKey = '';

  function clearRange() {
    if (range) { root.remove(range); disposeTree(range); range = null; rangeKey = ''; }
  }
  function setRange(x, y, rMin, rMax) {
    const key = `${x.toFixed(2)}|${y.toFixed(2)}|${rMin.toFixed(2)}|${rMax.toFixed(2)}`;
    if (key === rangeKey) return;
    clearRange();
    range = rangeDisplay(field, x, y, rMin, rMax);
    rangeKey = key;
    root.add(range);
  }
  function setFootprint(x, y, r, ok) {
    const key = `${x}|${y}|${r}|${ok}`;
    if (key === footprintKey) return;
    if (footprint) { root.remove(footprint); disposeTree(footprint); }
    footprint = drapedCircle(field, x, y, r, ok ? '#7dff8a' : '#ff5a4a');
    footprintKey = key;
    root.add(footprint);
  }
  function clearFootprint() {
    if (footprint) { root.remove(footprint); disposeTree(footprint); footprint = null; footprintKey = ''; }
  }

  // Wall preview: ghost course boxes + anchor rings.
  const wallGhostMat = ghostMaterial('#7dff8a');
  const wallBoxes = [];
  const wallBoxGeo = new THREE.BoxGeometry(1, 1, 1);
  function wallBox(k) {
    if (!wallBoxes[k]) {
      const m = new THREE.Mesh(wallBoxGeo, wallGhostMat);
      m.renderOrder = 5;
      root.add(m);
      wallBoxes[k] = m;
    }
    return wallBoxes[k];
  }
  const anchorRings = new Map();
  function anchorRing(id, x, y, r, color) {
    let ring = anchorRings.get(id);
    const key = `${x}|${y}|${color}`;
    if (ring && ring.userData.key === key) { ring.visible = true; return ring; }
    if (ring) { root.remove(ring); disposeTree(ring); }
    ring = drapedCircle(field, x, y, r, color);
    ring.userData.key = key;
    root.add(ring);
    anchorRings.set(id, ring);
    return ring;
  }

  // Debug layers (rebuilt at most twice a second).
  const debugRoot = new THREE.Group();
  root.add(debugRoot);
  let debugAt = -1;
  const arrowGeo = new THREE.ConeGeometry(0.25, 0.9, 4);
  arrowGeo.rotateX(-Math.PI / 2);
  const arrowMat = new THREE.MeshBasicMaterial({ color: '#7fe0ff' });
  const blockerMat = new THREE.MeshBasicMaterial({ color: '#ff3355', transparent: true, opacity: 0.35, depthWrite: false });
  const blockerGeo = new THREE.BoxGeometry(S * 0.96, 0.5, S * 0.96);

  function rebuildDebug(g, flags) {
    for (const c of [...debugRoot.children]) { debugRoot.remove(c); if (c.isLine || c.userData.ownGeo) disposeTree(c); }
    const p = g.player;
    if (flags.ranges) {
      for (const t of g.towers) {
        if (!t.built) continue;
        const ring = rangeDisplay(field, t.x, t.y, towerMinRange(g, t), towerStats(g, t).range);
        ring.userData.ownGeo = true;
        debugRoot.add(ring);
      }
    }
    if (flags.nests) {
      for (const n of g.nests) {
        if (n.destroyed) continue;
        const c = drapedCircle(field, n.x, n.y, NEST.territory, n.state === 'agitated' ? '#d7f36b' : '#8a6a9a');
        debugRoot.add(c);
        const leash = drapedCircle(field, n.x, n.y, NEST.territory + NEST.leash, '#553355', 0.6);
        debugRoot.add(leash);
      }
    }
    if (flags.blockers) {
      const tiles = [];
      const r = 30;
      for (let ty = Math.max(0, Math.floor(p.y - r)); ty < Math.min(MAP.h, p.y + r); ty++) {
        for (let tx = Math.max(0, Math.floor(p.x - r)); tx < Math.min(MAP.w, p.x + r); tx++) {
          if (g.blockerGrid[ty * MAP.w + tx]) tiles.push([tx, ty]);
        }
      }
      if (tiles.length) {
        const inst = new THREE.InstancedMesh(blockerGeo, blockerMat, tiles.length);
        const m = new THREE.Matrix4();
        tiles.forEach(([tx, ty], k) => {
          m.makeTranslation((tx + 0.5) * S, heightAt(field, tx + 0.5, ty + 0.5) + WORLD3D.wallHeight + 0.6, (ty + 0.5) * S);
          inst.setMatrixAt(k, m);
        });
        inst.renderOrder = 6;
        debugRoot.add(inst);
      }
    }
    if (flags.los) {
      // D109: each nearby Tower's sight lines - green to its target, red to an
      // in-annulus enemy it cannot see (ending where the line is blocked).
      const pts = [];
      const cols = [];
      const push = (a, b, c) => {
        pts.push(a.x * S, a.z, a.y * S, b.x * S, b.z, b.y * S);
        cols.push(c.r, c.g, c.b, c.r, c.g, c.b);
      };
      const green = new THREE.Color('#5dff7a');
      const red = new THREE.Color('#ff4a3a');
      const grey = new THREE.Color('#6a5a5a');
      for (const t of g.towers) {
        if (!t.built || Math.hypot(t.x - p.x, t.y - p.y) > 45) continue;
        const range = towerStats(g, t).range;
        const minR = towerMinRange(g, t);
        for (const e of g.enemies) {
          const d = Math.hypot(e.x - t.x, e.y - t.y);
          if (d < minR || d > range) continue;
          const tr = debugTowerSight(g.map, field, t, e.x, e.y, e);
          if (tr.clear) push(tr.from, tr.to, e.id === t.targetId ? green : grey);
          else { push(tr.from, tr.at, red); push(tr.at, tr.to, grey); }
        }
      }
      if (pts.length) {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
        geo.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
        const lines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false, transparent: true }));
        lines.renderOrder = 9;
        lines.userData.ownGeo = true;
        debugRoot.add(lines);
      }
    }
    if (flags.paths) {
      const field2 = enemyKeepField(g, 'swarm');
      if (field2) {
        const arrows = [];
        const r = 18;
        for (let ty = Math.max(1, Math.floor(p.y - r)); ty < Math.min(MAP.h - 1, p.y + r); ty += 2) {
          for (let tx = Math.max(1, Math.floor(p.x - r)); tx < Math.min(MAP.w - 1, p.x + r); tx += 2) {
            const here = field2[ty * MAP.w + tx];
            if (!Number.isFinite(here)) continue;
            let best = here;
            let bx = 0;
            let by = 0;
            for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
              const v = field2[(ty + oy) * MAP.w + tx + ox];
              if (Number.isFinite(v) && v < best) { best = v; bx = ox; by = oy; }
            }
            if (bx || by) arrows.push([tx + 0.5, ty + 0.5, Math.atan2(-bx, -by)]);
          }
        }
        if (arrows.length) {
          const inst = new THREE.InstancedMesh(arrowGeo, arrowMat, arrows.length);
          const o = new THREE.Object3D();
          arrows.forEach(([x, y, yaw], k) => {
            o.position.set(x * S, heightAt(field, x, y) + 0.6, y * S);
            o.rotation.set(0, yaw, 0);
            o.updateMatrix();
            inst.setMatrixAt(k, o.matrix);
          });
          debugRoot.add(inst);
        }
      }
    }
  }

  return {
    /**
     * view: { buildMode, buildType, site: {x, y, check} | null, wall: {...} | null,
     *         inspectTower, debug flags }
     */
    update(g, view) {
      for (const gh of Object.values(ghosts)) gh.visible = false;
      for (const box of wallBoxes) box.visible = false;
      for (const ring of anchorRings.values()) ring.visible = false;
      let showRange = false;
      let showFoot = false;

      if (view.buildMode && view.buildType !== 'wall' && view.site) {
        const { x, y, check } = view.site;
        const ghost = ghosts[view.buildType];
        if (ghost) {
          ghost.visible = true;
          ghost.position.set(x * S, heightAt(field, x, y), y * S);
          ghostMat.color.copy(check?.ok ? OK : BAD);
        }
        if (view.buildType === 'tower') {
          setRange(x, y, TOWER.weapon.minRange, TOWER.weapon.range);
          showRange = true;
          setFootprint(x, y, TOWER.radius, !!check?.ok);
          showFoot = true;
        } else if (view.buildType === 'farm') {
          setFootprint(x, y, 1.6, !!check?.ok);
          showFoot = true;
        } else if (check?.site) {
          setFootprint(check.site.x, check.site.y, 1.5, !!check?.ok);
          showFoot = true;
        }
      }

      if (view.buildMode && view.buildType === 'wall') {
        // Every eligible anchor is ringed; the Keep never is (D99).
        for (const t of g.towers) {
          if (t.keep || !t.built || t.hp <= 0) continue;
          const isA = t.id === view.wall?.a;
          const isHover = t.id === view.wall?.hover;
          const color = isA ? '#ffd666' : isHover ? (view.wall?.plan?.ok ? '#7dff8a' : '#ff5a4a') : '#bfe3ff';
          anchorRing(t.id, t.x, t.y, t.radius + 0.6, color);
        }
        const plan = view.wall?.plan;
        const a = g.towers.find((t) => t.id === view.wall?.a);
        const b = g.towers.find((t) => t.id === view.wall?.hover);
        if (plan && a && b) {
          wallGhostMat.color.copy(plan.ok && view.wall.near ? OK : BAD);
          const angle = Math.atan2(b.y - a.y, b.x - a.x);
          const len = S * (Math.abs(Math.cos(angle)) + Math.abs(Math.sin(angle)));
          (plan.segments || []).forEach((tile, k) => {
            const box = wallBox(k);
            const x = tile.x + 0.5;
            const y = tile.y + 0.5;
            box.visible = true;
            box.position.set(x * S, heightAt(field, x, y) + WORLD3D.wallHeight / 2, y * S);
            box.rotation.set(0, -angle, 0);
            box.scale.set(len, WORLD3D.wallHeight, WORLD3D.wallThickness);
          });
        }
      }

      if (!showRange && view.inspectTower) {
        const t = view.inspectTower;
        setRange(t.x, t.y, towerMinRange(g, t), towerStats(g, t).range);
        showRange = true;
      }
      if (!showRange) clearRange();
      if (!showFoot) clearFootprint();

      const flags = view.debug || {};
      const any = flags.ranges || flags.nests || flags.blockers || flags.paths || flags.los;
      const every = flags.los ? 0.12 : 0.5;
      if (!any && debugRoot.children.length) rebuildDebug(g, {});
      else if (any && (g.time - debugAt > every || g.time < debugAt)) { debugAt = g.time; rebuildDebug(g, flags); }
    },
  };
}

