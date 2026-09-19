// D67-D69 headless before/after measurement harness.
// Usage: node tools/pacing-report.js [source-root] [label]

import path from 'node:path';
import { pathToFileURL } from 'node:url';

const sourceRoot = path.resolve(process.argv[2] || '.');
const label = process.argv[3] || path.basename(sourceRoot);
const load = (relative) => import(pathToFileURL(path.join(sourceRoot, relative)).href);
const [config, terrain, game] = await Promise.all([
  load('src/config.js'), load('src/terrain.js'), load('src/game.js'),
]);

const {
  MAP, T, PLAYER, TOWER, ENEMIES, ENEMY, RICHNESS,
  richnessTierForRate,
} = config;
const {
  generateMap, idx, inBounds, isPassable, isTerrainBuildable,
  hasLineOfSight, hasClearWalk, clearTowerForest,
} = terrain;
const {
  createGame, update, forceNextWave, canPlaceAt, tryBuild, resourceScoreAt,
} = game;

const CANONICAL = [
  'ALPHA', 'BRAVO', 'CHARLIE', 'DELTA', 'ECHO', 'FOXTROT', 'GOLF', 'HOTEL',
  'INDIA', 'JULIET', 'KILO', 'LIMA', 'MIKE', 'NOVEMBER', 'OSCAR', 'PAPA',
  'QUEBEC', 'ROMEO', 'SIERRA', 'TANGO',
];
const SIM_SEEDS = CANONICAL.slice(0, 8);
const ECONOMY_SEEDS = [...CANONICAL, ...Array.from({ length: 24 }, (_, n) => `PACE-${String(n).padStart(2, '0')}`)];

function withSeededRandom(seed, fn) {
  const previous = Math.random;
  let state = 2166136261;
  for (const ch of seed) state = Math.imul(state ^ ch.charCodeAt(0), 16777619) >>> 0;
  Math.random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  try { return fn(); } finally { Math.random = previous; }
}

function quantile(values, q) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const at = (sorted.length - 1) * q;
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo);
}

function distribution(values) {
  const finite = values.filter(Number.isFinite);
  return {
    n: finite.length,
    min: finite.length ? Math.min(...finite) : null,
    p25: quantile(finite, 0.25),
    median: quantile(finite, 0.5),
    p75: quantile(finite, 0.75),
    max: finite.length ? Math.max(...finite) : null,
  };
}

function beginRealWave(g, wave = 8) {
  g.wave = wave;
  forceNextWave(g);
  update(g, 0);
  g.phaseLeft = 0;
  update(g, 0);
  if (g.phase !== 'combat') throw new Error(`wave ${wave} did not enter combat (${g.phase})`);
}

function occupy(g, tower) {
  g.player.x = tower.x;
  g.player.y = tower.y;
  g.player.hp = g.player.maxHp = 1e9;
  g.shelter = { towerId: tower.id, progress: PLAYER.shelterTime, required: PLAYER.shelterTime };
  g.occupiedTowerId = tower.id;
  g.input = { mx: 0, my: 0, melee: false, repair: false };
}

