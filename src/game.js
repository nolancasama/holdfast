// Simulation. Rendering and DOM live elsewhere; nothing here touches the canvas.

import {
  MAP, T, PLAYER, TOWER, OCCUPANCY, ARCHETYPES, ENEMIES, ENEMY, AGGRO,
  WAVE, START_MATERIALS, DROP,
} from './config.js';
import {
  generateMap, randomSeed, idx, inBounds, isPassable, moveCostAt,
  kindAt, elevAt, hasLineOfSight,
} from './terrain.js';
import { computeField, steer } from './flowfield.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// ---------------------------------------------------------------------------

export function createGame(seedString, archetypeKey) {
  const seed = seedString || randomSeed();
  const map = generateMap(seed);
  const arch = ARCHETYPES[archetypeKey] || ARCHETYPES.gunner;

  const g = {
    seed, map, arch, archetypeKey,
    time: 0,
    status: 'playing',
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
    effects: {},
    towers: [], enemies: [], drops: [],
    tracers: [], particles: [], floaters: [],
    nextTowerId: 1, nextEnemyId: 1,
    selected: null, buildMode: false,
    cursor: { x: map.start.x, y: map.start.y },
    occupiedTowerId: null,
    input: { mx: 0, my: 0, melee: false, repair: false },
    playerField: null, playerFieldAt: -99,
    log: [],
    stats: { kills: 0, towersLost: 0, materialsEarned: 0, wavesCleared: 0 },
    debug: { showPaths: false, spawnPaused: false, open: false },
  };

  const start = placeTower(g, map.start.x + 0.5, map.start.y + 0.5, true);
  start.hp = start.maxHp;
  say(g, `Seed ${seed} — objective zone lies to the ${map.objective.side}.`);
  return g;
}

function say(g, text) {
  g.log.unshift({ text, t: g.time });
  if (g.log.length > 7) g.log.pop();
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
  return {
    ok: unique.length === 0,
    reasons: unique,
    cost,
    income: resourceScoreAt(g.map, x, y, eRadius) * TOWER.extraction.baseRate,
    coverage: coverageAt(g.map, x, y, TOWER.weapon.range),
    inObjective: Math.hypot(g.map.objective.x + 0.5 - x, g.map.objective.y + 0.5 - y) <= g.map.objective.r,
    terrain: kindAt(g.map, Math.floor(x), Math.floor(y)),
    elev: elevAt(g.map, Math.floor(x), Math.floor(y)),
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
    isObjective: Math.hypot(g.map.objective.x + 0.5 - x, g.map.objective.y + 0.5 - y) <= g.map.objective.r,
  };
  g.towers.push(t);
  return t;
}

export function tryBuild(g, x, y) {
  const check = canPlaceAt(g, x, y);
  if (!check.ok) return check;
  g.materials -= check.cost;
  const t = placeTower(g, x, y, false);
  g.selected = t.id;
  say(g, t.isObjective ? 'Construction started in the OBJECTIVE ZONE.' : 'Construction started.');
  return check;
}

export function occupancyMults(g) {
  return { ...OCCUPANCY, ...g.arch.occupancy };
}

export function towerStats(g, t) {
  const occupied = g.occupiedTowerId === t.id;
  const m = occupied ? occupancyMults(g) : { damage: 1, fireRate: 1, extraction: 1, damageTaken: 1 };
  const u = TOWER.upgrade;
  const dmgBoost = g.effects.damage ? DROP.types.damage.mult : 1;
  const extBoost = g.effects.extraction ? DROP.types.extraction.mult : 1;
  return {
    occupied,
    damage: TOWER.weapon.damage * (1 + u.weaponDamagePerLevel * t.wLevel) * m.damage * dmgBoost,
    fireRate: TOWER.weapon.fireRate * (1 + u.weaponRatePerLevel * t.wLevel) * m.fireRate,
    range: TOWER.weapon.range + u.weaponRangePerLevel * t.wLevel,
    extractRadius: TOWER.extraction.radius + u.extractRadiusPerLevel * t.eLevel,
    income: t.resourceScore * TOWER.extraction.baseRate
            * (1 + u.extractRatePerLevel * t.eLevel) * m.extraction * extBoost,
    damageTaken: m.damageTaken,
  };
}

