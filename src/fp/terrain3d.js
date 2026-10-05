// D101: static world meshes built from the generated map: ground, water,
// roads, forest, marsh reeds, cliff boulders and resource deposits.
// Everything is derived from the simulation map; nothing here is game state.

import * as THREE from 'three';
import { MAP, T, WORLD3D } from '../config.js';
import { heightAt, hash2 } from './space.js';

const S = WORLD3D.tileMeters;

const KIND_COLOR = {
  [T.PLAIN]: new THREE.Color('#6f9a48'),
  [T.FOREST]: new THREE.Color('#4a6f30'),
  [T.MARSH]: new THREE.Color('#566040'),
  [T.SHALLOW]: new THREE.Color('#77704f'),
  [T.DEEP]: new THREE.Color('#3b4746'),
  [T.CLIFF]: new THREE.Color('#87827a'),
};
const ROAD_TILE = new THREE.Color('#8f7a55');
const FERTILE = new THREE.Color('#a7a54a');
const RICH = new THREE.Color('#c9b552');

const tmpColor = new THREE.Color();

/** Ground colour of one tile: kind, band brightness, fertility, road. */
function tileColor(map, tx, ty) {
  const i = ty * MAP.w + tx;
  const kind = map.kind[i];
  tmpColor.copy(KIND_COLOR[kind] || KIND_COLOR[T.PLAIN]);
  if (kind !== T.CLIFF && kind !== T.DEEP && kind !== T.SHALLOW) {
    const fert = map.fertility?.[i] || 0;
    if (fert > 0) tmpColor.lerp(fert > 1 ? RICH : FERTILE, fert > 1 ? 0.6 : 0.45);
    if (map.road[i]) tmpColor.lerp(ROAD_TILE, 0.75);
  }
  const band = [0.86, 1.0, 1.12][map.elev[i]] ?? 1;
  const jitter = 0.94 + hash2(tx, ty, 3) * 0.12;
  tmpColor.multiplyScalar(band * jitter);
  return tmpColor;
}

