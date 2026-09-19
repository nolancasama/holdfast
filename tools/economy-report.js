// Economy report: how rare Rich ground is on generated maps.
//
//   node tools/economy-report.js [source-root] [label] [--json]
//
// Rich sites are buildable tile-centre tower positions at least 12 tiles from
// the start with base income >= RICHNESS.moderateMax. They are clustered by
// single linkage (centres within 2 tiles) so a region reads as one place, not
// as dozens of interchangeable tiles.
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const args = process.argv.slice(2).filter((a) => a !== '--json');
const json = process.argv.includes('--json');
const root = resolve(args[0] || '.');
const label = args[1] || root;
const load = (file) => import(pathToFileURL(resolve(root, file)).href);

const { MAP, TOWER, RICHNESS } = await load('src/config.js');
const { generateMap, isTerrainBuildable, idx } = await load('src/terrain.js');

const CANONICAL = ['ALPHA', 'BRAVO', 'CHARLIE', 'DELTA', 'ECHO', 'FOXTROT', 'GOLF', 'HOTEL',
  'INDIA', 'JULIET', 'KILO', 'LIMA', 'MIKE', 'NOVEMBER', 'OSCAR', 'PAPA',
  'QUEBEC', 'ROMEO', 'SIERRA', 'TANGO'];
const SEEDS = [...CANONICAL, ...Array.from({ length: 24 }, (_, n) => `PACE-${String(n).padStart(2, '0')}`)];
const REMOTE = 12;
const LINK = 2;
const MEANINGFUL = 3; // sites; smaller clusters are reported but not counted as regions
const PLACE_LINK = 6; // clusters this close (e.g. one core split by a river) are one place

function incomeAt(map, x, y) {
  const r = TOWER.extraction.radius;
  let sum = 0;
  for (let ty = Math.floor(y - r); ty <= Math.ceil(y + r); ty++) {
    for (let tx = Math.floor(x - r); tx <= Math.ceil(x + r); tx++) {
      if (tx < 0 || ty < 0 || tx >= MAP.w || ty >= MAP.h) continue;
      if (Math.hypot(tx + 0.5 - x, ty + 0.5 - y) > r) continue;
      sum += map.res[idx(tx, ty)];
    }
  }
  return (sum / TOWER.extraction.normalizer) * TOWER.extraction.baseRate;
}

function clusters(sites, link = LINK) {
  const parent = sites.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let a = 0; a < sites.length; a++) {
    for (let b = a + 1; b < sites.length; b++) {
      if (Math.hypot(sites[a].x - sites[b].x, sites[a].y - sites[b].y) <= link) parent[find(a)] = find(b);
    }
  }
  const groups = new Map();
  sites.forEach((s, i) => {
    const k = find(i);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(s);
  });
  return [...groups.values()].map((g) => {
    const cx = g.reduce((s, p) => s + p.x, 0) / g.length;
    const cy = g.reduce((s, p) => s + p.y, 0) / g.length;
    const radius = Math.max(...g.map((p) => Math.hypot(p.x - cx, p.y - cy)));
    return { sites: g.length, x: cx, y: cy, radius, best: Math.max(...g.map((p) => p.income)) };
  }).sort((a, b) => b.sites - a.sites);
}

const rows = [];
for (const seed of SEEDS) {
  const t0 = performance.now();
  const map = generateMap(seed);
  const ms = performance.now() - t0;
  const sx = map.start.x + 0.5;
  const sy = map.start.y + 0.5;
  const start = incomeAt(map, sx, sy);
  const rich = [];
  let moderate = 0;
  let best = 0;
  for (let y = 0; y < MAP.h; y++) {
    for (let x = 0; x < MAP.w; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      if (Math.hypot(px - sx, py - sy) < REMOTE || !isTerrainBuildable(map, px, py)) continue;
      const income = incomeAt(map, px, py);
      best = Math.max(best, income);
      if (income >= RICHNESS.moderateMax) rich.push({ x: px, y: py, income });
      else if (income >= RICHNESS.poorMax) moderate++;
    }
  }
  const all = clusters(rich);
  const regions = all.filter((c) => c.sites >= MEANINGFUL);
  const places = clusters(rich, PLACE_LINK).filter((c) => c.sites >= MEANINGFUL).length;
  let minSep = Infinity;
  for (let a = 0; a < regions.length; a++) {
    for (let b = a + 1; b < regions.length; b++) {
      minSep = Math.min(minSep, Math.hypot(regions[a].x - regions[b].x, regions[a].y - regions[b].y));
    }
  }
  rows.push({ seed, start, richSites: rich.length, clusters: all.length, regions: regions.length, places,
    largest: all[0]?.sites ?? 0, regionSites: regions.map((c) => c.sites),
    regionRadius: regions.map((c) => +c.radius.toFixed(1)),
    minSeparation: Number.isFinite(minSep) ? +minSep.toFixed(1) : null,
    moderateSites: moderate, best, ratio: best / start, ms, attempts: map.attempts ?? null });
}

const stat = (key) => {
  const v = rows.map((r) => r[key]).sort((a, b) => a - b);
  const med = v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2;
  return [v[0], med, v[v.length - 1]];
};
const f = (n, d = 2) => (typeof n === 'number' ? n.toFixed(d) : String(n));

if (json) {
  console.log(JSON.stringify({ label, rows }, null, 2));
} else {
  console.log(`# Economy report: ${label} (${rows.length} seeds)`);
  console.log('seed      start  best  ratio  richSites clusters regions places  sizes (radius)            minSep moderate  ms');
  for (const r of rows) {
    const sizes = r.regionSites.map((s, i) => `${s}(${r.regionRadius[i]})`).join(' ');
    console.log(`${r.seed.padEnd(9)} ${f(r.start)}  ${f(r.best)}  ${f(r.ratio)}x ${String(r.richSites).padStart(8)} ${String(r.clusters).padStart(8)} ${String(r.regions).padStart(7)} ${String(r.places).padStart(6)}  ${sizes.padEnd(25)} ${String(r.minSeparation).padStart(6)} ${String(r.moderateSites).padStart(8)} ${r.ms.toFixed(0).padStart(4)}`);
  }
  console.log('\nmin / median / max');
  for (const [name, key, d] of [['start income', 'start', 3], ['best income', 'best', 3], ['best/start', 'ratio', 2],
    ['rich sites', 'richSites', 0], ['rich clusters (any)', 'clusters', 0], ['rich regions (>=3 sites)', 'regions', 0], ['distinct places (6-tile)', 'places', 0],
    ['largest cluster', 'largest', 0], ['moderate sites', 'moderateSites', 0], ['generation ms', 'ms', 0]]) {
    console.log(`  ${name.padEnd(26)} ${stat(key).map((v) => f(v, d)).join(' / ')}`);
  }
  const inRange = rows.filter((r) => r.regions >= 3 && r.regions <= 5).length;
  console.log(`  maps with 3-5 regions       ${inRange}/${rows.length}`);
  console.log(`  maps with 3-5 places        ${rows.filter((r) => r.places >= 3 && r.places <= 5).length}/${rows.length}`);
  console.log(`  maps with no remote Rich    ${rows.filter((r) => !r.richSites).length}`);
}
