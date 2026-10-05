// D101: mirrors simulation state into Three.js objects every frame. The
// simulation owns all gameplay state; this layer keeps id -> mesh maps, never
// writes gameplay fields, and adds renderer-only effects (debris, dust, shots).

import * as THREE from 'three';
import { MAP, T, WORLD3D, WALL, TOWER, WATCH } from '../config.js';
import { heightAt } from './space.js';
import { turretYaw } from './sight.js';
import { towerConnectivity, assaultIn } from '../game.js';
import { weatherParams } from '../weather.js';
import { MAT, makeTower, makeKeep, makeWallSegment, makeFarm, makeQuarry, makeMine, makeNest, makeEnemy, makeWorker } from './models.js';

const S = WORLD3D.tileMeters;
const STONE = new THREE.Color('#b1a898');
const SCORCHED = new THREE.Color('#4a3f36');
const HIT = new THREE.Color('#ff5a2a');

function softTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  const grad = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.4, 'rgba(255,255,255,0.55)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** The nearest Forest tile within `r` tiles (for birds), or null. */
function forestNear(map, x, y, r) {
  let best = null;
  for (let k = 0; k < 24; k++) {
    const tx = Math.floor(x + (Math.random() - 0.5) * 2 * r);
    const ty = Math.floor(y + (Math.random() - 0.5) * 2 * r);
    if (tx < 0 || ty < 0 || tx >= MAP.w || ty >= MAP.h || map.kind[ty * MAP.w + tx] !== T.FOREST) continue;
    const d = Math.hypot(tx - x, ty - y);
    if (!best || d < best.d) best = { x: tx + 0.5, y: ty + 0.5, d };
  }
  return best;
}

/** Lowest ground under a circular footprint, so bases never float. */
function footprintBase(field, x, y, radius) {
  let h = heightAt(field, x, y);
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2;
    h = Math.min(h, heightAt(field, x + Math.cos(a) * radius, y + Math.sin(a) * radius));
  }
  return h;
}

