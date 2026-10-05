// D101: first-person bootstrap, input, look-target picking and the frame loop.
// The simulation (src/game.js) is unchanged in kind: it still runs on the
// tile grid. This file turns mouse/keys into the same `g.input` the 2D shell
// used, and renders the result in Three.js.

import * as THREE from 'three';
import { BUILD, ENEMIES, WORLD3D, PLAYER, TOWER } from '../config.js';
import { randomSeed, isPassable } from '../terrain.js';
import {
  createGame, update, canPlaceAt, tryBuild, tryUpgrade, forceNextWave, startWaveEarly, spawnGroupAt,
  setPaused, drainAudioEvents, wallPlan, tryBuildWall, assignGarrison, assignWorkers, populationState, perchOnTower, leavePerch,
  towerStats, towerMinRange, wallState, nestState, garrisonState, resourceState, keepState, towerConnectivity,
  repairTarget, isPointVisible, recomputeVisibility, fireCrossbow, switchWeapon, assaultIn, buildingState,
} from '../game.js';
import { cycleWeather, setWeather, weatherState } from '../weather.js';
import { createAudioSystem } from '../audio.js';
import { renderPicks, showEnd, updateMapInfo } from '../ui.js';
import {
  buildHeightField, heightAt, raycastTerrain, pickTarget, snapToTile, wallAnchorFromPick,
  facingFromYaw, moveIntent, headingDegrees, tileToWorld,
} from './space.js';
import { buildTerrainScene, refreshVegetation, disposeTree } from './terrain3d.js';
import { createEntityLayer } from './entities3d.js';
import { createOverlays } from './overlays.js';
import { createTowerSight } from './sight.js';
import { createViewModel } from './weapon.js';
import { createWeatherLayer } from './weather.js';
import { updateHud, setVignette } from './hud.js';

const $ = (id) => document.getElementById(id);
const S = WORLD3D.tileMeters;

// --- renderer / scene ----------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(1.5, window.devicePixelRatio || 1));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
$('view').appendChild(renderer.domElement);

const SKY = new THREE.Color('#a8c4dc');
const scene = new THREE.Scene();
scene.background = SKY;
scene.fog = new THREE.Fog(SKY, WORLD3D.fogNear, WORLD3D.drawDistance);
const hemi = new THREE.HemisphereLight('#e6f0ff', '#5a5040', 1.7);
scene.add(hemi);
const sun = new THREE.DirectionalLight('#fff1d6', 1.9);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
const SHADOW_BOX = 70;
Object.assign(sun.shadow.camera, { left: -SHADOW_BOX, right: SHADOW_BOX, top: SHADOW_BOX, bottom: -SHADOW_BOX, near: 1, far: 300 });
sun.shadow.bias = -0.0006;
sun.shadow.normalBias = 0.6;
scene.add(sun);
scene.add(sun.target);

const camera = new THREE.PerspectiveCamera(WORLD3D.fov, 1, 0.1, WORLD3D.drawDistance + 60);
camera.rotation.order = 'YXZ';

const viewModel = createViewModel();
const weather = createWeatherLayer(scene, { hemi, sun });

function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  viewModel.resize(w / h);
}
window.addEventListener('resize', resize);
resize();

// --- run state ---------------------------------------------------------------------
const audio = createAudioSystem();
let game = null;
let field = null;
let world = null;      // { terrain, entities, overlays, terrainVersion }
let endShown = false;
let yaw = 0;
let pitch = -0.05;
let camY = null;
let autoPause = true;
let locked = false;
const keys = new Set();
let meleeQueued = false;
let lastHp = PLAYER.maxHp;
let hurt = 0;
const fly = { on: false, pos: new THREE.Vector3() };
const debugFlags = { info: false, ranges: false, nests: false, blockers: false, paths: false, los: false, intel: false };
const ui = { buildMode: false, buildType: 'tower', site: null, wall: { a: null, hover: null, plan: null, near: false, notice: null, noticeAt: 0 }, repairable: false };
let look = { target: null, hit: null };
let nestAmbientAt = 0;

let chosen = 'gunner';
$('seed-input').value = randomSeed();
function pick(key) { chosen = key; renderPicks(chosen, pick); }
renderPicks(chosen, pick);
$('reroll').onclick = () => { $('seed-input').value = randomSeed(); };
$('start-btn').onclick = () => { audio.gesture(); startRun($('seed-input').value.trim() || randomSeed(), chosen); requestLock(); };
$('again-btn').onclick = () => { $('end-overlay').hidden = true; $('select-overlay').hidden = false; $('seed-input').value = randomSeed(); };

function disposeWorld() {
  if (!world) return;
  scene.remove(world.terrain.group);
  disposeTree(world.terrain.group);
  world.entities.dispose();
  for (const child of [...scene.children]) {
    if (child.name === 'overlays' || child.name === 'entities') { scene.remove(child); disposeTree(child); }
  }
  world = null;
}

