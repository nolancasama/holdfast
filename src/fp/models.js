// D101: primitive low-poly models. Each factory returns a THREE.Group whose
// origin sits on the ground at the structure's centre. Sizes derive from the
// simulation radius x WORLD3D.tileMeters so collision and visuals agree.

import * as THREE from 'three';
import { TOWER, KEEP, WORLD3D, NEST, ENEMIES, WILD } from '../config.js';

const S = WORLD3D.tileMeters;

export const MAT = {
  stone: new THREE.MeshLambertMaterial({ color: '#b1a898', flatShading: true }),
  stoneDark: new THREE.MeshLambertMaterial({ color: '#867d70', flatShading: true }),
  keepStone: new THREE.MeshLambertMaterial({ color: '#c9bfa8', flatShading: true }),
  roof: new THREE.MeshLambertMaterial({ color: '#7b3f2c', flatShading: true }),
  wood: new THREE.MeshLambertMaterial({ color: '#7a5a3a', flatShading: true }),
  woodDark: new THREE.MeshLambertMaterial({ color: '#4f3a26', flatShading: true }),
  metal: new THREE.MeshLambertMaterial({ color: '#4b5058', flatShading: true }),
  banner: new THREE.MeshLambertMaterial({ color: '#e0a92e', side: THREE.DoubleSide, emissive: '#5a3d05' }),
  bannerConnected: new THREE.MeshLambertMaterial({ color: '#5aa9ff', side: THREE.DoubleSide, emissive: '#0d2c55' }),
  bannerOutpost: new THREE.MeshLambertMaterial({ color: '#f2a03b', side: THREE.DoubleSide, emissive: '#4d2a05' }),
  soldier: new THREE.MeshLambertMaterial({ color: '#3d5f9e' }),
  crop: new THREE.MeshLambertMaterial({ color: '#8fb547', flatShading: true }),
  cropRipe: new THREE.MeshLambertMaterial({ color: '#d4b54a', flatShading: true }),
  soil: new THREE.MeshLambertMaterial({ color: '#6b4f33' }),
  pit: new THREE.MeshLambertMaterial({ color: '#4d4a46' }),
  gold: new THREE.MeshPhongMaterial({ color: '#ffd23f', emissive: '#a07010', emissiveIntensity: 0.6, shininess: 110, flatShading: true }),
  rock: new THREE.MeshLambertMaterial({ color: '#8d8880', flatShading: true }),
  rubble: new THREE.MeshLambertMaterial({ color: '#76706a', flatShading: true }),
  scaffold: new THREE.LineBasicMaterial({ color: '#d9c39a', transparent: true, opacity: 0.55 }),
  nest: new THREE.MeshLambertMaterial({ color: '#3d2c3f', flatShading: true }),
  nestSpike: new THREE.MeshLambertMaterial({ color: '#2a2030', flatShading: true }),
  nestCore: new THREE.MeshBasicMaterial({ color: '#b7e04a' }),
  flash: new THREE.MeshBasicMaterial({ color: '#ffffff' }),
};

const ENEMY_MAT = {
  swarm: new THREE.MeshLambertMaterial({ color: ENEMIES.swarm.color, flatShading: true }),
  runner: new THREE.MeshLambertMaterial({ color: ENEMIES.runner.color, flatShading: true }),
  heavy: new THREE.MeshLambertMaterial({ color: ENEMIES.heavy.color, flatShading: true }),
  feral: new THREE.MeshLambertMaterial({ color: WILD.feral.color, flatShading: true }),
  eye: new THREE.MeshBasicMaterial({ color: '#ffef9a' }),
  horn: new THREE.MeshLambertMaterial({ color: '#e8e0cc', flatShading: true }),
};

function mesh(geo, mat, x = 0, y = 0, z = 0, shadow = true) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.castShadow = shadow;
  m.receiveShadow = shadow;
  return m;
}