function buildGround(map, field) {
  const quads = MAP.w * MAP.h;
  const pos = new Float32Array(quads * 6 * 3);
  const col = new Float32Array(quads * 6 * 3);
  const g = field.ground;
  const vw = field.vw;
  let p = 0;
  let c = 0;
  for (let ty = 0; ty < MAP.h; ty++) {
    for (let tx = 0; tx < MAP.w; tx++) {
      const h00 = g[ty * vw + tx];
      const h10 = g[ty * vw + tx + 1];
      const h01 = g[(ty + 1) * vw + tx];
      const h11 = g[(ty + 1) * vw + tx + 1];
      const x0 = tx * S;
      const x1 = (tx + 1) * S;
      const z0 = ty * S;
      const z1 = (ty + 1) * S;
      // Split along (0,0)-(1,1), matching heightAt(). Counter-clockwise from above.
      const verts = [
        x0, h00, z0, x1, h11, z1, x1, h10, z0,
        x0, h00, z0, x0, h01, z1, x1, h11, z1,
      ];
      pos.set(verts, p);
      p += 18;
      const color = tileColor(map, tx, ty);
      for (let k = 0; k < 6; k++) { col[c++] = color.r; col[c++] = color.g; col[c++] = color.b; }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.computeVertexNormals();
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.name = 'ground';
  return mesh;
}

function buildWater(map, field) {
  const tiles = [];
  for (let ty = 0; ty < MAP.h; ty++) {
    for (let tx = 0; tx < MAP.w; tx++) {
      const k = map.kind[ty * MAP.w + tx];
      if (k === T.SHALLOW || k === T.DEEP) tiles.push([tx, ty, k]);
    }
  }
  if (!tiles.length) return null;
  const pos = new Float32Array(tiles.length * 18);
  const col = new Float32Array(tiles.length * 18);
  const s = field.surface;
  const vw = field.vw;
  const shallow = new THREE.Color('#5d9fbf');
  const deep = new THREE.Color('#244f78');
  let p = 0;
  let c = 0;
  for (const [tx, ty, k] of tiles) {
    const drop = 0.22;
    const h00 = s[ty * vw + tx] - drop;
    const h10 = s[ty * vw + tx + 1] - drop;
    const h01 = s[(ty + 1) * vw + tx] - drop;
    const h11 = s[(ty + 1) * vw + tx + 1] - drop;
    const x0 = tx * S; const x1 = (tx + 1) * S; const z0 = ty * S; const z1 = (ty + 1) * S;
    pos.set([x0, h00, z0, x1, h11, z1, x1, h10, z0, x0, h00, z0, x0, h01, z1, x1, h11, z1], p);
    p += 18;
    const color = k === T.DEEP ? deep : shallow;
    for (let n = 0; n < 6; n++) { col[c++] = color.r; col[c++] = color.g; col[c++] = color.b; }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.computeVertexNormals();
  const mat = new THREE.MeshPhongMaterial({
    vertexColors: true, transparent: true, opacity: 0.82, shininess: 90, specular: 0x9fc7e0,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'water';
  mesh.renderOrder = 1;
  return mesh;
}

/** Smooth ribbons along each road's straightened polyline (D96 vertices). */
function buildRoads(map, field) {
  const halfWidth = 0.72; // tiles: the carved band is about 1.4 tiles wide
  const positions = [];
  const indices = [];
  for (const route of map.roadRoutes || []) {
    const verts = (route.vertices || []).map((i) => ({ x: (i % MAP.w) + 0.5, y: Math.floor(i / MAP.w) + 0.5 }));
    if (verts.length < 2) continue;
    const pts = [];
    for (let k = 0; k < verts.length - 1; k++) {
      const a = verts[k];
      const b = verts[k + 1];
      const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 0.5));
      for (let s = 0; s < steps; s++) pts.push({ x: a.x + (b.x - a.x) * s / steps, y: a.y + (b.y - a.y) * s / steps });
    }
    pts.push(verts[verts.length - 1]);
    const base = positions.length / 3;
    for (let k = 0; k < pts.length; k++) {
      const prev = pts[Math.max(0, k - 1)];
      const next = pts[Math.min(pts.length - 1, k + 1)];
      let dx = next.x - prev.x;
      let dy = next.y - prev.y;
      const len = Math.hypot(dx, dy) || 1;
      dx /= len; dy /= len;
      const nx = -dy;
      const ny = dx;
      for (const side of [-1, 1]) {
        const x = pts[k].x + nx * halfWidth * side;
        const y = pts[k].y + ny * halfWidth * side;
        const h = Math.max(heightAt(field, x, y), heightAt(field, pts[k].x, pts[k].y), heightAt(field, x, y, 'surface') - 0.15);
        positions.push(x * S, h + 0.07, y * S);
      }
      if (k > 0) {
        const a = base + (k - 1) * 2;
        indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
  }
  if (!positions.length) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  const mat = new THREE.MeshLambertMaterial({
    color: '#a88f62', side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.name = 'roads';
  return mesh;
}

const dummy = new THREE.Object3D();

function instanced(geometry, material, transforms, colors = null) {
  if (!transforms.length) return null;
  const mesh = new THREE.InstancedMesh(geometry, material, transforms.length);
  transforms.forEach((m, k) => mesh.setMatrixAt(k, m));
  if (colors) colors.forEach((cc, k) => mesh.setColorAt(k, cc));
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  return mesh;
}

function matrix(x, y, z, sx, sy, sz, ry = 0, rx = 0) {
  dummy.position.set(x, y, z);
  dummy.rotation.set(rx, ry, 0);
  dummy.scale.set(sx, sy, sz);
  dummy.updateMatrix();
  return dummy.matrix.clone();
}

/** Trees on forest tiles; sparse enough to walk between (D101 brief §9). */
function buildForest(map, field) {
  const trunks = [];
  const crowns = [];
  const crownColors = [];
  for (let ty = 0; ty < MAP.h; ty++) {
    for (let tx = 0; tx < MAP.w; tx++) {
      if (map.kind[ty * MAP.w + tx] !== T.FOREST) continue;
      // About half the forest tiles carry one tree; crowns start well above
      // eye height so the player can see between trunks.
      if (hash2(tx, ty, 11) > 0.5) continue;
      const x = tx + 0.25 + hash2(tx, ty, 12) * 0.5;
      const y = ty + 0.25 + hash2(tx, ty, 13) * 0.5;
      const h = heightAt(field, x, y);
      const height = 7 + hash2(tx, ty, 14) * 4;
      const wx = x * S;
      const wz = y * S;
      trunks.push(matrix(wx, h + height * 0.25, wz, 1, height * 0.5, 1));
      const r = 0.8 + hash2(tx, ty, 15) * 0.45;
      const crownBase = Math.max(2.8, height * 0.36);
      const crownH = height - crownBase;
      crowns.push(matrix(wx, h + crownBase + crownH / 2, wz, r, crownH, r, hash2(tx, ty, 16) * 6));
      crownColors.push(new THREE.Color().setHSL(0.27 + hash2(tx, ty, 17) * 0.07, 0.45, 0.2 + hash2(tx, ty, 18) * 0.1));
    }
  }
  const group = new THREE.Group();
  group.name = 'forest';
  const trunk = instanced(new THREE.CylinderGeometry(0.11, 0.17, 1, 5), new THREE.MeshLambertMaterial({ color: '#5a4430' }), trunks);
  const crown = instanced(new THREE.ConeGeometry(1, 1, 7), new THREE.MeshLambertMaterial({ color: '#ffffff', flatShading: true }), crowns, crownColors);
  if (trunk) group.add(trunk);
  if (crown) group.add(crown);
  return group;
}

function buildMarshAndRocks(map, field) {
  const reeds = [];
  const rocks = [];
  for (let ty = 0; ty < MAP.h; ty++) {
    for (let tx = 0; tx < MAP.w; tx++) {
      const kind = map.kind[ty * MAP.w + tx];
      if (kind === T.MARSH && hash2(tx, ty, 21) < 0.45) {
        for (let k = 0; k < 3; k++) {
          const x = tx + hash2(tx, ty, 22 + k);
          const y = ty + hash2(tx, ty, 25 + k);
          const h = heightAt(field, x, y);
          const height = 0.7 + hash2(tx, ty, 28 + k) * 0.8;
          reeds.push(matrix(x * S, h + height / 2, y * S, 1, height, 1, 0, (hash2(tx, ty, 31 + k) - 0.5) * 0.4));
        }
      } else if (kind === T.CLIFF && hash2(tx, ty, 41) < 0.3) {
        const x = tx + hash2(tx, ty, 42);
        const y = ty + hash2(tx, ty, 43);
        const r = 0.6 + hash2(tx, ty, 44) * 0.9;
        // Sit on the lowest nearby ground so boulders never hover over a ridge.
        let h = heightAt(field, x, y);
        for (const [ox, oy] of [[0.4, 0], [-0.4, 0], [0, 0.4], [0, -0.4]]) h = Math.min(h, heightAt(field, x + ox, y + oy));
        rocks.push(matrix(x * S, h + r * 0.15, y * S, r, r * 0.8, r, hash2(tx, ty, 45) * 6));
      }
    }
  }
  const group = new THREE.Group();
  const reed = instanced(new THREE.ConeGeometry(0.05, 1, 4), new THREE.MeshLambertMaterial({ color: '#8f9a4e' }), reeds);
  const rock = instanced(new THREE.DodecahedronGeometry(1, 0), new THREE.MeshLambertMaterial({ color: '#77736c', flatShading: true }), rocks);
  if (reed) group.add(reed);
  if (rock) { rock.castShadow = true; group.add(rock); }
  return group;
}

/** Stone and gold deposits: visible landmarks the player discovers on foot. */
function buildDeposits(map, field) {
  const stone = [];
  const goldRock = [];
  const goldVein = [];
  for (const site of map.stoneSites || []) {
    const rich = site.mult > 1;
    const n = rich ? 9 : 6;
    for (let k = 0; k < n; k++) {
      const a = hash2(site.x, site.y, 50 + k) * Math.PI * 2;
      const d = 0.3 + hash2(site.x, site.y, 60 + k) * (rich ? 1.6 : 1.1);
      const x = site.x + Math.cos(a) * d;
      const y = site.y + Math.sin(a) * d;
      const r = (rich ? 0.9 : 0.6) + hash2(site.x, site.y, 70 + k) * 0.7;
      stone.push(matrix(x * S, heightAt(field, x, y) + r * 0.35, y * S, r * 1.2, r, r, a));
    }
  }
  for (const site of map.goldSites || []) {
    const rich = site.mult > 1;
    const n = rich ? 7 : 5;
    for (let k = 0; k < n; k++) {
      const a = hash2(site.x, site.y, 80 + k) * Math.PI * 2;
      const d = 0.3 + hash2(site.x, site.y, 90 + k) * 1.1;
      const x = site.x + Math.cos(a) * d;
      const y = site.y + Math.sin(a) * d;
      const r = 0.55 + hash2(site.x, site.y, 100 + k) * 0.6;
      const h = heightAt(field, x, y);
      goldRock.push(matrix(x * S, h + r * 0.35, y * S, r, r * 0.9, r, a));
      goldVein.push(matrix(x * S, h + r * 0.95, y * S, 0.22 * (rich ? 1.5 : 1), 0.4 * (rich ? 1.5 : 1), 0.22, a, 0.3));
    }
  }
  const group = new THREE.Group();
  group.name = 'deposits';
  const s = instanced(new THREE.DodecahedronGeometry(1, 0), new THREE.MeshLambertMaterial({ color: '#c7cbcf', flatShading: true }), stone);
  const gr = instanced(new THREE.DodecahedronGeometry(1, 0), new THREE.MeshLambertMaterial({ color: '#4a4038', flatShading: true }), goldRock);
  const gv = instanced(new THREE.OctahedronGeometry(1, 0),
    new THREE.MeshPhongMaterial({ color: '#ffd23f', emissive: '#a87a10', emissiveIntensity: 0.7, shininess: 120, flatShading: true }), goldVein);
  for (const m of [s, gr, gv]) if (m) { m.castShadow = true; group.add(m); }
  return group;
}

/** A darker skirt beyond the map edge so the world does not end in a void. */
function buildSkirt() {
  const w = MAP.w * S;
  const h = MAP.h * S;
  const geo = new THREE.PlaneGeometry(w * 4, h * 6);
  geo.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: '#3f5a33' }));
  mesh.position.set(w / 2, -0.6, h / 2);
  return mesh;
}

/** Build the static world. Rebuild `vegetation` when terrainVersion changes. */
export function buildTerrainScene(map, field) {
  const group = new THREE.Group();
  group.name = 'terrain';
  group.add(buildSkirt());
  const ground = buildGround(map, field);
  group.add(ground);
  const water = buildWater(map, field);
  if (water) group.add(water);
  const roads = buildRoads(map, field);
  if (roads) group.add(roads);
  group.add(buildMarshAndRocks(map, field));
  group.add(buildDeposits(map, field));
  const forest = buildForest(map, field);
  group.add(forest);
  return { group, ground, forest };
}

/** Forest clearing (towers clear trees, D69) changes colours and trees only. */
export function refreshVegetation(scene3d, map, field) {
  const { group } = scene3d;
  group.remove(scene3d.forest);
  disposeTree(scene3d.forest);
  scene3d.forest = buildForest(map, field);
  group.add(scene3d.forest);
  const col = scene3d.ground.geometry.getAttribute('color');
  let c = 0;
  for (let ty = 0; ty < MAP.h; ty++) {
    for (let tx = 0; tx < MAP.w; tx++) {
      const color = tileColor(map, tx, ty);
      for (let k = 0; k < 6; k++) col.setXYZ(c++, color.r, color.g, color.b);
    }
  }
  col.needsUpdate = true;
}

export function disposeTree(object) {
  object.traverse((o) => {
    o.geometry?.dispose();
    if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose());
    else o.material?.dispose();
  });
}