function startRun(seed, archetype) {
  disposeWorld();
  game = createGame(seed, archetype);
  // D101: crosshair placement within reach, and solid Towers for the player.
  // D111: no assault announcements - the world carries that information.
  game.rules = { ...game.rules, buildReach: BUILD.lookReach, solidTowers: true, exploreRadius: WORLD3D.exploreRadius, announceAssaults: false };
  recomputeVisibility(game, true);
  field = buildHeightField(game.map);
  // D109: Towers fire on what they can physically see in this 3D scene.
  game.rules.towerSight = createTowerSight(field);
  const terrain = buildTerrainScene(game.map, field);
  scene.add(terrain.group);
  world = {
    terrain,
    entities: createEntityLayer(scene, field),
    overlays: createOverlays(scene, field),
    terrainVersion: game.map.terrainVersion || 0,
  };
  // Start a short walk south of the Keep, facing it: home is the first thing seen.
  const keep = game.towers.find((t) => t.keep);
  for (const back of [7, 6, 5, 4]) {
    const y = keep.y + back;
    if (isPassable(game.map, Math.floor(keep.x), Math.floor(y))) {
      game.player.x = keep.x;
      game.player.y = y;
      break;
    }
  }
  yaw = 0;
  pitch = 0.1;
  camY = null;
  fly.on = false;
  endShown = false;
  lastHp = game.player.hp;
  setBuild(false);
  weather.reset();
  $('select-overlay').hidden = true;
  $('end-overlay').hidden = true;
  $('pause-overlay').hidden = true;
  $('seed-label').textContent = `Seed ${game.seed} · ${game.arch.name}`;
  updateMapInfo(game);
  syncAudioControls();
}

function syncAudioControls() {
  $('sfx-volume').value = audio.state.volume;
  $('sfx-mute').textContent = audio.state.muted ? 'Unmute' : 'Mute';
}
$('sfx-volume').oninput = (e) => audio.setVolume(e.target.value);
$('sfx-mute').onclick = () => { audio.setMuted(!audio.state.muted); syncAudioControls(); };

// --- pointer lock + pause ------------------------------------------------------------
function requestLock() {
  try {
    const p = renderer.domElement.requestPointerLock?.();
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch { /* unsupported: automation drives the camera through window.holdfast */ }
}
function showPause(show) {
  if (!game || game.status !== 'playing') { $('pause-overlay').hidden = true; return; }
  $('pause-overlay').hidden = !show;
  setPaused(game, show);
  keys.clear();
  if (show) audio.suspendForPause(); else audio.resumeAfterPause();
}
document.addEventListener('pointerlockchange', () => {
  locked = document.pointerLockElement === renderer.domElement;
  if (!game || game.status !== 'playing') return;
  if (locked) showPause(false);
  else if (autoPause) showPause(true);
});
renderer.domElement.addEventListener('click', () => { if (game && !locked && game.status === 'playing') { audio.gesture(); requestLock(); } });
$('resume-btn').onclick = () => { audio.gesture(); requestLock(); if (!autoPause) showPause(false); };
$('quit-btn').onclick = () => { if (game) { game.status = 'lost'; game.lossCause = 'died'; } $('pause-overlay').hidden = true; };

document.addEventListener('mousemove', (e) => {
  if (!locked || !game) return;
  yaw -= e.movementX * WORLD3D.mouseSensitivity;
  pitch -= e.movementY * WORLD3D.mouseSensitivity;
  pitch = Math.max(-1.45, Math.min(1.45, pitch));
});
document.addEventListener('mousedown', (e) => {
  if (!locked || !game || game.paused) return;
  if (e.button === 0) primaryAction();
  if (e.button === 2) cancelStep();
});
// D113: the wheel swaps weapons outside build mode.
let wheelAt = 0;
document.addEventListener('wheel', (e) => {
  if (!locked || !game || game.paused || ui.buildMode || Math.abs(e.deltaY) < 1) return;
  const now = performance.now();
  if (now - wheelAt < 220) return;
  wheelAt = now;
  switchWeapon(game);
}, { passive: true });
document.addEventListener('contextmenu', (e) => e.preventDefault());

// --- build / interact -----------------------------------------------------------------
function setBuild(on, type = ui.buildType) {
  ui.buildMode = on;
  ui.buildType = type;
  ui.site = null;
  ui.wall = { a: null, hover: null, plan: null, near: false, notice: null, noticeAt: 0 };
  if (game) { game.buildMode = on; game.buildType = type; }
}
function toggleBuild(type) {
  if (ui.buildMode && ui.buildType === type) setBuild(false);
  else setBuild(true, type);
}
function cancelStep() {
  if (!ui.buildMode) return;
  if (ui.buildType === 'wall' && ui.wall.a != null) { ui.wall.a = null; ui.wall.plan = null; return; }
  setBuild(false);
}
function wallNotice(text) { ui.wall.notice = text; ui.wall.noticeAt = game.time; game.wallNotice = { text, until: game.time + 2.5 }; }

function nearTower(t) {
  return !!t && Math.hypot(game.player.x - t.x, game.player.y - t.y) <= PLAYER.presenceRadius + t.radius;
}

function primaryAction() {
  const g = game;
  // D113: outside build mode the left button uses the weapon in hand.
  if (!ui.buildMode) {
    if (g.player.weapon === 'crossbow') fireBolt();
    else meleeQueued = true;
    return;
  }
  if (ui.buildType === 'wall') {
    const pickRes = wallAnchorFromPick(look.target);
    if (!pickRes.ok) { if (pickRes.reason) wallNotice(pickRes.reason); return; }
    const t = pickRes.tower;
    if (ui.wall.a == null || ui.wall.a === t.id) {
      ui.wall.a = t.id;
      ui.wall.notice = null;
      return;
    }
    const res = tryBuildWall(g, ui.wall.a, t.id);
    if (res.ok) setBuild(false);
    else wallNotice([...new Set(res.reasons)].join(' · '));
    return;
  }
  const site = ui.site;
  if (!site) return;
  const res = tryBuild(g, site.x, site.y, ui.buildType);
  if (res.ok) setBuild(false);
}

/** D113: aim a bolt down the crosshair against the 3D scene, then let the sim resolve it. */
function fireBolt() {
  const g = game;
  if (g.player.boltCd > 0) return;
  const origin = camera.position.clone();
  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir);
  const maxDist = PLAYER.crossbow.range * S;
  const ground = raycastTerrain(field, origin, dir, maxDist);
  const targets = lookTargets(g).filter((t) => !(t.kind === 'tower' && t.ref.id === g.player.perchId) && t.kind !== 'site');
  const hit = pickTarget(field, origin, dir, targets, maxDist, ground ? ground.distance : Infinity);
  const along = hit ? hit.distance : ground ? ground.distance : maxDist;
  const point = origin.clone().addScaledVector(dir, along);
  const x = point.x / S;
  const y = point.z / S;
  const from = origin.clone().addScaledVector(dir, 0.6).add(new THREE.Vector3(0, -0.15, 0));
  fireCrossbow(g, {
    enemyId: hit?.kind === 'enemy' ? hit.ref.id : null,
    nestId: hit?.kind === 'nest' ? hit.ref.id : null,
    ground: !!(hit || ground),
    x, y, z: point.y - heightAt(field, x, y),
    from3d: { x: from.x, y: from.y, z: from.z },
  });
}