function crenels(group, radius, y, count, size = 0.55, mat = MAT.stone) {
  const geo = new THREE.BoxGeometry(size, size * 1.1, size);
  for (let k = 0; k < count; k++) {
    const a = (k / count) * Math.PI * 2;
    const m = mesh(geo, mat, Math.cos(a) * radius, y + size * 0.55, Math.sin(a) * radius);
    m.rotation.y = -a;
    group.add(m);
  }
}

function turret() {
  const g = new THREE.Group();
  g.add(mesh(new THREE.CylinderGeometry(0.55, 0.7, 0.7, 8), MAT.metal, 0, 0.35, 0));
  const barrel = mesh(new THREE.CylinderGeometry(0.13, 0.17, 1.9, 6), MAT.metal, 0, 0.55, -0.9);
  barrel.rotation.x = Math.PI / 2;
  g.add(barrel);
  g.userData.muzzle = new THREE.Vector3(0, 0.55, -1.85);
  return g;
}

function scaffoldFor(radius, height) {
  const geo = new THREE.EdgesGeometry(new THREE.CylinderGeometry(radius * 1.12, radius * 1.12, height, 8, 3));
  const lines = new THREE.LineSegments(geo, MAT.scaffold);
  lines.position.y = height / 2;
  return lines;
}

/** Tower: stone cylinder, firing platform, crenels, turret, pennant, garrison. */
export function makeTower() {
  const g = new THREE.Group();
  const r = TOWER.radius * S;
  const h = WORLD3D.towerHeight;
  const body = new THREE.Group();
  const shaftMat = MAT.stone.clone();
  const shaft = mesh(new THREE.CylinderGeometry(r * 0.92, r, h - 0.7, 10), shaftMat, 0, (h - 0.7) / 2, 0);
  body.add(shaft);
  // Door and arrow slits.
  const door = mesh(new THREE.BoxGeometry(0.9, 1.7, 0.3), MAT.woodDark, 0, 0.85, r * 0.93);
  body.add(door);
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * Math.PI * 2 + 0.6;
    const slit = mesh(new THREE.BoxGeometry(0.18, 0.9, 0.2), MAT.woodDark, Math.cos(a) * r * 0.9, h * 0.6, Math.sin(a) * r * 0.9);
    slit.rotation.y = -a + Math.PI / 2;
    body.add(slit);
  }
  g.add(body);
  const top = new THREE.Group();
  top.position.y = h - 0.7;
  top.add(mesh(new THREE.CylinderGeometry(r * 1.2, r * 0.95, 0.7, 10), shaftMat, 0, 0.35, 0));
  crenels(top, r * 1.1, 0.7, 10);
  const gun = turret();
  gun.position.y = 0.7;
  top.add(gun);
  const pole = mesh(new THREE.CylinderGeometry(0.05, 0.05, 3, 4), MAT.wood, -r * 0.7, 2.2, r * 0.7, false);
  top.add(pole);
  const pennant = mesh(new THREE.PlaneGeometry(1.3, 0.7), MAT.bannerOutpost, -r * 0.7 + 0.65, 3.3, r * 0.7, false);
  top.add(pennant);
  const soldiers = [];
  for (let k = 0; k < 2; k++) {
    const s = new THREE.Group();
    s.add(mesh(new THREE.CylinderGeometry(0.22, 0.26, 1.1, 6), MAT.soldier, 0, 1.25, 0, false));
    s.add(mesh(new THREE.SphereGeometry(0.2, 6, 5), MAT.stone, 0, 1.95, 0, false));
    s.position.set(k ? r * 0.6 : -r * 0.6, 0, k ? -r * 0.4 : -r * 0.3);
    s.visible = false;
    top.add(s);
    soldiers.push(s);
  }
  g.add(top);
  const scaffold = scaffoldFor(r, h);
  g.add(scaffold);
  g.userData = { body, top, gun, pennant, soldiers, scaffold, shaftMat, height: h, radius: r };
  return g;
}