export function upgradeCost(t, which) {
  const level = which === 'weapon' ? t.wLevel : t.eLevel;
  if (level >= TOWER.upgrade.maxLevel) return null;
  return (which === 'weapon' ? TOWER.upgrade.weaponCost : TOWER.upgrade.extractionCost)[level];
}

export function tryUpgrade(g, t, which) {
  const cost = upgradeCost(t, which);
  if (cost === null || g.materials < cost || !t.built) return false;
  g.materials -= cost;
  if (which === 'weapon') t.wLevel++;
  else {
    t.eLevel++;
    t.resourceScore = resourceScoreAt(g.map, t.x, t.y, towerStats(g, t).extractRadius);
  }
  return true;
}

export function repairCostPerHp(g) {
  return TOWER.repair.costPerHp * g.arch.repairCostMult;
}

function towerField(g, t) {
  if (!t.field) t.field = computeField(g.map, [idx(clampTx(t.x), clampTy(t.y))]);
  return t.field;
}
const clampTx = (x) => clamp(Math.floor(x), 0, MAP.w - 1);
const clampTy = (y) => clamp(Math.floor(y), 0, MAP.h - 1);

function destroyTower(g, t) {
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
    const dmg = PLAYER.maxHp * TOWER.collapseDamageFrac;
    g.player.hp -= dmg;
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

  const speedBoost = g.effects.speed ? DROP.types.speed.mult : 1;
  const cost = moveCostAt(g.map, Math.floor(p.x), Math.floor(p.y));
  const speed = PLAYER.speed * speedBoost / (Number.isFinite(cost) ? cost : 1);

  let { mx, my } = g.input;
  const len = Math.hypot(mx, my);
  if (len > 0) {
    mx /= len; my /= len;
    p.facing = { x: mx, y: my };
    moveWithCollision(g, p, mx * speed * dt, my * speed * dt, PLAYER.radius);
  }

  if (g.phase === 'prep' && p.hp < p.maxHp) p.hp = Math.min(p.maxHp, p.hp + PLAYER.regen * dt);

  // Occupied Tower: the nearest finished tower the player is standing in.
  let best = null;
  let bestD = PLAYER.presenceRadius;
  for (const t of g.towers) {
    if (!t.built) continue;
    const d = dist(p, t);
    if (d <= bestD) { bestD = d; best = t; }
  }
  const prev = g.occupiedTowerId;
  g.occupiedTowerId = best ? best.id : null;
  if (best && prev !== best.id) g.selected = best.id;

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
        say(g, t.isObjective ? 'OBJECTIVE tower online.' : 'Tower online.');
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
        damageEnemy(g, e, s.damage);
      } else {
        t.targetId = null;
      }
    }

    if (t.hp / t.maxHp < TOWER.collapsingAt) {
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
  else if (t.isObjective) w = AGGRO.objectiveWeight;
  if (!t.built) w *= 0.8;
  return w / (1 + dist(e, t) / AGGRO.distanceScale);
}

/**
 * D5: an enemy already sieging keeps its target until that tower dies. Everyone
 * else re-evaluates on a personal staggered timer and only switches past a
 * margin, so aggro rolls over gradually rather than the map turning as one.
 */
function retarget(g, e) {
  if (!g.towers.length) { e.targetId = null; return; }
  const current = g.towers.find((t) => t.id === e.targetId) || null;
  if (current && e.sieging) return;

  let best = current;
  let bestScore = current ? aggroScore(g, e, current) * AGGRO.switchMargin : -1;
  for (const t of g.towers) {
    if (t === current) continue;
    const s = aggroScore(g, e, t);
    if (s > bestScore) { bestScore = s; best = t; }
  }
  if (best && best !== current) { e.targetId = best.id; e.sieging = false; }
  else if (!current && best) e.targetId = best.id;
}