function runEngagement(seed, feature = false) {
  return withSeededRandom(`ENGAGEMENT-${seed}`, () => {
    const g = createGame(seed, 'gunner');
    let tower = g.towers[0];
    let site = 'start';
    if (feature) {
      const best = [...g.map.exposureFeatures]
        .filter((entry) => entry.kind === 'hairpin' || entry.kind === 'horseshoe')
        .sort((a, b) => b.exposure - a.exposure)[0];
      if (!best) return { skipped: 'no hairpin/horseshoe' };
      // Exercise the real placement path at the D52 site. The generated start
      // tower is removed only for this isolated engagement measurement.
      g.towers = [];
      g.materials = 99999;
      g.player.x = best.x;
      g.player.y = best.y;
      const built = tryBuild(g, best.x, best.y);
      if (!built.ok) return { skipped: `feature build refused: ${built.reasons.join(',')}` };
      tower = g.towers[0];
      tower.built = true;
      tower.progress = 1;
      site = `${best.kind}@${best.x.toFixed(1)},${best.y.toFixed(1)}`;
    }
    tower.wLevel = 0;
    tower.hp = tower.maxHp = 1e9;
    occupy(g, tower);
    beginRealWave(g, 8);

    const observations = new Map();
    const completed = [];
    const dt = 0.05;
    for (let elapsed = 0; elapsed < 300 && g.phase === 'combat' && g.status === 'playing'; elapsed += dt) {
      for (const enemy of g.enemies) {
        let row = observations.get(enemy.id);
        if (!row) {
          row = { id: enemy.id, type: enemy.type, seconds: 0, reached: false,
            diedInRange: false, lastInRange: false, ref: enemy };
          observations.set(enemy.id, row);
        }
        const inRange = Math.hypot(enemy.x - tower.x, enemy.y - tower.y) <= TOWER.weapon.range
          && hasLineOfSight(g.map, tower.x, tower.y, enemy.x, enemy.y);
        row.lastInRange = inRange;
        if (inRange) row.seconds += dt;
        const reach = TOWER.radius + ENEMY.attackRange + enemy.def.radius;
        if (enemy.sieging || Math.hypot(enemy.x - tower.x, enemy.y - tower.y) <= reach) row.reached = true;
      }
      update(g, dt);
      const alive = new Set(g.enemies.map((enemy) => enemy.id));
      for (const [id, row] of observations) {
        if (row.done || alive.has(id)) continue;
        row.done = true;
        row.diedInRange = row.ref.hp <= 0 && row.lastInRange;
        completed.push(row);
      }
    }
    for (const row of observations.values()) if (!row.done) completed.push(row);
    return { seed, site, rows: completed };
  });
}

function engagementSummary(runs) {
  const summary = {};
  for (const type of Object.keys(ENEMIES)) {
    const rows = runs.flatMap((run) => run.rows || []).filter((row) => row.type === type);
    summary[type] = {
      engagementSeconds: distribution(rows.map((row) => row.seconds)),
      diedInRangeFraction: rows.length ? rows.filter((row) => row.diedInRange).length / rows.length : null,
      reachedTowerFraction: rows.length ? rows.filter((row) => row.reached).length / rows.length : null,
    };
  }
  return summary;
}

function exposedSpot(g, tower) {
  for (const radius of [4, 5, 6]) for (let sample = 0; sample < 32; sample++) {
    const angle = sample * Math.PI * 2 / 32;
    const x = tower.x + Math.cos(angle) * radius;
    const y = tower.y + Math.sin(angle) * radius;
    if (isPassable(g.map, Math.floor(x), Math.floor(y))) return { x, y };
  }
  return null;
}

function stageMidWave(g, tower, nearby = 6) {
  const shotCd = tower.shotCd;
  tower.shotCd = 1e9;
  for (let elapsed = 0; elapsed < 180 && g.phase === 'combat'; elapsed += 0.05) {
    update(g, 0.05);
    const close = g.enemies.filter((enemy) => Math.hypot(enemy.x - tower.x, enemy.y - tower.y) <= 12).length;
    if (close >= nearby) {
      tower.shotCd = shotCd;
      return { ok: true, close, elapsed };
    }
  }
  tower.shotCd = shotCd;
  return { ok: false, close: 0, elapsed: 180 };
}

function runStandingExposure(seed) {
  return withSeededRandom(`EXPOSURE-STAND-${seed}`, () => {
    const g = createGame(seed, 'gunner');
    const tower = g.towers[0];
    tower.hp = tower.maxHp = 1e9;
    occupy(g, tower);
    beginRealWave(g, 8);
    const staged = stageMidWave(g, tower);
    const spot = exposedSpot(g, tower);
    if (!staged.ok || !spot) return { seed, preconditionFailed: !spot ? 'no exposed spot' : 'no nearby pack' };
    g.player.x = spot.x;
    g.player.y = spot.y;
    g.player.hp = g.player.maxHp = PLAYER.maxHp;
    g.shelter = { towerId: null, progress: 0, required: PLAYER.shelterTime };
    g.occupiedTowerId = null;
    let firstHit = null;
    let death = null;
    let previousHp = g.player.hp;
    const dt = 0.02;
    for (let elapsed = 0; elapsed < 30 && g.status === 'playing'; elapsed += dt) {
      update(g, dt);
      if (firstHit === null && g.player.hp < previousHp) firstHit = elapsed + dt;
      previousHp = g.player.hp;
      if (g.player.hp <= 0) { death = elapsed + dt; break; }
    }
    return { seed, firstHit, death };
  });
}