/**
 * Keep: tall octagonal donjon with a low crenellated roof and a banner. D108:
 * no corner turrets or spires - the roof is the best early observation point,
 * so nothing taller than the parapet stands between the player and the horizon.
 */
export function makeKeep() {
  const g = new THREE.Group();
  const r = KEEP.radius * S;
  const h = WORLD3D.keepHeight;
  const mat = MAT.keepStone.clone();
  const body = new THREE.Group();
  body.add(mesh(new THREE.CylinderGeometry(r * 1.02, r * 1.1, h, 8), mat, 0, h / 2, 0));
  body.add(mesh(new THREE.BoxGeometry(1.4, 2.4, 0.4), MAT.woodDark, 0, 1.2, r * 1.03));
  // Shallow buttresses keep the silhouette strong from the ground without
  // rising above the roof walk.
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2 + Math.PI / 4;
    body.add(mesh(new THREE.CylinderGeometry(0.7, 0.95, h * 0.72, 8), mat,
      Math.cos(a) * r * 0.98, h * 0.36, Math.sin(a) * r * 0.98));
  }
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2 + Math.PI / 8;
    const m = mesh(new THREE.BoxGeometry(0.4, 1.0, 0.25), MAT.woodDark, Math.cos(a) * r * 1.06, h * 0.62, Math.sin(a) * r * 1.06);
    m.rotation.y = -a + Math.PI / 2;
    body.add(m);
  }
  g.add(body);
  const top = new THREE.Group();
  top.position.y = h;
  top.add(mesh(new THREE.CylinderGeometry(r * 1.15, r * 1.02, 0.6, 8), mat, 0, 0.3, 0));
  crenels(top, r * 1.08, 0.6, 12, 0.6, mat);
  const gun = turret();
  gun.position.y = 0.6;
  gun.scale.setScalar(1.25);
  top.add(gun);
  // Banner on a thin pole at the parapet edge; the cloth flies above eye height.
  top.add(mesh(new THREE.CylinderGeometry(0.08, 0.08, 7, 5), MAT.wood, 0, 4.1, r * 1.0, false));
  const flag = mesh(new THREE.PlaneGeometry(3.2, 1.8, 6, 1), MAT.banner, 1.6, 6.6, r * 1.0, false);
  top.add(flag);
  g.add(top);
  g.userData = { body, top, gun, flag, shaftMat: mat, height: h + 0.6, radius: r, soldiers: [] };
  return g;
}

/** One wall segment. `length` follows the link direction (D81 tiles). */
export function makeWallSegment(length, gate) {
  const g = new THREE.Group();
  const h = WORLD3D.wallHeight;
  const t = WORLD3D.wallThickness;
  const mat = MAT.stone.clone();
  const body = new THREE.Group();
  if (gate) {
    // D101 postern: a gap the player walks through; enemies still treat it as solid.
    const post = new THREE.BoxGeometry(length * 0.22, h + 0.4, t * 1.15);
    body.add(mesh(post, mat, -length * 0.39, (h + 0.4) / 2, 0));
    body.add(mesh(post, mat, length * 0.39, (h + 0.4) / 2, 0));
    body.add(mesh(new THREE.BoxGeometry(length, 0.7, t * 1.15), mat, 0, h + 0.05, 0));
    const leaf = new THREE.BoxGeometry(length * 0.3, h - 0.9, 0.12);
    const l = mesh(leaf, MAT.wood, -length * 0.2, (h - 0.9) / 2, t * 0.55);
    l.rotation.y = -1.1;
    const rr = mesh(leaf, MAT.wood, length * 0.2, (h - 0.9) / 2, t * 0.55);
    rr.rotation.y = 1.1;
    body.add(l, rr);
  } else {
    body.add(mesh(new THREE.BoxGeometry(length, h, t), mat, 0, h / 2, 0));
  }
  g.add(body);
  const merlons = new THREE.Group();
  const mgeo = new THREE.BoxGeometry(length * 0.3, 0.55, t * 1.05);
  merlons.add(mesh(mgeo, mat, -length * 0.25, h + (gate ? 0.65 : 0.27), 0));
  merlons.add(mesh(mgeo, mat, length * 0.25, h + (gate ? 0.65 : 0.27), 0));
  g.add(merlons);
  const rubble = new THREE.Group();
  for (let k = 0; k < 5; k++) {
    const r = 0.35 + (k % 3) * 0.18;
    const m = mesh(new THREE.DodecahedronGeometry(r, 0), MAT.rubble, (k - 2) * length * 0.2, r * 0.5, ((k * 7) % 3 - 1) * 0.35);
    rubble.add(m);
  }
  rubble.visible = false;
  g.add(rubble);
  g.userData = { body, merlons, rubble, mat, gate };
  return g;
}

