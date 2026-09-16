// Simulation. Rendering and DOM live elsewhere; nothing here touches the canvas.

import {
  MAP, T, PLAYER, TOWER, OCCUPANCY, ARCHETYPES, ENEMIES, ENEMY, AGGRO,
  WAVE, START_MATERIALS, DROP, ELEVATION_NAMES, richnessTierForRate, AUDIO,
} from './config.js';
import {
  generateMap, randomSeed, idx, inBounds, isPassable, moveCostAt,
  kindAt, elevAt, hasLineOfSight, hasClearWalk,
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
    tracers: [], particles: [], floaters: [],
    nextTowerId: 1, nextEnemyId: 1,
    selected: null, buildMode: false,
    cursor: { x: map.start.x, y: map.start.y },
    occupiedTowerId: null,
    shelter: { towerId: null, progress: 0, required: PLAYER.shelterTime },
    input: { mx: 0, my: 0, melee: false, repair: false },
    playerField: null, playerFieldAt: -99,
    log: [], audioEvents: [],
    stats: { kills: 0, towersLost: 0, materialsEarned: 0, wavesCleared: 0 },
    debug: { showPaths: false, spawnPaused: false, open: false },
  };

  const start = placeTower(g, map.start.x + 0.5, map.start.y + 0.5, true);
  start.hp = start.maxHp;
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
  const r = TOWER.radius;
  let minE = 9;
  let maxE = -1;

  for (let ty = Math.floor(y - r); ty <= Math.ceil(y + r); ty++) {
    for (let tx = Math.floor(x - r); tx <= Math.ceil(x + r); tx++) {
      if (Math.hypot(tx + 0.5 - x, ty + 0.5 - y) > r + 0.3) continue;
      if (!inBounds(tx, ty)) { reasons.push('off the map'); continue; }
      const k = kindAt(g.map, tx, ty);
      if (k === T.CLIFF) reasons.push('cliff');
      else if (k === T.DEEP) reasons.push('deep water');
      if (g.map.road[idx(tx, ty)]) reasons.push('on the road');
      const e = elevAt(g.map, tx, ty);
      minE = Math.min(minE, e);
      maxE = Math.max(maxE, e);
    }
  }
  if (maxE - minE > 1) reasons.push('ground too steep');

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

function placeTower(g, x, y, instant = false) {
  const t = {
    id: g.nextTowerId++,
    x, y,
    hp: TOWER.maxHp * (instant ? 1 : TOWER.buildHpFraction),
    maxHp: TOWER.maxHp,
    built: instant,
    progress: instant ? 1 : 0,
    wLevel: 0, eLevel: 0,
    shotCd: 0, targetId: null, retargetIn: 0,
    flash: 0, smoke: 0,
    field: null,
    resourceScore: resourceScoreAt(g.map, x, y, TOWER.extraction.radius),
  };
  g.towers.push(t);
  return t;
}

