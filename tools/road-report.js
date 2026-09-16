import { MAP } from '../src/config.js';
import { generateMap, isTerrainBuildable } from '../src/terrain.js';
import {
  straightRoadBaseline, measureSiteExposure, findExposureFeatures, analyseRoadKnots,
} from '../src/roadexposure.js';

const DEFAULT_SEEDS = [
  'ALPHA', 'BRAVO', 'CHARLIE', 'DELTA', 'ECHO', 'FOXTROT', 'GOLF', 'HOTEL',
  'INDIA', 'JULIET', 'KILO', 'LIMA', 'MIKE', 'NOVEMBER', 'OSCAR', 'PAPA',
  'QUEBEC', 'ROMEO', 'SIERRA', 'TANGO',
];
const seeds = process.argv.slice(2);
if (!seeds.length) seeds.push(...DEFAULT_SEEDS);

const baseline = straightRoadBaseline();
let worst = { seed: '', ms: 0 };
console.log(`baseline=${baseline.toFixed(2)}`);
for (const seed of seeds) {
  const t0 = performance.now();
  const map = generateMap(seed);
  const t1 = performance.now();
  const fieldCache = new Map();
  const features = findExposureFeatures(map, { fieldCache });
  const knots = analyseRoadKnots(map);
  const t2 = performance.now();
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
    `knots=${knots.count} (spurs=${knots.spurs.length},loops=${knots.smallLoops.length},braids=${knots.braids.length})`,
    `buildable=${best ? best.buildable : '-'}`,
    `readable=${features[0] ? features[0].readable : '-'}`,
    `generation=${(t1 - t0).toFixed(1)}ms`,
    `analysis=${analysisMs.toFixed(1)}ms`,
    `measurement=${(t3 - t2).toFixed(1)}ms`,
    `total=${(t3 - t0).toFixed(1)}ms`,
  ].join('  '));
}
console.log(`worst analysis=${worst.seed} ${worst.ms.toFixed(1)}ms`);
