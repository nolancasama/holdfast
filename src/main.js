// Bootstrap, input, and the frame loop.

import { MAP, TOWER, ENEMIES, RENDER } from './config.js';
import { randomSeed } from './terrain.js';
import {
  createGame, update, canPlaceAt, tryBuild, tryUpgrade,
  forceNextWave, spawnGroupAt,
  towerStats, dangerState, setPaused, pauseState, equipmentState,
  drainAudioEvents, playerBuildSite,
  isTileVisible, isTileExplored, isPointVisible, visibilityState,
  upgradeState, towerAlarmState, stuckState, endState,
  keepState, resourceState, buildingState, resourceSitesState, keepFieldState, enemyKeepField,
  wallPlan, tryBuildWall, wallState, repairTarget,
} from './game.js';
import { createAudioSystem } from './audio.js';
import {
  buildTerrainLayer, buildTerrainDimLayer, screenToWorld, draw,
} from './render.js';
import { $, renderPicks, updateHud, updateMapInfo, showEnd } from './ui.js';

const canvas = $('game');
const ctx = canvas.getContext('2d');

let game = null;
let layers = null;
const view = { w: 0, h: 0, tilePx: RENDER.baseTilePx, zoom: RENDER.baseTilePx, offsetX: 0, offsetY: 0, worldX: 0, worldY: 0 };
const keys = new Set();
let lastBuildPlayerTile = '';
let endShown = false;
const audio = createAudioSystem();

let chosen = 'gunner';
$('seed-input').value = randomSeed();

function pick(key) {
  chosen = key;
  renderPicks(chosen, pick);
}
renderPicks(chosen, pick);

$('reroll').onclick = () => { $('seed-input').value = randomSeed(); };
$('start-btn').onclick = () => { audio.gesture(); startRun($('seed-input').value.trim() || randomSeed(), chosen); };
$('again-btn').onclick = () => {
  $('end-overlay').hidden = true;
  $('select-overlay').hidden = false;
  $('seed-input').value = randomSeed();
};

function startRun(seed, archetype) {
  game = createGame(seed, archetype);
  const terrain = buildTerrainLayer(game.map);
  layers = {
    terrain,
    terrainDim: buildTerrainDimLayer(terrain),
    terrainVersion: game.map.terrainVersion || 0,
  };
  endShown = false;
  lastBuildPlayerTile = '';
  $('select-overlay').hidden = true;
  $('end-overlay').hidden = true;
  updateMapInfo(game);
  syncAudioControls();
}

function syncAudioControls() {
  const state = audio.state;
  $('sfx-volume').value = state.volume;
  $('sfx-mute').textContent = state.muted ? 'Unmute SFX' : 'Mute SFX';
}
$('sfx-volume').oninput = (e) => audio.setVolume(e.target.value);
$('sfx-mute').onclick = () => { audio.setMuted(!audio.state.muted); syncAudioControls(); };

// ---------------------------------------------------------------------------
// Sizing
// ---------------------------------------------------------------------------

function resize() {
  const rect = $('stage').getBoundingClientRect();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  view.w = Math.round(rect.width);
  view.h = Math.round(rect.height);
  canvas.width = view.w * dpr;
  canvas.height = view.h * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  updateCamera();
}
window.addEventListener('resize', resize);
resize();

function setZoom(next) {
  view.zoom = Math.max(RENDER.minTilePx, Math.min(RENDER.maxTilePx, Math.round(next)));
  view.tilePx = view.zoom;
  updateCamera();
}

