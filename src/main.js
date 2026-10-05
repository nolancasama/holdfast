// Bootstrap, input, and the frame loop.

import { MAP, TOWER, PLAYER, ENEMIES, RENDER } from './config.js';
import { randomSeed } from './terrain.js';
import {
  createGame, update, canPlaceAt, tryBuild, tryUpgrade,
  forceNextWave, startWaveEarly, spawnGroupAt,
  towerStats, dangerState, setPaused, pauseState, equipmentState,
  drainAudioEvents, playerBuildSite,
  isTileVisible, isTileExplored, isPointVisible, visibilityState,
  upgradeState, towerAlarmState, stuckState, endState,
  keepState, resourceState, buildingState, resourceSitesState, keepFieldState, enemyKeepField,
  wallPlan, tryBuildWall, towerConnectivity, towerMinRange, wallState, repairTarget,
  assignGarrison, garrisonState, nestState,
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
  // D100: the minimap lives in its own canvas in the bottom console frame.
  const mini = $('minimap');
  const miniRect = mini.getBoundingClientRect();
  view.miniW = Math.round(miniRect.width);
  view.miniH = Math.round(miniRect.height);
  mini.width = view.miniW * dpr;
  mini.height = view.miniH * dpr;
  view.miniCtx = view.miniW > 0 && view.miniH > 0 ? mini.getContext('2d') : null;
  view.miniCtx?.setTransform(dpr, 0, 0, dpr, 0, 0);
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
  if (e.code === 'F10') { e.preventDefault(); toggleMenu(); return; }
  if ((e.code === 'Minus' || e.code === 'NumpadSubtract') && !e.repeat) { setZoom(view.zoom - 2); return; }
  if ((e.code === 'Equal' || e.code === 'NumpadAdd') && !e.repeat) { setZoom(view.zoom + 2); return; }
  if (e.code === 'Escape') { if (!$('menu').hidden) toggleMenu(false); else cancelBuildStep(); return; }
  if (e.code === 'KeyV' && !e.repeat) { game.debug.showFog = !game.debug.showFog; return; }
  if (game.paused) return;

  switch (e.code) {
    case 'KeyB': setBuildMode(!game.buildMode); break;
    case 'KeyX': if (!e.repeat) setBuildMode(true, 'wall'); break;
    // D100 command-card hotkeys; a blocked structure stays unselectable, as with its button.
    case 'KeyQ': if (!e.repeat) commandClick('build-tower'); break;
    case 'KeyF': if (!e.repeat) commandClick('build-farm'); break;
    case 'KeyC': if (!e.repeat) commandClick('build-quarry'); break;
    case 'KeyE': if (!e.repeat) commandClick('build-mine'); break;
    case 'KeyT': if (!e.repeat) startWaveEarly(game); break;
    case 'Enter': confirmBuild(); break;
    case 'Digit1': upgradeSelected('weapon'); break;
    case 'KeyG': garrisonSelected(e.shiftKey ? -1 : 1); break;
    // debug
    case 'KeyM': addDebugResources(); break;
    case 'KeyN': forceNextWave(game); break;
    case 'KeyY': debugSpawn(); break; // G is garrison (D91)
    case 'KeyK': debugDamage(); break;
    case 'KeyJ': debugKill(); break;
    case 'KeyH': game.debug.showPaths = !game.debug.showPaths; break;
    case 'KeyU': game.debug.showRoads = !game.debug.showRoads; break;
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
  if (e.button !== 0) return;
  const rect = canvas.getBoundingClientRect();
  const w = screenToWorld(view, e.clientX - rect.left, e.clientY - rect.top);
  game.cursor = w;

  if (game.buildMode && !game.paused) {
    if (game.buildType === 'wall') selectWallAnchor(w);
    else confirmBuild();
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
canvas.addEventListener('contextmenu', (e) => { e.preventDefault(); cancelBuildStep(); });

function setBuildMode(on, type = game?.buildType || 'tower') {
  if (on && game.paused) return;
  const changedType = game.buildType !== type;
  game.buildMode = on;
  game.buildType = type;
  if (!on || changedType) {
    game.wallAnchorA = null;
    game.wallAnchorB = null;
  }
  lastBuildPlayerTile = '';
  if (on) refreshBuildCheck(true);
  else {
    game.buildCheck = null;
    game.buildSite = null;
  }
}

/** Keep the local preview exact as resources accrue and blocking geometry changes. */
function refreshBuildCheck(force = false) {
  if (!game.buildMode) {
    game.buildCheck = null;
    game.buildSite = null;
    return;
  }
  const key = [
    Math.floor(game.player.x), Math.floor(game.player.y), game.buildType || 'tower',
    game.wallAnchorA ?? '', game.wallAnchorB ?? '',
    game.blockerVersion || 0, game.towers.length, game.walls?.length || 0,
    // Whole units: a fractional trickle must not re-plan walls every frame.
    Math.floor(game.res?.stone || 0), Math.floor(game.res?.gold || 0),
  ].join('|');
  if (!force && key === lastBuildPlayerTile) return;
  lastBuildPlayerTile = key;
  if (game.buildType === 'wall') {
    game.buildSite = null;
    if (game.wallAnchorA == null || game.wallAnchorB == null) { game.buildCheck = null; return; }
    const plan = wallPlan(game, game.wallAnchorA, game.wallAnchorB);
    const anchors = game.towers.filter((tower) => tower.id === game.wallAnchorA || tower.id === game.wallAnchorB);
    const near = anchors.some((tower) => Math.hypot(game.player.x - tower.x, game.player.y - tower.y)
      <= PLAYER.presenceRadius + tower.radius);
    game.buildCheck = near ? plan : { ...plan, ok: false,
      reasons: [...(plan.reasons || []), 'stand at one of the two towers to start the wall'] };
    return;
  }
  game.buildSite = playerBuildSite(game, game.buildType || 'tower');
  game.buildCheck = game.buildSite.check;
}

function confirmBuild() {
  if (!game || game.paused || !game.buildMode) return;
  refreshBuildCheck(true);
  if (game.buildType === 'wall') {
    if (game.wallAnchorA == null || game.wallAnchorB == null) return;
    const result = tryBuildWall(game, game.wallAnchorA, game.wallAnchorB);
    if (result.ok) setBuildMode(false);
    return;
  }
  const site = game.buildSite;
  if (!site) return;
  const res = tryBuild(game, site.x, site.y, game.buildType || 'tower');
  if (res.ok) setBuildMode(false);
}

function wallAnchorAt(point) {
  let best = null;
  let bestDistance = TOWER.radius + 0.9;
  for (const tower of game.towers) {
    if (tower.keep || !tower.built || tower.hp <= 0 || tower.destroyed) continue;
    const distance = Math.hypot(tower.x - point.x, tower.y - point.y);
    if (distance < bestDistance) { best = tower; bestDistance = distance; }
  }
  return best;
}

function selectWallAnchor(point) {
  const keep = game.towers.find((tower) => tower.keep);
  if (keep && Math.hypot(keep.x - point.x, keep.y - point.y) < (keep.radius ?? TOWER.radius) + 0.9) {
    game.wallNotice = { text: 'Walls must connect two Towers.', until: game.time + 2.5 };
    return;
  }
  const anchor = wallAnchorAt(point);
  if (!anchor) return;
  game.wallNotice = null;
  if (game.wallAnchorA == null) game.wallAnchorA = anchor.id;
  else if (anchor.id !== game.wallAnchorA) game.wallAnchorB = anchor.id;
  lastBuildPlayerTile = '';
  refreshBuildCheck(true);
}

function cancelBuildStep() {
  if (!game?.buildMode) return;
  if (game.buildType === 'wall' && game.wallAnchorB != null) {
    game.wallAnchorB = null;
    game.buildCheck = null;
    lastBuildPlayerTile = '';
  } else if (game.buildType === 'wall' && game.wallAnchorA != null) {
    game.wallAnchorA = null;
    game.buildCheck = null;
    lastBuildPlayerTile = '';
  } else setBuildMode(false);
}

/** D91: instant garrison change on the selected (or occupied) tower. */
function garrisonSelected(delta) {
  if (game.paused || game.selectedBuildingId != null) return;
  const t = game.towers.find((o) => o.id === (game.selected ?? game.occupiedTowerId));
  if (!t) return;
  const res = assignGarrison(game, t, delta);
  if (!res.ok && delta > 0) game.log.unshift({ text: `Cannot garrison: ${res.reason}.`, t: game.time });
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
  if (!game.res) game.res = { stone: 0, gold: 0 };
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
  if (game.debug.open) toggleMenu(true);
}
$('debug-toggle').onclick = toggleDebug;

// ---------------------------------------------------------------------------
// D100 console: menu drawer, command-card tooltips
// ---------------------------------------------------------------------------

function toggleMenu(open = $('menu').hidden) {
  $('menu').hidden = !open;
}
$('menu-toggle').onclick = () => toggleMenu();
$('menu-close').onclick = () => toggleMenu(false);

function commandClick(id) {
  const button = $(id);
  if (button && !button.disabled) button.click();
}

let tipTarget = null;
function refreshTooltip() {
  const tip = $('tooltip');
  if (!tipTarget || !tipTarget.isConnected) { tip.hidden = true; return; }
  const d = tipTarget.dataset;
  const cost = tipTarget.querySelector('.cost')?.textContent || '';
  const html = `<div class="tt-name">${d.tip}${d.key ? ` <kbd>${d.key}</kbd>` : ''}</div>`
    + (cost && /\d/.test(cost) ? `<div class="tt-cost">${cost}</div>` : '')
    + (d.desc ? `<div class="tt-desc">${d.desc}</div>` : '')
    + (d.reason ? `<div class="tt-reason">${d.reason}</div>` : '');
  if (tip.innerHTML !== html) tip.innerHTML = html;
  tip.hidden = false;
  const r = tipTarget.getBoundingClientRect();
  const w = tip.offsetWidth;
  tip.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w))}px`;
  tip.style.top = `${Math.max(8, r.top - tip.offsetHeight - 8)}px`;
}
$('cmd').addEventListener('mouseover', (e) => { tipTarget = e.target.closest('[data-tip]'); refreshTooltip(); });
$('cmd').addEventListener('mouseleave', () => { tipTarget = null; refreshTooltip(); });

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
$('start-wave').onclick = () => { if (!game.paused) startWaveEarly(game); };
$('d-mat').onclick = () => { if (!game.paused) addDebugResources(); };
$('d-wave').onclick = () => { if (!game.paused) forceNextWave(game); };
$('d-spawn').onclick = () => { if (!game.paused) debugSpawn(); };
$('d-dmg').onclick = () => { if (!game.paused) debugDamage(); };
$('d-kill').onclick = () => { if (!game.paused) debugKill(); };
$('d-paths').onclick = () => { game.debug.showPaths = !game.debug.showPaths; };
$('d-roads').onclick = () => { game.debug.showRoads = !game.debug.showRoads; };
$('d-fog').onclick = () => { game.debug.showFog = !game.debug.showFog; };
$('d-pause').onclick = () => {
  game.debug.spawnPaused = !game.debug.spawnPaused;
  $('d-pause').textContent = game.debug.spawnPaused ? 'Resume spawning' : 'Pause spawning';
};
$('d-regen').onclick = () => startRun(randomSeed(), game.archetypeKey);
$('build-toggle').onclick = () => { if (!game.paused) setBuildMode(!game.buildMode); };
$('build-tower').onclick = () => setBuildMode(true, 'tower');
$('build-wall').onclick = () => setBuildMode(true, 'wall');
$('build-farm').onclick = () => setBuildMode(true, 'farm');
$('build-quarry').onclick = () => setBuildMode(true, 'quarry');
$('build-mine').onclick = () => setBuildMode(true, 'mine');
$('build-confirm').onclick = confirmBuild;
$('build-cancel').onclick = cancelBuildStep;
$('up-weapon').onclick = () => upgradeSelected('weapon');
$('garrison-plus').onclick = () => garrisonSelected(1);
$('garrison-minus').onclick = () => garrisonSelected(-1);

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
    wallPlan: (aId, bId) => wallPlan(game, aId, bId),
    tryBuildWall: (aId, bId) => tryBuildWall(game, aId, bId),
    startWaveEarly: () => startWaveEarly(game),
    garrisonState: () => garrisonState(game),
    assignGarrison: (tower, delta) => assignGarrison(game, tower, delta),
    nestState: () => nestState(game),
    towerConnectivity: (tower) => towerConnectivity(game, tower),
    towerMinRange: (tower) => towerMinRange(game, tower),
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
  updateCamera();
  draw(ctx, game, layers, view);

  hudAccum += dt;
  if (hudAccum > 0.08) { hudAccum = 0; updateHud(game); refreshTooltip(); }

  if (game.status !== 'playing' && !endShown) {
    endShown = true;
    showEnd(game);
  }
}
requestAnimationFrame(frame);