export function tryBuild(g, x, y) {
  const check = canPlaceAt(g, x, y);
  if (g.paused) return { ...check, ok: false, reasons: [...check.reasons, 'paused'] };
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
    extractRadius: TOWER.extraction.radius + u.extractRadiusPerLevel * t.eLevel,
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
  const cost = upgradeCost(t, which);
  if (cost === null || g.materials < cost || !t.built) return false;
  g.materials -= cost;
  if (which === 'weapon') t.wLevel++;
  else {
    t.eLevel++;
    t.resourceScore = resourceScoreAt(g.map, t.x, t.y, towerStats(g, t).extractRadius);
  }
  emitAudioEvent(g, 'upgrade', t);
  return true;
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
  g.towers = g.towers.filter((o) => o !== t);
  g.stats.towersLost++;
  if (g.selected === t.id) g.selected = null;
  for (const e of g.enemies) if (e.targetId === t.id) { e.targetId = null; e.sieging = false; }

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

function updatePlayer(g, dt) {
  const p = g.player;
  p.meleeCd = Math.max(0, p.meleeCd - dt);
  p.hurtCd = Math.max(0, p.hurtCd - dt);

  const speedBoost = (g.effects.speed ? DROP.temporary.speed.mult : 1)
    * (hasEquipment(g, 'boots') ? DROP.equipment.boots.playerSpeed : 1);
  const cost = moveCostAt(g.map, Math.floor(p.x), Math.floor(p.y));
  const speed = PLAYER.speed * speedBoost / (Number.isFinite(cost) ? cost : 1);

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

  if (p.hp <= 0 && g.status === 'playing') {
    g.status = 'lost';
    emitAudioEvent(g, 'playerDeath', p);
    say(g, 'You died. Run over.');
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
  const occ = occupancyMults(g);

  for (const t of [...g.towers]) {
    t.flash = Math.max(0, t.flash - dt * 3);
    if (t.hp <= 0) { destroyTower(g, t); continue; }

    if (!t.built) {
      const near = dist(g.player, t) <= PLAYER.presenceRadius;
      const rate = (near ? occ.construction : 1) / TOWER.buildTime;
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
    x: p.x + 0.5 + (Math.random() - 0.5), y: p.y + 0.5 + (Math.random() - 0.5) * 2,
    hp: def.hp * hpScale, maxHp: def.hp * hpScale,
    targetId: null, sieging: false, siegeAngle: 0,
    retargetIn: AGGRO.retargetMin + Math.random() * (AGGRO.retargetMax - AGGRO.retargetMin),
    hitCd: 0, flash: 0,
  };
  g.enemies.push(e);
  return e;
}

export function spawnGroupAt(g, x, y, typeKey, count) {
  for (let i = 0; i < count; i++) {
    const def = ENEMIES[typeKey];
    g.enemies.push({
      id: g.nextEnemyId++, type: typeKey, def, side: 'debug',
      x: x + (Math.random() - 0.5) * 3, y: y + (Math.random() - 0.5) * 3,
      hp: def.hp, maxHp: def.hp, targetId: null, sieging: false, siegeAngle: 0,
      retargetIn: Math.random() * 2, hitCd: 0, flash: 0,
    });
  }
}

function aggroScore(g, e, t) {
  let w = AGGRO.baseWeight;
  if (t.id === g.occupiedTowerId) w = AGGRO.occupiedWeight;
  if (!t.built) w *= 0.8;
  return w / (1 + dist(e, t) / AGGRO.distanceScale);
}

function playerAggroScore(g, e) {
  return AGGRO.playerWeight / (1 + dist(e, g.player) / AGGRO.playerDistanceScale);
}

/**
 * D5: an enemy already sieging keeps its target until that tower dies. Everyone
 * else re-evaluates on a personal staggered timer and only switches past a
 * margin, so aggro rolls over gradually rather than the map turning as one.
 */
function retarget(g, e) {
  const currentTower = g.towers.find((t) => t.id === e.targetId) || null;
  if (currentTower && e.sieging) return;
  const playerExposed = g.occupiedTowerId === null;
  const currentIsPlayer = e.targetId === PLAYER_TARGET_ID && playerExposed;
  let best = currentTower ? currentTower.id : currentIsPlayer ? PLAYER_TARGET_ID : null;
  let bestScore = currentTower ? aggroScore(g, e, currentTower) * AGGRO.switchMargin
    : currentIsPlayer ? playerAggroScore(g, e) * AGGRO.switchMargin : -1;
  for (const t of g.towers) {
    if (t === currentTower) continue;
    const s = aggroScore(g, e, t);
    if (s > bestScore) { bestScore = s; best = t.id; }
  }
  if (playerExposed && !currentIsPlayer) {
    const s = playerAggroScore(g, e);
    if (s > bestScore) { bestScore = s; best = PLAYER_TARGET_ID; }
  }
  if (best !== e.targetId) { e.targetId = best; e.sieging = false; }
}

function playerField(g) {
  if (g.time - g.playerFieldAt > 0.5) {
    g.playerFieldAt = g.time;
    g.playerField = computeField(g.map, [idx(clampTx(g.player.x), clampTy(g.player.y))], 'direct');
  }
  return g.playerField;
}

function updateEnemies(g, dt) {
  const p = g.player;

  for (const e of [...g.enemies]) {
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

    const resolved = g.towers.find((t) => t.id === e.targetId) || null;
    const huntingPlayer = e.targetId === PLAYER_TARGET_ID && g.occupiedTowerId === null;
    let aim = null;
    let reach = 0;

    if (resolved) {
      reach = TOWER.radius + ENEMY.attackRange + e.def.radius;
      const d = dist(e, resolved);
      if (d <= reach) {
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
        aim = steer(g.map, towerField(g, resolved), e.x, e.y);
        if (!aim) aim = normTo(e, resolved);
      }
    } else if (huntingPlayer) {
      aim = interceptAim(g, e, p) || steer(g.map, playerField(g), e.x, e.y) || normTo(e, p);
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

    const speed = e.def.speed / Math.max(1, moveCostAt(g.map, Math.floor(e.x), Math.floor(e.y)));
    const vx = (aim ? aim.x : 0) + sx * 1.6;
    const vy = (aim ? aim.y : 0) + sy * 1.6;
    const l = Math.hypot(vx, vy);
    const px = e.x;
    const py = e.y;
    if (l > 0.01) moveWithCollision(g, e, (vx / l) * speed * dt, (vy / l) * speed * dt, e.def.radius);

    // Last-resort unstick. An enemy that cannot make progress and is not
    // besieging anything would otherwise hold the wave open forever.
    if (!e.sieging && Math.hypot(e.x - px, e.y - py) < speed * dt * 0.2) {
      e.stuck = (e.stuck || 0) + dt;
      if (e.stuck > 1.5 && (resolved || huntingPlayer)) {
        const nudge = bestNeighbourTile(g, resolved ? towerField(g, resolved) : playerField(g), e.x, e.y);
        if (nudge) { e.x = nudge.x; e.y = nudge.y; }
        e.stuck = 0;
      }
    } else {
      e.stuck = 0;
    }
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
  return {
    sheltered: g.occupiedTowerId !== null,
    shelterTowerId: g.shelter.towerId,
    shelterProgress: g.shelter.required ? g.shelter.progress / g.shelter.required : 0,
    hunters: g.enemies.filter((e) => e.targetId === PLAYER_TARGET_ID).length,
  };
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
  for (const a of [g.tracers, g.particles, g.floaters]) {
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

export function update(g, dt, { ignorePause = false } = {}) {
  if (g.paused && !ignorePause) return;
  if (g.status !== 'playing') { updateFx(g, dt); return; }
  g.time += dt;
  updateWaves(g, dt);
  updatePlayer(g, dt);
  updateRepair(g, dt);
  updateTowers(g, dt);
  updateEnemies(g, dt);
  updateDrops(g, dt);
  updateFx(g, dt);
}