function interact() {
  const g = game;
  if (g.player.perchId != null) { leavePerch(g, facingFromYaw(yaw)); camY = null; return; }
  const t = look.target;
  if (t?.kind === 'tower' && t.ref.built) {
    const res = perchOnTower(g, t.ref);
    if (!res.ok) g.log.unshift({ text: 'Walk up to the Tower to climb it.', t: g.time });
  }
}

function lookedTower(range = WORLD3D.interactRange) {
  const t = look.target;
  if (t?.kind === 'tower' && Math.hypot(t.ref.x - game.player.x, t.ref.y - game.player.y) <= range) return t.ref;
  return game.towers.find((o) => o.id === game.player.perchId) || null;
}

function lookedBuilding(range = WORLD3D.interactRange) {
  const t = look.target;
  if (t?.kind === 'building' && !t.ref.destroyed && Math.hypot(t.ref.x - game.player.x, t.ref.y - game.player.y) <= range) return t.ref;
  return null;
}

// --- keys ---------------------------------------------------------------------------------
const MOVE = { KeyW: 1, KeyS: 1, KeyA: 1, KeyD: 1, ArrowUp: 1, ArrowDown: 1, ArrowLeft: 1, ArrowRight: 1 };
window.addEventListener('keydown', (e) => {
  audio.gesture();
  if (e.target && (e.target.tagName === 'INPUT')) { if (e.code === 'Enter') $('start-btn').click(); return; }
  if (MOVE[e.code] || e.code === 'Space' || e.code.startsWith('F') && /^F\d+$/.test(e.code) || e.code === 'Tab') e.preventDefault();
  keys.add(e.code);
  if (!game || game.status !== 'playing') return;
  if (e.code === 'KeyP' && !e.repeat) {
    if (game.paused) { requestLock(); showPause(false); } else { document.exitPointerLock?.(); showPause(true); }
    return;
  }
  if (game.paused) return;
  if (e.repeat && e.code !== 'KeyG') return;
  switch (e.code) {
    case 'Digit1': toggleBuild('tower'); break;
    case 'Digit2': toggleBuild('wall'); break;
    case 'Digit3': toggleBuild('farm'); break;
    case 'Digit4': toggleBuild('quarry'); break;
    case 'Digit5': toggleBuild('mine'); break;
    case 'KeyQ': cancelStep(); break;
    case 'KeyF': switchWeapon(game); break;
    case 'KeyE': interact(); break;
    case 'KeyG': {
      // D110: G puts a free person to work or on the walls; Shift+G sends one back.
      const b = lookedBuilding();
      if (b) {
        const res = assignWorkers(game, b, e.shiftKey ? -1 : 1);
        if (!res.ok && !e.repeat) game.log.unshift({ text: `Cannot ${e.shiftKey ? 'withdraw' : 'assign'}: ${res.reason}.`, t: game.time });
        break;
      }
      const t = lookedTower();
      if (t) {
        const res = assignGarrison(game, t, e.shiftKey ? -1 : 1);
        if (!res.ok && !e.shiftKey && !e.repeat) game.log.unshift({ text: `Cannot garrison: ${res.reason}.`, t: game.time });
      }
      break;
    }
    case 'KeyU': {
      const t = lookedTower(PLAYER.presenceRadius + 1.5);
      if (t && !tryUpgrade(game, t, 'weapon')) game.log.unshift({ text: 'Upgrade needs Stone + Gold, a finished Tower, and you beside it.', t: game.time });
      break;
    }
    case 'KeyT': startWaveEarly(game); break;
    // debug
    case 'KeyM': game.res.stone += 500; game.res.gold += 500; break;
    case 'KeyN': forceNextWave(game); break;
    case 'KeyY': debugSpawn(); break;
    case 'KeyK': { const t = lookedTower(WORLD3D.pickRange); if (t) { t.hp = Math.max(1, t.hp - t.maxHp * 0.25); t.flash = 1; } break; }
    case 'KeyJ': { const t = lookedTower(WORLD3D.pickRange); if (t) t.hp = -1; break; }
    case 'KeyH': debugFlags.paths = !debugFlags.paths; break;
    case 'KeyL': game.debug.spawnPaused = !game.debug.spawnPaused; break;
    case 'KeyO': startRun(randomSeed(), game.archetypeKey); break;
    case 'F2': toggleFly(); break;
    case 'F3': debugFlags.info = !debugFlags.info; break;
    case 'F4': teleportKeep(); break;
    case 'F6': debugFlags.los = !debugFlags.los; break;
    case 'F7': cycleWeather(game, e.shiftKey); break;
    case 'F8': debugFlags.intel = !debugFlags.intel; break;
    default: break;
  }
});
window.addEventListener('keyup', (e) => keys.delete(e.code));
window.addEventListener('blur', () => keys.clear());