/** Farm: fenced field of crop rows with a small hut, spanning the 3x3 fertility area. */
export function makeFarm() {
  const g = new THREE.Group();
  const half = 1.5 * S - 0.2;
  const rows = new THREE.Group();
  const rowGeo = new THREE.BoxGeometry(half * 2 - 0.6, 0.45, 0.42);
  for (let k = 0; k < 7; k++) {
    const z = -half + 0.6 + k * ((half * 2 - 1.2) / 6);
    if (Math.abs(z) < 0.5) continue;
    rows.add(mesh(rowGeo, MAT.crop, 0, 0.22, z, false));
  }
  g.add(rows);
  g.add(mesh(new THREE.BoxGeometry(half * 2, 0.06, half * 2), MAT.soil, 0, 0.03, 0, false));
  const rail = new THREE.BoxGeometry(half * 2, 0.1, 0.1);
  for (const [x, z, ry] of [[0, -half, 0], [0, half, 0], [-half, 0, Math.PI / 2], [half, 0, Math.PI / 2]]) {
    const m = mesh(rail, MAT.wood, x, 0.75, z, false);
    m.rotation.y = ry;
    g.add(m);
  }
  const postGeo = new THREE.BoxGeometry(0.14, 1, 0.14);
  for (const x of [-half, 0, half]) for (const z of [-half, half]) g.add(mesh(postGeo, MAT.wood, x, 0.5, z, false));
  for (const z of [0]) for (const x of [-half, half]) g.add(mesh(postGeo, MAT.wood, x, 0.5, z, false));
  const hut = new THREE.Group();
  hut.add(mesh(new THREE.BoxGeometry(1.8, 1.5, 1.6), MAT.wood, 0, 0.75, 0));
  const roof = mesh(new THREE.ConeGeometry(1.5, 1.1, 4), MAT.roof, 0, 2.0, 0);
  roof.rotation.y = Math.PI / 4;
  hut.add(roof);
  g.add(hut);
  g.userData = { rows, hut, height: 3 };
  return g;
}

/** Quarry: excavated pit, cut blocks and a timber crane over a stone site. */
export function makeQuarry() {
  const g = new THREE.Group();
  const pit = mesh(new THREE.CylinderGeometry(2.3, 1.8, 0.12, 10), MAT.pit, 0, 0.07, 0, false);
  g.add(pit);
  const blocks = new THREE.Group();
  const bgeo = new THREE.BoxGeometry(0.7, 0.5, 0.5);
  for (let k = 0; k < 6; k++) blocks.add(mesh(bgeo, MAT.stone, 1.6 + (k % 3) * 0.75, 0.25 + Math.floor(k / 3) * 0.5, -1.2));
  g.add(blocks);
  const crane = new THREE.Group();
  crane.add(mesh(new THREE.BoxGeometry(0.3, 4.2, 0.3), MAT.wood, -1.5, 2.1, 1.2));
  const beam = mesh(new THREE.BoxGeometry(3.2, 0.25, 0.25), MAT.wood, -0.3, 4.1, 1.2);
  crane.add(beam);
  crane.add(mesh(new THREE.BoxGeometry(0.04, 1.8, 0.04), MAT.metal, 1.0, 3.2, 1.2, false));
  crane.add(mesh(new THREE.BoxGeometry(0.6, 0.45, 0.45), MAT.stone, 1.0, 2.2, 1.2));
  g.add(crane);
  g.userData = { crane, blocks, height: 4.4 };
  return g;
}