function playerField(g) {
  if (g.time - g.playerFieldAt > 0.5) {
    g.playerFieldAt = g.time;
    g.playerField = computeField(g.map, [idx(clampTx(g.player.x), clampTy(g.player.y))]);
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
      e.targetId = null;
      e.sieging = false;
    }
    if (e.targetId === null && g.towers.length) retarget(g, e);

    // Opportunistic swipe at a player who wanders into reach, wherever it is headed.
    const dPlayer = dist(e, p);
    if (dPlayer <= ENEMY.playerAttackRange + e.def.radius && e.hitCd <= 0 && p.hurtCd <= 0) {
      e.hitCd = ENEMY.playerHitCooldown;
      p.hp -= e.def.playerHit;
      p.hurtCd = PLAYER.invulnAfterHit;
      floater(g, p.x, p.y - 0.8, `-${e.def.playerHit}`, '#ff6b6b');
      burst(g, p.x, p.y, '#ff6b6b', 5, 2.5);
    }

    const resolved = g.towers.find((t) => t.id === e.targetId) || null;
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
        resolved.flash = 1;
        if (before >= TOWER.collapsingAt && resolved.hp / resolved.maxHp < TOWER.collapsingAt) {
          say(g, resolved.isObjective ? 'OBJECTIVE TOWER IS COLLAPSING.' : 'A tower is COLLAPSING.');
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
    } else {
      // No towers left anywhere: come for the player.
      aim = steer(g.map, playerField(g), e.x, e.y) || normTo(e, p);
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
      if (e.stuck > 1.5 && resolved) {
        const nudge = bestNeighbourTile(g, towerField(g, resolved), e.x, e.y);
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
  if (e.hp > 0) return;
  g.enemies = g.enemies.filter((o) => o !== e);
  g.stats.kills++;
  burst(g, e.x, e.y, e.def.color, 12, 5);
  if (Math.random() < DROP.chance) spawnDrop(g, e.x, e.y);
}

// ---------------------------------------------------------------------------
// Drops
// ---------------------------------------------------------------------------

function spawnDrop(g, x, y) {
  const keys = Object.keys(DROP.types);
  const key = keys[Math.floor(Math.random() * keys.length)];
  g.drops.push({ key, def: DROP.types[key], x, y, t: 0 });
}

function updateDrops(g, dt) {
  for (const d of [...g.drops]) {
    d.t += dt;
    if (d.t >= DROP.lifetime) { g.drops = g.drops.filter((o) => o !== d); continue; }
    if (dist(d, g.player) <= DROP.pickupRadius) {
      g.drops = g.drops.filter((o) => o !== d);
      if (d.def.instant) {
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
    return;
  }

  if (g.phase === 'warning' && g.phaseLeft <= 0) {
    g.phase = 'combat';
    g.phaseLeft = 0;
    g.combatT = 0;
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
      if (g.wave >= WAVE.totalToSurvive && objectiveHeld(g)) {
        g.status = 'won';
        say(g, 'Objective held and the line survived. Run complete.');
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

export function objectiveHeld(g) {
  return g.towers.some((t) => t.isObjective && t.built && t.hp > 0);
}

export function forceNextWave(g) {
  if (g.phase === 'combat') return;
  g.phase = 'prep';
  g.phaseLeft = 0;
}

// ---------------------------------------------------------------------------
// Repair
// ---------------------------------------------------------------------------

function updateRepair(g, dt) {
  if (!g.input.repair) return;
  const t = g.towers.find((o) => o.id === (g.occupiedTowerId ?? g.selected));
  if (!t || t.hp >= t.maxHp || !t.built) return;

  const occ = occupancyMults(g);
  const rate = TOWER.repair.hpPerSec * (g.occupiedTowerId === t.id ? occ.repair : 1);
  const perHp = repairCostPerHp(g);
  let hp = rate * dt;
  const cost = hp * perHp;
  if (cost > g.materials) hp = g.materials / perHp;
  hp = Math.min(hp, t.maxHp - t.hp);
  if (hp <= 0) return;
  t.hp += hp;
  g.materials -= hp * perHp;
  if (Math.random() < 0.25) burst(g, t.x, t.y - 0.5, '#5ecbff', 2, 1.5);
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

export function update(g, dt) {
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
