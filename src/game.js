// Simulation. Rendering and DOM live elsewhere; nothing here touches the canvas.

import {
  MAP, T, PLAYER, TOWER, OCCUPANCY, ARCHETYPES, ENEMIES, ENEMY, AGGRO,
  WAVE, START_MATERIALS, DROP, ELEVATION_NAMES, richnessTierForRate, AUDIO,
  BUILD, VISION, STUCK, BREACH,
} from './config.js';
import {
  generateMap, randomSeed, idx, inBounds, isPassable, moveCostAt,
  kindAt, elevAt, hasLineOfSight, hasClearWalk, isTerrainBuildable,
  clearTowerForest,
} from './terrain.js';
import { computeField, steer } from './flowfield.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
export const PLAYER_TARGET_ID = 'player';

// ---------------------------------------------------------------------------

export function createGame(seedString, archetypeKey) {
  const seed = seedString || randomSeed();
  const map = generateMap(seed);
  const arch = ARCHETYPES[archetypeKey] || ARCHETYPES.gunner;

  const g = {
    seed, map, arch, archetypeKey,
    time: 0,
    status: 'playing',
    lossCause: null,
    paused: false,
    materials: START_MATERIALS,
    phase: 'prep',
    phaseLeft: WAVE.prepFirst,
    wave: 1,
    spawnSides: [],
    pendingSpawns: [],
    player: {
      x: map.start.x + 0.5, y: map.start.y + 2.5,
      hp: PLAYER.maxHp, maxHp: PLAYER.maxHp,
      meleeCd: 0, hurtCd: 0, facing: { x: 0, y: 1 },
    },
    effects: {}, equipment: [],
    towers: [], enemies: [], drops: [],
    tracers: [], particles: [], floaters: [], shockwaves: [],
    nextTowerId: 1, nextEnemyId: 1,
    selected: null, buildMode: false,
    cursor: { x: map.start.x, y: map.start.y },
    occupiedTowerId: null,
    shelter: { towerId: null, progress: 0, required: PLAYER.shelterTime },
    input: { mx: 0, my: 0, melee: false, repair: false },
    playerField: null, playerFieldAt: -99, playerLaneField: null, playerLaneFieldAt: -99,
    log: [], audioEvents: [],
    stats: {
      kills: 0, towersLost: 0, materialsEarned: 0, wavesCleared: 0,
      breaches: 0, breachesByType: { swarm: 0, runner: 0, heavy: 0 }, breachDamage: 0,
      stuckDetections: 0, stuckRecoveries: 0, stuckDespawns: 0,
    },
    debug: { showPaths: false, showFog: false, spawnPaused: false, open: false, stuckEpisodes: [] },
    fog: {
      explored: new Uint8Array(MAP.w * MAP.h),
      visible: new Uint8Array(MAP.w * MAP.h),
      version: 0,
    },
    fogCache: { map, playerTile: null, towerSignature: null, towerTiles: new Map() },
  };

  const start = placeTower(g, map.start.x + 0.5, map.start.y + 0.5, true);
  start.hp = start.maxHp;
  recomputeVisibility(g, true);
  say(g, `Seed ${seed} — survive ${WAVE.totalToSurvive} waves.`);
  return g;
}

function say(g, text) {
  g.log.unshift({ text, t: g.time });
  if (g.log.length > 7) g.log.pop();
}

/** Bounded observer queue. Audio never affects simulation state or outcomes. */
export function emitAudioEvent(g, type, { x = g.player.x, y = g.player.y, ...data } = {}) {
  if (g.audioEvents.length >= AUDIO.eventQueueCap) g.audioEvents.shift();
  // `type` is applied LAST: callers pass whole entities as data, and enemies
  // carry their own `type` ('swarm', 'heavy'), which used to overwrite the cue
  // name and turned every enemy hit and death into the generic fallback beep.
  g.audioEvents.push({ x, y, ...data, type });
}

export function drainAudioEvents(g) {
  const events = g.audioEvents;
  g.audioEvents = [];
  return events;
}

// ---------------------------------------------------------------------------
// Fog of war
// ---------------------------------------------------------------------------

function tilesVisibleFrom(map, x, y, radius) {
  const tiles = [];
  const minX = Math.max(0, Math.floor(x - radius));
  const maxX = Math.min(MAP.w - 1, Math.floor(x + radius));
  const minY = Math.max(0, Math.floor(y - radius));
  const maxY = Math.min(MAP.h - 1, Math.floor(y + radius));
  for (let ty = minY; ty <= maxY; ty++) {
    for (let tx = minX; tx <= maxX; tx++) {
      if (Math.hypot(tx + 0.5 - x, ty + 0.5 - y) > radius) continue;
      if (hasLineOfSight(map, x, y, tx + 0.5, ty + 0.5)) tiles.push(idx(tx, ty));
    }
  }
  return tiles;
}

function towerVisionRadius(g, t) {
  return Math.max(VISION.towerMin, towerStats(g, t).range + VISION.towerRangeMargin);
}

/** Rebuild derived visibility only when a vision source changes. */
export function recomputeVisibility(g, force = false) {
  const playerTile = `${Math.floor(g.player.x)},${Math.floor(g.player.y)}`;
  const towerSignature = g.towers.map((t) => (
    t.built ? `${t.id}:1:${towerVisionRadius(g, t)}` : `${t.id}:0`
  )).join('|');
  const cache = g.fogCache;
  if (cache.map !== g.map) {
    cache.map = g.map;
    cache.towerTiles.clear();
    force = true;
  } else if (force) {
    cache.towerTiles.clear();
  }
  if (!force && cache.playerTile === playerTile && cache.towerSignature === towerSignature) return false;

  g.fog.visible.fill(0);
  for (const i of tilesVisibleFrom(g.map, g.player.x, g.player.y, VISION.player)) g.fog.visible[i] = 1;

  const usedTowerKeys = new Set();
  for (const t of g.towers) {
    if (!t.built) continue;
    const radius = towerVisionRadius(g, t);
    const key = `${t.x},${t.y},${radius}`;
    usedTowerKeys.add(key);
    let tiles = cache.towerTiles.get(key);
    if (!tiles) {
      tiles = tilesVisibleFrom(g.map, t.x, t.y, radius);
      cache.towerTiles.set(key, tiles);
    }
    for (const i of tiles) g.fog.visible[i] = 1;
  }
  for (const key of cache.towerTiles.keys()) {
    if (!usedTowerKeys.has(key)) cache.towerTiles.delete(key);
  }

  for (let i = 0; i < g.fog.visible.length; i++) {
    if (g.fog.visible[i]) g.fog.explored[i] = 1;
  }
  cache.playerTile = playerTile;
  cache.towerSignature = towerSignature;
  g.fog.version++;
  return true;
}

export function isTileVisible(g, tx, ty) {
  return inBounds(tx, ty) && !!g.fog.visible[idx(tx, ty)];
}

export function isTileExplored(g, tx, ty) {
  return inBounds(tx, ty) && !!g.fog.explored[idx(tx, ty)];
}

export function isPointVisible(g, x, y) {
  return isTileVisible(g, Math.floor(x), Math.floor(y));
}

export function visibilityState(g) {
  let exploredCount = 0;
  let visibleCount = 0;
  for (let i = 0; i < g.fog.visible.length; i++) {
    exploredCount += g.fog.explored[i];
    visibleCount += g.fog.visible[i];
  }
  return {
    exploredCount,
    visibleCount,
    total: g.fog.visible.length,
    playerRadius: VISION.player,
    towerRadii: g.towers.filter((t) => t.built).map((t) => ({ id: t.id, radius: towerVisionRadius(g, t) })),
  };
}

// ---------------------------------------------------------------------------
// Towers
// ---------------------------------------------------------------------------

/** Sum of resource density inside the extraction radius, normalised to ~1.0 typical. */
export function resourceScoreAt(map, x, y, radius) {
  let sum = 0;
  for (let ty = Math.floor(y - radius); ty <= Math.ceil(y + radius); ty++) {
    for (let tx = Math.floor(x - radius); tx <= Math.ceil(x + radius); tx++) {
      if (!inBounds(tx, ty)) continue;
      if (Math.hypot(tx + 0.5 - x, ty + 0.5 - y) > radius) continue;
      sum += map.res[idx(tx, ty)];
    }
  }
  return sum / TOWER.extraction.normalizer;
}