/** Gold Mine: timber adit into a rock mound, with a cart of ore. */
export function makeMine() {
  const g = new THREE.Group();
  const mound = mesh(new THREE.DodecahedronGeometry(2.0, 0), MAT.rock, 0, 0.6, -0.9);
  mound.scale.set(1.2, 0.85, 1);
  g.add(mound);
  const frame = new THREE.Group();
  frame.add(mesh(new THREE.BoxGeometry(0.3, 2.4, 0.3), MAT.wood, -0.85, 1.2, 0.9));
  frame.add(mesh(new THREE.BoxGeometry(0.3, 2.4, 0.3), MAT.wood, 0.85, 1.2, 0.9));
  frame.add(mesh(new THREE.BoxGeometry(2.2, 0.32, 0.4), MAT.wood, 0, 2.45, 0.9));
  frame.add(mesh(new THREE.BoxGeometry(1.4, 2.0, 0.2), new THREE.MeshBasicMaterial({ color: '#0d0b0a' }), 0, 1.0, 0.82, false));
  g.add(frame);
  const cart = new THREE.Group();
  cart.add(mesh(new THREE.BoxGeometry(1.0, 0.6, 0.7), MAT.woodDark, 0, 0.55, 0));
  for (let k = 0; k < 3; k++) cart.add(mesh(new THREE.OctahedronGeometry(0.22, 0), MAT.gold, (k - 1) * 0.28, 0.95, 0, false));
  cart.position.set(1.6, 0, 1.8);
  g.add(cart);
  g.userData = { frame, cart, height: 3.2 };
  return g;
}

/** Nest: corrupted mound with spikes and a glowing core (D92). */
export function makeNest() {
  const g = new THREE.Group();
  const r = NEST.radius * S;
  const mound = mesh(new THREE.SphereGeometry(r, 9, 6, 0, Math.PI * 2, 0, Math.PI / 2), MAT.nest, 0, -0.2, 0);
  mound.scale.y = 0.85;
  g.add(mound);
  const spikes = new THREE.Group();
  const sgeo = new THREE.ConeGeometry(0.28, 2.4, 5);
  for (let k = 0; k < 9; k++) {
    const a = (k / 9) * Math.PI * 2;
    const s = mesh(sgeo, MAT.nestSpike, Math.cos(a) * r * 0.85, 0.8, Math.sin(a) * r * 0.85);
    s.rotation.z = Math.cos(a) * -0.55;
    s.rotation.x = Math.sin(a) * 0.55;
    spikes.add(s);
  }
  g.add(spikes);
  const coreMat = MAT.nestCore.clone();
  const core = mesh(new THREE.IcosahedronGeometry(0.7, 0), coreMat, 0, r * 0.75, 0, false);
  g.add(core);
  // Burrow mouths ringed around the mound base.
  const hole = new THREE.MeshBasicMaterial({ color: '#0a0608' });
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * Math.PI * 2 + 0.4;
    const m = mesh(new THREE.CircleGeometry(0.55, 8), hole, Math.cos(a) * (r + 0.3), 0.05, Math.sin(a) * (r + 0.3), false);
    m.rotation.x = -Math.PI / 2;
    g.add(m);
  }
  g.userData = { mound, spikes, core, coreMat, height: r + 1.2 };
  return g;
}