function debugSpawn() {
  const at = look.hit || { x: game.player.x + facingFromYaw(yaw).x * 10, y: game.player.y + facingFromYaw(yaw).y * 10 };
  const types = Object.keys(ENEMIES);
  const type = types[Math.floor(Math.random() * types.length)];
  spawnGroupAt(game, at.x, at.y, type, type === 'heavy' ? 2 : 6);
}
function toggleFly() {
  fly.on = !fly.on;
  if (fly.on) fly.pos.copy(camera.position);
  camY = null;
}
function teleportKeep() {
  const keep = game.towers.find((t) => t.keep);
  if (!keep) return;
  game.player.perchId = null;
  game.player.x = keep.x;
  game.player.y = keep.y + keep.radius + 1.2;
  yaw = 0;
  camY = null;
}
for (const button of document.querySelectorAll('[data-dbg]')) {
  button.addEventListener('click', () => {
    if (!game) return;
    const key = button.dataset.dbg;
    if (key in debugFlags) debugFlags[key] = !debugFlags[key];
    else if (key === 'fly') toggleFly();
    else if (key === 'keep') teleportKeep();
    else if (key === 'res') { game.res.stone += 500; game.res.gold += 500; }
    else if (key === 'wave') forceNextWave(game);
    else if (key === 'spawn') debugSpawn();
    else if (key === 'spawnpause') game.debug.spawnPaused = !game.debug.spawnPaused;
    else if (key === 'regen') { startRun(randomSeed(), game.archetypeKey); }
    else if (key === 'weather') cycleWeather(game);
    else if (key === 'weatherFast') cycleWeather(game, true);
    refreshDebugButtons();
  });
}
function refreshDebugButtons() {
  for (const button of document.querySelectorAll('[data-dbg]')) {
    const key = button.dataset.dbg;
    const on = key in debugFlags ? debugFlags[key] : key === 'fly' ? fly.on : key === 'spawnpause' ? !!game?.debug.spawnPaused : false;
    button.classList.toggle('on', on);
  }
}