function updateCamera() {
  view.tilePx = view.zoom;
  const focusX = game?.player?.x ?? MAP.w / 2;
  const focusY = game?.player?.y ?? MAP.h / 2;
  const worldW = MAP.w * view.tilePx;
  const worldH = MAP.h * view.tilePx;
  view.offsetX = worldW <= view.w ? Math.floor((view.w - worldW) / 2)
    : Math.round(Math.max(view.w - worldW, Math.min(0, view.w / 2 - focusX * view.tilePx)));
  view.offsetY = worldH <= view.h ? Math.floor((view.h - worldH) / 2)
    : Math.round(Math.max(view.h - worldH, Math.min(0, view.h / 2 - focusY * view.tilePx)));
  view.worldX = -view.offsetX / view.tilePx;
  view.worldY = -view.offsetY / view.tilePx;
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

const MOVE_KEYS = {
  KeyW: [0, -1], ArrowUp: [0, -1],
  KeyS: [0, 1], ArrowDown: [0, 1],
  KeyA: [-1, 0], ArrowLeft: [-1, 0],
  KeyD: [1, 0], ArrowRight: [1, 0],
};

function typingInInput(e) {
  return e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA');
}

window.addEventListener('keydown', (e) => {
  audio.gesture();
  if (typingInInput(e)) {
    if (e.code === 'Enter') $('start-btn').click();
    return;
  }
  if (MOVE_KEYS[e.code] || e.code === 'Space' || e.code === 'KeyP' || e.code === 'Enter') e.preventDefault();
  keys.add(e.code);
  if (!game || game.status !== 'playing') return;

  if (e.code === 'KeyP' && !e.repeat) {
    togglePause();
    return;
  }
  if (e.code === 'F1') { e.preventDefault(); toggleDebug(); return; }
  if ((e.code === 'Minus' || e.code === 'NumpadSubtract') && !e.repeat) { setZoom(view.zoom - 2); return; }
  if ((e.code === 'Equal' || e.code === 'NumpadAdd') && !e.repeat) { setZoom(view.zoom + 2); return; }
  if (e.code === 'Escape') { setBuildMode(false); setWallMode(false); return; }
  if (e.code === 'KeyV' && !e.repeat) { game.debug.showFog = !game.debug.showFog; return; }
  if (game.paused) return;

  switch (e.code) {
    case 'KeyB': setWallMode(false); setBuildMode(!game.buildMode); break;
    case 'KeyX': setWallMode(!game.wallMode); break;
    case 'Enter': if (game.wallMode) confirmWall(); else confirmBuild(); break;
    case 'Digit1': upgradeSelected('weapon'); break;
    // debug
    case 'KeyM': addDebugResources(); break;
    case 'KeyN': forceNextWave(game); break;
    case 'KeyG': debugSpawn(); break;
    case 'KeyK': debugDamage(); break;
    case 'KeyJ': debugKill(); break;
    case 'KeyH': game.debug.showPaths = !game.debug.showPaths; break;
    case 'KeyL': game.debug.spawnPaused = !game.debug.spawnPaused; break;
    case 'KeyO': startRun(randomSeed(), game.archetypeKey); break;
    default: break;
  }
});
window.addEventListener('keyup', (e) => keys.delete(e.code));
window.addEventListener('blur', () => keys.clear());

canvas.addEventListener('mousemove', (e) => {
  if (!game) return;
  const rect = canvas.getBoundingClientRect();
  const w = screenToWorld(view, e.clientX - rect.left, e.clientY - rect.top);
  game.cursor = w;
});
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  setZoom(view.zoom + (e.deltaY < 0 ? 2 : -2));
}, { passive: false });

canvas.addEventListener('mousedown', (e) => {
  audio.gesture();
  if (!game || game.status !== 'playing') return;
  e.preventDefault();
  if (e.button !== 0) {
    if (e.button === 2) { setBuildMode(false); setWallMode(false); }
    return;
  }
  const rect = canvas.getBoundingClientRect();
  const w = screenToWorld(view, e.clientX - rect.left, e.clientY - rect.top);
  game.cursor = w;

  if (game.buildMode && !game.paused) {
    confirmBuild();
    return;
  }
  if (game.wallMode && !game.paused) {
    const target = towerNear(w, 1.8);
    if (target && target.id !== game.wallMode.fromId) {
      game.wallMode.toId = target.id;
      confirmWall();
    }
    return;
  }
  let best = null;
  let bestD = TOWER.radius + 0.9;
  for (const t of game.towers) {
    const d = Math.hypot(t.x - w.x, t.y - w.y);
    if (d < bestD) { bestD = d; best = t; }
  }
  let bestBuilding = null;
  let bestBuildingD = 1.15;
  for (const b of game.buildings || []) {
    if (b.destroyed || b.hp <= 0) continue;
    const d = Math.hypot(b.x - w.x, b.y - w.y);
    if (d < bestBuildingD) { bestBuildingD = d; bestBuilding = b; }
  }
  if (bestBuilding && (!best || bestBuildingD < bestD)) {
    game.selected = null;
    game.selectedBuildingId = bestBuilding.id;
    game.selectedBuilding = bestBuilding;
  } else {
    game.selected = best ? best.id : null;
    game.selectedBuildingId = null;
    game.selectedBuilding = null;
  }
});
canvas.addEventListener('contextmenu', (e) => { e.preventDefault(); setBuildMode(false); setWallMode(false); });

function setBuildMode(on, type = game?.buildType || 'tower') {
  if (on && game.paused) return;
  if (on) game.wallMode = null;
  game.buildMode = on;
  game.buildType = type;
  lastBuildPlayerTile = '';
  if (on) refreshBuildCheck(true);
  else {
    game.buildCheck = null;
    game.buildSite = null;
  }
}

