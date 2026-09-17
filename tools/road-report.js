import { MAP } from '../src/config.js';
import { generateMap, isTerrainBuildable } from '../src/terrain.js';
import {
  straightRoadBaseline, measureSiteExposure, findExposureFeatures, analyseRoadKnots, analyseRoadReadability,
} from '../src/roadexposure.js';
import { idx } from '../src/terrain.js';

const DEFAULT_SEEDS = [
  'ALPHA', 'BRAVO', 'CHARLIE', 'DELTA', 'ECHO', 'FOXTROT', 'GOLF', 'HOTEL',
  'INDIA', 'JULIET', 'KILO', 'LIMA', 'MIKE', 'NOVEMBER', 'OSCAR', 'PAPA',
  'QUEBEC', 'ROMEO', 'SIERRA', 'TANGO',
];
const seeds = process.argv.slice(2);
if (!seeds.length) seeds.push(...DEFAULT_SEEDS);

const baseline = straightRoadBaseline();
let worst = { seed: '', ms: 0 };
const totals = { strong: 0, readability: 0, knots: 0, ms: [] };
console.log(`baseline=${baseline.toFixed(2)}`);
for (const seed of seeds) {
  const t0 = performance.now();
  const map = generateMap(seed);
  const t1 = performance.now();
  const fieldCache = new Map();
  const features = findExposureFeatures(map, { fieldCache });
  const knots = analyseRoadKnots(map);
  const readability = analyseRoadReadability(map);
  const t2 = performance.now();
  const entry = ['west', 'east'].map((side) => {
    const edgeX = side === 'west' ? 0 : MAP.w - 1;
    const ok = map.spawns[side].every((m) => [0, -1, 1].some((oy) => map.road[idx(edgeX, m.y + oy)]));
    return `${side}:${ok ? 'yes' : 'NO'}`;
  }).join(',');
  totals.strong += features.filter((f) => f.tier === 'strong').length;
  totals.readability += readability.count;
  totals.knots += knots.count;
  totals.ms.push(t1 - t0);
  let best = null;
  for (let y = 0; y < MAP.h; y++) {
    for (let x = 0; x < MAP.w; x++) {
      const wx = x + 0.5;
      const wy = y + 0.5;
      if (!isTerrainBuildable(map, wx, wy)) continue;
      const measured = measureSiteExposure(map, wx, wy, { fieldCache });
      if (!best || measured.exposure > best.exposure) best = { x: wx, y: wy, ...measured };
    }
  }
  const t3 = performance.now();
  const strong = features.filter((f) => f.tier === 'strong');
  const analysisMs = t2 - t1;
  if (analysisMs > worst.ms) worst = { seed, ms: analysisMs };
  console.log([
    seed,
    `strong=${strong.length}`,
    `kinds=${strong.map((f) => f.kind).join(',') || '-'}`,
    `best=${best ? best.exposure.toFixed(2) : '0.00'}`,
    `ratio=${best ? best.ratio.toFixed(2) : '0.00'}`,
    `baseline=${baseline.toFixed(2)}`,
    `efficiency=${strong.map((f) => f.efficiency.toFixed(2)).join(',') || '-'}`,
    `knots=${knots.count} (spurs=${knots.spurs.length},loops=${knots.smallLoops.length},braids=${knots.braids.length})`,
    `readability=${readability.count} (near=${readability.nearPasses.length},thick=${readability.thickBands.length},`
      + `junction=${readability.junctionClutter.length},dense=${readability.denseAreas.length},zigzag=${readability.zigzags.length})`,
    `entry=${entry}`,
    `attempts=${map.attempts}${map.relaxed ? 'R' : ''}`,
    `buildable=${best ? best.buildable : '-'}`,
    `readable=${features[0] ? features[0].readable : '-'}`,
    `generation=${(t1 - t0).toFixed(1)}ms`,
    `analysis=${analysisMs.toFixed(1)}ms`,
    `measurement=${(t3 - t2).toFixed(1)}ms`,
    `total=${(t3 - t0).toFixed(1)}ms`,
  ].join('  '));
}
console.log(`worst analysis=${worst.seed} ${worst.ms.toFixed(1)}ms`);
const mean = totals.ms.reduce((a, b) => a + b, 0) / Math.max(1, totals.ms.length);
console.log(`summary strong=${totals.strong} knots=${totals.knots} readability=${totals.readability} `
  + `generation mean=${mean.toFixed(0)}ms max=${Math.max(...totals.ms).toFixed(0)}ms`);