// --- look target ---------------------------------------------------------------------------
function lookTargets(g) {
  const targets = [];
  for (const t of g.towers) {
    targets.push({ kind: 'tower', ref: t, x: t.x, y: t.y, radius: t.radius * (t.keep ? 1.15 : 1.1), height: (t.keep ? WORLD3D.keepHeight : WORLD3D.towerHeight) * (t.built ? 1 : Math.max(0.15, t.progress || 0)) });
  }
  for (const b of g.buildings) if (!b.destroyed) targets.push({ kind: 'building', ref: b, x: b.x, y: b.y, radius: b.type === 'farm' ? 1.4 : 1.2, height: b.type === 'farm' ? 1.4 : 3 });
  for (const link of g.walls) for (const seg of link.segments) {
    if (!seg.present || seg.cancelled) continue;
    targets.push({ kind: 'wall', ref: seg, x: seg.x, y: seg.y, radius: 0.6, height: seg.destroyed ? 0.9 : WORLD3D.wallHeight });
  }
  for (const n of g.nests) targets.push({ kind: 'nest', ref: n, x: n.x, y: n.y, radius: n.radius, height: n.destroyed ? 0.6 : 2.6 });
  for (const e of g.enemies) targets.push({ kind: 'enemy', ref: e, x: e.x, y: e.y, radius: Math.max(0.4, e.def.radius * 1.2), height: e.type === 'heavy' ? 3 : 2 });
  for (const site of [...(g.map.stoneSites || []), ...(g.map.goldSites || [])]) {
    const claimed = g.buildings.some((b) => !b.destroyed && b.siteId === site.id);
    if (!claimed) targets.push({ kind: 'site', ref: site, x: site.x, y: site.y, radius: 1.5, height: 1.6 });
  }
  return targets;
}

/** Best valid tile near the crosshair hit: forgiving, never pixel-perfect (D101 §64). */
function chooseSite(g, hit, type) {
  if (!hit) return null;
  const base = snapToTile(hit);
  const reach = BUILD.lookReach;
  const candidates = [];
  for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
    const x = base.x + ox;
    const y = base.y + oy;
    candidates.push({ x, y, d: Math.hypot(x - hit.x, y - hit.y) });
  }
  candidates.sort((a, b) => a.d - b.d);
  const withReach = (x, y) => {
    const check = canPlaceAt(g, x, y, type);
    if (Math.hypot(g.player.x - x, g.player.y - y) > reach + 1e-6) {
      return { ...check, ok: false, reasons: [...check.reasons, 'move closer to the site'] };
    }
    return check;
  };
  for (const c of candidates) {
    const check = withReach(c.x, c.y);
    if (check.ok) return { x: c.x, y: c.y, check };
  }
  return { x: base.x, y: base.y, check: withReach(base.x, base.y) };
}

function updateLook(g) {
  const origin = camera.position.clone();
  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir);
  const ground = raycastTerrain(field, origin, dir, WORLD3D.pickRange * S);
  const pickRes = pickTarget(field, origin, dir, lookTargets(g), WORLD3D.pickRange * S, ground ? ground.distance : Infinity);
  look = { target: pickRes, hit: ground ? { x: ground.x, y: ground.y, distance: ground.distance } : null };

  // Repair works on what you look at, when in reach (D83/D101: never remote).
  const ref = pickRes?.ref;
  const structural = pickRes && (pickRes.kind === 'tower' || pickRes.kind === 'building' || pickRes.kind === 'wall');
  g.repairFocus = structural ? ref : null;
  const radius = pickRes?.kind === 'wall' ? 0.5 : ref?.radius ?? 0.55;
  ui.repairable = structural && (g.occupiedTowerId === ref.id && pickRes.kind === 'tower'
    || Math.hypot(g.player.x - ref.x, g.player.y - ref.y) - radius <= TOWER.repair.reach);
  // The simulation's "selected" structure is the one you are looking at, nearby.
  if (pickRes?.kind === 'tower' && Math.hypot(ref.x - g.player.x, ref.y - g.player.y) <= WORLD3D.interactRange) {
    g.selected = ref.id; g.selectedBuildingId = null;
  } else if (pickRes?.kind === 'building' && Math.hypot(ref.x - g.player.x, ref.y - g.player.y) <= WORLD3D.interactRange) {
    g.selected = null; g.selectedBuildingId = ref.id;
  } else { g.selected = g.player.perchId ?? null; g.selectedBuildingId = null; }

  if (!ui.buildMode) return;
  if (ui.buildType === 'wall') {
    const anchor = wallAnchorFromPick(pickRes);
    ui.wall.hover = null;
    ui.wall.plan = null;
    ui.wall.hoverReason = pickRes?.kind === 'tower' && !anchor.ok ? anchor.reason : null;
    if (anchor.ok && ui.wall.a != null && anchor.tower.id !== ui.wall.a) {
      ui.wall.hover = anchor.tower.id;
      ui.wall.plan = wallPlan(g, ui.wall.a, anchor.tower.id);
      const a = g.towers.find((t) => t.id === ui.wall.a);
      ui.wall.near = nearTower(a) || nearTower(anchor.tower);
    } else if (anchor.ok && ui.wall.a == null) {
      ui.wall.hover = anchor.tower.id;
    }
    if (ui.wall.a != null && !g.towers.some((t) => t.id === ui.wall.a)) ui.wall.a = null;
    if (ui.wall.notice && g.time - ui.wall.noticeAt > 3) ui.wall.notice = null;
    return;
  }
  let hit = look.hit;
  // Looking at a deposit snaps a Quarry/Mine to it.
  if (pickRes?.kind === 'site' && (ui.buildType === 'quarry' || ui.buildType === 'mine')) hit = { x: pickRes.ref.x, y: pickRes.ref.y };
  ui.site = chooseSite(g, hit, ui.buildType);
}

