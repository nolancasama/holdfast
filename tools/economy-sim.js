// D80 opening-economy report. This uses the real placement, construction and
// production code; the scripted player teleports between build sites so the
// report measures the economy rather than travel execution.

import { MAP, NEST, TOWER, WALL } from '../src/config.js';
import {
  createGame, canPlaceAt, tryBuild, tryBuildWall, wallPlan, towerConnectivity, update, foodSupport,
} from '../src/game.js';

const SEEDS = ['ALPHA', 'BRAVO', 'CHARLIE', 'DELTA', 'ECHO', 'FOXTROT', 'GOLF', 'HOTEL'];
// D98-D99: towers and their deliberate Tower links are separate purchases.
const ORDER = ['tower', 'tower', 'farm', 'quarry', 'mine'];
const STEP = 0.1;
const DURATION = 300;

function findSite(g, type, wallFrom = null) {
  const keep = g.towers.find((t) => t.keep);
  const candidates = [];
  for (let y = 1; y < MAP.h - 1; y++) for (let x = 1; x < MAP.w - 1; x++) {
    const wx = x + 0.5;
    const wy = y + 0.5;
    const distance = Math.hypot(wx - keep.x, wy - keep.y);
    if (type === 'tower' && distance > WALL.maxLength) continue;
    if ((type === 'farm' || type === 'quarry') && distance > 20) continue;
    if (type === 'mine' && distance < 27) continue;
    // D92: measure the economy on unguarded Gold; guarded Gold needs a siege first.
    if (type === 'mine' && g.nests.some((n) => !n.destroyed
      && Math.hypot(n.x - wx, n.y - wy) <= NEST.territory + NEST.structureReach)) continue;
    const check = canPlaceAt(g, wx, wy, type);
    // Keep geography/occupancy valid while temporarily ignoring affordability.
    const onlyCost = check.reasons.length === 1 && /^need /i.test(check.reasons[0]);
    if (!(check.ok || onlyCost)) continue;
    if (type === 'tower' && wallFrom) {
      const probe = { id: -1, x: wx, y: wy, radius: TOWER.radius, built: true, hp: 1, maxHp: 1 };
      g.towers.push(probe);
      const plan = wallPlan(g, wallFrom.id, probe.id);
      g.towers.pop();
      if (!plan.ok && !plan.reasons.every((reason) => /^need /i.test(reason))) continue;
    }
    candidates.push({ x: wx, y: wy, distance, check });
  }
  candidates.sort((a, b) => a.distance - b.distance || a.y - b.y || a.x - b.x);
  return candidates[0] || null;
}

function snapshot(g, minute) {
  return {
    minute,
    food: foodSupport(g), // D91: soldiers fed, not a stockpile
    stone: g.res.stone,
    gold: g.res.gold,
  };
}