/** Placeholder creatures; silhouettes keep the three roles distinct at range. */
export function makeEnemy(type) {
  const g = new THREE.Group();
  const def = ENEMIES[type] || WILD[type] || ENEMIES.swarm;
  const r = def.radius * S;
  const mat = ENEMY_MAT[type] || ENEMY_MAT.swarm;
  const body = new THREE.Group();
  if (type === 'heavy') {
    body.add(mesh(new THREE.BoxGeometry(r * 1.7, r * 1.5, r * 1.5), mat, 0, r * 1.2, 0));
    body.add(mesh(new THREE.BoxGeometry(r * 1.0, r * 0.8, r * 0.9), mat, 0, r * 1.5, -r * 0.95));
    for (const sx of [-1, 1]) {
      const horn = mesh(new THREE.ConeGeometry(0.18, 0.9, 5), ENEMY_MAT.horn, sx * r * 0.45, r * 2.05, -r * 1.1);
      horn.rotation.x = -0.6;
      body.add(horn);
      body.add(mesh(new THREE.BoxGeometry(r * 0.45, r * 0.9, r * 0.45), mat, sx * r * 0.55, r * 0.4, 0));
    }
    for (const sx of [-1, 1]) body.add(mesh(new THREE.BoxGeometry(0.16, 0.12, 0.05), ENEMY_MAT.eye, sx * r * 0.25, r * 1.6, -r * 1.42, false));
  } else if (type === 'runner') {
    const torso = mesh(new THREE.CylinderGeometry(r * 0.45, r * 0.6, r * 2.6, 6), mat, 0, r * 2.0, 0);
    torso.rotation.x = -0.45;
    body.add(torso);
    body.add(mesh(new THREE.SphereGeometry(r * 0.55, 6, 5), mat, 0, r * 3.2, -r * 0.7));
    for (const sx of [-1, 1]) body.add(mesh(new THREE.BoxGeometry(r * 0.3, r * 1.6, r * 0.3), mat, sx * r * 0.35, r * 0.8, 0));
    for (const sx of [-1, 1]) body.add(mesh(new THREE.BoxGeometry(0.1, 0.08, 0.05), ENEMY_MAT.eye, sx * r * 0.22, r * 3.3, -r * 1.2, false));
  } else if (type === 'feral') {
    body.add(mesh(new THREE.BoxGeometry(r * 1.4, r * 1.1, r * 2.4), mat, 0, r * 1.2, 0));
    body.add(mesh(new THREE.BoxGeometry(r * 1.0, r * 0.9, r * 0.9), mat, 0, r * 1.4, -r * 1.5));
    for (let k = 0; k < 3; k++) body.add(mesh(new THREE.ConeGeometry(0.12, 0.6, 4), ENEMY_MAT.horn, 0, r * 1.9, -r * 0.6 + k * r * 0.6));
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) body.add(mesh(new THREE.BoxGeometry(r * 0.3, r * 0.8, r * 0.3), mat, sx * r * 0.5, r * 0.4, sz * r * 0.8));
    for (const sx of [-1, 1]) body.add(mesh(new THREE.BoxGeometry(0.1, 0.08, 0.05), ENEMY_MAT.eye, sx * r * 0.25, r * 1.55, -r * 1.96, false));
  } else {
    const blob = mesh(new THREE.SphereGeometry(r, 7, 5), mat, 0, r * 0.85, 0);
    blob.scale.set(1, 0.75, 1.25);
    body.add(blob);
    for (const sx of [-1, 1]) body.add(mesh(new THREE.BoxGeometry(0.1, 0.08, 0.05), ENEMY_MAT.eye, sx * r * 0.3, r * 1.0, -r * 1.2, false));
    for (const sx of [-1, 1]) body.add(mesh(new THREE.ConeGeometry(0.1, 0.5, 4), ENEMY_MAT.horn, sx * r * 0.45, r * 1.35, -r * 0.4));
  }
  g.add(body);
  g.userData = { body, mat, type, radius: r };
  return g;
}

/** Translucent material for placement ghosts. */
export function ghostMaterial(color) {
  return new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.38, depthWrite: false });
}

/** Swap every mesh in a group to one material (for ghosts). */
export function setGroupMaterial(group, material) {
  group.traverse((o) => {
    if (o.isMesh) { o.material = material; o.castShadow = false; o.receiveShadow = false; }
    if (o.isLineSegments) o.visible = false;
  });
}