/** Site evaluation can sample line of sight, so only recompute when the player changes tile. */
function refreshBuildCheck(force = false) {
  if (!game.buildMode) {
    game.buildCheck = null;
    game.buildSite = null;
    return;
  }
  const key = `${Math.floor(game.player.x)},${Math.floor(game.player.y)}`;
  if (!force && key === lastBuildPlayerTile) return;
  lastBuildPlayerTile = key;
  game.buildSite = playerBuildSite(game, game.buildType || 'tower');
  game.buildCheck = game.buildSite.check;
}

function confirmBuild() {
  if (!game || game.paused || !game.buildMode) return;
  refreshBuildCheck(true);
  const site = game.buildSite;
  if (!site) return;
  const res = tryBuild(game, site.x, site.y, game.buildType || 'tower');
  if (res.ok) setBuildMode(false);
}

function towerNear(w, radius) {
  let best = null;
  let bestD = radius;
  for (const t of game.towers) {
    const d = Math.hypot(t.x - w.x, t.y - w.y);
    if (d < bestD) { bestD = d; best = t; }
  }
  return best;
}

/** D81: X starts a wall from the selected (or occupied) finished tower. */
function setWallMode(on) {
  if (!game) return;
  if (!on) { game.wallMode = null; return; }
  if (game.paused) return;
  const from = game.towers.find((t) => t.id === (game.selected ?? game.occupiedTowerId));
  setBuildMode(false);
  if (!from || !from.built) {
    game.wallMode = { fromId: null, toId: null, plan: null, note: 'Select a finished tower first, then press X.' };
    return;
  }
  game.wallMode = { fromId: from.id, toId: null, plan: null, note: null };
}

function refreshWallPlan() {
  const mode = game.wallMode;
  if (!mode || mode.fromId === null) return;
  const hover = towerNear(game.cursor, 1.8);
  if (hover && hover.id !== mode.fromId) mode.toId = hover.id;
  mode.plan = mode.toId !== null ? wallPlan(game, mode.fromId, mode.toId) : null;
}

function confirmWall() {
  const mode = game.wallMode;
  if (!mode || mode.fromId === null || mode.toId === null || game.paused) return;
  const res = tryBuildWall(game, mode.fromId, mode.toId);
  if (res.ok) game.wallMode = null;
  else mode.note = res.reasons.join(', ');
}

function upgradeSelected(which) {
  if (game.paused || game.selectedBuildingId != null) return;
  const t = game.towers.find((o) => o.id === (game.selected ?? game.occupiedTowerId));
  if (t) tryUpgrade(game, t, which);
}

function selectedTower() {
  return game.towers.find((o) => o.id === (game.selected ?? game.occupiedTowerId));
}

function addDebugResources() {
  if (!game.res) game.res = { food: 0, stone: 0, gold: 0 };
  game.res.food += 500;
  game.res.stone += 500;
  game.res.gold += 500;
}

// ---------------------------------------------------------------------------
// Debug panel
// ---------------------------------------------------------------------------

function toggleDebug() {
  const body = $('debug-body');
  body.classList.toggle('open');
  game.debug.open = body.classList.contains('open');
}
$('debug-toggle').onclick = toggleDebug;

function togglePause() {
  const paused = setPaused(game);
  keys.clear();
  if (paused) setBuildMode(false);
  if (paused) audio.suspendForPause(); else audio.resumeAfterPause();
  updateHud(game);
}

function debugSpawn() {
  const types = Object.keys(ENEMIES);
  const type = types[Math.floor(Math.random() * types.length)];
  spawnGroupAt(game, game.cursor.x, game.cursor.y, type, type === 'heavy' ? 2 : 6);
}
function debugDamage() {
  const t = selectedTower();
  if (!t) return;
  t.hp = Math.max(1, t.hp - t.maxHp * 0.25);
  t.flash = 1;
}
function debugKill() {
  const t = selectedTower();
  if (t) t.hp = -1; // destroyed on the next tower update, collapse damage included
}