function simulate(seed) {
  const g = createGame(seed, 'gunner');
  g.phase = 'prep';
  g.phaseLeft = 1e9;
  const timings = {};
  const samples = [];
  let orderIndex = 0;
  let pendingSite = null;
  let pendingTower = null;
  let previousTower = null;

  for (let elapsed = 0; elapsed <= DURATION + 1e-6; elapsed += STEP) {
    while (orderIndex < ORDER.length) {
      const type = ORDER[orderIndex];
      if (pendingTower) {
        if (!pendingTower.tower.built) break;
        if (!previousTower) {
          timings[`${pendingTower.key}Links`] = 0;
          timings[`${pendingTower.key}Segments`] = 0;
          timings[`${pendingTower.key}WallStone`] = 0;
          timings[`${pendingTower.key}TotalStone`] = pendingTower.towerStone;
          timings[`${pendingTower.key}Status`] = towerConnectivity(g, pendingTower.tower);
          previousTower = pendingTower.tower;
          pendingTower = null;
          orderIndex++;
          pendingSite = null;
          continue;
        }
        const plan = wallPlan(g, previousTower.id, pendingTower.tower.id);
        if (!plan.ok) {
          if (plan.reasons.every((reason) => /^need /i.test(reason))) break;
          throw new Error(`${seed}: cannot join ${pendingTower.key} to previous Tower: ${plan.reasons.join(', ')}`);
        }
        g.player.x = pendingTower.tower.x;
        g.player.y = pendingTower.tower.y;
        const result = tryBuildWall(g, previousTower.id, pendingTower.tower.id);
        if (!result.ok) throw new Error(`${seed}: ${pendingTower.key} wall changed during build`);
        const link = g.walls[g.walls.length - 1];
        timings[`${pendingTower.key}Links`] = 1;
        timings[`${pendingTower.key}Segments`] = link.segments.length;
        timings[`${pendingTower.key}WallStone`] = plan.cost.stone;
        timings[`${pendingTower.key}TotalStone`] = pendingTower.towerStone + plan.cost.stone;
        timings[`${pendingTower.key}Status`] = towerConnectivity(g, pendingTower.tower);
        const previousKey = `tower${orderIndex}`;
        timings[`${previousKey}Status`] = towerConnectivity(g, previousTower);
        previousTower = pendingTower.tower;
        pendingTower = null;
        orderIndex++;
        pendingSite = null;
        continue;
      }
      const site = pendingSite || findSite(g, type, type === 'tower' ? previousTower : null);
      if (!site) throw new Error(`${seed}: no valid ${type} site for scripted opening`);
      pendingSite = site;
      const current = canPlaceAt(g, site.x, site.y, type);
      if (!current.ok) break;
      g.player.x = site.x;
      g.player.y = site.y;
      const result = tryBuild(g, site.x, site.y, type);
      if (!result.ok) throw new Error(`${seed}: ${type} placement changed during build`);
      const ordinal = ORDER.slice(0, orderIndex + 1).filter((value) => value === type).length;
      const key = `${type}${type === 'tower' ? ordinal : ''}`;
      timings[key] = elapsed;
      if (type === 'tower') {
        pendingTower = { tower: result.structure, key, towerStone: result.cost.stone || 0 };
        break;
      }
      orderIndex++;
      pendingSite = null;
      // Walk home rather than loiter at a remote site.
      g.player.x = g.towers[0].x; g.player.y = g.towers[0].y + 2;
    }
    const nextMinute = samples.length + 1;
    if (nextMinute <= 5 && elapsed + 1e-6 >= nextMinute * 60) samples.push(snapshot(g, nextMinute));
    if (elapsed < DURATION) update(g, STEP);
  }
  return { seed, timings, samples, final: { ...g.res } };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length % 2 ? sorted[(sorted.length - 1) / 2]
    : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
}

const runs = SEEDS.map(simulate);
console.log('D99 scripted opening (seconds affordable/built; manual Tower links charged separately)');
const COLS = ['tower1', 'tower2', 'farm', 'quarry', 'mine'];
console.log('| Seed | Tower 1 (links/segs, wall/total Stone) | Tower 2 (links/segs, wall/total Stone) | Farm | Quarry | Gold Mine |');
console.log('|---|---:|---:|---:|---:|---:|');
const cell = (t, k) => {
  const at = Number.isFinite(t[k]) ? t[k].toFixed(1) : 'n/a';
  return k.startsWith('tower')
    ? `${at} (${t[`${k}Links`]}L/${t[`${k}Segments`]}s, ${t[`${k}WallStone`]}/${t[`${k}TotalStone`]} Stone, ${t[`${k}Status`]})`
    : at;
};
for (const run of runs) console.log(`| ${run.seed} | ${COLS.map((k) => cell(run.timings, k)).join(' | ')} |`);
console.log(`| median | ${COLS.map((k) => {
  const at = median(runs.map((r) => r.timings[k]).filter(Number.isFinite)).toFixed(1);
  if (!k.startsWith('tower')) return at;
  const links = median(runs.map((r) => r.timings[`${k}Links`]));
  const segments = median(runs.map((r) => r.timings[`${k}Segments`]));
  const wallStone = median(runs.map((r) => r.timings[`${k}WallStone`]));
  const totalStone = median(runs.map((r) => r.timings[`${k}TotalStone`]));
  return `${at} (${links}L/${segments}s, ${wallStone}/${totalStone} Stone)`;
}).join(' | ')} |`);

console.log('\nMedian resource totals by minute');
console.log('| Minute | Food support | Stone | Gold |');
console.log('|---:|---:|---:|---:|');
for (let minute = 1; minute <= 5; minute++) {
  console.log(`| ${minute} | ${median(runs.map((r) => r.samples[minute - 1].food)).toFixed(1)} | ${median(runs.map((r) => r.samples[minute - 1].stone)).toFixed(1)} | ${median(runs.map((r) => r.samples[minute - 1].gold)).toFixed(1)} |`);
}
