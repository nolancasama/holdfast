// D80 opening-economy report. This uses the real placement, construction and
// production code; the scripted player teleports between build sites so the
// report measures the economy rather than travel execution.

import { MAP, NEST } from '../src/config.js';
import { autoWallPlan, createGame, canPlaceAt, tryBuild, update, foodSupport } from '../src/game.js';

const SEEDS = ['ALPHA', 'BRAVO', 'CHARLIE', 'DELTA', 'ECHO', 'FOXTROT', 'GOLF', 'HOTEL'];
// D89: wall links and their Stone cost are part of each tower placement.
const ORDER = ['tower', 'tower', 'farm', 'quarry', 'mine'];
const STEP = 0.1;
const DURATION = 300;

function findSite(g, type) {
  const keep = g.towers.find((t) => t.keep);
  const candidates = [];
  for (let y = 1; y < MAP.h - 1; y++) for (let x = 1; x < MAP.w - 1; x++) {
    const wx = x + 0.5;
    const wy = y + 0.5;
    const distance = Math.hypot(wx - keep.x, wy - keep.y);
    if ((type === 'farm' || type === 'quarry') && distance > 20) continue;
    if (type === 'mine' && distance < 27) continue;
    // D92: measure the economy on unguarded Gold; guarded Gold needs a siege first.
    if (type === 'mine' && g.nests.some((n) => !n.destroyed
      && Math.hypot(n.x - wx, n.y - wy) <= NEST.territory + NEST.structureReach)) continue;
    const check = canPlaceAt(g, wx, wy, type);
    // Keep geography/occupancy valid while temporarily ignoring affordability.
    const onlyCost = check.reasons.length === 1 && /^need /i.test(check.reasons[0]);
    if (check.ok || onlyCost) candidates.push({ x: wx, y: wy, distance, check });
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

  for (let elapsed = 0; elapsed <= DURATION + 1e-6; elapsed += STEP) {
    while (orderIndex < ORDER.length) {
      const type = ORDER[orderIndex];
      const site = pendingSite || findSite(g, type);
      if (!site) throw new Error(`${seed}: no valid ${type} site for scripted opening`);
      pendingSite = site;
      const current = canPlaceAt(g, site.x, site.y, type);
      if (!current.ok) break;
      const wallPlan = type === 'tower' ? autoWallPlan(g, site.x, site.y) : null;
      const wallsBefore = g.walls.length;
      g.player.x = site.x;
      g.player.y = site.y;
      const result = tryBuild(g, site.x, site.y, type);
      if (!result.ok) throw new Error(`${seed}: ${type} placement changed during build`);
      const ordinal = ORDER.slice(0, orderIndex + 1).filter((value) => value === type).length;
      const key = `${type}${type === 'tower' ? ordinal : ''}`;
      timings[key] = elapsed;
      if (type === 'tower') {
        const links = g.walls.slice(wallsBefore);
        timings[`${key}Links`] = links.length;
        timings[`${key}Segments`] = links.reduce((sum, link) => sum + link.segments.length, 0);
        timings[`${key}WallStone`] = wallPlan.wallCost;
        timings[`${key}TotalStone`] = wallPlan.total;
        timings[`${key}Status`] = wallPlan.status;
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
console.log('D89 scripted opening (seconds affordable/built; automatic links charged with towers)');
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