/** Fraction of tiles in weapon range this site can actually see (D3 line of sight). */
export function coverageAt(map, x, y, range) {
  let seen = 0;
  let total = 0;
  for (let ty = Math.floor(y - range); ty <= Math.ceil(y + range); ty += 2) {
    for (let tx = Math.floor(x - range); tx <= Math.ceil(x + range); tx += 2) {
      if (!inBounds(tx, ty)) continue;
      if (Math.hypot(tx + 0.5 - x, ty + 0.5 - y) > range) continue;
      if (!isPassable(map, tx, ty)) continue;
      total++;
      if (hasLineOfSight(map, x, y, tx + 0.5, ty + 0.5)) seen++;
    }
  }
  return total ? seen / total : 0;
}

/** Towers get dearer the more you already own, so sprawl has a real price. */
export function towerCost(g) {
  return TOWER.cost + TOWER.costPerExisting * g.towers.length;
}

export function canPlaceAt(g, x, y) {
  const reasons = [];
  isTerrainBuildable(g.map, x, y, reasons);

  for (const t of g.towers) {
    if (Math.hypot(t.x - x, t.y - y) < TOWER.minSpacing) {
      reasons.push(`too close to another tower (${TOWER.minSpacing} tiles apart)`);
      break;
    }
  }

  const unique = [...new Set(reasons)];
  const cost = towerCost(g);
  if (g.materials < cost) unique.push(`need ${cost} Materials`);

  const eRadius = TOWER.extraction.radius;
  const income = resourceScoreAt(g.map, x, y, eRadius) * TOWER.extraction.baseRate;
  const terrain = kindAt(g.map, Math.floor(x), Math.floor(y));
  const elev = elevAt(g.map, Math.floor(x), Math.floor(y));
  return {
    ok: unique.length === 0,
    reasons: unique,
    cost,
    income,
    richness: richnessTierForRate(income),
    coverage: coverageAt(g.map, x, y, TOWER.weapon.range),
    terrain,
    elev,
    elevationName: terrain === T.CLIFF ? 'Cliff' : ELEVATION_NAMES[elev],
  };
}

/** Nearest buildable tile centre the player can physically reach to build. */
export function playerBuildSite(g) {
  const candidates = [];
  for (let ty = Math.floor(g.player.y - BUILD.reach); ty <= Math.floor(g.player.y + BUILD.reach); ty++) {
    for (let tx = Math.floor(g.player.x - BUILD.reach); tx <= Math.floor(g.player.x + BUILD.reach); tx++) {
      if (!inBounds(tx, ty)) continue;
      const x = tx + 0.5;
      const y = ty + 0.5;
      const distance = Math.hypot(g.player.x - x, g.player.y - y);
      if (distance <= BUILD.reach + 1e-6) candidates.push({ x, y, distance });
    }
  }
  candidates.sort((a, b) => a.distance - b.distance || a.y - b.y || a.x - b.x);
  for (const candidate of candidates) {
    const check = canPlaceAt(g, candidate.x, candidate.y);
    if (check.ok) return { x: candidate.x, y: candidate.y, check };
  }
  const x = Math.floor(g.player.x) + 0.5;
  const y = Math.floor(g.player.y) + 0.5;
  return { x, y, check: canPlaceAt(g, x, y) };
}

function placeTower(g, x, y, instant = false) {
  const t = {
    id: g.nextTowerId++,
    x, y,
    hp: TOWER.maxHp * (instant ? 1 : TOWER.buildHpFraction),
    maxHp: TOWER.maxHp,
    built: instant,
    progress: instant ? 1 : 0,
    wLevel: 0, eLevel: 0,
    upgrade: null,
    shotCd: 0, targetId: null, retargetIn: 0,
    flash: 0, smoke: 0,
    unseenHitAt: null,
    field: null,
    resourceScore: resourceScoreAt(g.map, x, y, TOWER.extraction.radius),
  };
  g.towers.push(t);
  if (clearTowerForest(g.map, x, y)) {
    // Forest -> plain changes movement cost and every LOS-derived view. Keep
    // placement validation on the original terrain, then invalidate only after
    // the tower has been accepted and the clearing has actually changed tiles.
    for (const tower of g.towers) tower.field = null;
    g.playerField = null;
    g.playerFieldAt = -99;
    g.playerLaneField = null;
    g.playerLaneFieldAt = -99;
    recomputeVisibility(g, true);
  }
  return t;
}

export function tryBuild(g, x, y) {
  const check = canPlaceAt(g, x, y);
  if (g.paused) return { ...check, ok: false, reason: 'paused', reasons: [...check.reasons, 'paused'] };
  if (Math.hypot(g.player.x - x, g.player.y - y) > BUILD.reach + 1e-6) {
    const reason = 'stand at the site to build';
    return { ...check, ok: false, reason, reasons: [...check.reasons, reason] };
  }
  if (!check.ok) return check;
  g.materials -= check.cost;
  const t = placeTower(g, x, y, false);
  g.selected = t.id;
  say(g, 'Construction started.');
  emitAudioEvent(g, 'constructionStart', t);
  return check;
}

export function occupancyMults(g) {
  return { ...OCCUPANCY, ...g.arch.occupancy };
}

export function constructionRateMult(g, t) {
  return dist(g.player, t) <= PLAYER.presenceRadius ? occupancyMults(g).construction : 1;
}

export function upgradeRateMult(g, t) {
  return g.occupiedTowerId === t.id ? (g.arch.occupancy.construction ?? 1) : 1;
}

export function towerStats(g, t) {
  const occupied = g.occupiedTowerId === t.id;
  const m = occupied ? occupancyMults(g) : { damage: 1, fireRate: 1, extraction: 1, damageTaken: 1 };
  const u = TOWER.upgrade;
  const dmgBoost = g.effects.damage ? DROP.temporary.damage.mult : 1;
  const extBoost = g.effects.extraction ? DROP.temporary.extraction.mult : 1;
  const barrel = hasEquipment(g, 'reinforcedBarrel') ? DROP.equipment.reinforcedBarrel.towerDamage : 1;
  const module = hasEquipment(g, 'targetingModule') ? DROP.equipment.targetingModule.towerRange : 1;
  const chip = hasEquipment(g, 'extractionChip') ? DROP.equipment.extractionChip.extraction : 1;
  return {
    occupied,
    damage: TOWER.weapon.damage * (1 + u.weaponDamagePerLevel * t.wLevel) * m.damage * dmgBoost * barrel,
    fireRate: TOWER.weapon.fireRate * (1 + u.weaponRatePerLevel * t.wLevel) * m.fireRate,
    range: (TOWER.weapon.range + u.weaponRangePerLevel * t.wLevel) * module,
    extractRadius: TOWER.extraction.radius, // D75: upgrades raise the rate, never the footprint
    income: t.resourceScore * TOWER.extraction.baseRate
            * (1 + u.extractRatePerLevel * t.eLevel) * m.extraction * extBoost * chip,
    damageTaken: m.damageTaken,
  };
}

export function upgradeCost(t, which) {
  const level = which === 'weapon' ? t.wLevel : t.eLevel;
  if (level >= TOWER.upgrade.maxLevel) return null;
  return (which === 'weapon' ? TOWER.upgrade.weaponCost : TOWER.upgrade.extractionCost)[level];
}

export function tryUpgrade(g, t, which) {
  if (g.paused) return false;
  if (which !== 'weapon' && which !== 'extraction') return false;
  const cost = upgradeCost(t, which);
  if (cost === null || g.materials < cost || !t.built || t.upgrade) return false;
  g.materials -= cost;
  const level = which === 'weapon' ? t.wLevel : t.eLevel;
  t.upgrade = { which, toLevel: level + 1, progress: 0, duration: TOWER.upgrade.buildTime[level] };
  emitAudioEvent(g, 'upgradeStart', t);
  return true;
}

export function upgradeState(gOrTower, maybeTower) {
  const g = maybeTower ? gOrTower : null;
  const t = maybeTower || gOrTower;
  if (!t.upgrade) return null;
  const { which, toLevel, progress, duration } = t.upgrade;
  const rate = g ? upgradeRateMult(g, t) : 1;
  return {
    which,
    fromLevel: toLevel - 1,
    toLevel,
    progress,
    duration,
    remaining: duration * (1 - progress) / rate,
  };
}

export function repairCostPerHp(g) {
  const rig = hasEquipment(g, 'repairRig') ? DROP.equipment.repairRig.repairCost : 1;
  return TOWER.repair.costPerHp * g.arch.repairCostMult * rig;
}

function hasEquipment(g, key) {
  return g.equipment.includes(key);
}

function towerField(g, t) {
  if (!t.field) t.field = computeField(g.map, [idx(clampTx(t.x), clampTy(t.y))], 'lane');
  return t.field;
}
const clampTx = (x) => clamp(Math.floor(x), 0, MAP.w - 1);
const clampTy = (y) => clamp(Math.floor(y), 0, MAP.h - 1);

