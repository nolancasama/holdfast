// D96 road-quality report: generates maps and prints the hard road metrics.
// Usage: npm run road-report [count]   (seeds R0..R{count-1}, default 40)

import { generateMap } from '../src/terrain.js';
import { analyseRoadNetwork } from '../src/roads.js';
import { analyseRoadKnots, analyseRoadReadability } from '../src/roadexposure.js';

const count = Number(process.argv[2]) || 40;
const rows = [];
console.log('| seed | ms | attempts | roads | junctions | turns avg/max | min spacing | loops | self-crossings | knots | readability | rejected roads |');
console.log('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
for (let n = 0; n < count; n++) {
  const seed = `R${n}`;
  const started = performance.now();
  const map = generateMap(seed);
  const ms = performance.now() - started;
  const r = analyseRoadNetwork(map);
  const knots = analyseRoadKnots(map).count;
  const read = analyseRoadReadability(map).count;
  rows.push({ ms, ...r, knots, read, ok: map.report.ok });
  console.log(`| ${seed} | ${ms.toFixed(0)} | ${map.attempts}${map.relaxed ? 'R' : ''} | ${r.roads} | ${r.junctions} | `
    + `${r.avgTurns.toFixed(1)}/${r.maxTurns} | ${Number.isFinite(r.minSpacing) ? r.minSpacing : '-'} | ${r.loops} | `
    + `${r.selfIntersections} | ${knots} | ${read} | ${r.rejected} |`);
}
const sorted = rows.map((r) => r.ms).sort((a, b) => a - b);
const bad = rows.filter((r) => r.loops || r.selfIntersections || r.knots || !r.ok).length;
console.log(`\n${count} maps: ${bad} with a hard defect or failed validation; roads per map `
  + `${Math.min(...rows.map((r) => r.roads))}-${Math.max(...rows.map((r) => r.roads))}; readability defects `
  + `${rows.reduce((s, r) => s + r.read, 0)}; generation median ${sorted[sorted.length >> 1].toFixed(0)} ms, `
  + `max ${sorted[sorted.length - 1].toFixed(0)} ms`);