// --- frame loop ------------------------------------------------------------------------------
function inputFromKeys() {
  let forward = 0;
  let strafe = 0;
  if (keys.has('KeyW') || keys.has('ArrowUp')) forward += 1;
  if (keys.has('KeyS') || keys.has('ArrowDown')) forward -= 1;
  if (keys.has('KeyD') || keys.has('ArrowRight')) strafe += 1;
  if (keys.has('KeyA') || keys.has('ArrowLeft')) strafe -= 1;
  return { forward, strafe };
}

function updateCamera(g, dt) {
  if (fly.on) {
    const { forward, strafe } = inputFromKeys();
    const dir = new THREE.Vector3();
    camera.getWorldDirection(dir);
    const right = new THREE.Vector3().crossVectors(dir, camera.up).normalize();
    const speed = (keys.has('ShiftLeft') || keys.has('ShiftRight') ? 60 : 20) * dt;
    fly.pos.addScaledVector(dir, forward * speed).addScaledVector(right, strafe * speed);
    if (keys.has('Space')) fly.pos.y += speed;
    if (keys.has('KeyC') || keys.has('ControlLeft')) fly.pos.y -= speed;
    camera.position.copy(fly.pos);
  } else {
    const p = g.player;
    const perch = p.perchId != null ? g.towers.find((t) => t.id === p.perchId) : null;
    const base = heightAt(field, p.x, p.y);
    let target = base + WORLD3D.eyeHeight;
    if (perch) {
      const obj = world.entities.towerObject(perch.id);
      target = (obj ? obj.position.y : base) + (perch.keep ? WORLD3D.keepHeight + 0.6 : WORLD3D.towerHeight) + WORLD3D.eyeHeight;
    }
    // Smooth vertical motion (terrain steps, climbing) without lagging walking.
    camY = camY == null ? target : camY + (target - camY) * Math.min(1, dt * (Math.abs(target - camY) > 3 ? 4 : 14));
    let { x, z } = tileToWorld(p.x, p.y);
    if (perch) {
      // Stand at the parapet you face, so the ground below the tower is in view.
      const f = facingFromYaw(yaw);
      const lean = perch.radius * S * 0.62;
      x += f.x * lean;
      z += f.y * lean;
    }
    camera.position.set(x, camY, z);
  }
  const shake = world.entities.shake;
  if (shake > 0.01) {
    camera.position.x += (Math.random() - 0.5) * shake * 0.35;
    camera.position.y += (Math.random() - 0.5) * shake * 0.25;
  }
  camera.rotation.set(pitch, yaw, 0);
  sun.position.set(camera.position.x + 45, camera.position.y + 120, camera.position.z + 25);
  sun.target.position.set(camera.position.x, camera.position.y - 10, camera.position.z);
}

function nestAmbience(g) {
  if (g.time < nestAmbientAt) return;
  nestAmbientAt = g.time + 3.5;
  for (const n of g.nests) {
    if (n.destroyed) continue;
    if (Math.hypot(n.x - g.player.x, n.y - g.player.y) < 26) g.audioEvents.push({ type: 'nestAmbient', x: n.x, y: n.y });
  }
}

