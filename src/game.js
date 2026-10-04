// Simulation. Rendering and DOM live elsewhere; nothing here touches the canvas.

import {
  MAP, T, PLAYER, TOWER, OCCUPANCY, ARCHETYPES, ENEMIES, ENEMY,
  WAVE, START_RESOURCES, BUILDINGS, KEEP, WALL_PATH, DROP, ELEVATION_NAMES, AUDIO,
  BUILD, VISION, STUCK, BREACH, WALL, GARRISON, NEST, WILD,
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

export function createGame(seedString, archetypeKey, mapOverride = null) {
  const seed = seedString || randomSeed();
  const map = mapOverride || generateMap(seed);
  const arch = ARCHETYPES[archetypeKey] || ARCHETYPES.gunner;

  const g = {
    seed, map, arch, archetypeKey,
    time: 0,
    status: 'playing',
    lossCause: null,
    paused: false,
    res: { ...START_RESOURCES },
    phase: 'prep',
    phaseLeft: WAVE.prepFirst - WAVE.warning,
    wave: 1,
    spawnSides: [],
    pendingSpawns: [],
    player: {
      x: map.start.x + 0.5, y: map.start.y + 2.5,
      hp: PLAYER.maxHp, maxHp: PLAYER.maxHp,
      meleeCd: 0, hurtCd: 0, facing: { x: 0, y: 1 },
    },
    effects: {}, equipment: [],
    towers: [], buildings: [], walls: [], enemies: [], drops: [],
    tracers: [], particles: [], floaters: [], shockwaves: [],
    nextTowerId: 1, nextBuildingId: 1, nextWallId: 1, nextEnemyId: 1,
    selected: null, selectedBuildingId: null, buildMode: false, buildType: 'tower',
    cursor: { x: map.start.x, y: map.start.y },
    occupiedTowerId: null,
    shelter: { towerId: null, progress: 0, required: PLAYER.shelterTime },
    input: { mx: 0, my: 0, melee: false, repair: false },
    playerField: null, playerFieldAt: -99,
    blockerGrid: new Array(MAP.w * MAP.h).fill(null),
    blockerVersion: 0,
    keepFields: Object.create(null),
    keepFieldTypes: new Set(),
    keepFieldsDirty: false,
    keepFieldNextAt: 0,
    towerConnectivityCache: Object.create(null),
    log: [], audioEvents: [],
    stats: {
      kills: 0, towersLost: 0, resourcesEarned: { stone: 0, gold: 0 }, wavesCleared: 0,
      nestsDestroyed: 0, feralKills: 0, standDowns: 0,
      breaches: 0, breachesByType: { swarm: 0, runner: 0, heavy: 0 }, breachDamage: 0,
      keepFieldRecomputes: 0, wallsBuilt: 0, wallSegmentsLost: 0, wallSegmentsRebuilt: 0,
      stuckDetections: 0, stuckRecoveries: 0, stuckDespawns: 0,
    },
    debug: { showPaths: false, showFog: false, spawnPaused: false, open: false, stuckEpisodes: [] },
    fog: {
      explored: new Uint8Array(MAP.w * MAP.h),
      visible: new Uint8Array(MAP.w * MAP.h),
      version: 0,
    },
    fogCache: { map, playerTile: null, towerSignature: null, towerTiles: new Map() },
    // D91: Food deficit state. `since` is the time the deficit began.
    supply: { since: null, nextStandDownAt: null },
    nests: [],
    wildFields: new Map(),
    warning5Cued: false,
  };

  const start = placeTower(g, map.start.x + 0.5, map.start.y + 0.5, true, true);
  start.hp = start.maxHp;
  g.keepId = start.id;
  g.towerConnectivityCache[start.id] = 'keep';
  for (const n of map.nests || []) addNest(g, n.x, n.y, n.guards);
  // D97: the approach is known for the whole mandatory expansion phase.
  rollWave(g);
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

/** D80/D91: each resource keeps its identity; tower sprawl escalates Stone only. */
export function towerCost(g) {
  const count = g.towers.filter((t) => !t.keep).length;
  return {
    stone: TOWER.cost.stone + TOWER.costStonePerExisting * count,
    gold: 0,
  };
}

// D91: Food is never spent, so only Stone and Gold are spendable resources.
const SPEND_KEYS = ['stone', 'gold'];

function normalizeBuildType(type) {
  return type === 'goldMine' || type === 'gold-mine' ? 'mine' : (type || 'tower');
}

function stewardCostMult(g, type) {
  return type !== 'tower' && g.arch.buildingCostMult ? g.arch.buildingCostMult : 1;
}

function buildCost(g, type) {
  if (type === 'tower') return towerCost(g);
  const def = BUILDINGS[type];
  const cost = { ...def.cost };
  if (def.costStonePerExisting) cost.stone = (cost.stone || 0) + def.costStonePerExisting
    * g.buildings.filter((b) => b.type === type && !b.destroyed).length;
  const mult = stewardCostMult(g, type);
  return {
    stone: Math.ceil((cost.stone || 0) * mult),
    gold: Math.ceil((cost.gold || 0) * mult),
  };
}

function canAfford(g, cost) {
  return SPEND_KEYS.every((key) => (g.res[key] || 0) >= (cost[key] || 0));
}

function spend(g, cost) {
  for (const key of SPEND_KEYS) g.res[key] -= cost[key] || 0;
}

function costLabel(cost) {
  return SPEND_KEYS.filter((key) => cost[key])
    .map((key) => `${cost[key]} ${key[0].toUpperCase()}${key.slice(1)}`).join(', ');
}

function activeSiteClaim(g, siteId) {
  return g.buildings.find((b) => !b.destroyed && b.siteId === siteId) || null;
}

function farmQuality(map, x, y) {
  let fertile = 0;
  let sum = 0;
  let total = 0;
  const tx = Math.floor(x);
  const ty = Math.floor(y);
  for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
    if (!inBounds(tx + ox, ty + oy)) continue;
    total++;
    const value = map.fertility?.[idx(tx + ox, ty + oy)] || 0;
    if (value > 0) fertile++;
    sum += value;
  }
  return { fertile, total, mean: total ? sum / total : 0 };
}

function nearestOpenSite(g, type, x, y) {
  const sites = type === 'quarry' ? g.map.stoneSites : g.map.goldSites;
  let best = null;
  let bestD = Infinity;
  for (const site of sites || []) {
    if (activeSiteClaim(g, site.id)) continue;
    const d = Math.hypot(site.x - x, site.y - y);
    if (d <= BUILDINGS[type].siteRange && d < bestD) { best = site; bestD = d; }
  }
  return best;
}

export function canPlaceAt(g, x, y, buildType = g.buildType || 'tower') {
  const type = normalizeBuildType(buildType);
  const reasons = [];
  let cost = buildCost(g, type);
  let site = null;
  let rate = 0;
  let fertility = null;

  if (type === 'tower') {
    isTerrainBuildable(g.map, x, y, reasons);
    for (const t of g.towers) {
      if (Math.hypot(t.x - x, t.y - y) < TOWER.minSpacing) {
        reasons.push(`too close to another tower (${TOWER.minSpacing} tiles apart)`);
        break;
      }
    }
  } else if (!BUILDINGS[type]) {
    reasons.push('unknown building');
  } else if (!isPassable(g.map, Math.floor(x), Math.floor(y))) {
    reasons.push('impassable ground');
  } else if (g.towers.some((t) => Math.hypot(t.x - x, t.y - y) < t.radius + 0.8)
      || g.buildings.some((b) => !b.destroyed && Math.hypot(b.x - x, b.y - y) < 1.0)) {
    reasons.push('site is occupied');
  } else if (type === 'farm') {
    const quality = farmQuality(g.map, x, y);
    fertility = quality.mean;
    if (quality.fertile < 5) reasons.push('not fertile enough (need most of the 3x3)');
    if (g.buildings.some((b) => b.type === 'farm' && !b.destroyed
        && Math.hypot(b.x - x, b.y - y) < BUILDINGS.farm.minSpacing)) {
      reasons.push(`too close to another farm (${BUILDINGS.farm.minSpacing} tiles apart)`);
    }
    rate = BUILDINGS.farm.baseRate * quality.mean;
  } else {
    site = nearestOpenSite(g, type, x, y);
    if (!site) reasons.push(type === 'quarry' ? 'no unclaimed stone site in reach' : 'no unclaimed gold site in reach');
    rate = site ? BUILDINGS[type].baseRate * site.mult : 0;
  }

  // D92: a nest's footprint is solid; nothing is built on top of it.
  const ownRadius = type === 'tower' ? TOWER.radius : 0.55;
  if (g.nests.some((n) => !n.destroyed && Math.hypot(n.x - x, n.y - y) < n.radius + ownRadius + 0.6)) {
    reasons.push('too close to the nest');
  }

  const unique = [...new Set(reasons)];
  if (!canAfford(g, cost)) unique.push(`need ${costLabel(cost)}`);
  const terrain = kindAt(g.map, Math.floor(x), Math.floor(y));
  const elev = elevAt(g.map, Math.floor(x), Math.floor(y));
  return {
    ok: unique.length === 0,
    reasons: unique,
    type,
    cost,
    rate,
    fertility,
    site,
    coverage: type === 'tower' ? coverageAt(g.map, x, y, TOWER.weapon.range) : null,
    terrain,
    elev,
    elevationName: terrain === T.CLIFF ? 'Cliff' : ELEVATION_NAMES[elev],
  };
}

/** Nearest buildable tile centre the player can physically reach to build. */
export function playerBuildSite(g, buildType = g.buildType || 'tower') {
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
    const check = canPlaceAt(g, candidate.x, candidate.y, buildType);
    if (check.ok) return { x: candidate.x, y: candidate.y, check };
  }
  const x = Math.floor(g.player.x) + 0.5;
  const y = Math.floor(g.player.y) + 0.5;
  return { x, y, check: canPlaceAt(g, x, y, buildType) };
}