function destroyTower(g, t) {
  emitAudioEvent(g, 'towerDestroy', t);
  g.lastTowerDestroyAt = g.time;
  t.upgrade = null;
  g.towers = g.towers.filter((o) => o !== t);
  g.stats.towersLost++;
  if (g.selected === t.id) g.selected = null;
  for (const e of g.enemies) if (e.targetId === t.id) { e.targetId = null; e.sieging = false; e.siegedId = null; }

  for (let i = 0; i < 46; i++) {
    const a = Math.random() * Math.PI * 2;
    const s = 1.5 + Math.random() * 6;
    g.particles.push({ x: t.x, y: t.y, vx: Math.cos(a) * s, vy: Math.sin(a) * s,
      t: 0, life: 0.5 + Math.random() * 0.9, color: i % 3 ? '#8a8f98' : '#ff9d4d', size: 1 + Math.random() * 3 });
  }

  // D6: standing in the wreckage is near-lethal, and lethal if already hurt.
  if (dist(g.player, t) <= TOWER.collapseRadius) {
    const armour = hasEquipment(g, 'armourPlate') ? DROP.equipment.armourPlate.playerDamageTaken : 1;
    const dmg = PLAYER.maxHp * TOWER.collapseDamageFrac * armour;
    g.player.hp -= dmg;
    emitAudioEvent(g, 'playerDamage', g.player);
    floater(g, g.player.x, g.player.y - 1, `CRUSHED -${Math.round(dmg)}`, '#ff4d4d');
    say(g, 'The tower came down on top of you.');
  } else {
    say(g, 'Tower destroyed.');
  }
}

/** D73: the distance at which an enemy touches the occupied tower and breaches. */
export function breachContact(e) {
  return TOWER.radius + e.def.radius + BREACH.contactGap;
}

/**
 * D73: an enemy that reaches the occupied tower hits it once and is gone. It is
 * a leak, not a kill: no kill credit, no drop, no death cue. A lethal breach
 * goes through the ordinary destroyTower path.
 */
function breachTower(g, e, t) {
  e.breached = true;
  g.enemies = g.enemies.filter((o) => o !== e);

  const dmg = (e.def.breachFrac ?? 0) * t.maxHp * towerStats(g, t).damageTaken;
  const before = t.hp / t.maxHp;
  t.hp -= dmg;
  t.flash = 1;
  t.shake = BREACH.shake;
  g.stats.breaches++;
  g.stats.breachesByType[e.type] = (g.stats.breachesByType[e.type] || 0) + 1;
  g.stats.breachDamage += dmg;

  // Impact where the enemy meets the wall, on its own bearing.
  const a = Math.atan2(e.y - t.y, e.x - t.x);
  const ix = t.x + Math.cos(a) * TOWER.radius;
  const iy = t.y + Math.sin(a) * TOWER.radius;
  const heavy = e.type === 'heavy';
  burst(g, ix, iy, e.def.color, heavy ? 22 : 12, heavy ? 7 : 5);
  burst(g, ix, iy, '#ffb347', heavy ? 18 : 9, heavy ? 6 : 4.5);
  burst(g, ix, iy, '#ffffff', heavy ? 8 : 4, 3);
  g.shockwaves.push({ x: ix, y: iy, t: 0, life: BREACH.ring.life,
    radius: heavy ? BREACH.ring.heavyRadius : BREACH.ring.radius, color: heavy ? '#ff7a2e' : '#ffb347' });
  emitAudioEvent(g, heavy ? 'heavyBreach' : 'breach', { x: ix, y: iy, enemyType: e.type });

  // Close breaches share one floater so a cluster reads as one number.
  const merge = g.floaters.find((f) => f.breachTowerId === t.id && g.time - f.breachAt < BREACH.floaterMerge);
  if (merge) {
    merge.breachDamage += dmg;
    merge.breachAt = g.time;
    merge.t = 0;
    merge.text = `BREACH -${Math.round(merge.breachDamage)}`;
  } else {
    // Above the OCCUPIED label, which sits just over the tower's hp bar.
    floater(g, t.x, t.y - 2.9, `BREACH -${Math.round(dmg)}`, '#ff5a3c');
    Object.assign(g.floaters[g.floaters.length - 1], { breachTowerId: t.id, breachAt: g.time, breachDamage: dmg });
  }
  if (!Number.isFinite(t.breachSaidAt) || g.time - t.breachSaidAt >= BREACH.messageInterval) {
    t.breachSaidAt = g.time;
    say(g, `Breach! ${e.def.name || 'An enemy'} got through to tower #${t.id}.`);
  }

  if (before >= TOWER.collapsingAt && t.hp / t.maxHp < TOWER.collapsingAt) {
    say(g, 'A tower is COLLAPSING.');
    emitAudioEvent(g, 'collapsing', t);
  }
  if (t.hp <= 0) destroyTower(g, t);
}

// ---------------------------------------------------------------------------
// Effects / feedback
// ---------------------------------------------------------------------------

function floater(g, x, y, text, color) {
  g.floaters.push({ x, y, text, color, t: 0, life: 1.4 });
}

function burst(g, x, y, color, n = 8, speed = 4) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const s = speed * (0.3 + Math.random());
    g.particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s,
      t: 0, life: 0.25 + Math.random() * 0.4, color, size: 1 + Math.random() * 2 });
  }
}

// ---------------------------------------------------------------------------
// Player
// ---------------------------------------------------------------------------

/**
 * Player tiles/sec at the current position: terrain cost divides it, speed
 * effects/equipment multiply it, and D75 road tiles add PLAYER.roadSpeedMult.
 */
export function playerSpeed(g) {
  const p = g.player;
  const tx = Math.floor(p.x);
  const ty = Math.floor(p.y);
  const speedBoost = (g.effects.speed ? DROP.temporary.speed.mult : 1)
    * (hasEquipment(g, 'boots') ? DROP.equipment.boots.playerSpeed : 1);
  const road = inBounds(tx, ty) && g.map.road[idx(tx, ty)] ? PLAYER.roadSpeedMult : 1;
  const cost = moveCostAt(g.map, tx, ty);
  return PLAYER.speed * speedBoost * road / (Number.isFinite(cost) ? cost : 1);
}