function findDashSite(g, tower, targetDistance) {
  const candidates = [];
  for (let y = 2; y < MAP.h - 2; y++) for (let x = 2; x < MAP.w - 2; x++) {
    const cx = x + 0.5;
    const cy = y + 0.5;
    const distance = Math.hypot(cx - tower.x, cy - tower.y);
    if (Math.abs(distance - targetDistance) > 2.5) continue;
    if (!canPlaceAt(g, cx, cy).ok || !hasClearWalk(g.map, tower.x, tower.y, cx, cy)) continue;
    candidates.push({ x: cx, y: cy, distance, delta: Math.abs(distance - targetDistance) });
  }
  candidates.sort((a, b) => a.delta - b.delta || a.y - b.y || a.x - b.x);
  return candidates[0] || null;
}

function runDash(seed, category, targetDistance) {
  return withSeededRandom(`EXPOSURE-DASH-${category}-${seed}`, () => {
    const g = createGame(seed, 'gunner');
    const start = g.towers[0];
    g.materials = 99999;
    const site = findDashSite(g, start, targetDistance);
    if (!site) return { seed, preconditionFailed: 'no straight buildable corridor' };
    g.player.x = site.x;
    g.player.y = site.y;
    const built = tryBuild(g, site.x, site.y);
    if (!built.ok) return { seed, preconditionFailed: `build refused: ${built.reasons.join(',')}` };
    const destination = g.towers[g.towers.length - 1];
    destination.built = true;
    destination.progress = 1;
    destination.hp = destination.maxHp = 1e9;
    start.hp = start.maxHp = 1e9;
    occupy(g, start);
    beginRealWave(g, 8);
    const staged = stageMidWave(g, start);
    if (!staged.ok) return { seed, preconditionFailed: 'no nearby pack' };
    g.player.hp = g.player.maxHp = PLAYER.maxHp;
    const before = g.player.hp;
    let reached = false;
    const dt = 0.02;
    for (let elapsed = 0; elapsed < 30 && g.status === 'playing'; elapsed += dt) {
      const dx = destination.x - g.player.x;
      const dy = destination.y - g.player.y;
      const length = Math.hypot(dx, dy);
      g.input = { mx: dx / Math.max(length, 1e-9), my: dy / Math.max(length, 1e-9), melee: false, repair: false };
      update(g, dt);
      if (Math.hypot(destination.x - g.player.x, destination.y - g.player.y) <= 0.45) {
        reached = true;
        break;
      }
    }
    return {
      seed, category, distance: site.distance,
      hpLost: before - Math.max(0, g.player.hp), death: g.player.hp <= 0, reached,
    };
  });
}

function runShelteredOutcome(seed) {
  return withSeededRandom(`SHELTERED-${seed}`, () => {
    const g = createGame(seed, 'gunner');
    let tower = g.towers[0];
    occupy(g, tower);
    g.player.maxHp = g.player.hp = 1e9;
    g.input = { mx: 0, my: 0, melee: false, repair: false };
    const waves = [];
    let active = null;
    let previousPhase = g.phase;
    let previousHp = tower.hp;
    const reached = new Set();
    const dt = 0.1;
    for (let elapsed = 0; elapsed < 1200 && g.status === 'playing'; elapsed += dt) {
      update(g, dt);
      tower = g.towers.find((entry) => entry.id === tower.id) || tower;
      if (g.phase === 'combat' && previousPhase !== 'combat') {
        active = { wave: g.wave, duration: 0, towerHpLost: 0, enemiesReaching: 0 };
        previousHp = tower.hp;
        reached.clear();
      }
      if (active && previousHp > tower.hp) active.towerHpLost += previousHp - tower.hp;
      previousHp = tower.hp;
      if (active && g.phase === 'combat') {
        active.duration += dt;
        for (const enemy of g.enemies) {
          const reach = TOWER.radius + ENEMY.attackRange + enemy.def.radius;
          if (enemy.sieging || Math.hypot(enemy.x - tower.x, enemy.y - tower.y) <= reach) reached.add(enemy.id);
        }
      }
      if (active && previousPhase === 'combat' && g.phase !== 'combat') {
        active.enemiesReaching = reached.size;
        waves.push(active);
        active = null;
      }
      previousPhase = g.phase;
    }
    if (active) {
      active.enemiesReaching = reached.size;
      waves.push(active);
    }
    return { seed, wavesSurvived: g.stats.wavesCleared, status: g.status, waves };
  });
}