function placeTower(g, x, y, instant = false, keep = false) {
  const radius = keep ? KEEP.radius : TOWER.radius;
  const maxHp = keep ? KEEP.maxHp : TOWER.maxHp;
  const t = {
    id: g.nextTowerId++,
    x, y,
    keep,
    radius,
    hp: maxHp * (instant ? 1 : TOWER.buildHpFraction),
    maxHp,
    built: instant,
    progress: instant ? 1 : 0,
    wLevel: 0,
    upgrade: null,
    garrison: 0,
    shotCd: 0, targetId: null, nestTargetId: null, retargetIn: 0,
    flash: 0, smoke: 0,
    unseenHitAt: null,
  };
  g.towers.push(t);
  if (clearTowerForest(g.map, x, y)) {
    // Forest -> plain changes movement cost and every LOS-derived view. Keep
    // placement validation on the original terrain, then invalidate only after
    // the tower has been accepted and the clearing has actually changed tiles.
    invalidateKeepFields(g);
    g.playerField = null;
    g.playerFieldAt = -99;
    recomputeVisibility(g, true);
  }
  if (!keep) {
    registerTowerBlocker(g, t);
    g.towerConnectivityCache[t.id] = 'outpost';
  }
  return t;
}

function placeBuilding(g, x, y, type, check) {
  const def = BUILDINGS[type];
  const b = {
    id: g.nextBuildingId++, type, x, y,
    hp: def.maxHp * (def.buildHpFraction ?? TOWER.buildHpFraction), maxHp: def.maxHp,
    built: false, progress: 0, destroyed: false,
    rate: check.rate, siteId: check.site?.id ?? null,
    flash: 0, unseenHitAt: null,
  };
  g.buildings.push(b);
  return b;
}

export function tryBuild(g, x, y, buildType = g.buildType || 'tower') {
  const type = normalizeBuildType(buildType);
  const check = canPlaceAt(g, x, y, type);
  if (g.paused) return { ...check, ok: false, reason: 'paused', reasons: [...check.reasons, 'paused'] };
  if (Math.hypot(g.player.x - x, g.player.y - y) > BUILD.reach + 1e-6) {
    const reason = 'stand at the site to build';
    return { ...check, ok: false, reason, reasons: [...check.reasons, reason] };
  }
  if (!check.ok) return check;
  spend(g, check.cost);
  if (type === 'tower') {
    const t = placeTower(g, x, y, false);
    g.selected = t.id;
    g.selectedBuildingId = null;
  } else {
    const b = placeBuilding(g, x, y, type, check);
    g.selectedBuildingId = b.id;
    g.selected = null;
  }
  say(g, 'Construction started.');
  emitAudioEvent(g, 'constructionStart', { x, y });
  return { ...check, links: [],
  structure: type === 'tower' ? g.towers[g.towers.length - 1] : g.buildings[g.buildings.length - 1] };
}

export function occupancyMults(g) {
  return { ...OCCUPANCY, ...g.arch.occupancy };
}

export function constructionRateMult(g, t) {
  const nearby = dist(g.player, t) <= PLAYER.presenceRadius ? occupancyMults(g).construction : 1;
  return nearby * (t.type && g.arch.buildingBuildMult ? g.arch.buildingBuildMult : 1);
}

export function upgradeRateMult(g, t) {
  return g.occupiedTowerId === t.id ? (g.arch.occupancy.construction ?? 1) : 1;
}

export function towerStats(g, t) {
  const occupied = g.occupiedTowerId === t.id;
  const m = occupied ? occupancyMults(g) : { damage: 1, fireRate: 1, damageTaken: 1 };
  const u = TOWER.upgrade;
  const dmgBoost = g.effects.damage ? DROP.temporary.damage.mult : 1;
  const barrel = hasEquipment(g, 'reinforcedBarrel') ? DROP.equipment.reinforcedBarrel.towerDamage : 1;
  const module = hasEquipment(g, 'targetingModule') ? DROP.equipment.targetingModule.towerRange : 1;
  // D91: soldiers stack with the player's occupancy; they never touch min range.
  const soldiers = t.garrison || 0;
  return {
    occupied,
    garrison: soldiers,
    damage: TOWER.weapon.damage * (1 + u.weaponDamagePerLevel * t.wLevel) * m.damage * dmgBoost * barrel
      * (1 + GARRISON.damagePerSoldier * soldiers),
    fireRate: TOWER.weapon.fireRate * (1 + u.weaponRatePerLevel * t.wLevel) * m.fireRate
      * (1 + GARRISON.fireRatePerSoldier * soldiers),
    range: (TOWER.weapon.range + u.weaponRangePerLevel * t.wLevel) * module,
    damageTaken: m.damageTaken,
  };
}

// ---------------------------------------------------------------------------
// Garrison (D91): Food support feeds soldiers; soldiers strengthen towers.
// ---------------------------------------------------------------------------

export function garrisonSlots(t) {
  if (t.keep) return GARRISON.slots.keep;
  return t.wLevel >= GARRISON.upgradedFromLevel ? GARRISON.slots.towerUpgraded : GARRISON.slots.tower;
}

/** Soldiers a finished, standing farm feeds: richer soil feeds more. */
export function farmSupport(b) {
  return Math.round(GARRISON.supportPerFarm * (b.rate || 0) / BUILDINGS.farm.baseRate);
}

export function foodSupport(g) {
  let support = g.arch.foodSupportBonus || 0;
  for (const b of g.buildings) {
    if (b.type === 'farm' && b.built && !b.destroyed) support += farmSupport(b);
  }
  return support;
}

export function garrisonAssigned(g) {
  return g.towers.reduce((n, t) => n + (t.garrison || 0), 0);
}

export function garrisonState(g) {
  const support = foodSupport(g);
  const assigned = garrisonAssigned(g);
  const deficit = assigned > support;
  const since = g.supply.since;
  const graceLeft = deficit && since !== null ? Math.max(0, GARRISON.graceSeconds - (g.time - since)) : null;
  return { support, assigned, free: Math.max(0, support - assigned), deficit, graceLeft,
    standingDown: deficit && graceLeft === 0 };
}

/** Instant assignment; remote is allowed (a command, not labour). */
export function assignGarrison(g, towerOrId, delta) {
  if (g.paused) return { ok: false, reason: 'paused' };
  const id = typeof towerOrId === 'object' ? towerOrId?.id : towerOrId;
  const t = g.towers.find((o) => o.id === id);
  if (!t) return { ok: false, reason: 'no tower' };
  if (delta > 0) {
    if (!t.built) return { ok: false, reason: 'tower is still under construction' };
    if ((t.garrison || 0) >= garrisonSlots(t)) return { ok: false, reason: 'no free garrison slot' };
    if (garrisonAssigned(g) >= foodSupport(g)) return { ok: false, reason: 'not enough Food support — build a Farm' };
    t.garrison = (t.garrison || 0) + 1;
    emitAudioEvent(g, 'towerEntry', t);
    return { ok: true };
  }
  if (delta < 0) {
    if (!(t.garrison > 0)) return { ok: false, reason: 'no soldiers to withdraw' };
    t.garrison--;
    return { ok: true };
  }
  return { ok: false, reason: 'no change' };
}

/** Outposts stand down first and the Keep last; ties go to the newest tower. */
function standDownOrder(g, a, b) {
  const rank = (t) => (t.keep ? 2 : towerConnectivity(g, t) === 'outpost' ? 0 : 1);
  return rank(a) - rank(b) || b.id - a.id;
}