function updatePlayer(g, dt) {
  const p = g.player;
  p.meleeCd = Math.max(0, p.meleeCd - dt);
  p.hurtCd = Math.max(0, p.hurtCd - dt);

  const speed = playerSpeed(g);

  let { mx, my } = g.input;
  const len = Math.hypot(mx, my);
  const wasX = p.x;
  const wasY = p.y;
  if (len > 0) {
    mx /= len; my /= len;
    p.facing = { x: mx, y: my };
    moveWithCollision(g, p, mx * speed * dt, my * speed * dt, PLAYER.radius);
  }
  // Actual achieved velocity, so hunters lead the player's real path rather
  // than their intent (terrain drag and walls are already accounted for).
  p.vx = dt > 0 ? (p.x - wasX) / dt : 0;
  p.vy = dt > 0 ? (p.y - wasY) / dt : 0;

  if (g.phase === 'prep' && p.hp < p.maxHp) p.hp = Math.min(p.maxHp, p.hp + PLAYER.regen * dt);

  // Shelter is earned, not instantaneous. Occupancy (and its bonuses) begins
  // only after continuously remaining inside one finished tower long enough.
  let best = null;
  let bestD = PLAYER.presenceRadius;
  for (const t of g.towers) {
    if (!t.built) continue;
    const d = dist(p, t);
    if (d <= bestD) { bestD = d; best = t; }
  }
  const wasSheltered = g.occupiedTowerId !== null;
  const previousTowerId = g.occupiedTowerId;
  if (!best) {
    g.shelter.towerId = null;
    g.shelter.progress = 0;
    g.occupiedTowerId = null;
  } else {
    if (g.shelter.towerId !== best.id) {
      g.shelter.towerId = best.id;
      g.shelter.progress = 0;
      g.occupiedTowerId = null;
      g.selected = best.id;
    }
    g.shelter.progress = Math.min(g.shelter.required, g.shelter.progress + dt);
    g.occupiedTowerId = g.shelter.progress >= g.shelter.required ? best.id : null;
  }
  if (previousTowerId !== null && g.occupiedTowerId !== previousTowerId) releaseTowerAggro(g, previousTowerId);
  if (wasSheltered && g.occupiedTowerId === null && g.phase === 'combat') emitAudioEvent(g, 'exposed', p);
  if (!wasSheltered && g.occupiedTowerId !== null) emitAudioEvent(g, 'towerEntry', p);

  if (g.input.melee && p.meleeCd <= 0) {
    p.meleeCd = PLAYER.melee.cooldown;
    let hit = false;
    for (const e of g.enemies) {
      const d = dist(p, e);
      if (d > PLAYER.melee.range + e.def.radius) continue;
      const ang = Math.atan2(e.y - p.y, e.x - p.x);
      const face = Math.atan2(p.facing.y, p.facing.x);
      let diff = Math.abs(((ang - face + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
      if (diff > PLAYER.melee.arc / 2) continue;
      damageEnemy(g, e, PLAYER.melee.damage);
      hit = true;
    }
    burst(g, p.x + p.facing.x, p.y + p.facing.y, hit ? '#ffffff' : '#666c78', 6, 3);
  }

}

/**
 * Axis-separated movement so things slide along cliffs instead of sticking.
 * The probe radius is capped well under a tile: a body as wide as its own
 * sprite cannot fit through a one-tile ford that the flow field says is open,
 * and would wedge there permanently.
 */
function moveWithCollision(g, ent, dx, dy, radius) {
  const probe = Math.min(radius, 0.3);
  const tryAxis = (nx, ny) => {
    for (const [ox, oy] of [[probe, 0], [-probe, 0], [0, probe], [0, -probe]]) {
      if (!isPassable(g.map, Math.floor(nx + ox), Math.floor(ny + oy))) return false;
    }
    return true;
  };
  if (tryAxis(ent.x + dx, ent.y)) ent.x += dx;
  if (tryAxis(ent.x, ent.y + dy)) ent.y += dy;
  ent.x = clamp(ent.x, 0.6, MAP.w - 0.6);
  ent.y = clamp(ent.y, 0.6, MAP.h - 0.6);
}

// ---------------------------------------------------------------------------
// Towers: fire and extract
// ---------------------------------------------------------------------------

function updateTowers(g, dt) {
  for (const t of [...g.towers]) {
    t.flash = Math.max(0, t.flash - dt * 3);
    if (t.hp <= 0) { destroyTower(g, t); continue; }

    if (!t.built) {
      const rate = constructionRateMult(g, t) / TOWER.buildTime;
      const before = t.progress;
      t.progress = Math.min(1, t.progress + rate * dt);
      t.hp = Math.min(t.maxHp, t.hp + (t.progress - before) * t.maxHp * (1 - TOWER.buildHpFraction));
      if (t.progress >= 1) {
        t.built = true;
        t.hp = t.maxHp;
        say(g, 'Tower online.');
        emitAudioEvent(g, 'constructionComplete', t);
      }
      continue;
    }

    if (t.upgrade) {
      t.upgrade.progress = Math.min(1, t.upgrade.progress
        + dt * upgradeRateMult(g, t) / t.upgrade.duration);
      if (t.upgrade.progress >= 1) {
        const { which, toLevel } = t.upgrade;
        if (which === 'weapon') t.wLevel = toLevel;
        else t.eLevel = toLevel; // D75: same footprint, same resourceScore; only the rate rises
        t.upgrade = null;
        const short = which === 'weapon' ? 'W' : 'E';
        say(g, `${which === 'weapon' ? 'Weapon' : 'Extraction'} upgrade complete.`);
        floater(g, t.x, t.y - 1.2, `${short}${toLevel} ONLINE`, '#5ecbff');
        emitAudioEvent(g, 'upgrade', t);
      }
    }

    const s = towerStats(g, t);
    const gained = s.income * dt;
    g.materials += gained;
    g.stats.materialsEarned += gained;

    t.shotCd -= dt;
    t.retargetIn -= dt;
    if (t.retargetIn <= 0) {
      t.retargetIn = 0.22;
      t.targetId = acquireTarget(g, t, s.range);
    }
    if (t.shotCd <= 0 && t.targetId !== null) {
      const e = g.enemies.find((o) => o.id === t.targetId);
      if (e && dist(e, t) <= s.range && hasLineOfSight(g.map, t.x, t.y, e.x, e.y)) {
        t.shotCd = 1 / s.fireRate;
        g.tracers.push({ x0: t.x, y0: t.y, x1: e.x, y1: e.y, t: 0,
          life: 0.09, color: s.occupied ? '#ffe680' : '#cfd6e0' });
        emitAudioEvent(g, 'towerFire', { ...t, occupied: s.occupied });
        damageEnemy(g, e, s.damage);
      } else {
        t.targetId = null;
      }
    }

    if (t.hp / t.maxHp < TOWER.collapsingAt) {
      // D47: the COLLAPSING announcement fires once on crossing the threshold;
      // while the tower stays below it, a quieter reminder repeats on a slow
      // cadence - hard to forget, never a continuous full-volume alarm. Runs on
      // simulation time, so pause stops it.
      t.alarmT = (t.alarmT ?? 0) + dt;
      if (t.alarmT >= AUDIO.collapsingReminderInterval) {
        t.alarmT = 0;
        emitAudioEvent(g, 'collapsingReminder', t);
      }
      t.smoke += dt;
      if (t.smoke > 0.08) {
        t.smoke = 0;
        g.particles.push({ x: t.x + (Math.random() - 0.5), y: t.y + (Math.random() - 0.5),
          vx: (Math.random() - 0.5) * 0.6, vy: -0.9 - Math.random(),
          t: 0, life: 1.1, color: '#5d626b', size: 2 + Math.random() * 2 });
      }
    }
  }
}

/** Prefer whatever is chewing on this tower, then the closest thing it can see. */
function acquireTarget(g, t, range) {
  let best = null;
  let bestKey = Infinity;
  for (const e of g.enemies) {
    const d = dist(e, t);
    if (d > range) continue;
    const key = (e.targetId === t.id && e.sieging ? 0 : 1000) + d;
    if (key >= bestKey) continue;
    if (!hasLineOfSight(g.map, t.x, t.y, e.x, e.y)) continue;
    bestKey = key;
    best = e;
  }
  return best ? best.id : null;
}

// ---------------------------------------------------------------------------
// Enemies
// ---------------------------------------------------------------------------

function spawnEnemy(g, typeKey, side, pointSeed) {
  const def = ENEMIES[typeKey];
  const points = side === 'west' ? g.map.spawns.west : g.map.spawns.east;
  const p = points[(pointSeed ?? Math.floor(Math.random() * points.length)) % points.length];
  const hpScale = 1 + WAVE.hpScalePerWave * (g.wave - 1);
  const e = {
    id: g.nextEnemyId++, type: typeKey, def, side,
    x: p.x + 0.5, y: p.y + 0.5,
    hp: def.hp * hpScale, maxHp: def.hp * hpScale,
    targetId: null, sieging: false, siegeAngle: 0,
    retargetIn: AGGRO.retargetMin + Math.random() * (AGGRO.retargetMax - AGGRO.retargetMin),
    hitCd: 0, flash: 0, stuckOrigin: 'spawn',
  };
  retarget(g, e);
  const target = enemyTargetField(g, e);
  const spawn = validSpawnPosition(g, e, p, target?.field);
  if (!spawn) return null;
  e.x = spawn.x;
  e.y = spawn.y;
  g.enemies.push(e);
  return e;
}

/** Keep a spawn in its authored mouth column and on terrain connected to its target. */
function validSpawnPosition(g, e, mouth, field) {
  const authored = e.side === 'west' ? g.map.spawns.west : g.map.spawns.east;
  for (const candidate of [mouth, ...authored.filter((p) => p !== mouth)]) {
    const ti = idx(candidate.x, candidate.y);
    if (!isPassable(g.map, candidate.x, candidate.y) || !Number.isFinite(field?.[ti])) continue;
    // Keep every collision probe inside the validated mouth tile. A centre can
    // be on valid terrain while a +/-0.3 probe overlaps the cliff next to it.
    const jitter = 0.18;
    return {
      x: candidate.x + 0.5 + (Math.random() - 0.5) * jitter * 2,
      y: candidate.y + 0.5 + (Math.random() - 0.5) * jitter * 2,
    };
  }
  return null;
}

export function spawnGroupAt(g, x, y, typeKey, count) {
  for (let i = 0; i < count; i++) {
    const def = ENEMIES[typeKey];
    g.enemies.push({
      id: g.nextEnemyId++, type: typeKey, def, side: 'debug',
      x: x + (Math.random() - 0.5) * 3, y: y + (Math.random() - 0.5) * 3,
      hp: def.hp, maxHp: def.hp, targetId: null, sieging: false, siegeAngle: 0,
      retargetIn: Math.random() * 2, hitCd: 0, flash: 0, stuckOrigin: 'spawn',
    });
  }
}

/** D5: an enemy that has physically attacked a tower stays committed to it. */
function committedTo(e, t) {
  return !!t && (e.sieging || e.siegedId === t.id);
}

/**
 * D53: a tower target is held only while the player occupies it or this enemy
 * has already begun sieging it. An unoccupied tower is never a strategic target.
 */
function staleTowerTarget(g, e, t) {
  return !!t && t.id !== g.occupiedTowerId && !committedTo(e, t);
}

/**
 * D5/D53: an enemy already sieging keeps its target until that tower dies.
 * Everyone else takes the one strategic target the current state offers - the
 * occupied tower, or the exposed player - on a personal staggered timer, so
 * aggro rolls over gradually rather than the map turning as one. Unoccupied
 * towers, including one the player has just left, are not candidates.
 */
function retarget(g, e) {
  const currentTower = g.towers.find((t) => t.id === e.targetId) || null;
  if (committedTo(e, currentTower)) return;
  const occupied = g.towers.find((t) => t.id === g.occupiedTowerId) || null;
  const best = occupied ? occupied.id : PLAYER_TARGET_ID;
  if (best !== e.targetId) { e.targetId = best; e.sieging = false; e.siegedId = null; }
}

/**
 * D53: the player has just left a tower. Enemies still merely heading for it
 * lose it as a target soon - each on a short random delay, so they peel away
 * rather than turn in unison - while enemies already sieging it stay.
 */
function releaseTowerAggro(g, towerId) {
  for (const e of g.enemies) {
    if (e.targetId !== towerId || committedTo(e, g.towers.find((t) => t.id === towerId))) continue;
    e.retargetIn = Math.min(e.retargetIn, Math.random() * AGGRO.releaseDelayMax);
  }
}

/** D53: near hunters close in directly; distant ones travel toward the player by road. */
export function isHunting(g, e) {
  return e.targetId === PLAYER_TARGET_ID && g.occupiedTowerId === null
    && dist(e, g.player) <= AGGRO.directPursuitRange;
}

function playerLaneField(g) {
  if (g.time - g.playerLaneFieldAt > 0.5 || !g.playerLaneField) {
    g.playerLaneFieldAt = g.time;
    g.playerLaneField = computeField(g.map, [idx(clampTx(g.player.x), clampTy(g.player.y))], 'lane');
  }
  return g.playerLaneField;
}

function playerField(g) {
  if (g.time - g.playerFieldAt > 0.5) {
    g.playerFieldAt = g.time;
    g.playerField = computeField(g.map, [idx(clampTx(g.player.x), clampTy(g.player.y))], 'direct');
  }
  return g.playerField;
}

function fieldValueAt(field, x, y) {
  const tx = Math.floor(x);
  const ty = Math.floor(y);
  return field && inBounds(tx, ty) ? field[idx(tx, ty)] : Infinity;
}

function enemyTargetField(g, e, resolved = null, directPursuit = null) {
  resolved ||= g.towers.find((t) => t.id === e.targetId) || null;
  if (resolved) return { field: towerField(g, resolved), key: `tower:${resolved.id}` };
  if (e.targetId !== PLAYER_TARGET_ID || g.occupiedTowerId !== null) return null;
  const direct = directPursuit ?? dist(e, g.player) <= AGGRO.directPursuitRange;
  return direct
    ? { field: playerField(g), key: 'player:direct' }
    : { field: playerLaneField(g), key: 'player:lane' };
}

function safeNormTo(g, from, to, field) {
  return Number.isFinite(fieldValueAt(field, from.x, from.y))
    && hasClearWalk(g.map, from.x, from.y, to.x, to.y) ? normTo(from, to) : null;
}

function updateEnemies(g, dt) {
  const p = g.player;

  for (const e of [...g.enemies]) {
    if (e.breached) continue;
    e.flash = Math.max(0, e.flash - dt * 4);
    e.hitCd = Math.max(0, e.hitCd - dt);
    e.retargetIn -= dt;
    if (e.retargetIn <= 0) {
      e.retargetIn = AGGRO.retargetMin + Math.random() * (AGGRO.retargetMax - AGGRO.retargetMin);
      retarget(g, e);
    }

    if (e.targetId !== null && !g.towers.some((t) => t.id === e.targetId)) {
      if (e.targetId !== PLAYER_TARGET_ID || g.occupiedTowerId !== null) {
        e.targetId = null;
        e.sieging = false;
      }
    }
    if (e.targetId === null) retarget(g, e);

    // Opportunistic swipe at a player who wanders into reach, wherever it is headed.
    const dPlayer = dist(e, p);
    if (g.occupiedTowerId === null && dPlayer <= ENEMY.playerAttackRange + e.def.radius
        && e.hitCd <= 0 && p.hurtCd <= 0) {
      e.hitCd = ENEMY.playerHitCooldown;
      const armour = hasEquipment(g, 'armourPlate') ? DROP.equipment.armourPlate.playerDamageTaken : 1;
      const playerDamage = e.def.playerHit * armour;
      p.hp -= playerDamage;
      emitAudioEvent(g, 'playerDamage', p);
      p.hurtCd = PLAYER.invulnAfterHit;
      floater(g, p.x, p.y - 0.8, `-${Math.round(playerDamage)}`, '#ff6b6b');
      burst(g, p.x, p.y, '#ff6b6b', 5, 2.5);
    }

    let resolved = g.towers.find((t) => t.id === e.targetId) || null;
    // D53: an enemy reaching a tower it no longer has reason to attack re-reads
    // the situation instead of starting a siege there.
    if (staleTowerTarget(g, e, resolved)
        && dist(e, resolved) <= TOWER.radius + ENEMY.attackRange + e.def.radius) {
      retarget(g, e);
      resolved = g.towers.find((t) => t.id === e.targetId) || null;
    }
    const huntingPlayer = e.targetId === PLAYER_TARGET_ID && g.occupiedTowerId === null;
    const directPursuit = huntingPlayer && dPlayer <= AGGRO.directPursuitRange;
    const playerGoalKey = `${clampTx(p.x)},${clampTy(p.y)}`;
    let aim = null;
    let motionField = null;
    let motionFieldKey = null;
    let reach = 0;

    if (resolved && resolved.id === g.occupiedTowerId) {
      // D73: the occupied tower is the endpoint. Keep closing (and taking fire)
      // until actual contact, then breach once. It is never sieged over time;
      // siegedId is kept so a sticky besieger stays committed if the player leaves.
      e.sieging = false;
      reach = breachContact(e);
      if (dist(e, resolved) <= reach) { breachTower(g, e, resolved); continue; }
      motionField = towerField(g, resolved);
      motionFieldKey = `tower:${resolved.id}`;
      aim = steer(g.map, motionField, e.x, e.y) || safeNormTo(g, e, resolved, motionField);
    } else if (resolved) {
      reach = TOWER.radius + ENEMY.attackRange + e.def.radius;
      const d = dist(e, resolved);
      if (d <= reach) {
        e.siegedId = resolved.id;
        if (!e.sieging) {
          e.sieging = true;
          // §10: spread around the perimeter rather than piling on one point.
          e.siegeAngle = Math.atan2(e.y - resolved.y, e.x - resolved.x) + (Math.random() - 0.5) * 0.7;
        }
        const s = towerStats(g, resolved);
        const dealt = e.def.towerDps * dt * s.damageTaken;
        const before = resolved.hp / resolved.maxHp;
        resolved.hp -= dealt;
        emitAudioEvent(g, e.type === 'heavy' ? 'heavyTowerHit' : 'towerHit', { ...resolved, enemyType: e.type });
        if (!isPointVisible(g, e.x, e.y)) {
          const previousHitAt = resolved.unseenHitAt;
          if (!Number.isFinite(previousHitAt) || g.time - previousHitAt >= 5) {
            say(g, `Tower #${resolved.id} UNDER ATTACK.`);
          }
          resolved.unseenHitAt = g.time;
          emitAudioEvent(g, 'towerUnderAttack', resolved);
        }
        resolved.flash = 1;
        if (before >= TOWER.collapsingAt && resolved.hp / resolved.maxHp < TOWER.collapsingAt) {
          say(g, 'A tower is COLLAPSING.');
          emitAudioEvent(g, 'collapsing', resolved);
        }
        if (resolved.hp <= 0) destroyTower(g, resolved);

        // Settle onto the perimeter slot instead of walking into the wall.
        const want = { x: resolved.x + Math.cos(e.siegeAngle) * (reach - 0.35),
                       y: resolved.y + Math.sin(e.siegeAngle) * (reach - 0.35) };
        aim = { x: want.x - e.x, y: want.y - e.y };
        const l = Math.hypot(aim.x, aim.y);
        aim = l > 0.08 ? { x: aim.x / l, y: aim.y / l } : null;
      } else {
        e.sieging = false;
        motionField = towerField(g, resolved);
        motionFieldKey = `tower:${resolved.id}`;
        aim = steer(g.map, motionField, e.x, e.y) || safeNormTo(g, e, resolved, motionField);
      }
    } else if (directPursuit) {
      motionField = playerField(g);
      motionFieldKey = `player:direct:${playerGoalKey}`;
      aim = interceptAim(g, e, p) || steer(g.map, motionField, e.x, e.y)
        || safeNormTo(g, e, p, motionField);
    } else if (huntingPlayer) {
      motionField = playerLaneField(g);
      motionFieldKey = `player:lane:${playerGoalKey}`;
      aim = steer(g.map, motionField, e.x, e.y);
      if (!aim) {
        motionField = playerField(g);
        motionFieldKey = `player:direct:${playerGoalKey}`;
        aim = steer(g.map, motionField, e.x, e.y) || safeNormTo(g, e, p, motionField);
      }
    }

    // Separation keeps the crowd from collapsing into one dot.
    let sx = 0;
    let sy = 0;
    for (const o of g.enemies) {
      if (o === e) continue;
      const dx = e.x - o.x;
      const dy = e.y - o.y;
      const d2 = dx * dx + dy * dy;
      const rad = e.def.radius + o.def.radius + ENEMY.separation;
      if (d2 > rad * rad || d2 < 1e-6) continue;
      const d = Math.sqrt(d2);
      sx += (dx / d) * (1 - d / rad);
      sy += (dy / d) * (1 - d / rad);
    }

    const terrainCost = moveCostAt(g.map, Math.floor(e.x), Math.floor(e.y));
    const speed = e.def.speed / Math.max(1, Number.isFinite(terrainCost) ? terrainCost : 1);
    const vx = (aim ? aim.x : 0) + sx * 1.6;
    const vy = (aim ? aim.y : 0) + sy * 1.6;
    const l = Math.hypot(vx, vy);
    const px = e.x;
    const py = e.y;
    if (l > 0.01) moveWithCollision(g, e, (vx / l) * speed * dt, (vy / l) * speed * dt, e.def.radius);
    if (Math.hypot(e.x - px, e.y - py) > 1e-6) {
      const separationStrength = Math.hypot(sx, sy) * 1.6;
      e.stuckOrigin = separationStrength > (aim ? 1 : 0) ? 'separation push'
        : separationStrength > 0.15 ? 'steering + separation' : 'steering';
    }

    // Last-resort unstick. An enemy that cannot make progress and is not
    // besieging anything would otherwise hold the wave open forever.
    if (!e.sieging && Math.hypot(e.x - px, e.y - py) < speed * dt * 0.2) {
      e.stuck = (e.stuck || 0) + dt;
      if (e.stuck > 1.5 && (resolved || huntingPlayer)) {
        const field = resolved ? towerField(g, resolved) : directPursuit ? playerField(g) : playerLaneField(g);
        const nudge = bestNeighbourTile(g, field, e.x, e.y);
        recordStuckEpisode(g, e, field, 'nudge', !!nudge);
        if (nudge) { e.x = nudge.x; e.y = nudge.y; }
        e.stuck = 0;
      }
    } else {
      e.stuck = 0;
    }


    const inTowerReach = resolved && dist(e, resolved) <= reach;
    const inPlayerReach = huntingPlayer && dPlayer <= ENEMY.playerAttackRange + e.def.radius;
    if (trackEnemyProgress(g, e, motionField, motionFieldKey,
      !!motionField && !e.sieging && !inTowerReach && !inPlayerReach)) continue;
  }
}

/** Centre of the adjacent walkable tile closest to the target, for unsticking. */
function bestNeighbourTile(g, field, x, y) {
  const tx = Math.floor(x);
  const ty = Math.floor(y);
  let best = null;
  let bestD = Infinity;
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      const nx = tx + ox;
      const ny = ty + oy;
      if (!inBounds(nx, ny) || !isPassable(g.map, nx, ny)) continue;
      const d = field[idx(nx, ny)];
      if (d < bestD) { bestD = d; best = { x: nx + 0.5, y: ny + 0.5 }; }
    }
  }
  return Number.isFinite(bestD) ? best : null;
}

function enemyFitsTile(g, e, tx, ty) {
  if (!inBounds(tx, ty) || !isPassable(g.map, tx, ty)) return false;
  if (e.def.radius <= 0.5) return true;
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      if (!inBounds(tx + ox, ty + oy) || !isPassable(g.map, tx + ox, ty + oy)) return false;
    }
  }
  return true;
}