$('pause-toggle').onclick = togglePause;
$('d-mat').onclick = () => { if (!game.paused) addDebugResources(); };
$('d-wave').onclick = () => { if (!game.paused) forceNextWave(game); };
$('d-spawn').onclick = () => { if (!game.paused) debugSpawn(); };
$('d-dmg').onclick = () => { if (!game.paused) debugDamage(); };
$('d-kill').onclick = () => { if (!game.paused) debugKill(); };
$('d-paths').onclick = () => { game.debug.showPaths = !game.debug.showPaths; };
$('d-fog').onclick = () => { game.debug.showFog = !game.debug.showFog; };
$('d-pause').onclick = () => {
  game.debug.spawnPaused = !game.debug.spawnPaused;
  $('d-pause').textContent = game.debug.spawnPaused ? 'Resume spawning' : 'Pause spawning';
};
$('d-regen').onclick = () => startRun(randomSeed(), game.archetypeKey);
$('build-toggle').onclick = () => { if (!game.paused) setBuildMode(!game.buildMode); };
$('build-tower').onclick = () => setBuildMode(true, 'tower');
$('build-farm').onclick = () => setBuildMode(true, 'farm');
$('build-quarry').onclick = () => setBuildMode(true, 'quarry');
$('build-mine').onclick = () => setBuildMode(true, 'mine');
$('build-confirm').onclick = () => (game.wallMode ? confirmWall() : confirmBuild());
$('build-wall').onclick = () => setWallMode(!game.wallMode);
$('up-weapon').onclick = () => upgradeSelected('weapon');

// ---------------------------------------------------------------------------
// Frame loop
// ---------------------------------------------------------------------------

// Debug handle for scripted playthroughs and console poking (plan §17).
window.holdfast = {
  get game() { return game; },
  start: startRun,
  errors: [],
  api: {
    canPlaceAt, tryBuild, tryUpgrade, towerStats, spawnGroupAt, forceNextWave, dangerState,
    playerBuildSite, isTileVisible, isTileExplored, isPointVisible, visibilityState,
    upgradeState: (...args) => args.length > 1
      ? upgradeState(args[0], args[1]) : upgradeState(game, args[0]),
    towerAlarmState, stuckState, endState,
    pauseState, setPaused: (paused) => {
      const state = setPaused(game, paused);
      if (state) audio.suspendForPause(); else audio.resumeAfterPause();
      return state;
    }, equipmentState,
    keepState: () => keepState(game),
    resourceState: () => resourceState(game),
    buildingState: () => buildingState(game),
    resourceSitesState: () => resourceSitesState(game),
    siteState: () => resourceSitesState(game),
    keepFieldState: () => keepFieldState(game),
    enemyKeepField: (type) => {
      const field = enemyKeepField(game, type);
      return field ? new Float32Array(field) : null;
    },
    cameraState: () => ({ ...view }),
    wallPlan: (a, b) => wallPlan(game, a, b),
    tryBuildWall: (a, b) => tryBuildWall(game, a, b),
    wallState: () => wallState(game),
    repairTarget: () => { const t = repairTarget(game); return t ? { id: t.id, wall: !!t.wall, type: t.type || null, hp: t.hp, destroyed: !!t.destroyed } : null; },
    minimapState: () => layers?.minimapState ? { ...layers.minimapState } : null,
    setAudioEnabled: (enabled) => audio.setEnabled(enabled),
    audioState: () => audio.state,
  },
  /** Run the simulation forward without waiting in real time. */
  fastForward(seconds, onStep) {
    const step = 1 / 60;
    for (let t = 0; t < seconds && game.status === 'playing'; t += step) {
      update(game, step, { ignorePause: true });
      if (onStep) onStep(game, t);
    }
  },
};
window.addEventListener('error', (e) => window.holdfast.errors.push(String(e.message)));
window.addEventListener('unhandledrejection', (e) => window.holdfast.errors.push(String(e.reason)));

let last = performance.now();
let hudAccum = 0;

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (!game) return;

  let mx = 0;
  let my = 0;
  for (const code of keys) {
    const m = MOVE_KEYS[code];
    if (m) { mx += m[0]; my += m[1]; }
  }
  game.input = game.paused
    ? { mx: 0, my: 0, melee: false, repair: false }
    : { mx, my, melee: keys.has('Space'), repair: keys.has('KeyR') };

  update(game, dt);
  audio.playEvents(drainAudioEvents(game), game.player, game.paused);

  if (layers.terrainVersion !== (game.map.terrainVersion || 0)) {
    const terrain = buildTerrainLayer(game.map);
    layers = {
      terrain,
      terrainDim: buildTerrainDimLayer(terrain),
      terrainVersion: game.map.terrainVersion || 0,
    };
  }

  refreshBuildCheck();
  refreshWallPlan();
  updateCamera();
  draw(ctx, game, layers, view);

  hudAccum += dt;
  if (hudAccum > 0.08) { hudAccum = 0; updateHud(game); }

  if (game.status !== 'playing' && !endShown) {
    endShown = true;
    showEnd(game);
  }
}
requestAnimationFrame(frame);
