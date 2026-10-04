// D92 probe: a lone tower vs a nest, and two supporting towers vs a nest,
// 5-7 tiles out with line of sight. Run: npm run nest-probe
import { createGame, update, tryBuild } from '../src/game.js';
import { isTerrainBuildable, hasLineOfSight } from '../src/terrain.js';

function siteNear(g, n, dmin, dmax, avoid = []) {
  for (let r = dmin; r <= dmax; r += 0.5) {
    for (let a = 0; a < 64; a++) {
      const x = Math.floor(n.x + Math.cos(a / 64 * Math.PI * 2) * r) + 0.5;
      const y = Math.floor(n.y + Math.sin(a / 64 * Math.PI * 2) * r) + 0.5;
      if (avoid.some((p) => Math.hypot(p.x - x, p.y - y) < 7.2)) continue;
      g.player.x = x; g.player.y = y;
      const reasons = [];
      if (!isTerrainBuildable(g.map, x, y, reasons)) continue;
      // A sensible siege tower can see the nest.
      if (!hasLineOfSight(g.map, x, y, n.x, n.y)) continue;
      const res = tryBuild(g, x, y, 'tower');
      if (res.ok) return res.structure;
    }
  }
  return null;
}

function run(seed, count) {
  const g = createGame(seed, 'gunner');
  g.res = { stone: 99999, gold: 0 };
  const n = g.nests[0];
  if (!n) return console.log(seed, 'no nest');
  const towers = [];
  const a = siteNear(g, n, 5, 7);
  if (!a) return console.log(seed, 'no site A');
  towers.push(a);
  if (count > 1) {
    const b = siteNear(g, n, 5, 7, [a]);
    if (b) towers.push(b);
  }
  // Player stands far away so only the towers fight.
  g.player.x = g.map.start.x + 0.5; g.player.y = g.map.start.y + 0.5;
  let t = 0;
  for (; t < 240 && !n.destroyed && towers.some((o) => g.towers.includes(o)); t += 1 / 30) {
    g.input = { mx: 0, my: 0, melee: false, repair: false };
    update(g, 1 / 30);
  }
  const alive = towers.filter((o) => g.towers.includes(o)).length;
  console.log(`${seed} towers=${towers.length} d=${towers.map((o) => Math.hypot(o.x - n.x, o.y - n.y).toFixed(1)).join('/')}`
    + ` t=${t.toFixed(0)}s nest=${n.destroyed ? 'DESTROYED' : `${Math.round(n.hp)}hp ${n.state}`} towersAlive=${alive}`
    + ` hp=${towers.map((o) => Math.round(o.hp)).join('/')} feralKills=${g.stats.feralKills}`);
}

for (const seed of ['ALPHA', 'BRAVO', 'CHARLIE', 'DELTA']) { run(seed, 1); run(seed, 2); }