function debugInfo(g) {
  const el = $('debug-info');
  el.hidden = !debugFlags.info;
  if (!debugFlags.info) return;
  const p = g.player;
  const heading = headingDegrees(p.facing.x, p.facing.y);
  const hit = look.hit ? `${look.hit.x.toFixed(1)}, ${look.hit.y.toFixed(1)}` : '—';
  const wx = weatherState(g);
  const pop = populationState(g);
  const tower = look.target?.kind === 'tower' ? look.target.ref : g.towers.find((t) => t.id === g.player.perchId);
  el.textContent = [
    `tile ${p.x.toFixed(2)}, ${p.y.toFixed(2)}  world ${(p.x * S).toFixed(1)}, ${camera.position.y.toFixed(1)}, ${(p.y * S).toFixed(1)}`,
    `heading ${heading.toFixed(0)}°  pitch ${(pitch * 57.3).toFixed(0)}°  ${fly.on ? 'FLY' : ''}`,
    `crosshair tile ${hit}  target ${look.target ? look.target.kind : '—'}`,
    `fps ${fps.toFixed(0)}  draw calls ${renderer.info.render.calls}  tris ${(renderer.info.render.triangles / 1000).toFixed(0)}k`,
    `enemies ${g.enemies.length}  phase ${g.phase} ${g.phaseLeft.toFixed(1)}s  assault in ${assaultIn(g).toFixed(0)}s  wave ${g.wave}  from ${(g.spawnSides || []).join('+')}`,
    `weather ${wx.kind} ${(wx.blend * 100).toFixed(0)}%  vis ${wx.visibility.toFixed(2)}  next ${Number.isFinite(wx.timeLeft) ? wx.timeLeft.toFixed(0) : '-'}s`,
    `people ${pop.total}/${pop.support}  work ${pop.workers}  guard ${pop.garrison}  free ${pop.free}${pop.shortage ? `  SHORTAGE grace ${pop.graceLeft.toFixed(0)}s` : pop.growthIn != null ? `  next in ${pop.growthIn.toFixed(0)}s` : ''}`,
    `jobs ${buildingState(g).filter((b) => !b.destroyed).map((b) => `${b.type[0]}${b.id}:${b.workers}/${b.slots}`).join(' ') || '-'}`,
    tower ? `tower #${tower.id} target ${tower.targetId ?? '-'}  nest ${tower.nestTargetId ?? '-'}  cd ${Math.max(0, tower.shotCd).toFixed(2)}  garrison ${tower.garrison || 0}${tower.alarmUntil > g.time ? '  ALARM' : ''}` : 'tower -',
  ].join('\n');
}

let last = performance.now();
let hudAt = 0;
let fps = 60;
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  fps += ((dt > 0 ? 1 / dt : 60) - fps) * 0.05;
  if (!game || !world) { renderer.render(scene, camera); return; }
  stepGame(dt);
  renderFrame();
}

function renderFrame() {
  // Stats cover the world pass only; the weapon pass is drawn after reading them.
  renderer.info.autoReset = true;
  renderer.render(scene, camera);
  renderer.info.autoReset = false;
  if (game && game.status === 'playing') viewModel.render(renderer);
}

function stepGame(dt, { render = true } = {}) {
  const g = game;
  const facing = facingFromYaw(yaw);
  if (!g.paused && !fly.on) {
    const { forward, strafe } = inputFromKeys();
    const intent = moveIntent(forward, strafe, yaw);
    const sprint = keys.has('ShiftLeft') || keys.has('ShiftRight');
    g.input = {
      mx: intent.mx, my: intent.my,
      melee: meleeQueued, repair: keys.has('KeyR'),
      speedMult: sprint ? WORLD3D.sprintMult : WORLD3D.walkMult,
      facing,
    };
  } else {
    g.input = { mx: 0, my: 0, melee: false, repair: false, facing };
  }
  meleeQueued = false;
  if (!g.paused) nestAmbience(g);
  update(g, dt);
  const right = { x: -facing.y, y: facing.x };
  audio.playEvents(drainAudioEvents(g), g.player, g.paused, right);

  if (world.terrainVersion !== (g.map.terrainVersion || 0)) {
    world.terrainVersion = g.map.terrainVersion || 0;
    refreshVegetation(world.terrain, g.map, field);
  }
  updateCamera(g, dt);
  updateLook(g);
  // D112: weather changes what the eye can see; D113: the weapon in hand.
  const sky = weather.update(g, g.paused ? 0 : dt, camera);
  audio.setAmbience({ rain: g.paused ? 0 : sky.rain, wind: g.paused ? 0 : sky.wind });
  if (sky.thunder && !g.paused) audio.playEvents([{ type: 'thunder', x: g.player.x, y: g.player.y }], g.player, false);
  const moving = !g.paused && Math.hypot(g.player.vx || 0, g.player.vy || 0) > 0.5 ? 1 : 0;
  viewModel.update(g, g.paused ? 0 : dt, { moving, sprint: keys.has('ShiftLeft') || keys.has('ShiftRight'), hidden: fly.on, dim: sky.dim });
  world.entities.sync(g, g.paused ? 0 : dt);
  // The firing annulus shows for the Tower you look at, or the one you stand on.
  const perched = g.player.perchId != null ? g.towers.find((t) => t.id === g.player.perchId) : null;
  const inspectTower = ui.buildMode ? null
    : look.target?.kind === 'tower' && look.target.ref.built
      && Math.hypot(look.target.ref.x - g.player.x, look.target.ref.y - g.player.y) <= WORLD3D.interactRange ? look.target.ref
      : perched && perched.built ? perched : null;
  world.overlays.update(g, {
    buildMode: ui.buildMode, buildType: ui.buildType, site: ui.site,
    wall: ui.wall, inspectTower, debug: debugFlags,
  });

  // Damage feedback.
  if (g.player.hp < lastHp - 0.5) { hurt = Math.min(1, hurt + (lastHp - g.player.hp) / 40); world.entities.addShake(0.25); }
  lastHp = g.player.hp;
  hurt = Math.max(0, hurt - dt * 1.2);
  setVignette(hurt * 0.9 + (g.player.hp < g.player.maxHp * 0.3 ? 0.25 : 0));

  hudAt += dt;
  if (render && (hudAt > 0.08 || g.paused)) {
    hudAt = 0;
    updateHud(g, look, ui, debugFlags);
    debugInfo(g);
    refreshDebugButtons();
  }
  if (g.status !== 'playing' && !endShown) {
    endShown = true;
    document.exitPointerLock?.();
    $('pause-overlay').hidden = true;
    showEnd(g);
  }
}
requestAnimationFrame(frame);

