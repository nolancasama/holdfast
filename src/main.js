// Bootstrap, input, and the frame loop.

import { MAP, TOWER, ENEMIES } from './config.js';
import { randomSeed } from './terrain.js';
import {
  createGame, update, canPlaceAt, tryBuild, tryUpgrade,
  forceNextWave, spawnGroupAt,
  towerStats, dangerState, setPaused, pauseState, equipmentState, depositRichness,
  drainAudioEvents, playerBuildSite,
  isTileVisible, isTileExplored, isPointVisible, visibilityState,
  upgradeState, towerAlarmState,
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
const view = { w: 0, h: 0, tilePx: 1, offsetX: 0, offsetY: 0 };
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
  layers = { terrain, terrainDim: buildTerrainDimLayer(terrain), terrainView: null };
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
  view.tilePx = Math.max(1, Math.floor(Math.min(view.w / MAP.w, view.h / MAP.h)));
  view.offsetX = Math.floor((view.w - MAP.w * view.tilePx) / 2);
  view.offsetY = Math.floor((view.h - MAP.h * view.tilePx) / 2);
}
window.addEventListener('resize', resize);
resize();

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
  if (e.code === 'Escape') { setBuildMode(false); return; }
  if (e.code === 'KeyV' && !e.repeat) { game.debug.showFog = !game.debug.showFog; return; }
  if (game.paused) return;

  switch (e.code) {
    case 'KeyB': setBuildMode(!game.buildMode); break;
    case 'Enter': confirmBuild(); break;
    case 'Digit1': upgradeSelected('weapon'); break;
    case 'Digit2': upgradeSelected('extraction'); break;
    // debug
    case 'KeyM': game.materials += 500; break;
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

canvas.addEventListener('mousedown', (e) => {
  audio.gesture();
  if (!game || game.status !== 'playing') return;
  e.preventDefault();
  if (e.button !== 0) {
    if (e.button === 2) setBuildMode(false);
    return;
  }
  const rect = canvas.getBoundingClientRect();
  const w = screenToWorld(view, e.clientX - rect.left, e.clientY - rect.top);
  game.cursor = w;

  if (game.buildMode && !game.paused) {
    confirmBuild();
    return;
  }
  let best = null;
  let bestD = TOWER.radius + 0.9;
  for (const t of game.towers) {
    const d = Math.hypot(t.x - w.x, t.y - w.y);
    if (d < bestD) { bestD = d; best = t; }
  }
  game.selected = best ? best.id : null;
});
canvas.addEventListener('contextmenu', (e) => { e.preventDefault(); setBuildMode(false); });

function setBuildMode(on) {
  if (on && game.paused) return;
  game.buildMode = on;
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
  game.buildSite = playerBuildSite(game);
  game.buildCheck = game.buildSite.check;
}

function confirmBuild() {
  if (!game || game.paused || !game.buildMode) return;
  refreshBuildCheck(true);
  const site = game.buildSite;
  if (!site) return;
  const res = tryBuild(game, site.x, site.y);
  if (res.ok) setBuildMode(false);
}

function upgradeSelected(which) {
  if (game.paused) return;
  const t = game.towers.find((o) => o.id === (game.selected ?? game.occupiedTowerId));
  if (t) tryUpgrade(game, t, which);
}

function selectedTower() {
  return game.towers.find((o) => o.id === (game.selected ?? game.occupiedTowerId));
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
$('d-mat').onclick = () => { if (!game.paused) game.materials += 500; };
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
$('build-confirm').onclick = confirmBuild;
$('up-weapon').onclick = () => upgradeSelected('weapon');
$('up-extract').onclick = () => upgradeSelected('extraction');

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
    upgradeState, towerAlarmState,
    pauseState, setPaused: (paused) => {
      const state = setPaused(game, paused);
      if (state) audio.suspendForPause(); else audio.resumeAfterPause();
      return state;
    }, equipmentState, depositRichness,
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

  refreshBuildCheck();
  draw(ctx, game, layers, view);

  hudAccum += dt;
  if (hudAccum > 0.08) { hudAccum = 0; updateHud(game); }

  if (game.status !== 'playing' && !endShown) {
    endShown = true;
    showEnd(game);
  }
}
requestAnimationFrame(frame);