function updateGarrison(g) {
  const support = foodSupport(g);
  let assigned = garrisonAssigned(g);
  if (assigned <= support) {
    if (g.supply.since !== null) say(g, 'Supply restored. The garrison is fed.');
    g.supply.since = null;
    g.supply.nextStandDownAt = null;
    return;
  }
  if (g.supply.since === null) {
    g.supply.since = g.time;
    g.supply.nextStandDownAt = g.time + GARRISON.graceSeconds;
    say(g, `SUPPLY DEFICIT: ${assigned} soldiers, Food for ${support}. ${GARRISON.graceSeconds}s before they stand down.`);
    emitAudioEvent(g, 'supplyDeficit', keepTower(g) || g.player);
  }
  if (g.time < g.supply.nextStandDownAt) return;
  const t = g.towers.filter((o) => o.garrison > 0).sort((a, b) => standDownOrder(g, a, b))[0];
  if (!t) return;
  t.garrison--;
  assigned--;
  g.stats.standDowns++;
  g.supply.nextStandDownAt = g.time + GARRISON.standDownInterval;
  floater(g, t.x, t.y - 1.3, 'STOOD DOWN', '#ffb347');
  say(g, `Unfed soldiers stood down at ${t.keep ? 'the Keep' : `tower #${t.id}`}.`);
}

// ---------------------------------------------------------------------------
// Wilderness nests (D92): local territory that resists expansion.
// ---------------------------------------------------------------------------

// A nest is solid ground for everyone, never a thing the army chooses to
// break: its path cost is effectively infinite.
const NEST_BLOCK_HP = 1e7;

export function addNest(g, x, y, guards = null) {
  const n = {
    id: `nest-${g.nests.length}`, nest: true, x, y, guards,
    radius: NEST.radius, hp: NEST.maxHp, maxHp: NEST.maxHp,
    state: 'dormant', underSiege: false, siegeCheckAt: 0,
    spawnCd: 0, lastThreatAt: -Infinity, destroyed: false, destroyedAt: null,
    flash: 0, shake: 0,
  };
  n.blockerTiles = towerFootprintTiles(n);
  for (const i of n.blockerTiles) g.blockerGrid[i] = { kind: 'nest', id: n.id, structure: n, maxHp: NEST_BLOCK_HP };
  g.nests.push(n);
  invalidateKeepFields(g);
  return n;
}

function nestThreatened(g, n) {
  const r = NEST.territory;
  if (dist(g.player, n) <= r) return true;
  return g.towers.some((t) => dist(t, n) <= r)
    || g.buildings.some((b) => !b.destroyed && dist(b, n) <= r);
}

/** D93 applies to nests: visible, within the annulus and in line of sight. */
export function towerCanHitNest(g, t, n) {
  if (!t.built || n.destroyed) return false;
  const d = dist(t, n);
  if (d < towerMinRange(g, t) || d - n.radius > towerStats(g, t).range) return false;
  return isPointVisible(g, n.x, n.y) && hasLineOfSight(g.map, t.x, t.y, n.x, n.y);
}

function agitateNest(g, n) {
  if (n.state !== 'dormant' || n.destroyed) return;
  n.state = 'agitated';
  n.spawnCd = 1.0;
  n.lastThreatAt = g.time;
  floater(g, n.x, n.y - 1.6, 'NEST AGITATED', '#d7f36b');
  say(g, 'A nest stirs: its defenders are coming.');
  emitAudioEvent(g, 'nestAgitated', n);
}

function damageNest(g, n, amount) {
  if (n.destroyed) return;
  n.hp -= amount;
  n.flash = 1;
  n.lastThreatAt = g.time;
  agitateNest(g, n);
  burst(g, n.x, n.y, '#9fbf4a', 3, 2.5);
  if (n.hp <= 0) destroyNest(g, n);
}

function destroyNest(g, n) {
  if (n.destroyed) return;
  n.destroyed = true;
  n.hp = 0;
  n.state = 'destroyed';
  n.underSiege = false;
  n.destroyedAt = g.time;
  for (const i of n.blockerTiles) if (g.blockerGrid[i]?.structure === n) g.blockerGrid[i] = null;
  invalidateKeepFields(g);
  g.wildFields.clear();
  for (const key of SPEND_KEYS) {
    g.res[key] += NEST.reward[key] || 0;
    g.stats.resourcesEarned[key] += NEST.reward[key] || 0;
  }
  for (const e of g.enemies) {
    if (e.nestId === n.id) e.fadeAt = g.time + Math.random() * NEST.feralFadeSeconds;
  }
  g.stats.nestsDestroyed++;
  burst(g, n.x, n.y, '#9fbf4a', 40, 7);
  burst(g, n.x, n.y, '#ffb347', 24, 6);
  g.shockwaves.push({ x: n.x, y: n.y, t: 0, life: 0.9, radius: 5, color: '#d7f36b' });
  floater(g, n.x, n.y - 1.8, `TERRITORY CLEARED +${NEST.reward.stone} Stone +${NEST.reward.gold} Gold`, '#d7f36b');
  say(g, 'Nest destroyed. The territory is cleared.');
  emitAudioEvent(g, 'nestDestroyed', n);
}

function spawnFeral(g, n) {
  for (let tries = 0; tries < 12; tries++) {
    const a = Math.random() * Math.PI * 2;
    const r = n.radius + 1.1 + Math.random();
    const x = n.x + Math.cos(a) * r;
    const y = n.y + Math.sin(a) * r;
    const tx = Math.floor(x);
    const ty = Math.floor(y);
    if (!inBounds(tx, ty) || !isPassable(g.map, tx, ty) || g.blockerGrid[idx(tx, ty)]) continue;
    const def = WILD.feral;
    const e = {
      id: g.nextEnemyId++, type: 'feral', def, side: 'wild', wild: true, nestId: n.id,
      home: { x: n.x, y: n.y, radius: n.radius },
      x, y, hp: def.hp, maxHp: def.hp, structMult: 1,
      targetId: null, strategicTargetId: null, econTargetId: null, blockerTargetId: null,
      playerAggroUntil: 0, playerAggroCooldownUntil: 0, hitCd: 0, flash: 0, stuckOrigin: 'spawn',
    };
    g.enemies.push(e);
    burst(g, x, y, def.color, 8, 3);
    return e;
  }
  return null;
}

function updateNests(g, dt) {
  for (const n of g.nests) {
    if (n.destroyed) continue;
    n.flash = Math.max(0, n.flash - dt * 3);
    if (nestThreatened(g, n)) {
      n.lastThreatAt = g.time;
      agitateNest(g, n);
    }
    if (g.time >= n.siegeCheckAt) {
      n.siegeCheckAt = g.time + NEST.siegeCheckInterval;
      const was = n.underSiege;
      n.underSiege = g.towers.some((t) => towerCanHitNest(g, t, n));
      if (n.underSiege && !was) say(g, 'A tower has the nest in its sights: UNDER SIEGE.');
    }
    if (n.state !== 'agitated') continue;
    if (g.time - n.lastThreatAt > NEST.calmAfter) {
      n.state = 'dormant';
      say(g, 'The nest settles.');
      continue;
    }
    n.spawnCd -= dt;
    if (n.spawnCd <= 0) {
      n.spawnCd = NEST.spawnInterval;
      const alive = g.enemies.filter((e) => e.nestId === n.id && !e.fadeAt).length;
      if (alive < NEST.maxAlive) spawnFeral(g, n);
    }
  }
}

export function nestState(g) {
  return g.nests.map((n) => ({
    id: n.id, x: n.x, y: n.y, guards: n.guards, hp: n.hp, maxHp: n.maxHp,
    state: n.destroyed ? 'destroyed' : n.underSiege ? 'siege' : n.state,
    underSiege: n.underSiege, destroyed: n.destroyed,
    ferals: g.enemies.filter((e) => e.nestId === n.id).length,
  }));
}

/** D93 future hook: closeDefense can only shrink the fixed blind radius. */
export function towerMinRange(g, t) {
  const base = t.keep ? KEEP.minRange : TOWER.weapon.minRange;
  return Math.max(0, base - (t.closeDefense || 0));
}

export function upgradeCost(t, which = 'weapon') {
  if (which !== 'weapon') return null;
  const level = t.wLevel;
  if (level >= TOWER.upgrade.maxLevel) return null;
  return { ...TOWER.upgrade.weaponCost[level] };
}

export function tryUpgrade(g, t, which) {
  if (g.paused) return false;
  if (which !== 'weapon') return false;
  const cost = upgradeCost(t, which);
  if (cost === null || !canAfford(g, cost) || !t.built || t.upgrade) return false;
  if (dist(g.player, t) > PLAYER.presenceRadius) return false;
  spend(g, cost);
  const level = t.wLevel;
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

const clampTx = (x) => clamp(Math.floor(x), 0, MAP.w - 1);
const clampTy = (y) => clamp(Math.floor(y), 0, MAP.h - 1);

function towerFootprintTiles(t) {
  const out = [];
  const minX = Math.max(0, Math.floor(t.x - t.radius - 0.5));
  const maxX = Math.min(MAP.w - 1, Math.floor(t.x + t.radius + 0.5));
  const minY = Math.max(0, Math.floor(t.y - t.radius - 0.5));
  const maxY = Math.min(MAP.h - 1, Math.floor(t.y + t.radius + 0.5));
  for (let ty = minY; ty <= maxY; ty++) for (let tx = minX; tx <= maxX; tx++) {
    const nx = clamp(t.x, tx, tx + 1);
    const ny = clamp(t.y, ty, ty + 1);
    if (Math.hypot(nx - t.x, ny - t.y) <= t.radius + 1e-6) out.push(idx(tx, ty));
  }
  return out;
}

function invalidateKeepFields(g) {
  g.blockerVersion++;
  if (!g.keepFieldsDirty) {
    g.keepFieldsDirty = true;
    // An idle field reacts on the next frame (a breach must reroute at once);
    // only changes arriving during a busy spell wait out the interval.
    g.keepFieldNextAt = Math.max(g.time,
      (g.keepFieldLastAt ?? -Infinity) + WALL_PATH.recomputeInterval);
  }
}

function registerTowerBlocker(g, t) {
  if (t.keep) return;
  t.blockerTiles = towerFootprintTiles(t);
  for (const i of t.blockerTiles) g.blockerGrid[i] = { kind: 'tower', id: t.id, structure: t, maxHp: t.maxHp };
  invalidateKeepFields(g);
}

function unregisterTowerBlocker(g, t) {
  if (t.keep) return;
  for (const i of t.blockerTiles || towerFootprintTiles(t)) {
    if (g.blockerGrid[i]?.structure === t) g.blockerGrid[i] = null;
  }
  invalidateKeepFields(g);
}

function keepTower(g) {
  return g.towers.find((t) => t.id === g.keepId) || null;
}

function rebuildKeepField(g, type) {
  const keep = keepTower(g);
  if (!keep) return null;
  const goal = idx(clampTx(keep.x), clampTy(keep.y));
  const def = ENEMIES[type];
  if (!def) return null;
  const obstacleCosts = new Float32Array(MAP.w * MAP.h);
  for (let i = 0; i < g.blockerGrid.length; i++) {
    const blocker = g.blockerGrid[i];
    if (blocker) obstacleCosts[i] = WALL_PATH.breakBias * (blocker.maxHp / def.structDps) * def.speed;
  }
  const field = computeField(g.map, [goal], 'lane', obstacleCosts);
  g.keepFields[type] = { version: g.blockerVersion, goal, map: g.map, field, obstacleCosts };
  g.stats.keepFieldRecomputes++;
  return field;
}

function keepField(g, type) {
  const keep = keepTower(g);
  if (!keep) return null;
  g.keepFieldTypes.add(type);
  const goal = idx(clampTx(keep.x), clampTy(keep.y));
  const cached = g.keepFields[type];
  // D90: a geometry change does not synchronously throw away a usable field.
  // The field and its obstacle costs remain paired at their original version;
  // live blocker collision still prevents walking through newer geometry.
  if (cached && cached.goal === goal && cached.map === g.map) return cached.field;
  return rebuildKeepField(g, type);
}

function updateKeepFieldRecomputes(g) {
  if (!g.keepFieldsDirty || g.time + 1e-9 < g.keepFieldNextAt) return;
  const type = [...g.keepFieldTypes].find((key) => g.keepFields[key]?.version !== g.blockerVersion);
  if (!type) { g.keepFieldsDirty = false; return; }
  rebuildKeepField(g, type);
  // One type per frame; the remaining types follow on the next frames, and the
  // interval starts once the whole set is current.
  g.keepFieldsDirty = [...g.keepFieldTypes].some((key) => g.keepFields[key]?.version !== g.blockerVersion);
  if (!g.keepFieldsDirty) g.keepFieldLastAt = g.time;
}

/** Test/tool seam: settle every requested field against current live blockers. */
export function flushKeepFieldRecomputes(g) {
  const types = g.keepFieldTypes.size ? [...g.keepFieldTypes] : Object.keys(g.keepFields);
  for (const type of types) {
    if (g.keepFields[type]?.version !== g.blockerVersion) rebuildKeepField(g, type);
  }
  g.keepFieldsDirty = false;
  g.keepFieldLastAt = g.time;
  g.keepFieldNextAt = g.time + WALL_PATH.recomputeInterval;
  return types.length;
}

function keepObstacles(g, type) {
  const cached = g.keepFields[type];
  return cached && cached.map === g.map ? cached.obstacleCosts : null;
}

// ---------------------------------------------------------------------------
// Walls (D81)
// ---------------------------------------------------------------------------

/**
 * 4-connected (supercover) tile walk from one point to another. Every step
 * changes x or y, never both, so consecutive tiles share an edge and the line
 * has no diagonal gap an 8-connected mover could slip through.
 */
export function supercoverLine(x0, y0, x1, y1) {
  let tx = Math.floor(x0);
  let ty = Math.floor(y0);
  const endX = Math.floor(x1);
  const endY = Math.floor(y1);
  const dx = x1 - x0;
  const dy = y1 - y0;
  const stepX = Math.sign(dx);
  const stepY = Math.sign(dy);
  const tDeltaX = stepX ? Math.abs(1 / dx) : Infinity;
  const tDeltaY = stepY ? Math.abs(1 / dy) : Infinity;
  let tMaxX = stepX > 0 ? (tx + 1 - x0) / dx : stepX < 0 ? (x0 - tx) / -dx : Infinity;
  let tMaxY = stepY > 0 ? (ty + 1 - y0) / dy : stepY < 0 ? (y0 - ty) / -dy : Infinity;
  const tiles = [{ x: tx, y: ty }];
  for (let guard = 0; guard < 4 * (MAP.w + MAP.h) && (tx !== endX || ty !== endY); guard++) {
    // Ties step x first; either choice keeps the walk 4-connected.
    if (tMaxX <= tMaxY) { tx += stepX; tMaxX += tDeltaX; } else { ty += stepY; tMaxY += tDeltaY; }
    tiles.push({ x: tx, y: ty });
  }
  return tiles;
}

function wallLinkExists(g, aId, bId) {
  return g.walls.some((w) => (w.a === aId && w.b === bId) || (w.a === bId && w.b === aId));
}

function samePoint(a, b) {
  return Math.abs(a.x - b.x) < 1e-7 && Math.abs(a.y - b.y) < 1e-7;
}

function orient(a, b, c) {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

/** Strict centre-line crossing: endpoint touches and collinear runs are not proper crossings. */
function properLineCross(a, b, c, d) {
  if ([a, b].some((p) => samePoint(p, c) || samePoint(p, d))) return false;
  const abC = orient(a, b, c);
  const abD = orient(a, b, d);
  const cdA = orient(c, d, a);
  const cdB = orient(c, d, b);
  const eps = 1e-8;
  return abC * abD < -eps && cdA * cdB < -eps;
}

function linkPoints(g, link) {
  const a = g.towers.find((t) => t.id === link.a) || link.aPos;
  const b = g.towers.find((t) => t.id === link.b) || link.bPos;
  return a && b ? [a, b] : null;
}

function towerComponents(g) {
  const byId = new Map(g.towers.map((t) => [t.id, t]));
  const edges = new Map(g.towers.map((t) => [t.id, []]));
  for (const link of g.walls) {
    if (!byId.has(link.a) || !byId.has(link.b)) continue;
    edges.get(link.a).push(link.b);
    edges.get(link.b).push(link.a);
  }
  const components = new Map();
  let component = 0;
  for (const tower of g.towers) {
    if (components.has(tower.id)) continue;
    const todo = [tower.id];
    components.set(tower.id, component);
    while (todo.length) {
      const id = todo.pop();
      for (const other of edges.get(id) || []) if (!components.has(other)) {
        components.set(other, component);
        todo.push(other);
      }
    }
    component++;
  }
  return components;
}

function recomputeTowerConnectivity(g) {
  const components = towerComponents(g);
  const keepComponent = components.get(g.keepId);
  const next = Object.create(null);
  for (const t of g.towers) next[t.id] = t.keep ? 'keep'
    : components.get(t.id) === keepComponent ? 'connected' : 'outpost';
  g.towerConnectivityCache = next;
}

/** D89 cached graph accessor. The graph itself changes only with links/deaths. */
export function towerConnectivity(g, towerOrId) {
  const id = typeof towerOrId === 'object' ? towerOrId?.id : towerOrId;
  const t = g.towers.find((o) => o.id === id);
  if (!t) return null;
  return g.towerConnectivityCache[id] || (t.keep ? 'keep' : 'outpost');
}

function footprintContains(structure, tile) {
  const radius = structure.radius ?? 0.55;
  const nx = clamp(structure.x, tile.x, tile.x + 1);
  const ny = clamp(structure.y, tile.y, tile.y + 1);
  return Math.hypot(nx - structure.x, ny - structure.y) <= radius + 1e-6;
}

/** Everything the wall preview needs: tiles, segments, cost and refusal reasons. */
export function wallPlan(g, aId, bId) {
  const a = g.towers.find((t) => t.id === aId);
  const b = g.towers.find((t) => t.id === bId);
  const reasons = [];
  const result = { ok: false, reasons, a: aId, b: bId, tiles: [], segments: [], skipped: 0, length: 0,
    cost: { stone: 0, gold: 0 } };
  if (!a || !b) { reasons.push('choose two towers'); return result; }
  if (a === b) { reasons.push('choose a different tower'); return result; }
  if (!a.built || !b.built) reasons.push('both towers must be finished');
  result.length = dist(a, b);
  if (result.length > WALL.maxLength + 1e-6) reasons.push(`too long (${result.length.toFixed(1)} > ${WALL.maxLength} tiles)`);
  if (wallLinkExists(g, aId, bId)) reasons.push('these towers are already joined');
  for (const existing of g.walls) {
    const points = linkPoints(g, existing);
    if (points && properLineCross(a, b, points[0], points[1])) reasons.push('crosses an existing wall');
  }

  const footprints = new Set([...towerFootprintTiles(a), ...towerFootprintTiles(b)]);
  for (const tile of supercoverLine(a.x, a.y, b.x, b.y)) {
    if (!inBounds(tile.x, tile.y)) continue;
    const i = idx(tile.x, tile.y);
    if (footprints.has(i)) continue;
    result.tiles.push(tile);
    // Cliffs and deep water are already barriers: skipped, never charged.
    if (!isPassable(g.map, tile.x, tile.y)) { result.skipped++; continue; }
    const blocker = g.blockerGrid[i];
    if (blocker?.kind === 'wall'
      || wallSegments(g).some((seg) => !seg.cancelled && seg.tx === tile.x && seg.ty === tile.y)) {
      reasons.push('crosses an existing wall');
    }
    else if (blocker?.kind === 'tower') reasons.push('crosses another tower');
    if (g.towers.some((t) => t !== a && t !== b && towerFootprintTiles(t).includes(i))) reasons.push('crosses another tower');
    if (g.buildings.some((o) => !o.destroyed && footprintContains(o, tile))) {
      reasons.push('crosses an economic building');
    }
    if ((g.nests || []).some((n) => !n.destroyed && footprintContains(n, tile))) reasons.push('crosses a nest');
    result.segments.push(tile);
  }
  if (!result.segments.length && !reasons.length) reasons.push('nothing to build between these towers');
  result.cost = { stone: WALL.costStonePerSegment * result.segments.length, gold: 0 };
  const unique = [...new Set(reasons)];
  if (!canAfford(g, result.cost)) unique.push(`need ${costLabel(result.cost)}`);
  result.reasons = unique;
  result.ok = unique.length === 0;
  return result;
}

function registerWallSegment(g, seg) {
  g.blockerGrid[seg.i] = { kind: 'wall', id: seg.id, structure: seg, maxHp: seg.maxHp };
}

/** D81: start a wall link. The player must be at one of its towers. */
export function tryBuildWall(g, aId, bId) {
  const plan = wallPlan(g, aId, bId);
  if (g.paused) return { ...plan, ok: false, reasons: [...plan.reasons, 'paused'] };
  const a = g.towers.find((t) => t.id === aId);
  const b = g.towers.find((t) => t.id === bId);
  const near = [a, b].some((t) => t && dist(g.player, t) <= PLAYER.presenceRadius + t.radius);
  if (!near) {
    const reason = 'stand at one of the two towers to start the wall';
    return { ...plan, ok: false, reasons: [...plan.reasons, reason] };
  }
  if (!plan.ok) return plan;
  g.res.stone -= plan.cost.stone;
  const link = {
    id: g.nextWallId++, a: aId, b: bId,
    aPos: { x: a.x, y: a.y }, bPos: { x: b.x, y: b.y },
    built: false, progress: 0,
    duration: WALL.buildBase + WALL.buildPerTile * plan.segments.length,
    segments: [],
  };
  plan.segments.forEach((tile, k) => {
    const seg = {
      id: `w${link.id}:${k}`, wall: true, linkId: link.id,
      tx: tile.x, ty: tile.y, i: idx(tile.x, tile.y), x: tile.x + 0.5, y: tile.y + 0.5,
      radius: 0.5, maxHp: WALL.segmentHp, hp: 0,
      // The segment next to each anchor is a postern: enemy-solid, player-open.
      gate: k === 0 || k === plan.segments.length - 1,
      present: false, cancelled: false, destroyed: false, flash: 0, shake: 0, unseenHitAt: null,
    };
    link.segments.push(seg);
  });
  g.walls.push(link);
  invalidateKeepFields(g);
  recomputeTowerConnectivity(g);
  g.stats.wallsBuilt++;
  say(g, `Wall started: ${plan.segments.length} segments.`);
  emitAudioEvent(g, 'constructionStart', { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  return { ...plan, link };
}

export function wallSegments(g) {
  return g.walls.flatMap((w) => w.segments);
}

function wallSegmentAt(g, i) {
  const blocker = g.blockerGrid[i];
  return blocker?.kind === 'wall' ? blocker.structure : null;
}

function updateWalls(g, dt) {
  for (const link of g.walls) {
    for (const seg of link.segments) {
      if (!seg.present) continue;
      seg.flash = Math.max(0, seg.flash - dt * 3);
      if (seg.shake > 0) seg.shake = Math.max(0, seg.shake - dt);
      if (!seg.destroyed && seg.hp <= 0) destroyWallSegment(g, seg);
    }
    if (link.built || link.cancelled) continue;
    const near = link.segments.some((s) => dist(g.player, s) <= PLAYER.presenceRadius)
      || [link.a, link.b].some((id) => { const t = g.towers.find((o) => o.id === id); return t && dist(g.player, t) <= PLAYER.presenceRadius; });
    const rate = near ? occupancyMults(g).construction : 1;
    link.progress = Math.min(1, link.progress + rate * dt / link.duration);
    const count = link.segments.length;
    for (let k = 0; k < count; k++) {
      const seg = link.segments[k];
      const share = clamp(link.progress * count - k, 0, 1);
      if (share <= 0) continue;
      if (!seg.present) {
        seg.present = true;
        seg.hp = seg.maxHp * WALL.buildHpFraction;
        registerWallSegment(g, seg);
        invalidateKeepFields(g);
      }
      if (!seg.destroyed) seg.hp = Math.min(seg.maxHp,
        seg.maxHp * (WALL.buildHpFraction + share * (1 - WALL.buildHpFraction)));
    }
    if (link.progress >= 1) {
      link.built = true;
      for (const seg of link.segments) if (seg.present && !seg.destroyed) seg.hp = seg.maxHp;
      say(g, 'Wall complete.');
      const mid = link.segments[Math.floor(link.segments.length / 2)];
      emitAudioEvent(g, 'constructionComplete', mid || g.player);
    }
  }
}

function destroyWallSegment(g, seg, attacker = null) {
  if (seg.destroyed || !seg.present) return;
  seg.destroyed = true;
  seg.hp = 0;
  if (g.blockerGrid[seg.i]?.structure === seg) g.blockerGrid[seg.i] = null;
  invalidateKeepFields(g);
  g.stats.wallSegmentsLost++;
  for (const e of g.enemies) if (e.blockerTargetId === seg.id) e.blockerTargetId = null;
  const heavy = attacker?.type === 'heavy';
  burst(g, seg.x, seg.y, '#9a9387', 26, 6);
  burst(g, seg.x, seg.y, '#ffb347', 14, 5);
  g.shockwaves.push({ x: seg.x, y: seg.y, t: 0, life: BREACH.ring.life * 1.4,
    radius: BREACH.ring.heavyRadius, color: heavy ? '#ff7a2e' : '#ffb347' });
  floater(g, seg.x, seg.y - 1.1, 'BREACH', '#ff7a2e');
  emitAudioEvent(g, 'wallBreak', seg);
  if (!Number.isFinite(g.wallBreachSaidAt) || g.time - g.wallBreachSaidAt >= WALL.breachMessageInterval) {
    g.wallBreachSaidAt = g.time;
    say(g, heavy ? 'A Heavy smashed through the wall. Wall breached!' : 'Wall breached!');
  }
}

/** D81: rubble is rebuilt in place for one segment's Stone if nothing stands in it. */
function rebuildWallSegment(g, seg) {
  if (!seg.destroyed) return false;
  if (g.res.stone < WALL.costStonePerSegment) return false;
  const occupied = [g.player, ...g.enemies].some((u) => Math.floor(u.x) === seg.tx && Math.floor(u.y) === seg.ty);
  if (occupied) return false;
  g.res.stone -= WALL.costStonePerSegment;
  seg.destroyed = false;
  seg.hp = seg.maxHp * WALL.buildHpFraction;
  registerWallSegment(g, seg);
  invalidateKeepFields(g);
  g.stats.wallSegmentsRebuilt++;
  burst(g, seg.x, seg.y, '#5ecbff', 8, 2);
  emitAudioEvent(g, 'constructionStart', seg);
  return true;
}

export function wallState(g) {
  return g.walls.map((w) => ({
    id: w.id, a: w.a, b: w.b, built: w.built, cancelled: !!w.cancelled,
    progress: w.progress, duration: w.duration,
    segments: w.segments.map((s) => ({ id: s.id, tx: s.tx, ty: s.ty, hp: s.hp, maxHp: s.maxHp,
      gate: s.gate, present: s.present !== false, cancelled: !!s.cancelled, destroyed: s.destroyed })),
  }));
}

function destroyTower(g, t) {
  emitAudioEvent(g, 'towerDestroy', t);
  g.lastTowerDestroyAt = g.time;
  t.upgrade = null;
  unregisterTowerBlocker(g, t);
  g.towers = g.towers.filter((o) => o !== t);
  recomputeTowerConnectivity(g);
  g.stats.towersLost++;
  if (g.selected === t.id) g.selected = null;
  for (const e of g.enemies) if (e.blockerTargetId === t.id) e.blockerTargetId = null;

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

function destroyBuilding(g, b) {
  if (b.destroyed) return;
  b.destroyed = true;
  b.built = false;
  b.hp = 0;
  b.progress = 0;
  b.destroyedAt = g.time;
  if (g.selectedBuildingId === b.id) g.selectedBuildingId = null;
  for (const e of g.enemies) if (e.econTargetId === b.id) e.econTargetId = null;
  say(g, `${BUILDINGS[b.type].name} destroyed.`);
  emitAudioEvent(g, 'towerDestroy', b);
  burst(g, b.x, b.y, '#8a8f98', 24, 5);
}

function structureRadius(s) {
  return s.radius ?? BUILDINGS[s.type]?.radius ?? 0.55;
}

function structureReach(e, structure) {
  return structureRadius(structure) + ENEMY.attackRange + e.def.radius;
}

/** D78: sustained structural damage, retaining the old breach feedback vocabulary. */
function structureName(g, structure) {
  if (structure.wall) return 'the wall';
  if (structure.type) return `the ${BUILDINGS[structure.type].name}`;
  return structure.keep ? 'the Keep' : `tower #${structure.id}`;
}

function destroyStructure(g, structure, attacker) {
  if (structure.wall) destroyWallSegment(g, structure, attacker);
  else if (structure.type) destroyBuilding(g, structure);
  else destroyTower(g, structure);
}

/** D78: sustained structural damage, retaining the old breach feedback vocabulary. */
function attackStructure(g, e, structure, dt) {
  const isTower = !structure.type && !structure.wall;
  const damageTaken = isTower ? towerStats(g, structure).damageTaken : 1;
  const dmg = e.def.structDps * (e.structMult || 1) * damageTaken * dt;
  const before = structure.hp / structure.maxHp;
  const newEpisode = !Number.isFinite(structure.lastHitAt) || g.time - structure.lastHitAt >= 6;
  structure.lastHitAt = g.time;
  structure.hp -= dmg;
  structure.flash = 1;
  structure.shake = BREACH.shake;
  // An abandoned structure is usually attacked out of sight; raise the alarm
  // so the player knows what they left behind is falling.
  if (!isPointVisible(g, e.x, e.y)) {
    if (!Number.isFinite(structure.unseenHitAt) || g.time - structure.unseenHitAt >= 5) {
      const name = structureName(g, structure);
      say(g, `${name[0].toUpperCase()}${name.slice(1)} is UNDER ATTACK.`);
    }
    structure.unseenHitAt = g.time;
    emitAudioEvent(g, 'towerUnderAttack', structure);
  }
  g.stats.breachDamage += dmg;
  e.pendingStructDmg = (e.pendingStructDmg || 0) + dmg;

  e.structureFxCd = Math.max(0, (e.structureFxCd || 0) - dt);
  if (e.structureFxCd <= 0) {
    e.structureFxCd = e.type === 'heavy' ? 0.34 : 0.55;
    g.stats.breaches++;
    g.stats.breachesByType[e.type] = (g.stats.breachesByType[e.type] || 0) + 1;
    const r = structureRadius(structure);
    const a = Math.atan2(e.y - structure.y, e.x - structure.x);
    const ix = structure.x + Math.cos(a) * r;
    const iy = structure.y + Math.sin(a) * r;
    const heavy = e.type === 'heavy';
    burst(g, ix, iy, structure.wall ? '#b9b0a0' : e.def.color, heavy ? 22 : 12, heavy ? 7 : 5);
    burst(g, ix, iy, '#ffb347', heavy ? 18 : 9, heavy ? 6 : 4.5);
    burst(g, ix, iy, '#ffffff', heavy ? 8 : 4, 3);
    g.shockwaves.push({ x: ix, y: iy, t: 0, life: BREACH.ring.life,
      radius: (heavy ? BREACH.ring.heavyRadius : BREACH.ring.radius) * (structure.wall ? 0.6 : 1),
      color: heavy ? '#ff7a2e' : '#ffb347' });
    const cue = structure.wall ? (heavy ? 'heavyWallHit' : 'wallHit') : (heavy ? 'heavyBreach' : 'breach');
    emitAudioEvent(g, cue, { x: ix, y: iy, enemyType: e.type });

    // Close hits on one structure share one merged damage floater.
    const shown = e.pendingStructDmg;
    e.pendingStructDmg = 0;
    const structureKey = `${structure.wall ? 'w' : isTower ? 't' : 'b'}:${structure.id}`;
    const merge = g.floaters.find((f) => f.breachStructureId === structureKey && g.time - f.breachAt < BREACH.floaterMerge);
    if (merge) {
      merge.breachDamage += shown;
      merge.breachAt = g.time;
      merge.t = 0;
      merge.text = `-${Math.round(merge.breachDamage)}`;
    } else {
      floater(g, structure.x, structure.y - r - 0.7, `-${Math.max(1, Math.round(shown))}`, '#ff5a3c');
      Object.assign(g.floaters[g.floaters.length - 1], { breachStructureId: structureKey, breachAt: g.time, breachDamage: shown });
    }
  }
  // One log line when an attack on a structure begins, not one per blow.
  if (newEpisode && !structure.wall) say(g, `${e.def.name || 'An enemy'} is striking ${structureName(g, structure)}.`);
  else if (structure.wall) {
    const link = g.walls.find((w) => w.id === structure.linkId);
    if (link && (!Number.isFinite(link.hitSaidAt) || g.time - link.hitSaidAt >= 8)) {
      link.hitSaidAt = g.time;
      say(g, `${e.def.name || 'An enemy'} is battering the wall.`);
    }
  }

  if (isTower && before >= TOWER.collapsingAt && structure.hp / structure.maxHp < TOWER.collapsingAt) {
    say(g, structure.keep ? 'The Keep is COLLAPSING.' : 'A tower is COLLAPSING.');
    emitAudioEvent(g, 'collapsing', structure);
  }
  if (structure.hp <= 0) destroyStructure(g, structure, e);
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
      if (g.selectedBuildingId === null) g.selected = best.id;
    }
    g.shelter.progress = Math.min(g.shelter.required, g.shelter.progress + dt);
    g.occupiedTowerId = g.shelter.progress >= g.shelter.required ? best.id : null;
  }
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
    // D92: the player may chop at a nest, but its hp makes towers the real answer.
    for (const n of g.nests) {
      if (n.destroyed || dist(p, n) > PLAYER.melee.range + n.radius) continue;
      const ang = Math.atan2(n.y - p.y, n.x - p.x);
      const face = Math.atan2(p.facing.y, p.facing.x);
      if (Math.abs(((ang - face + Math.PI * 3) % (Math.PI * 2)) - Math.PI) > PLAYER.melee.arc / 2) continue;
      damageNest(g, n, PLAYER.melee.damage);
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
  const enemy = !!ent.def;
  // D81/D82: walls and tower footprints are solid for enemies; walls except
  // posterns are solid for the player. The tile an entity already stands in
  // never blocks it, so nothing is trapped when a wall is laid over it.
  const here = idx(clampTx(ent.x), clampTy(ent.y));
  const structureBlocks = (tx, ty) => {
    if (!inBounds(tx, ty)) return false;
    const i = idx(tx, ty);
    if (i === here) return false;
    const blocker = g.blockerGrid[i];
    if (!blocker) return false;
    if (enemy) return true;
    if (blocker.kind === 'nest') return true;
    return blocker.kind === 'wall' && !blocker.structure.gate;
  };
  const tryAxis = (nx, ny) => {
    for (const [ox, oy] of [[probe, 0], [-probe, 0], [0, probe], [0, -probe]]) {
      const tx = Math.floor(nx + ox);
      const ty = Math.floor(ny + oy);
      if (!isPassable(g.map, tx, ty)) return false;
      if (structureBlocks(tx, ty)) return false;
    }
    if (ent.def) {
      for (const tower of g.towers) {
        if (Math.hypot(nx - tower.x, ny - tower.y) < radius + tower.radius) return false;
      }
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
        t.wLevel = toLevel;
        t.upgrade = null;
        say(g, 'Weapon upgrade complete.');
        floater(g, t.x, t.y - 1.2, `W${toLevel} ONLINE`, '#5ecbff');
        emitAudioEvent(g, 'upgrade', t);
      }
    }

    const s = towerStats(g, t);

    t.shotCd -= dt;
    t.retargetIn -= dt;
    if (t.retargetIn <= 0) {
      t.retargetIn = 0.22;
      t.targetId = acquireTarget(g, t, s.range);
      // D92: a nest is the target only when no enemy or feral is in the annulus.
      t.nestTargetId = t.targetId === null ? acquireNestTarget(g, t) : null;
    }
    if (t.shotCd <= 0 && t.targetId === null && t.nestTargetId !== null) {
      const n = g.nests.find((o) => o.id === t.nestTargetId);
      if (n && towerCanHitNest(g, t, n)) {
        t.shotCd = 1 / s.fireRate;
        g.tracers.push({ x0: t.x, y0: t.y, x1: n.x, y1: n.y, t: 0,
          life: 0.09, color: s.occupied ? '#ffe680' : '#cfd6e0' });
        emitAudioEvent(g, 'towerFire', { ...t, occupied: s.occupied });
        damageNest(g, n, s.damage);
      } else {
        t.nestTargetId = null;
      }
    }
    if (t.shotCd <= 0 && t.targetId !== null) {
      const e = g.enemies.find((o) => o.id === t.targetId);
      const targetDistance = e ? dist(e, t) : Infinity;
      if (e && targetDistance >= towerMinRange(g, t) && targetDistance <= s.range
          && hasLineOfSight(g.map, t.x, t.y, e.x, e.y)) {
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

function updateBuildings(g, dt) {
  for (const b of g.buildings) {
    b.flash = Math.max(0, (b.flash || 0) - dt * 3);
    if (b.destroyed) continue;
    if (b.hp <= 0) { destroyBuilding(g, b); continue; }
    const def = BUILDINGS[b.type];
    if (!b.built) {
      const rate = constructionRateMult(g, b) / def.buildTime;
      const before = b.progress;
      b.progress = Math.min(1, b.progress + rate * dt);
      const startFraction = def.buildHpFraction ?? TOWER.buildHpFraction;
      b.hp = Math.min(b.maxHp, b.hp + (b.progress - before) * b.maxHp * (1 - startFraction));
      if (b.progress >= 1) {
        b.built = true;
        b.hp = b.maxHp;
        say(g, `${def.name} producing.`);
        emitAudioEvent(g, 'constructionComplete', b);
      }
      continue;
    }
    const key = def.resource;
    if (key === 'food') continue; // D91: Food is support (foodSupport), never a stockpile
    const gained = b.rate * dt;
    g.res[key] += gained;
    g.stats.resourcesEarned[key] += gained;
  }
}

/** Prefer whatever is chewing on this tower, then the closest thing it can see. */
function acquireTarget(g, t, range) {
  let best = null;
  let bestKey = Infinity;
  for (const e of g.enemies) {
    const d = dist(e, t);
    if (d < towerMinRange(g, t) || d > range) continue;
    const key = (e.blockerTargetId === t.id ? 0 : 1000) + d;
    if (key >= bestKey) continue;
    if (!hasLineOfSight(g.map, t.x, t.y, e.x, e.y)) continue;
    bestKey = key;
    best = e;
  }
  return best ? best.id : null;
}

function acquireNestTarget(g, t) {
  let best = null;
  let bestD = Infinity;
  for (const n of g.nests) {
    if (n.destroyed) continue;
    const d = dist(t, n);
    if (d < bestD && towerCanHitNest(g, t, n)) { best = n; bestD = d; }
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
    structMult: 1 + WAVE.structScalePerWave * (g.wave - 1),
    x: p.x + 0.5, y: p.y + 0.5,
    hp: def.hp * hpScale, maxHp: def.hp * hpScale,
    targetId: g.keepId, strategicTargetId: g.keepId,
    econTargetId: null, blockerTargetId: null,
    playerAggroUntil: 0, playerAggroCooldownUntil: 0,
    hitCd: 0, flash: 0, stuckOrigin: 'spawn',
  };
  const field = keepField(g, e.type);
  const spawn = validSpawnPosition(g, e, p, field);
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
      hp: def.hp, maxHp: def.hp, targetId: g.keepId, strategicTargetId: g.keepId,
      econTargetId: null, blockerTargetId: null, playerAggroUntil: 0, playerAggroCooldownUntil: 0,
      hitCd: 0, flash: 0, stuckOrigin: 'spawn',
    });
  }
}

function retarget(g, e) {
  const p = g.player;
  const d = dist(e, p);
  const hunting = e.targetId === PLAYER_TARGET_ID;
  const mustReturn = g.occupiedTowerId !== null
    || d > e.def.playerAggroRange * ENEMY.playerGiveUpRangeMult
    || (hunting && g.time >= e.playerAggroUntil)
    || (hunting && !structureClearLine(g, e, p));
  if (hunting && mustReturn) {
    e.targetId = g.keepId;
    e.playerAggroCooldownUntil = g.time + 0.75;
    clearProgressEpisode(e);
  }
  if (e.targetId !== PLAYER_TARGET_ID && g.occupiedTowerId === null
      && g.time >= e.playerAggroCooldownUntil
      && d <= e.def.playerAggroRange
      && hasLineOfSight(g.map, e.x, e.y, p.x, p.y)
      && structureClearLine(g, e, p)) {
    e.targetId = PLAYER_TARGET_ID;
    e.playerAggroUntil = g.time + ENEMY.playerLeash;
    e.econTargetId = null;
    clearProgressEpisode(e);
  }
}

export function isHunting(g, e) {
  return e.targetId === PLAYER_TARGET_ID && g.occupiedTowerId === null;
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

function safeNormTo(g, from, to, field) {
  return Number.isFinite(fieldValueAt(field, from.x, from.y))
    && hasClearWalk(g.map, from.x, from.y, to.x, to.y) ? normTo(from, to) : null;
}

/** True when no wall segment or tower footprint lies on the straight line. */
export function structureClearLine(g, a, b) {
  const steps = Math.max(1, Math.ceil(dist(a, b) / 0.25));
  const start = idx(clampTx(a.x), clampTy(a.y));
  const end = idx(clampTx(b.x), clampTy(b.y));
  for (let k = 1; k < steps; k++) {
    const x = a.x + (b.x - a.x) * k / steps;
    const y = a.y + (b.y - a.y) * k / steps;
    const i = idx(clampTx(x), clampTy(y));
    if (i !== start && i !== end && g.blockerGrid[i]) return false;
  }
  return hasClearWalk(g.map, a.x, a.y, b.x, b.y);
}

function nearbyEconomyTarget(g, e) {
  const current = g.buildings.find((b) => b.id === e.econTargetId && !b.destroyed) || null;
  if (current && structureClearLine(g, e, current)) return current;
  let best = null;
  let bestD = Infinity;
  for (const b of g.buildings) {
    if (b.destroyed) continue;
    const edge = dist(e, b) - structureRadius(b) - e.def.radius;
    // A wall between them protects the building (D78: walls shelter economy).
    if (edge <= ENEMY.econAggroRange && edge < bestD && structureClearLine(g, e, b)) { best = b; bestD = edge; }
  }
  e.econTargetId = best?.id ?? null;
  return best;
}

function updateEnemies(g, dt) {
  const p = g.player;

  for (const e of [...g.enemies]) {
    e.flash = Math.max(0, e.flash - dt * 4);
    e.hitCd = Math.max(0, e.hitCd - dt);
    if (e.wild) { updateFeral(g, e, dt); continue; }
    retarget(g, e);
    if (e.targetId !== PLAYER_TARGET_ID) e.targetId = g.keepId;

    // Opportunistic swipe at a player who wanders into reach, wherever it is headed.
    const dPlayer = dist(e, p);
    swipePlayer(g, e);

    const keep = keepTower(g);
    const huntingPlayer = isHunting(g, e);
    const playerGoalKey = `${clampTx(p.x)},${clampTy(p.y)}`;
    const econ = huntingPlayer ? null : nearbyEconomyTarget(g, e);
    let aim = null;
    let motionField = null;
    let motionFieldKey = null;
    let attacking = false;

    if (huntingPlayer) {
      motionField = playerField(g);
      motionFieldKey = `player:direct:${playerGoalKey}`;
      aim = interceptAim(g, e, p) || steer(g.map, motionField, e.x, e.y)
        || safeNormTo(g, e, p, motionField);
    } else if (econ) {
      motionFieldKey = `econ:${econ.id}`;
      if (dist(e, econ) <= structureReach(e, econ)) {
        attackStructure(g, e, econ, dt);
        attacking = true;
      } else aim = normTo(e, econ);
    } else if (keep) {
      motionField = keepField(g, e.type);
      motionFieldKey = `keep:${e.type}:${g.keepFields[e.type]?.version ?? 'none'}`;
      if (dist(e, keep) <= structureReach(e, keep)) {
        attackStructure(g, e, keep, dt);
        attacking = true;
      } else {
        aim = steer(g.map, motionField, e.x, e.y, keepObstacles(g, e.type)) || safeNormTo(g, e, keep, motionField);
        const blocker = aim?.i !== undefined ? g.blockerGrid[aim.i] : null;
        if (blocker && blocker.kind !== 'nest') {
          e.blockerTargetId = blocker.id;
          if (dist(e, blocker.structure) <= structureReach(e, blocker.structure)) {
            attackStructure(g, e, blocker.structure, dt);
            attacking = true;
          }
        } else e.blockerTargetId = null;
      }
    }

    // Separation keeps the crowd from collapsing into one dot.
    const { sx, sy } = separationPush(g, e);

    const terrainCost = moveCostAt(g.map, Math.floor(e.x), Math.floor(e.y));
    const speed = e.def.speed / Math.max(1, Number.isFinite(terrainCost) ? terrainCost : 1);
    const vx = (aim ? aim.x : 0) + sx * 1.6;
    const vy = (aim ? aim.y : 0) + sy * 1.6;
    const l = Math.hypot(vx, vy);
    const px = e.x;
    const py = e.y;
    if (!attacking && l > 0.01) moveWithCollision(g, e, (vx / l) * speed * dt, (vy / l) * speed * dt, e.def.radius);
    if (Math.hypot(e.x - px, e.y - py) > 1e-6) {
      const separationStrength = Math.hypot(sx, sy) * 1.6;
      e.stuckOrigin = separationStrength > (aim ? 1 : 0) ? 'separation push'
        : separationStrength > 0.15 ? 'steering + separation' : 'steering';
    }

    // Last-resort unstick. An enemy that cannot make progress and is not
    // besieging anything would otherwise hold the wave open forever.
    if (!attacking && Math.hypot(e.x - px, e.y - py) < speed * dt * 0.2) {
      e.stuck = (e.stuck || 0) + dt;
      if (e.stuck > 1.5 && motionField) {
        const nudge = bestNeighbourTile(g, motionField, e.x, e.y);
        recordStuckEpisode(g, e, motionField, 'nudge', !!nudge);
        if (nudge) { e.x = nudge.x; e.y = nudge.y; }
        e.stuck = 0;
      }
    } else {
      e.stuck = 0;
    }


    const inPlayerReach = huntingPlayer && dPlayer <= ENEMY.playerAttackRange + e.def.radius;
    if (trackEnemyProgress(g, e, motionField, motionFieldKey,
      !!motionField && !attacking && !inPlayerReach)) continue;
  }
}

function swipePlayer(g, e) {
  const p = g.player;
  if (g.occupiedTowerId !== null || dist(e, p) > ENEMY.playerAttackRange + e.def.radius
      || e.hitCd > 0 || p.hurtCd > 0 || !structureClearLine(g, e, p)) return;
  e.hitCd = ENEMY.playerHitCooldown;
  const armour = hasEquipment(g, 'armourPlate') ? DROP.equipment.armourPlate.playerDamageTaken : 1;
  const playerDamage = e.def.playerHit * armour;
  p.hp -= playerDamage;
  emitAudioEvent(g, 'playerDamage', p);
  p.hurtCd = PLAYER.invulnAfterHit;
  floater(g, p.x, p.y - 0.8, `-${Math.round(playerDamage)}`, '#ff6b6b');
  burst(g, p.x, p.y, '#ff6b6b', 5, 2.5);
}

function separationPush(g, e) {
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
  return { sx, sy };
}

/** Terrain-only field to a tile, shared by every feral heading there. */
function wildField(g, target) {
  const goal = idx(clampTx(target.x), clampTy(target.y));
  const cached = g.wildFields.get(goal);
  if (cached && g.time - cached.at < 2) return cached.field;
  for (const [key, entry] of g.wildFields) if (g.time - entry.at >= 4) g.wildFields.delete(key);
  const field = computeField(g.map, [goal], 'direct');
  g.wildFields.set(goal, { field, at: g.time });
  return field;
}

/**
 * D92: ferals guard their nest's territory. They attack the player inside it,
 * else the nearest player structure near it, else mill at home; they never
 * march on the Keep and turn back beyond the leash.
 */
function feralFocus(g, e) {
  const n = g.nests.find((o) => o.id === e.nestId);
  const home = n && !n.destroyed ? n : e.home;
  if (dist(e, home) > NEST.territory + NEST.leash) return { kind: 'home', target: home };
  if (g.occupiedTowerId === null && dist(g.player, home) <= NEST.territory) {
    return { kind: 'player', target: g.player };
  }
  const reach = NEST.territory + NEST.structureReach;
  let best = null;
  let bestD = Infinity;
  const consider = (s) => {
    if (dist(s, home) > reach) return;
    const d = dist(e, s);
    if (d < bestD) { best = s; bestD = d; }
  };
  for (const t of g.towers) consider(t);
  for (const b of g.buildings) if (!b.destroyed) consider(b);
  for (const seg of wallSegments(g)) if (seg.present !== false && !seg.destroyed && !seg.cancelled) consider(seg);
  return best ? { kind: 'structure', target: best } : { kind: 'home', target: home };
}

function updateFeral(g, e, dt) {
  if (e.fadeAt !== undefined && g.time >= e.fadeAt) {
    g.enemies = g.enemies.filter((o) => o !== e);
    burst(g, e.x, e.y, e.def.color, 10, 4);
    return;
  }
  swipePlayer(g, e);
  if (!(e.focusAt > g.time)) {
    e.focusAt = g.time + 0.5;
    e.focus = feralFocus(g, e);
  }
  const { kind, target } = e.focus;
  let aim = null;
  let attacking = false;
  e.blockerTargetId = null;
  if (kind === 'structure' && dist(e, target) <= structureReach(e, target)) {
    attackStructure(g, e, target, dt);
    if (!target.wall && !target.type) e.blockerTargetId = target.id;
    attacking = true;
  } else if (!(kind === 'home' && dist(e, target) < (target.radius || 1) + 2.2)) {
    if (structureClearLine(g, e, target)) aim = normTo(e, target);
    else {
      aim = steer(g.map, wildField(g, target), e.x, e.y);
      const blocker = aim?.i !== undefined ? g.blockerGrid[aim.i] : null;
      if (blocker && blocker.kind !== 'nest' && dist(e, blocker.structure) <= structureReach(e, blocker.structure)) {
        attackStructure(g, e, blocker.structure, dt);
        if (blocker.kind === 'tower') e.blockerTargetId = blocker.id;
        attacking = true;
      }
      if (!aim) aim = normTo(e, target);
    }
  }
  const { sx, sy } = separationPush(g, e);
  const terrainCost = moveCostAt(g.map, Math.floor(e.x), Math.floor(e.y));
  const speed = e.def.speed / Math.max(1, Number.isFinite(terrainCost) ? terrainCost : 1);
  const vx = (aim ? aim.x : 0) + sx * 1.6;
  const vy = (aim ? aim.y : 0) + sy * 1.6;
  const l = Math.hypot(vx, vy);
  if (!attacking && l > 0.01) moveWithCollision(g, e, (vx / l) * speed * dt, (vy / l) * speed * dt, e.def.radius);
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
      if (!inBounds(nx, ny) || !isPassable(g.map, nx, ny) || g.blockerGrid[idx(nx, ny)]) continue;
      const d = field[idx(nx, ny)];
      if (d < bestD) { bestD = d; best = { x: nx + 0.5, y: ny + 0.5 }; }
    }
  }
  return Number.isFinite(bestD) ? best : null;
}

function enemyFitsTile(g, e, tx, ty) {
  if (!inBounds(tx, ty) || !isPassable(g.map, tx, ty) || g.blockerGrid[idx(tx, ty)]) return false;
  if (e.def.radius <= 0.5) return true;
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      if (!inBounds(tx + ox, ty + oy) || !isPassable(g.map, tx + ox, ty + oy)
          || g.blockerGrid[idx(tx + ox, ty + oy)]) return false;
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
  if (e.wild) g.stats.feralKills++;
  emitAudioEvent(g, 'enemyDeath', e);
  burst(g, e.x, e.y, e.def.color, 12, 5);
  // A nest respawns defenders forever, so ferals never drop loot (no farming).
  if (!e.wild && Math.random() < DROP.chance) spawnDrop(g, e.x, e.y);
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

export function spawnDrop(g, x, y, forcedCategory = null, forcedKey = null) {
  const unavailable = g.equipment.length >= DROP.equipmentCap;
  const weights = DROP.categoryWeights;
  let category = forcedCategory;
  if (!category) {
    const total = weights.temporary + weights.supply + (unavailable ? 0 : weights.equipment);
    let roll = Math.random() * total;
    category = (roll -= weights.temporary) < 0 ? 'temporary'
      : (roll -= weights.supply) < 0 ? 'supply' : 'equipment';
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
  if (category === 'supply') {
    const def = DROP.supplyCache;
    const amount = Math.round(def.min + Math.random() * (def.max - def.min));
    const resource = def.resources[Math.floor(Math.random() * def.resources.length)];
    g.drops.push({ category, key: resource, resource, def, amount, x, y, t: 0 });
    emitAudioEvent(g, 'dropSpawn', { x, y, category, key: resource });
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
  } else if (d.category === 'supply') {
    g.res[d.resource] += d.amount;
    g.stats.resourcesEarned[d.resource] += d.amount;
    floater(g, g.player.x, g.player.y - 1, `+${d.amount} ${d.resource}`, d.def.color);
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
  const w = g.wave - 1;
  let budget = WAVE.budgetBase + WAVE.budgetPerWave * w + WAVE.budgetAccel * w * w;
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

/** D97: whole countdown to combat, including the final warning. */
export function assaultIn(g) {
  if (g.phase === 'prep') return Math.max(0, g.phaseLeft) + WAVE.warning;
  if (g.phase === 'warning') return Math.max(0, g.phaseLeft);
  return 0;
}

function beginWaveWarning(g, seconds = WAVE.warning) {
  g.phase = 'warning';
  g.phaseLeft = Math.min(WAVE.warning, Math.max(0, seconds));
  g.warning5Cued = false;
  const where = g.spawnSides.length
    ? g.spawnSides.map((s) => s.toUpperCase()).join(' and ')
    : 'UNKNOWN';
  say(g, `Wave ${g.wave} incoming from the ${where}.`);
  emitAudioEvent(g, 'waveWarning', g.player);
}

/** Player-facing early start; unlike forceNextWave, this preserves readiness. */
export function startWaveEarly(g) {
  if (g.status !== 'playing') return { ok: false, reason: 'game ended' };
  if (g.paused) return { ok: false, reason: 'paused' };
  if (g.phase !== 'prep' && g.phase !== 'warning') return { ok: false, reason: `unavailable during ${g.phase}` };
  const readyIn = Math.min(assaultIn(g), WAVE.earlyStartReady);
  if (g.phase === 'prep') beginWaveWarning(g, readyIn);
  else g.phaseLeft = readyIn;
  // The readiness countdown already opened with the warning cue; no second one.
  g.warning5Cued = true;
  return { ok: true };
}

function updateWaves(g, dt) {
  if (g.phase === 'prep' || g.phase === 'warning' || g.phase === 'aftermath') g.phaseLeft -= dt;

  if (g.phase === 'prep' && g.phaseLeft <= 0) {
    beginWaveWarning(g);
    return;
  }

  if (g.phase === 'warning') {
    if (g.phaseLeft <= 5 && !g.warning5Cued) {
      g.warning5Cued = true;
      emitAudioEvent(g, 'waveWarning', g.player);
    }
    if (g.phaseLeft <= 0) {
      g.phase = 'combat';
      g.phaseLeft = 0;
      g.combatT = 0;
      emitAudioEvent(g, g.wave >= WAVE.totalToSurvive ? 'finalWave' : 'waveStart', g.player);
    }
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
    // Ferals guard their nests and never hold a wave open.
    if (!g.pendingSpawns.length && !g.enemies.some((e) => !e.wild)) {
      g.phase = 'aftermath';
      g.phaseLeft = WAVE.aftermath;
      g.stats.wavesCleared++;
      say(g, `Wave ${g.wave} cleared.`);
    }
    return;
  }

  if (g.phase === 'aftermath' && g.phaseLeft <= 0) {
    if (g.wave >= WAVE.totalToSurvive) {
      g.phaseLeft = 0;
      g.status = 'won';
      emitAudioEvent(g, 'victory', g.player);
      say(g, 'The final wave broke. Run complete.');
      return;
    }
    g.wave++;
    g.phase = 'prep';
    g.phaseLeft = WAVE.prep - WAVE.warning;
    rollWave(g);
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
  return [...g.towers, ...g.buildings.filter((b) => !b.destroyed)].map((t) => ({
    id: t.id,
    kind: t.type ? 'building' : 'tower',
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

export function keepState(g) {
  const keep = keepTower(g);
  return keep ? { id: keep.id, x: keep.x, y: keep.y, hp: keep.hp, maxHp: keep.maxHp,
    built: keep.built, occupied: g.occupiedTowerId === keep.id } : null;
}

export function resourceState(g) {
  const rates = { stone: 0, gold: 0 };
  for (const b of g.buildings) {
    if (b.destroyed || !b.built || BUILDINGS[b.type].resource === 'food') continue;
    rates[BUILDINGS[b.type].resource] += b.rate;
  }
  return { totals: { ...g.res }, rates, food: garrisonState(g) };
}

export function buildingState(g) {
  return g.buildings.map((b) => ({
    id: b.id, type: b.type, x: b.x, y: b.y, hp: b.hp, maxHp: b.maxHp,
    built: b.built, progress: b.progress, destroyed: b.destroyed, rate: b.rate, siteId: b.siteId,
  }));
}

export function resourceSitesState(g) {
  return (g.map.sites || []).filter((site) => isPointVisible(g, site.x, site.y)
    || isTileExplored(g, Math.floor(site.x), Math.floor(site.y)))
    .map((site) => ({ ...site, claimed: !!activeSiteClaim(g, site.id) }));
}

export function keepFieldState(g) {
  return {
    blockerVersion: g.blockerVersion,
    recomputes: g.stats.keepFieldRecomputes,
    cachedTypes: Object.keys(g.keepFields),
    cachedVersions: Object.fromEntries(Object.entries(g.keepFields).map(([type, entry]) => [type, entry.version])),
    dirty: !!g.keepFieldsDirty,
    nextAt: g.keepFieldNextAt,
    blockers: g.blockerGrid.reduce((n, b) => n + (b ? 1 : 0), 0),
  };
}

/** Read-only acceptance surface for the cached per-type D82 field. */
export function enemyKeepField(g, type) {
  return keepField(g, type);
}

// ---------------------------------------------------------------------------
// Repair
// ---------------------------------------------------------------------------

function inRepairReach(g, s) {
  if (!s.wall && !s.type && g.occupiedTowerId === s.id) return true;
  return dist(g.player, s) - structureRadius(s) <= TOWER.repair.reach;
}

/** D83: the structure Repair would work on right now, or null. Never remote. */
export function repairTarget(g) {
  // Half an hp of slack: float build steps must not read as damage.
  const needs = (s) => s && (s.destroyed ? !!s.wall : s.hp < s.maxHp - 0.5);
  const occupied = g.towers.find((o) => o.id === g.occupiedTowerId);
  if (needs(occupied)) return occupied;
  const selected = g.towers.find((o) => o.id === g.selected)
    || g.buildings.find((b) => b.id === g.selectedBuildingId && !b.destroyed);
  if (needs(selected) && inRepairReach(g, selected)) return selected;
  let best = null;
  let bestD = Infinity;
  const candidates = [...g.towers, ...g.buildings.filter((b) => !b.destroyed),
    ...wallSegments(g).filter((s) => s.present && !s.cancelled)];
  for (const s of candidates) {
    if (!needs(s) || !inRepairReach(g, s)) continue;
    const d = dist(g.player, s) - structureRadius(s);
    if (d < bestD) { bestD = d; best = s; }
  }
  return best;
}

function updateRepair(g, dt) {
  if (!g.input.repair) return;
  const t = repairTarget(g);
  if (!t) return;
  if (t.wall && t.destroyed) { rebuildWallSegment(g, t); return; }

  const occ = occupancyMults(g);
  const rig = hasEquipment(g, 'repairRig') ? DROP.equipment.repairRig.repairSpeed : 1;
  const rate = TOWER.repair.hpPerSec * (g.occupiedTowerId === t.id && !t.type && !t.wall ? occ.repair : 1) * rig;
  const perHp = repairCostPerHp(g);
  let hp = rate * dt;
  const cost = hp * perHp;
  if (cost > g.res.stone) hp = g.res.stone / perHp;
  hp = Math.min(hp, t.maxHp - t.hp);
  if (hp <= 0) return;
  t.hp += hp;
  g.res.stone -= hp * perHp;
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
  } else if (!keepTower(g)) {
    g.status = 'lost';
    g.lossCause = 'keep';
    say(g, 'The Keep has fallen. Position lost.');
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
  updateBuildings(g, dt);
  updateGarrison(g);
  updateWalls(g, dt);
  updateKeepFieldRecomputes(g);
  recomputeVisibility(g);
  updateNests(g, dt);
  updateEnemies(g, dt);
  updateDrops(g, dt);
  updateFx(g, dt);
  resolveEndState(g);
}