// --- automation / console handle -------------------------------------------------------------
window.holdfast = {
  get game() { return game; },
  start: (seed, arch = 'gunner') => { startRun(seed, arch); },
  errors: [],
  fp: {
    setAutoPause(v) { autoPause = !!v; },
    setLook(y, p = pitch) { yaw = y; pitch = p; },
    get look() { return { yaw, pitch, target: look.target ? { kind: look.target.kind, id: look.target.ref.id ?? null } : null, hit: look.hit }; },
    lookAt(x, y, height = 1) {
      // Aim the camera at a tile position (height in metres above ground).
      const from = camera.position;
      const { x: wx, z: wz } = tileToWorld(x, y);
      const wy = heightAt(field, x, y) + height;
      const dx = wx - from.x;
      const dz = wz - from.z;
      yaw = Math.atan2(-dx, -dz);
      pitch = Math.atan2(wy - from.y, Math.hypot(dx, dz));
    },
    key(code, down = true) { if (down) keys.add(code); else keys.delete(code); },
    press(code, shift = false) {
      window.dispatchEvent(new KeyboardEvent('keydown', { code, shiftKey: shift }));
      window.dispatchEvent(new KeyboardEvent('keyup', { code, shiftKey: shift }));
    },
    primary: () => primaryAction(),
    weapon: (w) => switchWeapon(game, w),
    weather: (kind, instant = false) => setWeather(game, kind, { duration: 240, blendSeconds: instant ? 0 : undefined, forced: true }),
    cancel: () => cancelStep(),
    interact: () => interact(),
    ui: () => ({ buildMode: ui.buildMode, buildType: ui.buildType, site: ui.site && { x: ui.site.x, y: ui.site.y, ok: ui.site.check.ok, reasons: ui.site.check.reasons },
      wall: { a: ui.wall.a, hover: ui.wall.hover, ok: !!ui.wall.plan?.ok, near: ui.wall.near, reasons: ui.wall.plan?.reasons || [], notice: ui.wall.notice } }),
    /** Advance simulation + scene by N fixed steps (renders the last one). */
    step(seconds, dt = 1 / 30) {
      for (let t = 0; t < seconds; t += dt) stepGame(dt, { render: t + dt >= seconds });
      renderFrame();
    },
    camera: () => ({ x: camera.position.x, y: camera.position.y, z: camera.position.z, yaw, pitch }),
    stats: () => ({ ...world.entities.stats(), calls: renderer.info.render.calls, triangles: renderer.info.render.triangles, fps }),
    debug: debugFlags,
    toggleFly,
    teleportKeep,
  },
  api: {
    canPlaceAt: (x, y, type) => canPlaceAt(game, x, y, type),
    tryBuild: (x, y, type) => tryBuild(game, x, y, type),
    wallPlan: (a, b) => wallPlan(game, a, b),
    tryBuildWall: (a, b) => tryBuildWall(game, a, b),
    towerStats: (t) => towerStats(game, t),
    towerMinRange: (t) => towerMinRange(game, t),
    towerConnectivity: (t) => towerConnectivity(game, t),
    wallState: () => wallState(game),
    nestState: () => nestState(game),
    garrisonState: () => garrisonState(game),
    populationState: () => populationState(game),
    weatherState: () => weatherState(game),
    resourceState: () => resourceState(game),
    keepState: () => keepState(game),
    forceNextWave: () => forceNextWave(game),
    startWaveEarly: () => startWaveEarly(game),
    spawnGroupAt: (x, y, type, n) => spawnGroupAt(game, x, y, type, n),
    repairTarget: () => { const t = repairTarget(game); return t ? { id: t.id, wall: !!t.wall } : null; },
    isPointVisible: (x, y) => isPointVisible(game, x, y),
    setPaused: (v) => setPaused(game, v),
    fastForward(seconds) {
      for (let t = 0; t < seconds && game.status === 'playing'; t += 1 / 60) update(game, 1 / 60, { ignorePause: true });
    },
  },
};
window.addEventListener('error', (e) => window.holdfast.errors.push(String(e.message)));
window.addEventListener('unhandledrejection', (e) => window.holdfast.errors.push(String(e.reason)));