/** Breadth-first recovery, with road and lower-field tie breaks at equal range. */
function recoveryTile(g, e, field, radius) {
  const sx = clampTx(e.x);
  const sy = clampTy(e.y);
  const startValue = fieldValueAt(field, e.x, e.y);
  const seen = new Uint8Array(MAP.w * MAP.h);
  const queue = [{ x: sx, y: sy, d: 0 }];
  seen[idx(sx, sy)] = 1;
  let head = 0;
  let best = null;
  while (head < queue.length) {
    const cur = queue[head++];
    if (cur.d > radius) break;
    if (cur.d > 0) {
      const value = field[idx(cur.x, cur.y)];
      if (Number.isFinite(value)
          && (!Number.isFinite(startValue) || value <= startValue + 1e-6)
          && enemyFitsTile(g, e, cur.x, cur.y)) {
        const candidate = { x: cur.x + 0.5, y: cur.y + 0.5, d: cur.d,
          road: !!g.map.road[idx(cur.x, cur.y)], value };
        candidate.strict = !Number.isFinite(startValue) || candidate.value < startValue - 1e-6;
        if (!best || candidate.d < best.d
            || (candidate.d === best.d && candidate.strict && !best.strict)
            || (candidate.d === best.d && candidate.strict === best.strict && candidate.road && !best.road)
            || (candidate.d === best.d && candidate.strict === best.strict
              && candidate.road === best.road && candidate.value < best.value)) {
          best = candidate;
        }
      }
    }
    if (best && cur.d >= best.d) continue;
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        if (!ox && !oy) continue;
        const nx = cur.x + ox;
        const ny = cur.y + oy;
        if (!inBounds(nx, ny)) continue;
        const ni = idx(nx, ny);
        if (seen[ni]) continue;
        seen[ni] = 1;
        queue.push({ x: nx, y: ny, d: cur.d + 1 });
      }
    }
  }
  return best;
}