function economyReport() {
  const rows = [];
  const generationMs = [];
  for (const seed of ECONOMY_SEEDS) {
    const started = performance.now();
    const map = generateMap(seed);
    generationMs.push(performance.now() - started);
    const startIncome = resourceScoreAt(map, map.start.x + 0.5, map.start.y + 0.5, TOWER.extraction.radius)
      * TOWER.extraction.baseRate;
    let richSites = 0;
    let bestIncome = 0;
    for (let y = 0; y < MAP.h; y++) for (let x = 0; x < MAP.w; x++) {
      if (Math.hypot(x - map.start.x, y - map.start.y) < 12) continue;
      if (!isTerrainBuildable(map, x + 0.5, y + 0.5)) continue;
      const income = resourceScoreAt(map, x + 0.5, y + 0.5, TOWER.extraction.radius)
        * TOWER.extraction.baseRate;
      if (income >= RICHNESS.moderateMax) richSites++;
      bestIncome = Math.max(bestIncome, income);
    }
    let roadTilesInRange = 0;
    for (let y = 0; y < MAP.h; y++) for (let x = 0; x < MAP.w; x++) {
      if (map.road[idx(x, y)]
          && Math.hypot(x - map.start.x, y - map.start.y) <= TOWER.weapon.range) roadTilesInRange++;
    }
    rows.push({
      seed, startIncome, startTier: richnessTierForRate(startIncome).key,
      richSites, bestIncome, bestStartRatio: bestIncome / startIncome, roadTilesInRange,
    });
  }
  return {
    seeds: rows.length,
    startIncome: distribution(rows.map((row) => row.startIncome)),
    richSiteCount: distribution(rows.map((row) => row.richSites)),
    bestStartRatio: distribution(rows.map((row) => row.bestStartRatio)),
    generationMs: distribution(generationMs),
    canonical: rows.filter((row) => CANONICAL.includes(row.seed)),
    failures: rows.filter((row) => row.startIncome < 0.8 || row.startIncome > 1.0
      || row.startTier !== 'moderate' || row.richSites < 1).map((row) => row.seed),
  };
}

function blockedTile(map, x0, y0, x1, y1) {
  let cx = Math.floor(x0);
  let cy = Math.floor(y0);
  const tx = Math.floor(x1);
  const ty = Math.floor(y1);
  const dx = Math.abs(tx - cx);
  const dy = Math.abs(ty - cy);
  const sx = cx < tx ? 1 : -1;
  const sy = cy < ty ? 1 : -1;
  let err = dx - dy;
  for (;;) {
    if (cx === tx && cy === ty) return null;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; cx += sx; }
    if (e2 < dx) { err += dx; cy += sy; }
    if (cx === tx && cy === ty) return null;
    if (map.kind[idx(cx, cy)] === T.FOREST) return { x: cx, y: cy };
  }
}