export function createEntityLayer(scene, field) {
  const root = new THREE.Group();
  root.name = 'entities';
  scene.add(root);
  const towers = new Map();
  const buildings = new Map();
  const segments = new Map();
  const nests = new Map();
  const enemies = new Map();
  const drops = new Map();
  const pools = { swarm: [], runner: [], heavy: [], feral: [] };
  const tex = softTexture();

  // --- renderer-only effects ----------------------------------------------
  const MAX_SHOTS = 160;
  const shotGeo = new THREE.BufferGeometry();
  shotGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_SHOTS * 6), 3));
  shotGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(MAX_SHOTS * 6), 3));
  const shotLines = new THREE.LineSegments(shotGeo, new THREE.LineBasicMaterial({
    vertexColors: true, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  shotLines.frustumCulled = false;
  root.add(shotLines);
  const shots = [];
  // WebGL lines are one pixel wide, so each shot also carries a glowing bolt
  // and (D109) a solid streak several metres long, readable from 20-30 m.
  const boltMat = new THREE.SpriteMaterial({ map: tex, color: '#ffe7a8', blending: THREE.AdditiveBlending, depthWrite: false, transparent: true });
  const bolts = [];
  const streaks = [];
  const streakGeo = new THREE.CylinderGeometry(0.1, 0.1, 1, 5, 1, true);
  streakGeo.translate(0, 0.5, 0); // origin at the tail; +Y towards the head
  for (let k = 0; k < 64; k++) {
    const b = new THREE.Sprite(boltMat);
    b.scale.setScalar(1.3);
    b.visible = false;
    root.add(b);
    bolts.push(b);
    const st = new THREE.Mesh(streakGeo, new THREE.MeshBasicMaterial({
      color: '#ffe7a8', transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    st.visible = false;
    st.frustumCulled = false;
    root.add(st);
    streaks.push(st);
  }
  const UP = new THREE.Vector3(0, 1, 0);
  const tmpDir = new THREE.Vector3();

  const MAX_PARTICLES = 2400;
  const partGeo = new THREE.BufferGeometry();
  partGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_PARTICLES * 3), 3));
  partGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(MAX_PARTICLES * 3), 3));
  const partPoints = new THREE.Points(partGeo, new THREE.PointsMaterial({
    size: 0.55, map: tex, vertexColors: true, transparent: true, depthWrite: false, sizeAttenuation: true,
  }));
  partPoints.frustumCulled = false;
  root.add(partPoints);
  const localParticles = []; // { x, y, z, vx, vy, vz, t, life, color, gravity }

  // D111: birds scattering from woods - a far cue that something is moving.
  const BIRDS = 160;
  const birdGeo = new THREE.BufferGeometry();
  birdGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(BIRDS * 3), 3));
  const birdPoints = new THREE.Points(birdGeo, new THREE.PointsMaterial({ color: '#1d1a18', size: 0.55, transparent: true, opacity: 0.9, depthWrite: false }));
  birdPoints.frustumCulled = false;
  root.add(birdPoints);
  const birds = [];
  let flockClock = 2;
  let warnFlockDone = false;
  function spawnFlock(x, y, fromX, fromY) {
    const away = Math.atan2(y - fromY, x - fromX);
    const base = heightAt(field, x, y) + 6;
    for (let k = 0; k < 14 && birds.length < BIRDS; k++) {
      const a = away + (Math.random() - 0.5) * 1.2;
      const sp = 7 + Math.random() * 4;
      birds.push({ x: x * S + (Math.random() - 0.5) * 6, y: base + Math.random() * 3, z: y * S + (Math.random() - 0.5) * 6,
        vx: Math.cos(a) * sp, vy: 3 + Math.random() * 2.5, vz: Math.sin(a) * sp, t: 0, life: 9 + Math.random() * 3, ph: Math.random() * 6 });
    }
  }
  function updateBirds(dt) {
    const bp = birdGeo.getAttribute('position');
    let n = 0;
    for (let i = birds.length - 1; i >= 0; i--) {
      const b = birds[i];
      b.t += dt;
      if (b.t >= b.life) { birds.splice(i, 1); continue; }
      b.vy *= 1 - 0.35 * dt;
      b.x += b.vx * dt; b.y += b.vy * dt; b.z += b.vz * dt;
      bp.setXYZ(n++, b.x, b.y + Math.sin(b.t * 14 + b.ph) * 0.25, b.z);
    }
    birdGeo.setDrawRange(0, n);
    bp.needsUpdate = true;
  }

  const DUST_MAX = 1200;
  const dustGeo = new THREE.BufferGeometry();
  dustGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(DUST_MAX * 3), 3));
  const dustPoints = new THREE.Points(dustGeo, new THREE.PointsMaterial({
    size: 16, map: tex, color: '#c9b28a', transparent: true, opacity: 0.42, depthWrite: false,
  }));
  dustPoints.frustumCulled = false;
  root.add(dustPoints);
  const dust = [];

  const flashes = [];
  const flashMat = new THREE.SpriteMaterial({ map: tex, color: '#ffd27a', blending: THREE.AdditiveBlending, depthWrite: false, transparent: true });
  for (let k = 0; k < 24; k++) {
    const s = new THREE.Sprite(flashMat);
    s.visible = false;
    root.add(s);
    flashes.push({ sprite: s, t: 1, life: 1 });
  }
  let flashCursor = 0;

  const rings = [];
  for (let k = 0; k < 16; k++) {
    const m = new THREE.Mesh(new THREE.RingGeometry(0.85, 1, 40), new THREE.MeshBasicMaterial({
      color: '#ffb347', transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false,
    }));
    m.rotation.x = -Math.PI / 2;
    m.visible = false;
    root.add(m);
    rings.push({ mesh: m, t: 1, life: 1, radius: 1 });
  }
  let ringCursor = 0;

  const debris = [];
  const debrisGeo = new THREE.BoxGeometry(0.45, 0.35, 0.4);
  for (let k = 0; k < 90; k++) {
    const m = new THREE.Mesh(debrisGeo, MAT.rubble);
    m.castShadow = true;
    m.visible = false;
    root.add(m);
    debris.push({ mesh: m, vx: 0, vy: 0, vz: 0, t: 99, life: 3, spin: new THREE.Vector3() });
  }
  let debrisCursor = 0;

  let shake = 0;
  const shakeFrom = (g, x, y, amount) => {
    const d = Math.hypot(g.player.x - x, g.player.y - y);
    if (d < 30) shake = Math.min(1, shake + amount * (1 - d / 30));
  };

  function spawnFlash(pos, scale = 1.6, life = 0.08) {
    const f = flashes[flashCursor++ % flashes.length];
    f.sprite.position.copy(pos);
    f.sprite.scale.setScalar(scale);
    f.sprite.visible = true;
    f.t = 0;
    f.life = life;
    f.scale = scale;
  }

  function spawnRing(x, y, radiusTiles, color, life) {
    const r = rings[ringCursor++ % rings.length];
    r.mesh.material.color.set(color);
    r.mesh.position.set(x * S, heightAt(field, x, y) + 0.15, y * S);
    r.radius = radiusTiles * S;
    r.t = 0;
    r.life = life;
    r.mesh.visible = true;
  }

  function spawnDebris(x, y, height, count, power = 1) {
    const base = heightAt(field, x, y);
    for (let k = 0; k < count; k++) {
      const d = debris[debrisCursor++ % debris.length];
      const a = Math.random() * Math.PI * 2;
      const sp = (2 + Math.random() * 5) * power;
      d.mesh.position.set(x * S + (Math.random() - 0.5) * 1.5, base + height * (0.3 + Math.random() * 0.7), y * S + (Math.random() - 0.5) * 1.5);
      d.vx = Math.cos(a) * sp;
      d.vz = Math.sin(a) * sp;
      d.vy = 2 + Math.random() * 6 * power;
      d.spin.set(Math.random() * 8, Math.random() * 8, Math.random() * 8);
      d.mesh.scale.setScalar(0.6 + Math.random() * 1.3);
      d.mesh.visible = true;
      d.t = 0;
      d.life = 2.6 + Math.random();
    }
  }

  function puff(x, y, height, color, count, speed = 3, gravity = -2) {
    const base = heightAt(field, x, y) + height;
    const c = new THREE.Color(color);
    for (let k = 0; k < count && localParticles.length < MAX_PARTICLES / 2; k++) {
      const a = Math.random() * Math.PI * 2;
      const sp = speed * (0.3 + Math.random());
      localParticles.push({
        x: x * S, y: base, z: y * S, vx: Math.cos(a) * sp, vy: Math.random() * speed, vz: Math.sin(a) * sp,
        t: 0, life: 0.5 + Math.random() * 0.8, color: c, gravity,
      });
    }
  }

  // --- structures ------------------------------------------------------------
  function syncTowers(g, enemyById, nestById) {
    const seen = new Set();
    for (const t of g.towers) {
      seen.add(t.id);
      let obj = towers.get(t.id);
      if (!obj) {
        obj = t.keep ? makeKeep() : makeTower();
        obj.position.set(t.x * S, footprintBase(field, t.x, t.y, t.radius), t.y * S);
        root.add(obj);
        towers.set(t.id, obj);
        obj.userData.wasBuilt = t.built;
      }
      const u = obj.userData;
      const p = t.built ? 1 : Math.max(0, Math.min(1, t.progress || 0));
      u.body.scale.y = 0.06 + 0.94 * p;
      u.top.visible = t.built;
      if (u.scaffold) u.scaffold.visible = !t.built;
      if (!u.wasBuilt && t.built) { puff(t.x, t.y, u.height, '#e8dcc0', 24, 3); u.wasBuilt = true; }
      // Damage: darken towards scorched stone and flash on hits.
      const frac = Math.max(0, t.hp / t.maxHp);
      u.shaftMat.color.copy(t.keep ? MAT.keepStone.color : STONE).lerp(SCORCHED, (1 - frac) * 0.55);
      u.shaftMat.emissive.copy(HIT).multiplyScalar(Math.min(1, t.flash || 0) * 0.6);
      const collapsing = frac < TOWER.collapsingAt && t.built;
      obj.rotation.z = collapsing ? Math.sin(g.time * 13) * 0.012 : 0;
      if (t.shake > 0) obj.position.x = t.x * S + (Math.random() - 0.5) * 0.25 * t.shake;
      else obj.position.x = t.x * S;
      // Turret tracks its current target (enemy or nest).
      const target = enemyById.get(t.targetId) || nestById.get(t.nestTargetId);
      if (target && t.built) {
        const want = turretYaw(t, target);
        let diff = want - u.gun.rotation.y;
        diff = Math.atan2(Math.sin(diff), Math.cos(diff));
        u.gun.rotation.y += diff * 0.35;
      }
      // D109: recoil kicks the turret back along its barrel, then settles.
      const kick = u.gun.userData.kick || 0;
      u.gun.position.x = Math.sin(u.gun.rotation.y) * kick * 0.28;
      u.gun.position.z = Math.cos(u.gun.rotation.y) * kick * 0.28;
      u.gun.userData.kick = Math.max(0, kick - 0.12);
      // D111: a Tower whose lookouts see the army streams a red pennant.
      const alarmed = t.alarmUntil > g.time;
      if (!t.keep) {
        const conn = towerConnectivity(g, t);
        u.pennant.material = alarmed ? MAT.bannerAlarm : conn === 'outpost' ? MAT.bannerOutpost : MAT.bannerConnected;
        u.pennant.rotation.y = Math.sin(g.time * (alarmed ? 11 : 2) + t.id) * (alarmed ? 0.5 : 0.3);
        u.pennant.scale.setScalar(alarmed ? 1.5 : 1);
      } else {
        u.flag.material = alarmed ? MAT.bannerAlarm : MAT.banner;
        u.flag.rotation.y = Math.sin(g.time * (alarmed ? 9 : 1.6)) * (alarmed ? 0.4 : 0.18);
      }
      u.soldiers.forEach((s, k) => { s.visible = t.built && (t.garrison || 0) > k; });
      // Your own turret would fill the view while you stand on its platform.
      u.gun.visible = g.player.perchId !== t.id;
    }
    for (const [id, obj] of towers) {
      if (seen.has(id)) continue;
      // Destroyed: collapse into debris where it stood.
      const x = obj.position.x / S;
      const y = obj.position.z / S;
      spawnDebris(x, y, obj.userData.height, 30, 1.3);
      puff(x, y, 2, '#9a9387', 60, 6);
      spawnRing(x, y, 3.6, '#ff7a2e', 0.9);
      shakeFrom(g, x, y, 0.9);
      root.remove(obj);
      towers.delete(id);
    }
  }

  function syncWalls(g) {
    const seen = new Set();
    for (const link of g.walls) {
      const dx = link.bPos.x - link.aPos.x;
      const dy = link.bPos.y - link.aPos.y;
      const angle = Math.atan2(dy, dx);
      const len = S * (Math.abs(Math.cos(angle)) + Math.abs(Math.sin(angle))) * 1.02;
      for (const seg of link.segments) {
        if (seg.cancelled) continue;
        seen.add(seg.id);
        let obj = segments.get(seg.id);
        if (!obj) {
          obj = makeWallSegment(len, seg.gate);
          obj.position.set(seg.x * S, footprintBase(field, seg.x, seg.y, 0.6), seg.y * S);
          obj.rotation.y = -angle;
          root.add(obj);
          segments.set(seg.id, obj);
          obj.userData.wasDestroyed = !!seg.destroyed;
          obj.userData.wasPresent = !!seg.present;
        }
        const u = obj.userData;
        obj.visible = true;
        if (!seg.present) {
          // Planned but not yet raised: a faint ghost course.
          u.body.visible = true;
          u.body.scale.y = 0.12;
          u.merlons.visible = false;
          u.rubble.visible = false;
          u.mat.transparent = true;
          u.mat.opacity = 0.35;
          continue;
        }
        u.mat.transparent = false;
        u.mat.opacity = 1;
        if (!u.wasPresent) { puff(seg.x, seg.y, 0.5, '#d8cdb5', 8, 2); u.wasPresent = true; }
        if (seg.destroyed) {
          if (!u.wasDestroyed) {
            spawnDebris(seg.x, seg.y, WORLD3D.wallHeight, 12, 1.1);
            puff(seg.x, seg.y, 1.5, '#9a9387', 40, 5);
            shakeFrom(g, seg.x, seg.y, 0.6);
          }
          u.wasDestroyed = true;
          u.body.visible = false;
          u.merlons.visible = false;
          u.rubble.visible = true;
          continue;
        }
        if (u.wasDestroyed) { puff(seg.x, seg.y, 0.5, '#5ecbff', 10, 2); u.wasDestroyed = false; }
        u.rubble.visible = false;
        u.body.visible = true;
        const frac = Math.max(0, seg.hp / seg.maxHp);
        // During construction a course rises with its hp share (D81 grow-from-anchor).
        u.body.scale.y = link.built ? (frac < WALL.crackAt[1] ? 0.78 : 1) : Math.max(0.2, frac);
        u.merlons.visible = link.built && frac >= WALL.crackAt[0];
        u.merlons.position.y = 0;
        u.mat.color.copy(STONE).lerp(SCORCHED, (1 - frac) * 0.5);
        u.mat.emissive.copy(HIT).multiplyScalar(Math.min(1, seg.flash || 0) * 0.55);
        obj.position.x = seg.x * S + (seg.shake > 0 ? (Math.random() - 0.5) * 0.2 : 0);
      }
    }
    for (const [id, obj] of segments) {
      if (seen.has(id)) continue;
      root.remove(obj);
      segments.delete(id);
    }
  }

  const BUILDING_MAKERS = { farm: makeFarm, quarry: makeQuarry, mine: makeMine };
  function syncBuildings(g) {
    const seen = new Set();
    for (const b of g.buildings) {
      seen.add(b.id);
      let obj = buildings.get(b.id);
      if (!obj) {
        obj = (BUILDING_MAKERS[b.type] || makeFarm)();
        obj.position.set(b.x * S, footprintBase(field, b.x, b.y, 0.9), b.y * S);
        obj.rotation.y = ((b.id * 7) % 4) * (Math.PI / 2);
        root.add(obj);
        buildings.set(b.id, obj);
      }
      if (b.destroyed || b.hp <= 0) {
        if (!obj.userData.gone) {
          spawnDebris(b.x, b.y, 2, 10, 0.8);
          puff(b.x, b.y, 1, '#8a7a60', 30, 4);
          obj.userData.gone = true;
        }
        obj.visible = false;
        continue;
      }
      obj.visible = true;
      const p = b.built ? 1 : Math.max(0, Math.min(1, b.progress || 0));
      obj.scale.y = 0.15 + 0.85 * p;
      const u = obj.userData;
      if (b.type === 'farm' && u.rows) {
        for (const row of u.rows.children) row.material = b.built ? MAT.cropRipe : MAT.crop;
        u.rows.scale.y = b.built ? 1 + Math.sin(g.time * 1.3 + b.id) * 0.05 : 0.4;
      }
      if (b.type === 'quarry' && u.crane && b.built) u.crane.rotation.y = Math.sin(g.time * 0.5 + b.id) * 0.6;
      // D110: cosmetic workers at their posts - a figure per assigned worker.
      if (!u.crew) {
        u.crew = [];
        const tool = b.type === 'farm' ? 'hoe' : b.type === 'quarry' ? 'hammer' : 'pick';
        const spots = b.type === 'farm' ? [[1.2, 0.8]] : b.type === 'quarry' ? [[0.6, -0.4], [1.9, -0.6]] : [[-0.6, 1.5], [0.8, 1.6]];
        for (const [sx, sz] of spots) {
          const w = makeWorker(tool);
          w.position.set(sx, 0, sz);
          w.rotation.y = Math.atan2(-sx, -sz) + Math.PI;
          w.visible = false;
          obj.add(w);
          u.crew.push(w);
        }
      }
      u.crew.forEach((w, k) => {
        w.visible = b.built && (b.workers || 0) > k;
        if (!w.visible) return;
        const ph = g.time * (b.type === 'farm' ? 2.2 : 3.4) + k * 1.7 + b.id;
        w.userData.arm.rotation.x = Math.sin(ph) * (b.type === 'farm' ? 0.45 : 0.8) - 0.2;
        w.userData.body.rotation.x = b.type === 'farm' ? 0.25 + Math.sin(ph) * 0.12 : Math.max(0, Math.sin(ph)) * 0.15;
      });
      if (b.flash > 0) obj.position.y = footprintBase(field, b.x, b.y, 0.9) + Math.sin(g.time * 60) * 0.05;
    }
    for (const [id, obj] of buildings) {
      if (seen.has(id)) continue;
      root.remove(obj);
      buildings.delete(id);
    }
  }

  function syncNests(g) {
    for (const n of g.nests) {
      let obj = nests.get(n.id);
      if (!obj) {
        obj = makeNest();
        obj.position.set(n.x * S, footprintBase(field, n.x, n.y, n.radius * 0.6), n.y * S);
        root.add(obj);
        nests.set(n.id, obj);
      }
      const u = obj.userData;
      if (n.destroyed) {
        if (!u.gone) {
          puff(n.x, n.y, 1, '#9fbf4a', 80, 7);
          spawnDebris(n.x, n.y, 2, 16, 1);
          shakeFrom(g, n.x, n.y, 0.5);
          u.gone = true;
        }
        u.mound.scale.y = 0.18;
        u.spikes.visible = false;
        u.core.visible = false;
        continue;
      }
      const agitated = n.state === 'agitated';
      const pulse = 0.5 + 0.5 * Math.sin(g.time * (agitated ? 7 : 1.4) + (n.x || 0));
      u.coreMat.color.set(n.underSiege ? '#ff6a3a' : agitated ? '#d7f36b' : '#6f8a30');
      u.core.scale.setScalar(agitated ? 0.9 + pulse * 0.5 : 0.75 + pulse * 0.15);
      u.core.rotation.y += 0.02;
      u.spikes.rotation.y = Math.sin(g.time * 0.4) * 0.05;
      const frac = Math.max(0.25, n.hp / n.maxHp);
      u.mound.scale.set(1, 0.85 * (0.6 + 0.4 * frac), 1);
      obj.position.x = n.x * S + (n.flash > 0.4 ? (Math.random() - 0.5) * 0.2 : 0);
    }
  }

  // --- enemies ----------------------------------------------------------------
  function acquireEnemyMesh(type) {
    const pool = pools[type] || (pools[type] = []);
    const obj = pool.pop() || makeEnemy(type);
    obj.visible = true;
    root.add(obj);
    return obj;
  }

  function syncEnemies(g, dt) {
    const seen = new Set();
    for (const e of g.enemies) {
      seen.add(e.id);
      let rec = enemies.get(e.id);
      if (!rec) {
        rec = { obj: acquireEnemyMesh(e.type), px: e.x, py: e.y, yaw: 0, phase: Math.random() * 6 };
        enemies.set(e.id, rec);
      }
      const { obj } = rec;
      const u = obj.userData;
      const mx = e.x - rec.px;
      const my = e.y - rec.py;
      const moved = Math.hypot(mx, my);
      if (moved > 1e-4) {
        const want = Math.atan2(-mx, -my);
        let diff = want - rec.yaw;
        diff = Math.atan2(Math.sin(diff), Math.cos(diff));
        rec.yaw += diff * Math.min(1, dt * 10);
      }
      const speed = dt > 0 ? moved / dt : 0;
      rec.phase += dt * (4 + speed * 3);
      rec.px = e.x;
      rec.py = e.y;
      const ground = heightAt(field, e.x, e.y);
      const bob = e.type === 'heavy' ? Math.abs(Math.sin(rec.phase * 0.6)) * 0.12 : Math.abs(Math.sin(rec.phase)) * 0.18 * Math.min(1, speed);
      obj.position.set(e.x * S, ground + bob, e.y * S);
      obj.rotation.y = rec.yaw;
      // Lunge while hitting something; flash white on damage.
      const attacking = e.hitCd > 0 && speed < 0.3;
      u.body.position.z = attacking ? -Math.max(0, Math.sin(g.time * (e.type === 'heavy' ? 6 : 12))) * 0.35 : 0;
      const flashing = (e.flash || 0) > 0.35;
      if (flashing !== !!u.flashing) {
        u.flashing = flashing;
        u.body.traverse((o) => {
          if (!o.isMesh) return;
          if (flashing) { o.userData.baseMat = o.userData.baseMat || o.material; o.material = MAT.flash; }
          else if (o.userData.baseMat) o.material = o.userData.baseMat;
        });
      }
      const fade = e.fadeAt != null ? Math.max(0.05, 1 - Math.max(0, g.time - e.fadeAt + 1)) : 1;
      obj.scale.setScalar(fade);
    }
    for (const [id, rec] of enemies) {
      if (seen.has(id)) continue;
      const type = rec.obj.userData.type;
      const color = type === 'heavy' ? '#e8833a' : type === 'runner' ? '#78e08f' : type === 'feral' ? '#b5d16b' : '#c98bd8';
      puff(rec.px, rec.py, 0.8, color, type === 'heavy' ? 30 : 12, type === 'heavy' ? 4 : 3);
      if (type === 'heavy') shakeFrom(g, rec.px, rec.py, 0.25);
      rec.obj.visible = false;
      root.remove(rec.obj);
      if (rec.obj.userData.flashing) {
        rec.obj.userData.flashing = false;
        rec.obj.userData.body.traverse((o) => { if (o.isMesh && o.userData.baseMat) o.material = o.userData.baseMat; });
      }
      rec.obj.scale.setScalar(1);
      (pools[type] || (pools[type] = [])).push(rec.obj);
      enemies.delete(id);
    }
  }

  const dropGeo = new THREE.OctahedronGeometry(0.45, 0);
  function syncDrops(g) {
    const seen = new Set();
    for (const d of g.drops || []) {
      const key = d.id ?? d;
      seen.add(key);
      let obj = drops.get(key);
      if (!obj) {
        obj = new THREE.Mesh(dropGeo, new THREE.MeshBasicMaterial({ color: d.color || '#ffd166' }));
        root.add(obj);
        drops.set(key, obj);
      }
      obj.position.set(d.x * S, heightAt(field, d.x, d.y) + 0.9 + Math.sin(g.time * 3) * 0.2, d.y * S);
      obj.rotation.y += 0.04;
    }
    for (const [key, obj] of drops) {
      if (seen.has(key)) continue;
      root.remove(obj);
      obj.material.dispose();
      drops.delete(key);
    }
  }

  // --- sim effects -> 3D effects ----------------------------------------------
  function muzzleOf(g, x, y) {
    const t = g.towers.find((o) => Math.abs(o.x - x) < 1e-6 && Math.abs(o.y - y) < 1e-6);
    const obj = t && towers.get(t.id);
    if (obj) {
      const gun = obj.userData.gun;
      gun.updateWorldMatrix(true, false);
      const m = gun.userData.muzzle.clone();
      gun.localToWorld(m);
      gun.userData.kick = 1; // D109: recoil
      return m;
    }
    return new THREE.Vector3(x * S, heightAt(field, x, y) + WORLD3D.towerHeight + 1, y * S);
  }

  function syncSimFx(g) {
    for (const tr of g.tracers) {
      if (tr._seen) continue;
      tr._seen = true;
      const player = tr.kind === 'bolt';
      const from = tr.from3d ? new THREE.Vector3(tr.from3d.x, tr.from3d.y, tr.from3d.z) : muzzleOf(g, tr.x0, tr.y0);
      const to = new THREE.Vector3(tr.x1 * S, heightAt(field, tr.x1, tr.y1) + (tr.z1 ?? 0.9), tr.y1 * S);
      const color = new THREE.Color(tr.color || '#cfd6e0').lerp(new THREE.Color('#ffd27a'), player ? 0.1 : 0.4);
      if (shots.length < MAX_SHOTS) {
        shots.push({ from, to, t: 0, life: Math.max(0.08, from.distanceTo(to) / (player ? 90 : 60)), color, player, impact: tr.hit !== false });
      }
      if (!player) {
        // D109: a muzzle flash big enough to read at 30 m, and a breath of smoke.
        spawnFlash(from, 3.2, 0.12);
        localParticles.push({ x: from.x, y: from.y, z: from.z, vx: (Math.random() - 0.5) * 0.6, vy: 0.9, vz: (Math.random() - 0.5) * 0.6,
          t: 0, life: 0.7, color: new THREE.Color('#bdb6a8'), gravity: 0.4 });
      }
    }
    for (const p of g.particles) {
      if (p._seen) continue;
      p._seen = true;
      p._vz = 1 + Math.random() * 4;
      p._h = heightAt(field, p.x, p.y) + 0.6;
      p._c = new THREE.Color(p.color || '#ffffff');
    }
    for (const w of g.shockwaves) {
      if (w._seen) continue;
      w._seen = true;
      spawnRing(w.x, w.y, w.radius || 2, w.color || '#ffb347', w.life || 0.5);
      if ((w.radius || 0) >= 3) shakeFrom(g, w.x, w.y, 0.35);
    }
  }

  function updateFx(g, dt) {
    // Shots: a bright streak travelling muzzle -> target.
    const sp = shotGeo.getAttribute('position');
    const sc = shotGeo.getAttribute('color');
    let n = 0;
    for (let i = shots.length - 1; i >= 0; i--) {
      const s = shots[i];
      s.t += dt;
      if (s.t >= s.life) {
        // Impact: a bright spark and a short flash where the shot lands.
        if (s.impact) {
          puff(s.to.x / S, s.to.z / S, s.to.y - heightAt(field, s.to.x / S, s.to.z / S), '#fff0b8', s.player ? 6 : 9, 4);
          spawnFlash(s.to, s.player ? 1.2 : 1.9, 0.1);
        }
        shots.splice(i, 1);
        continue;
      }
      const a = Math.min(1, s.t / s.life);
      const len = s.from.distanceTo(s.to) || 1;
      const b = Math.max(0, a - (s.player ? 1.6 : 4.5) / len);
      const ax = s.from.x + (s.to.x - s.from.x) * a;
      const ay = s.from.y + (s.to.y - s.from.y) * a;
      const az = s.from.z + (s.to.z - s.from.z) * a;
      const bx = s.from.x + (s.to.x - s.from.x) * b;
      const by = s.from.y + (s.to.y - s.from.y) * b;
      const bz = s.from.z + (s.to.z - s.from.z) * b;
      sp.setXYZ(n * 2, bx, by, bz);
      sp.setXYZ(n * 2 + 1, ax, ay, az);
      sc.setXYZ(n * 2, s.color.r * 0.3, s.color.g * 0.3, s.color.b * 0.3);
      sc.setXYZ(n * 2 + 1, s.color.r, s.color.g, s.color.b);
      if (n < bolts.length) {
        bolts[n].visible = true;
        bolts[n].position.set(ax, ay, az);
        bolts[n].scale.setScalar(s.player ? 0.5 : 1.3);
        const st = streaks[n];
        tmpDir.set(ax - bx, ay - by, az - bz);
        const sl = tmpDir.length();
        st.visible = sl > 0.01;
        if (st.visible) {
          st.position.set(bx, by, bz);
          st.quaternion.setFromUnitVectors(UP, tmpDir.divideScalar(sl));
          st.scale.set(s.player ? 0.6 : 1, sl, s.player ? 0.6 : 1);
          st.material.color.copy(s.color);
        }
      }
      n++;
    }
    for (let k = n; k < bolts.length; k++) { bolts[k].visible = false; streaks[k].visible = false; }
    shotGeo.setDrawRange(0, n * 2);
    sp.needsUpdate = true;
    sc.needsUpdate = true;

    for (const f of flashes) {
      if (!f.sprite.visible) continue;
      f.t += dt;
      if (f.t >= f.life) f.sprite.visible = false;
      else f.sprite.scale.setScalar((f.scale || 1.6) * (1 - 0.5 * f.t / f.life));
    }
    for (const r of rings) {
      if (!r.mesh.visible) continue;
      r.t += dt;
      const k = r.t / r.life;
      if (k >= 1) { r.mesh.visible = false; continue; }
      const s = r.radius * (0.25 + 0.75 * k);
      r.mesh.scale.set(s, s, s);
      r.mesh.material.opacity = 0.7 * (1 - k);
    }
    for (const d of debris) {
      if (!d.mesh.visible) continue;
      d.t += dt;
      if (d.t >= d.life) { d.mesh.visible = false; continue; }
      const m = d.mesh;
      d.vy -= 18 * dt;
      m.position.x += d.vx * dt;
      m.position.y += d.vy * dt;
      m.position.z += d.vz * dt;
      const floor = heightAt(field, m.position.x / S, m.position.z / S) + 0.15;
      if (m.position.y < floor) {
        m.position.y = floor;
        d.vy = Math.abs(d.vy) * 0.25;
        d.vx *= 0.5;
        d.vz *= 0.5;
        d.spin.multiplyScalar(0.5);
      }
      m.rotation.x += d.spin.x * dt;
      m.rotation.y += d.spin.y * dt;
      m.rotation.z += d.spin.z * dt;
      if (d.t > d.life - 0.6) m.scale.multiplyScalar(1 - dt * 3);
    }

    // Particles: simulation sparks (lifted into 3D) plus local puffs.
    const pp = partGeo.getAttribute('position');
    const pc = partGeo.getAttribute('color');
    let m = 0;
    for (const p of g.particles) {
      if (m >= MAX_PARTICLES) break;
      if (!p._c) continue;
      const life = 1 - p.t / p.life;
      const y = p._h + p._vz * p.t - 4.9 * p.t * p.t * 0.6;
      pp.setXYZ(m, p.x * S, Math.max(p._h - 0.5, y), p.y * S);
      pc.setXYZ(m, p._c.r * life, p._c.g * life, p._c.b * life);
      m++;
    }
    for (let i = localParticles.length - 1; i >= 0; i--) {
      const p = localParticles[i];
      p.t += dt;
      if (p.t >= p.life) { localParticles.splice(i, 1); continue; }
      p.vy += p.gravity * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      p.vx *= 1 - 1.5 * dt;
      p.vz *= 1 - 1.5 * dt;
      if (m >= MAX_PARTICLES) continue;
      const life = 1 - p.t / p.life;
      pp.setXYZ(m, p.x, p.y, p.z);
      pc.setXYZ(m, p.color.r * life, p.color.g * life, p.color.b * life);
      m++;
    }
    partGeo.setDrawRange(0, m);
    pp.needsUpdate = true;
    pc.needsUpdate = true;

    // D111: the assault is read from the world, not the HUD. Dust rises at the
    // road mouths it will use, thickening as it nears, then hangs over the
    // marching columns. Rain wets the ground and keeps the dust down.
    const wx = weatherParams(g);
    const damp = 1 - 0.7 * Math.min(1, wx.rain);
    const lead = g.phase === 'prep' ? WATCH.mouthDustLead - assaultIn(g) : 0;
    const mouthRate = g.phase === 'warning' ? 14 : g.phase === 'combat' && g.pendingSpawns?.length ? 8
      : lead > 0 ? 3 + 9 * (lead / WATCH.mouthDustLead) : 0;
    if (mouthRate > 0) {
      const mouths = (g.spawnSides || []).flatMap((side) => g.map.spawns?.[side] || []);
      for (const mouth of mouths) {
        if (dust.length >= DUST_MAX || Math.random() > dt * mouthRate * damp) continue;
        const x = mouth.x + 0.5 + (Math.random() - 0.5) * 6;
        const y = mouth.y + 0.5 + (Math.random() - 0.5) * 6;
        dust.push({ x: x * S, y: heightAt(field, x, y) + 2, z: y * S, vy: 3 + Math.random() * 3, t: 0, life: 6 + Math.random() * 4 });
      }
    }
    if (g.phase === 'combat') {
      for (const e of g.enemies) {
        if (e.wild || dust.length >= DUST_MAX) continue;
        if (Math.random() > dt * (e.type === 'heavy' ? 1.6 : 0.55) * damp) continue;
        dust.push({ x: e.x * S + (Math.random() - 0.5) * 3, y: heightAt(field, e.x, e.y) + 1.2, z: e.y * S + (Math.random() - 0.5) * 3,
          vy: 2 + Math.random() * 2, t: 0, life: 5 + Math.random() * 3 });
      }
      // Birds put up from woods the army passes.
      flockClock -= dt;
      if (flockClock <= 0) {
        flockClock = 3 + Math.random() * 4;
        const army = g.enemies.filter((e) => !e.wild);
        const e = army[Math.floor(Math.random() * army.length)];
        const wood = e && forestNear(g.map, e.x, e.y, 5);
        if (wood) spawnFlock(wood.x, wood.y, e.x, e.y);
      }
    } else if (g.phase === 'warning' && !warnFlockDone) {
      warnFlockDone = true;
      const mouths = (g.spawnSides || []).flatMap((side) => g.map.spawns?.[side] || []);
      const m = mouths[Math.floor(Math.random() * mouths.length)];
      const wood = m && forestNear(g.map, m.x, m.y, 14);
      if (wood) spawnFlock(wood.x, wood.y, m.x, m.y);
    }
    if (g.phase !== 'warning') warnFlockDone = false;
    updateBirds(dt);
    const dp = dustGeo.getAttribute('position');
    let q = 0;
    for (let i = dust.length - 1; i >= 0; i--) {
      const d = dust[i];
      d.t += dt;
      if (d.t >= d.life) { dust.splice(i, 1); continue; }
      d.y += d.vy * dt;
      d.x += 1.2 * dt;
      dp.setXYZ(q++, d.x, d.y, d.z);
    }
    dustGeo.setDrawRange(0, q);
    dp.needsUpdate = true;

    shake = Math.max(0, shake - dt * 2.2);
  }

  return {
    root,
    sync(g, dt) {
      const enemyById = new Map(g.enemies.map((e) => [e.id, e]));
      const nestById = new Map(g.nests.map((n) => [n.id, n]));
      syncTowers(g, enemyById, nestById);
      syncWalls(g);
      syncBuildings(g);
      syncNests(g);
      syncEnemies(g, dt);
      syncDrops(g);
      syncSimFx(g);
      updateFx(g, dt);
    },
    towerObject: (id) => towers.get(id),
    get shake() { return shake; },
    addShake(v) { shake = Math.min(1, shake + v); },
    dispose() {
      scene.remove(root);
    },
    stats: () => ({ towers: towers.size, segments: segments.size, buildings: buildings.size, nests: nests.size, enemies: enemies.size, shots: shots.length }),
  };
}