function clearProgressEpisode(e) {
  e.fieldProgress = null;
  e.stuckEpisodeAt = null;
  e.stuckRecoveries = 0;
}

function recordStuckEpisode(g, e, field, stage, recovered) {
  const tx = clampTx(e.x);
  const ty = clampTy(e.y);
  const neighbours = [];
  for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
    if (!ox && !oy) continue;
    const nx = tx + ox; const ny = ty + oy;
    if (!inBounds(nx, ny)) continue;
    const value = field?.[idx(nx, ny)];
    neighbours.push({ dx: ox, dy: oy, kind: kindAt(g.map, nx, ny), finite: Number.isFinite(value) });
  }
  g.debug.stuckEpisodes ||= [];
  if (g.debug.stuckEpisodes.length < 10000) g.debug.stuckEpisodes.push({
    stage, time: g.time, enemyId: e.id, x: e.x, y: e.y, tileKind: kindAt(g.map, tx, ty), neighbours,
    enemyType: e.type, radius: e.def.radius, target: e.targetId,
    fieldFinite: Number.isFinite(fieldValueAt(field, e.x, e.y)),
    source: e.stuckOrigin || 'steering', recovered,
  });
}

/** Returns true when the enemy was silently removed. */
function trackEnemyProgress(g, e, field, key, candidate) {
  if (!candidate) {
    clearProgressEpisode(e);
    return false;
  }
  const value = fieldValueAt(field, e.x, e.y);
  const targetKey = key?.startsWith('player:') ? 'player' : key;
  let progress = e.fieldProgress;
  if (!progress || progress.targetKey !== targetKey) {
    e.fieldProgress = { key, targetKey, best: value, improvedAt: g.time, observed: false };
    e.stuckEpisodeAt = null;
    e.stuckRecoveries = 0;
    return false;
  }
  if (progress.key !== key) {
    e.fieldProgress = { key, targetKey, best: value, improvedAt: g.time, observed: false };
    // A moving player changes the goal tile, and lane/direct switches replace
    // the metric. Values from those fields are not comparable, so they begin a
    // fresh episode rather than aging an enemy toward a false recovery/despawn.
    e.stuckEpisodeAt = null;
    e.stuckRecoveries = 0;
    return false;
  }
  const improved = (!Number.isFinite(progress.best) && Number.isFinite(value))
    || (Number.isFinite(value) && progress.best - value >= STUCK.minProgress);
  if (improved) {
    progress.best = value;
    progress.improvedAt = g.time;
    progress.observed = false;
    e.stuckEpisodeAt = null;
    e.stuckRecoveries = 0;
    return false;
  }
  if (!progress.observed && g.time - progress.improvedAt >= 2) {
    recordStuckEpisode(g, e, field, 'no-progress-2s', false);
    progress.observed = true;
  }
  if (g.time - progress.improvedAt < STUCK.detectAfter) return false;

  g.stats.stuckDetections = (g.stats.stuckDetections || 0) + 1;
  e.stuckEpisodeAt ??= g.time;
  e.stuckRecoveries ||= 0;
  const expired = g.time - e.stuckEpisodeAt >= STUCK.despawnAfter;
  if (expired || e.stuckRecoveries >= STUCK.maxRecoveries) {
    recordStuckEpisode(g, e, field, 'despawn', false);
    g.enemies = g.enemies.filter((o) => o !== e);
    g.stats.stuckDespawns = (g.stats.stuckDespawns || 0) + 1;
    return true;
  }

  const tile = recoveryTile(g, e, field, STUCK.searchRadius)
    || recoveryTile(g, e, field, Math.max(MAP.w, MAP.h));
  progress.improvedAt = g.time;
  progress.observed = false;
  if (!tile) {
    recordStuckEpisode(g, e, field, 'failed-recovery', false);
    return false;
  }
  recordStuckEpisode(g, e, field, 'recovery', true);
  e.x = tile.x;
  e.y = tile.y;
  e.stuck = 0;
  e.stuckOrigin = null;
  e.stuckRecoveries++;
  g.stats.stuckRecoveries = (g.stats.stuckRecoveries || 0) + 1;
  retarget(g, e);
  e.fieldProgress = {
    key, targetKey, best: fieldValueAt(field, e.x, e.y), improvedAt: g.time, observed: false,
  };
  return false;
}

