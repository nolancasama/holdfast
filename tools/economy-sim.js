// D80 opening-economy report. This uses the real placement, construction and
// production code; the scripted player teleports between build sites so the
// report measures the economy rather than travel execution.

import { MAP } from '../src/config.js';
import { createGame, canPlaceAt, tryBuild, update, wallPlan, tryBuildWall } from '../src/game.js';

const SEEDS = ['ALPHA', 'BRAVO', 'CHARLIE', 'DELTA', 'ECHO', 'FOXTROT', 'GOLF', 'HOTEL'];
// D81: two opening walls (Keep-tower, tower-tower) follow the first economy.
const ORDER = ['tower', 'tower', 'farm', 'quarry', 'wall', 'wall', 'mine'];
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
    const check = canPlaceAt(g, wx, wy, type);
    // Keep geography/occupancy valid while temporarily ignoring affordability.
    const onlyCost = check.reasons.length === 1 && check.reasons[0].startsWith('need ');
    if (check.ok || onlyCost) candidates.push({ x: wx, y: wy, distance, check });
  }
  candidates.sort((a, b) => a.distance - b.distance || a.y - b.y || a.x - b.x);
  return candidates[0] || null;
}

function snapshot(g, minute) {
  return {
    minute,
    food: g.res.food,
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
      if (type === 'wall') {
        const ordinal = ORDER.slice(0, orderIndex + 1).filter((value) => value === 'wall').length;
        const [keep, t1, t2] = g.towers;
        const pairs = ordinal === 1 ? [[keep, t1], [keep, t2]] : [[t1, t2], [keep, t2], [keep, t1]];
        // Wait for anchors to finish and Stone to arrive; skip geometry that can never work.
        const usable = pairs.map(([a, b]) => ({ a, b, plan: wallPlan(g, a.id, b.id) }))
          .filter(({ plan }) => plan.reasons.every((r) => r.startsWith('need ') || r === 'both towers must be finished'));
        if (!usable.length) { timings[`wall${ordinal}`] = NaN; orderIndex++; continue; }
        const ready = usable.find(({ plan }) => plan.ok);
        if (!ready) break;
        g.player.x = ready.a.x; g.player.y = ready.a.y;
        if (!tryBuildWall(g, ready.a.id, ready.b.id).ok) throw new Error(`${seed}: wall start failed`);
        timings[`wall${ordinal}`] = elapsed;
        timings[`wall${ordinal}Segments`] = ready.plan.segments.length;
        orderIndex++;
        continue;
      }
      const site = pendingSite || findSite(g, type);
      if (!site) throw new Error(`${seed}: no valid ${type} site for scripted opening`);
      pendingSite = site;
      const current = canPlaceAt(g, site.x, site.y, type);
      if (!current.ok) break;
      g.player.x = site.x;
      g.player.y = site.y;
      const result = tryBuild(g, site.x, site.y, type);
      if (!result.ok) throw new Error(`${seed}: ${type} placement changed during build`);
      const ordinal = ORDER.slice(0, orderIndex + 1).filter((value) => value === type).length;
      timings[`${type}${type === 'tower' ? ordinal : ''}`] = elapsed;
      orderIndex++;
      pendingSite = null;
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
console.log('D80 scripted opening (seconds affordable/built)');
const COLS = ['tower1', 'tower2', 'farm', 'quarry', 'wall1', 'wall2', 'mine'];
console.log('| Seed | Tower 1 | Tower 2 | Farm | Quarry | Wall 1 (segs) | Wall 2 (segs) | Gold Mine |');
console.log('|---|---:|---:|---:|---:|---:|---:|---:|');
const cell = (t, k) => (Number.isFinite(t[k]) ? t[k].toFixed(1) : 'n/a') + (t[`${k}Segments`] ? ` (${t[`${k}Segments`]})` : '');
for (const run of runs) console.log(`| ${run.seed} | ${COLS.map((k) => cell(run.timings, k)).join(' | ')} |`);
console.log(`| median | ${COLS.map((k) => median(runs.map((r) => r.timings[k]).filter(Number.isFinite)).toFixed(1)).join(' | ')} |`);

console.log('\nMedian resource totals by minute');
console.log('| Minute | Food | Stone | Gold |');
console.log('|---:|---:|---:|---:|');
for (let minute = 1; minute <= 5; minute++) {
  console.log(`| ${minute} | ${median(runs.map((r) => r.samples[minute - 1].food)).toFixed(1)} | ${median(runs.map((r) => r.samples[minute - 1].stone)).toFixed(1)} | ${median(runs.map((r) => r.samples[minute - 1].gold)).toFixed(1)} |`);
}