function forestReproduction() {
  for (const seed of CANONICAL) {
    const map = generateMap(seed);
    for (let ty = 3; ty < MAP.h - 3; ty++) for (let tx = 3; tx < MAP.w - 3; tx++) {
      if (map.kind[idx(tx, ty)] !== T.FOREST || !isTerrainBuildable(map, tx + 0.5, ty + 0.5)) continue;
      const tower = { x: tx + 0.5, y: ty + 0.5 };
      const distance = TOWER.radius + ENEMY.attackRange + ENEMIES.heavy.radius - 0.35;
      for (let sample = 0; sample < 64; sample++) {
        const angle = sample * Math.PI * 2 / 64;
        const enemy = { x: tower.x + Math.cos(angle) * distance, y: tower.y + Math.sin(angle) * distance };
        if (!inBounds(Math.floor(enemy.x), Math.floor(enemy.y))
            || hasLineOfSight(map, tower.x, tower.y, enemy.x, enemy.y)) continue;
        const blocker = blockedTile(map, tower.x, tower.y, enemy.x, enemy.y);
        const row = { seed, tower, enemy, blocker, beforeLos: false };
        if (clearTowerForest) {
          clearTowerForest(map, tower.x, tower.y);
          row.afterLos = hasLineOfSight(map, tower.x, tower.y, enemy.x, enemy.y);
          const distant = { x: tower.x + Math.cos(angle) * 6, y: tower.y + Math.sin(angle) * 6 };
          row.distantLos = hasLineOfSight(map, tower.x, tower.y, distant.x, distant.y);
        }
        return row;
      }
    }
  }
  return null;
}

function clearingPerformance() {
  if (!clearTowerForest) return { available: false };
  const size = MAP.w * MAP.h;
  const map = {
    w: MAP.w, h: MAP.h, kind: new Uint8Array(size).fill(T.FOREST),
    elev: new Uint8Array(size).fill(1), res: new Float32Array(size),
    road: new Uint8Array(size), terrainVersion: 0,
  };
  const original = map.kind.slice();
  const samples = [];
  for (let n = 0; n < 2000; n++) {
    map.kind.set(original);
    map.terrainVersion = 0;
    const started = performance.now();
    clearTowerForest(map, 52.5, 26.5);
    samples.push(performance.now() - started);
  }
  return { available: true, milliseconds: distribution(samples) };
}

const startEngagementRuns = SIM_SEEDS.map((seed) => runEngagement(seed, false));
const featureEngagementRuns = SIM_SEEDS.map((seed) => runEngagement(seed, true));
const standingRuns = SIM_SEEDS.map(runStandingExposure);
const dashSpecs = [['short-covered', 8], ['mid-covered', 13], ['long-uncovered', 24]];
const dashRuns = Object.fromEntries(dashSpecs.map(([name, distance]) => [
  name, SIM_SEEDS.map((seed) => runDash(seed, name, distance)),
]));
const waveRuns = SIM_SEEDS.map(runShelteredOutcome);

const report = {
  label,
  speeds: { player: PLAYER.speed, swarm: ENEMIES.swarm.speed, runner: ENEMIES.runner.speed, heavy: ENEMIES.heavy.speed },
  engagement: {
    start: engagementSummary(startEngagementRuns),
    feature: engagementSummary(featureEngagementRuns),
    featureSites: featureEngagementRuns.map((run) => ({ seed: run.seed, site: run.site, skipped: run.skipped })),
  },
  exposure: {
    standing: {
      firstHitSeconds: distribution(standingRuns.map((run) => run.firstHit)),
      deathSeconds: distribution(standingRuns.map((run) => run.death)),
      preconditionFailures: standingRuns.filter((run) => run.preconditionFailed),
    },
    dashes: Object.fromEntries(Object.entries(dashRuns).map(([name, runs]) => [name, {
      hpLost: distribution(runs.map((run) => run.hpLost)),
      deaths: runs.filter((run) => run.death).length,
      completed: runs.filter((run) => run.reached).length,
      distances: distribution(runs.map((run) => run.distance)),
      preconditionFailures: runs.filter((run) => run.preconditionFailed),
    }])),
  },
  shelteredWaves: {
    wavesSurvived: distribution(waveRuns.map((run) => run.wavesSurvived)),
    waveDurations: distribution(waveRuns.flatMap((run) => run.waves.map((wave) => wave.duration))),
    towerHpLostPerWave: distribution(waveRuns.flatMap((run) => run.waves.map((wave) => wave.towerHpLost))),
    enemiesReachingPerWave: distribution(waveRuns.flatMap((run) => run.waves.map((wave) => wave.enemiesReaching))),
    perSeed: waveRuns.map((run) => ({ seed: run.seed, wavesSurvived: run.wavesSurvived, status: run.status })),
  },
  economy: economyReport(),
  forestReproduction: forestReproduction(),
  clearingPerformance: clearingPerformance(),
};

console.log(JSON.stringify(report, null, 2));