/**
 * D31: close-range interception. A hunter with a clear run at the player aims at
 * where they will be, not where they are, so a player running a circle gets cut
 * off instead of towed around behind the pack. Falls back to the flow field
 * whenever the direct line is blocked, so this never walks anyone into a cliff.
 */
function interceptAim(g, e, p) {
  const d = dist(e, p);
  if (d > ENEMY.pursuitLeadRange) return null;
  if (!hasClearWalk(g.map, e.x, e.y, p.x, p.y)) return null;
  const lead = Math.min(ENEMY.pursuitLeadTime, d / Math.max(0.5, e.def.speed));
  const ax = p.x + (p.vx || 0) * lead - e.x;
  const ay = p.y + (p.vy || 0) * lead - e.y;
  const l = Math.hypot(ax, ay);
  return l > 0.05 ? { x: ax / l, y: ay / l } : null;
}

function normTo(from, to) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const l = Math.hypot(dx, dy) || 1;
  return { x: dx / l, y: dy / l };
}

function damageEnemy(g, e, amount) {
  e.hp -= amount;
  e.flash = 1;
  burst(g, e.x, e.y, e.def.color, 3, 2);
  if (e.hp > 0) { emitAudioEvent(g, 'enemyHit', e); return; }
  g.enemies = g.enemies.filter((o) => o !== e);
  g.stats.kills++;
  emitAudioEvent(g, 'enemyDeath', e);
  burst(g, e.x, e.y, e.def.color, 12, 5);
  if (Math.random() < DROP.chance) spawnDrop(g, e.x, e.y);
}

// ---------------------------------------------------------------------------
// Drops
// ---------------------------------------------------------------------------

export function grantEquipment(g, key) {
  if (!DROP.equipment[key] || hasEquipment(g, key) || g.equipment.length >= DROP.equipmentCap) return false;
  g.equipment.push(key);
  return true;
}

export function equipmentState(g) {
  return {
    count: g.equipment.length,
    cap: DROP.equipmentCap,
    held: g.equipment.map((key) => ({ key, name: DROP.equipment[key].name })),
  };
}

export function depositRichness(map, deposit) {
  const d = typeof deposit === 'number' ? map.deposits[deposit] : deposit;
  if (!d) return null;
  const tier = richnessTierForRate(d.income);
  return { tier: tier.key, name: tier.name, bars: tier.bars, income: d.income };
}

export function spawnDrop(g, x, y, forcedCategory = null, forcedKey = null) {
  const unavailable = g.equipment.length >= DROP.equipmentCap;
  const weights = DROP.categoryWeights;
  let category = forcedCategory;
  if (!category) {
    const total = weights.temporary + weights.materials + (unavailable ? 0 : weights.equipment);
    let roll = Math.random() * total;
    category = (roll -= weights.temporary) < 0 ? 'temporary'
      : (roll -= weights.materials) < 0 ? 'materials' : 'equipment';
  }

  if (category === 'equipment') {
    const dropped = new Set(g.drops.filter((d) => d.category === 'equipment').map((d) => d.key));
    const keys = Object.keys(DROP.equipment).filter((key) => !hasEquipment(g, key) && !dropped.has(key));
    if (!keys.length || unavailable) category = 'temporary';
    else {
      const key = forcedKey && keys.includes(forcedKey) ? forcedKey : keys[Math.floor(Math.random() * keys.length)];
      g.drops.push({ category, key, def: DROP.equipment[key], x, y, t: 0 });
      emitAudioEvent(g, 'dropSpawn', { x, y, category, key });
      return;
    }
  }
  if (category === 'materials') {
    const def = DROP.materialsCache;
    const amount = Math.round(def.min + Math.random() * (def.max - def.min));
    g.drops.push({ category, key: 'materials', def, amount, x, y, t: 0 });
    emitAudioEvent(g, 'dropSpawn', { x, y, category, key: 'materials' });
    return;
  }
  const keys = Object.keys(DROP.temporary);
  const key = forcedKey && DROP.temporary[forcedKey] ? forcedKey : keys[Math.floor(Math.random() * keys.length)];
  g.drops.push({ category: 'temporary', key, def: DROP.temporary[key], x, y, t: 0 });
  emitAudioEvent(g, 'dropSpawn', { x, y, category: 'temporary', key });
}

export function collectDrop(g, d) {
  if (g.paused) return false;
  if (d.category === 'equipment') {
    if (!grantEquipment(g, d.key)) return false;
    floater(g, g.player.x, g.player.y - 1, d.def.name, d.def.color);
    say(g, `${d.def.name} equipped for this run.`);
  } else if (d.category === 'materials') {
    g.materials += d.amount;
    g.stats.materialsEarned += d.amount;
    floater(g, g.player.x, g.player.y - 1, `+${d.amount} Materials`, d.def.color);
  } else if (d.def.instant) {
    // Patches up the tower you are holding AND you. After a collapse this is
    // the thing worth sprinting into the open for.
    const t = g.towers.find((o) => o.id === (g.occupiedTowerId ?? g.selected));
    if (t) {
      t.hp = Math.min(t.maxHp, t.hp + t.maxHp * d.def.healFrac);
      floater(g, t.x, t.y - 1.5, 'REPAIRED', d.def.color);
    }
    const heal = Math.min(g.player.maxHp - g.player.hp, d.def.playerHeal);
    if (heal > 0) {
      g.player.hp += heal;
      floater(g, g.player.x, g.player.y - 1, `+${Math.round(heal)} HP`, d.def.color);
    }
  } else {
    g.effects[d.key] = DROP.effectDuration;
    floater(g, g.player.x, g.player.y - 1, d.def.name, d.def.color);
  }
  emitAudioEvent(g, 'dropCollect', { ...d, x: g.player.x, y: g.player.y });
  return true;
}

function updateDrops(g, dt) {
  for (const d of [...g.drops]) {
    d.t += dt;
    if (d.t >= DROP.lifetime) { g.drops = g.drops.filter((o) => o !== d); continue; }
    if (dist(d, g.player) <= DROP.pickupRadius) {
      if (collectDrop(g, d)) g.drops = g.drops.filter((o) => o !== d);
    }
  }
  for (const k of Object.keys(g.effects)) {
    g.effects[k] -= dt;
    if (g.effects[k] <= 0) delete g.effects[k];
  }
}

// ---------------------------------------------------------------------------
// Waves
// ---------------------------------------------------------------------------

function rollWave(g) {
  let budget = WAVE.budgetBase + WAVE.budgetPerWave * (g.wave - 1);
  const available = Object.entries(ENEMIES).filter(([, d]) => g.wave >= d.unlockWave);
  const sides = g.wave >= WAVE.bothSidesFromWave && Math.random() < 0.55
    ? ['west', 'east']
    : [Math.random() < 0.5 ? 'west' : 'east'];

  const list = [];
  let guard = 0;
  while (budget > 0 && guard++ < 600) {
    const affordable = available.filter(([, d]) => d.cost <= budget);
    if (!affordable.length) break;
    // Cheap units make the crowd; later waves lean harder on Heavies.
    const weights = affordable.map(([key, d]) =>
      (1 / d.cost) * (key === 'heavy' ? 1 + WAVE.heavyBiasPerWave * Math.max(0, g.wave - d.unlockWave) : 1));
    const total = weights.reduce((a, b) => a + b, 0);
    let roll = Math.random() * total;
    let picked = affordable[0][0];
    for (let i = 0; i < affordable.length; i++) {
      roll -= weights[i];
      if (roll <= 0) { picked = affordable[i][0]; break; }
    }
    budget -= ENEMIES[picked].cost;
    list.push({ type: picked });
  }

  // Enemies arrive in clusters, not as an even trickle. A drip gets picked off
  // one at a time by any single tower; a cluster is actual pressure, and it is
  // far easier to read on screen.
  const window = WAVE.spawnWindowMin + Math.random() * (WAVE.spawnWindowMax - WAVE.spawnWindowMin);
  const clusterCount = Math.min(WAVE.maxClusters, 2 + Math.floor(g.wave / 2));
  const clusters = Array.from({ length: clusterCount }, (_, k) => ({
    at: (window * k) / clusterCount,
    side: sides[Math.floor(Math.random() * sides.length)],
    point: Math.floor(Math.random() * 1000),
  }));

  g.spawnSides = sides;
  g.pendingSpawns = list
    .map((s) => {
      const c = clusters[Math.floor(Math.random() * clusterCount)];
      return { type: s.type, side: c.side, point: c.point, at: c.at + Math.random() * WAVE.clusterSpread };
    })
    .sort((a, b) => a.at - b.at);
  g.waveWindow = window;
}

function updateWaves(g, dt) {
  g.phaseLeft -= dt;

  if (g.phase === 'prep' && g.phaseLeft <= 0) {
    rollWave(g);
    g.phase = 'warning';
    g.phaseLeft = WAVE.warning;
    const where = g.spawnSides.map((s) => s.toUpperCase()).join(' and ');
    say(g, `Wave ${g.wave} incoming from the ${where}.`);
    emitAudioEvent(g, 'waveWarning', g.player);
    return;
  }

  if (g.phase === 'warning' && g.phaseLeft <= 0) {
    g.phase = 'combat';
    g.phaseLeft = 0;
    g.combatT = 0;
    emitAudioEvent(g, g.wave >= WAVE.totalToSurvive ? 'finalWave' : 'waveStart', g.player);
    return;
  }

  if (g.phase === 'combat') {
    g.combatT += dt;
    if (!g.debug.spawnPaused) {
      while (g.pendingSpawns.length && g.pendingSpawns[0].at <= g.combatT) {
        const s = g.pendingSpawns.shift();
        spawnEnemy(g, s.type, s.side, s.point);
      }
    }
    if (!g.pendingSpawns.length && !g.enemies.length) {
      g.phase = 'aftermath';
      g.phaseLeft = WAVE.aftermath;
      g.stats.wavesCleared++;
      say(g, `Wave ${g.wave} cleared.`);
      if (g.wave >= WAVE.totalToSurvive) {
        g.status = 'won';
        emitAudioEvent(g, 'victory', g.player);
        say(g, 'The final wave broke. Run complete.');
      }
    }
    return;
  }

  if (g.phase === 'aftermath' && g.phaseLeft <= 0) {
    g.wave++;
    g.phase = 'prep';
    g.phaseLeft = WAVE.prep;
  }
}

export function forceNextWave(g) {
  if (g.phase === 'combat') return;
  g.phase = 'prep';
  g.phaseLeft = 0;
}

/** Stable semantic state for the acceptance harness and HUD. */
export function dangerState(g) {
  const hunters = g.enemies.filter((e) => isHunting(g, e));
  return {
    sheltered: g.occupiedTowerId !== null,
    shelterTowerId: g.shelter.towerId,
    shelterProgress: g.shelter.required ? g.shelter.progress / g.shelter.required : 0,
    hunters: hunters.length,
    visibleHunters: hunters.filter((e) => isPointVisible(g, e.x, e.y)).length,
  };
}

export function towerAlarmState(g) {
  return g.towers.map((t) => ({
    id: t.id,
    active: Number.isFinite(t.unseenHitAt) && g.time - t.unseenHitAt < 1.5,
  }));
}

export function stuckState(g) {
  return {
    detections: g.stats.stuckDetections || 0,
    recoveries: g.stats.stuckRecoveries || 0,
    despawns: g.stats.stuckDespawns || 0,
  };
}

export function endState(g) {
  return { status: g.status, lossCause: g.lossCause || null };
}

// ---------------------------------------------------------------------------
// Repair
// ---------------------------------------------------------------------------

function updateRepair(g, dt) {
  if (!g.input.repair) return;
  const t = g.towers.find((o) => o.id === (g.occupiedTowerId ?? g.selected));
  if (!t || t.hp >= t.maxHp || !t.built) return;

  const occ = occupancyMults(g);
  const rig = hasEquipment(g, 'repairRig') ? DROP.equipment.repairRig.repairSpeed : 1;
  const rate = TOWER.repair.hpPerSec * (g.occupiedTowerId === t.id ? occ.repair : 1) * rig;
  const perHp = repairCostPerHp(g);
  let hp = rate * dt;
  const cost = hp * perHp;
  if (cost > g.materials) hp = g.materials / perHp;
  hp = Math.min(hp, t.maxHp - t.hp);
  if (hp <= 0) return;
  t.hp += hp;
  g.materials -= hp * perHp;
  if (Math.random() < 0.25) burst(g, t.x, t.y - 0.5, '#5ecbff', 2, 1.5);
  emitAudioEvent(g, 'repair', t);
}

// ---------------------------------------------------------------------------
// Frame
// ---------------------------------------------------------------------------

function updateFx(g, dt) {
  for (const a of [g.tracers, g.particles, g.floaters, g.shockwaves]) {
    for (let i = a.length - 1; i >= 0; i--) {
      a[i].t += dt;
      if (a[i].t >= a[i].life) a.splice(i, 1);
    }
  }
  for (const p of g.particles) {
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.vx *= 1 - 2.2 * dt;
    p.vy *= 1 - 2.2 * dt;
  }
  for (const f of g.floaters) f.y -= 1.1 * dt;
  for (const t of g.towers) if (t.shake > 0) t.shake = Math.max(0, t.shake - dt);
}

export function setPaused(g, paused = !g.paused) {
  if (g.status !== 'playing') return g.paused;
  g.paused = !!paused;
  g.input = { mx: 0, my: 0, melee: false, repair: false };
  return g.paused;
}

export function pauseState(g) {
  return { paused: !!g.paused };
}

function resolveEndState(g) {
  if (g.status !== 'playing') return;
  if (g.player.hp <= 0) {
    g.status = 'lost';
    g.lossCause = 'died';
    emitAudioEvent(g, 'playerDeath', g.player);
    say(g, 'You died. Run over.');
  } else if (g.towers.length === 0) {
    g.status = 'lost';
    g.lossCause = 'towers';
    say(g, 'All towers destroyed. Position lost.');
    if (g.lastTowerDestroyAt !== g.time) emitAudioEvent(g, 'towerDestroy', g.player);
  }
}

export function update(g, dt, { ignorePause = false } = {}) {
  if (g.paused && !ignorePause) return;
  if (g.status !== 'playing') { updateFx(g, dt); return; }
  g.time += dt;
  updateWaves(g, dt);
  updatePlayer(g, dt);
  updateRepair(g, dt);
  updateTowers(g, dt);
  recomputeVisibility(g);
  updateEnemies(g, dt);
  updateDrops(g, dt);
  updateFx(g, dt);
  resolveEndState(g);
}
