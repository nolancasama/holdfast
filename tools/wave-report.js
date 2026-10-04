// D83 wave-pressure report. Real wave rolls, spawning, pathing, combat, walls
// and repair; a scripted player sits in the Keep holding Repair. Two defences:
//   open     - the Keep plus two towers beside it, no walls
//   fortress - the Keep enclosed by a three-tower triangle joined by walls,
//              towers upgraded to W1 on wave 4 and W2 on wave 7
//   fortress+ - the same, plus three outer towers covering the walls
// Both get a farm and a quarry at the nearest valid sites, then live on the
// real economy (no cheats after setup). Run: npm run wave-report [seeds...]

import { MAP, WAVE } from '../src/config.js';
import {
  createGame, update, canPlaceAt, tryBuild, tryUpgrade, wallPlan, tryBuildWall, wallSegments,
} from '../src/game.js';

const SEEDS = process.argv.slice(2).length ? process.argv.slice(2)
  : ['ALPHA', 'BRAVO', 'CHARLIE', 'DELTA', 'ECHO', 'FOXTROT'];
const STEP = 1 / 30;

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

function place(g, x, y, type) {
  g.player.x = x; g.player.y = y;
  const r = tryBuild(g, x, y, type);
  return r.ok ? r.structure : null;
}

function finish(s) { s.built = true; s.progress = 1; s.hp = s.maxHp; }

function nearestSite(g, type, maxDistance = 40) {
  const keep = g.towers[0];
  let best = null;
  for (let y = 2; y < MAP.h - 2; y++) for (let x = 2; x < MAP.w - 2; x++) {
    const wx = x + 0.5; const wy = y + 0.5;
    const d = Math.hypot(wx - keep.x, wy - keep.y);
    if (d > maxDistance || (best && d >= best.d)) continue;
    if (canPlaceAt(g, wx, wy, type).ok) best = { x: wx, y: wy, d };
  }
  return best;
}

/** Three towers ~7.4 tiles out at 120 degrees, every pair wallable. */
function enclosingTriangle(g) {
  const keep = g.towers[0];
  for (let r of [7.2, 7.4, 7.0, 7.5]) {
    for (let a0 = 0; a0 < 120; a0 += 5) {
      const pts = [0, 120, 240].map((d) => {
        const a = ((a0 + d) * Math.PI) / 180;
        return { x: Math.floor(keep.x + Math.cos(a) * r) + 0.5, y: Math.floor(keep.y + Math.sin(a) * r) + 0.5 };
      });
      const saved = { towers: g.towers.slice(), next: g.nextTowerId, res: { ...g.res }, grid: g.blockerGrid.slice(), v: g.blockerVersion };
      const built = [];
      for (const p of pts) { const t = place(g, p.x, p.y, 'tower'); if (!t) break; finish(t); built.push(t); }
      const ok = built.length === 3 && [[0, 1], [1, 2], [2, 0]].every(([i, j]) => wallPlan(g, built[i].id, built[j].id).ok);
      if (ok) return built;
      g.towers = saved.towers; g.nextTowerId = saved.next; g.res = saved.res; g.blockerGrid = saved.grid;
      g.blockerVersion = saved.v + 1; g.keepFields = Object.create(null);
    }
  }
  return null;
}

function setup(seed, profile) {
  const g = createGame(seed, 'gunner');
  g.res = { food: 1e5, stone: 1e5, gold: 1e5 };
  const keep = g.towers[0];
  let towers = [];
  if (profile.startsWith('fortress')) {
    towers = enclosingTriangle(g);
    if (!towers) return null;
    for (const [i, j] of [[0, 1], [1, 2], [2, 0]]) {
      g.player.x = towers[i].x; g.player.y = towers[i].y;
      const r = tryBuildWall(g, towers[i].id, towers[j].id);
      if (!r.ok) return null;
      r.link.built = true; r.link.progress = 1;
      for (const s of r.link.segments) s.hp = s.maxHp;
    }
    if (profile === 'fortress+') {
      // Outer towers opposite each wall's midpoint, ~5 tiles beyond it.
      for (const [i, j] of [[0, 1], [1, 2], [2, 0]]) {
        const mx = (towers[i].x + towers[j].x) / 2; const my = (towers[i].y + towers[j].y) / 2;
        const ox = mx - keep.x; const oy = my - keep.y; const l = Math.hypot(ox, oy) || 1;
        let t = null;
        for (let k = 0; k < 30 && !t; k++) {
          const r = 9 + (k % 6) * 0.5; const a = Math.atan2(oy, ox) + (Math.floor(k / 6) - 2) * 0.12;
          t = place(g, Math.floor(keep.x + Math.cos(a) * r) + 0.5, Math.floor(keep.y + Math.sin(a) * r) + 0.5, 'tower');
        }
        if (t) { finish(t); towers.push(t); }
        void l;
      }
    }
  } else {
    for (const want of [{ dx: 9, dy: 0 }, { dx: -9, dy: 0 }]) {
      let t = null;
      for (let k = 0; k < 40 && !t; k++) {
        const a = (k / 40) * Math.PI * 2;
        t = place(g, Math.floor(keep.x + want.dx + Math.cos(a) * (k / 10)) + 0.5,
          Math.floor(keep.y + want.dy + Math.sin(a) * (k / 10)) + 0.5, 'tower');
      }
      if (t) { finish(t); towers.push(t); }
    }
  }
  for (const type of ['farm', 'quarry']) {
    const site = nearestSite(g, type);
    if (site) finish(place(g, site.x, site.y, type));
  }
  g.res = { food: 60, stone: 120, gold: 0 };
  g.player.x = keep.x; g.player.y = keep.y;
  return { g, keep, towers };
}

function runProfile(seed, profile) {
  return withSeededRandom(`${seed}:${profile}`, () => {
    const s = setup(seed, profile);
    if (!s) return { seed, profile, skipped: true };
    const { g, keep, towers } = s;
    const waves = [];
    let row = null;
    let lastKeepHp = keep.hp;
    let lastWave = 0;
    for (let t = 0; t < 60 * 40 && g.status === 'playing'; t += STEP) {
      // Stone goes to the walls first; the Keep is repaired only when it is in trouble.
      const combat = g.phase === 'combat' || g.phase === 'warning';
      g.input = { mx: 0, my: 0, melee: false, repair: !combat || keep.hp < keep.maxHp * 0.6 };
      // Prep: stand beside the most damaged wall segment (rubble first) and repair it.
      if (g.phase === 'prep' || g.phase === 'aftermath') {
        const worst = wallSegments(g).filter((o) => o.destroyed || o.hp < o.maxHp)
          .sort((a, b) => (a.destroyed ? -1 : a.hp / a.maxHp) - (b.destroyed ? -1 : b.hp / b.maxHp))[0];
        if (worst && g.res.stone > 5) {
          const side = Math.hypot(worst.x + 1.3 - keep.x, worst.y - keep.y) < Math.hypot(worst.x - 1.3 - keep.x, worst.y - keep.y) ? 1.3 : -1.3;
          g.player.x = worst.x + side; g.player.y = worst.y;
        } else { g.player.x = keep.x; g.player.y = keep.y; }
      } else if (Math.hypot(g.player.x - keep.x, g.player.y - keep.y) > 0.5) { g.player.x = keep.x; g.player.y = keep.y; }
      if (g.wave !== lastWave && g.phase === 'prep') {
        lastWave = g.wave;
        if (profile.startsWith('fortress') && (g.wave === 4 || g.wave === 7)) {
          // Upgrades are local (D83): visit each tower, buy, come home.
          g.res.gold += 400; g.res.stone += 400;
          for (const tw of [keep, ...towers]) {
            if (!g.towers.includes(tw) || tw.upgrade) continue;
            g.player.x = tw.x + 1; g.player.y = tw.y;
            tryUpgrade(g, tw, 'weapon');
          }
          g.player.x = keep.x; g.player.y = keep.y;
        }
      }
      if (g.phase === 'combat' && (!row || row.wave !== g.wave)) {
        row = { wave: g.wave, spawned: { swarm: 0, runner: 0, heavy: 0 }, kills0: g.stats.kills,
          seg0: g.stats.wallSegmentsLost, keepLost: 0, bld0: g.buildings.filter((b) => b.destroyed).length,
          t0: g.time, towers0: g.stats.towersLost };
        for (const p of g.pendingSpawns) row.spawned[p.type]++;
        waves.push(row);
      }
      const nextIds = g.nextEnemyId;
      update(g, STEP);
      void nextIds;
      if (keep.hp < lastKeepHp && row) row.keepLost += lastKeepHp - keep.hp;
      lastKeepHp = g.towers.includes(keep) ? keep.hp : 0;
      if (row && !row.done && (g.phase === 'aftermath' || g.status !== 'playing')) {
        row.done = true;
        row.openBreaches = wallSegments(g).filter((o) => o.destroyed).length;
        row.kills = g.stats.kills - row.kills0;
        row.segLost = g.stats.wallSegmentsLost - row.seg0;
        row.bldLost = g.buildings.filter((b) => b.destroyed).length - row.bld0;
        row.towersLost = g.stats.towersLost - row.towers0;
        row.duration = g.time - row.t0;
        row.keepEnd = Math.max(0, Math.round(keep.hp));
      }
    }
    return { seed, profile, waves, status: g.status, cause: g.lossCause, wave: g.wave,
      segTotal: wallSegments(g).length, segLost: g.stats.wallSegmentsLost };
  });
}

const results = [];
for (const seed of SEEDS) for (const profile of ['open', 'fortress', 'fortress+']) {
  const started = Date.now();
  const r = runProfile(seed, profile);
  r.ms = Date.now() - started;
  results.push(r);
}

for (const profile of ['open', 'fortress', 'fortress+']) {
  console.log(`\n## ${profile}`);
  console.log('| seed | outcome | per wave: S/R/H spawned, wall segs lost, Keep hp lost (Keep hp at end) |');
  console.log('|---|---|---|');
  for (const r of results.filter((x) => x.profile === profile)) {
    if (r.skipped) { console.log(`| ${r.seed} | skipped (no valid layout) | |`); continue; }
    const cells = r.waves.map((w) => `w${w.wave} ${w.spawned.swarm}/${w.spawned.runner}/${w.spawned.heavy} s${w.segLost ?? '?'}${w.openBreaches ? `(${w.openBreaches} open)` : ''} k${Math.round(w.keepLost)}(${w.keepEnd ?? '?'})${w.bldLost ? ` b${w.bldLost}` : ''}${w.towersLost ? ` t${w.towersLost}` : ''} ${Math.round(w.duration ?? 0)}s`);
    console.log(`| ${r.seed} | ${r.status}${r.cause ? `/${r.cause}` : ''} wave ${r.wave}/${WAVE.totalToSurvive} | ${cells.join('; ')} |`);
  }
}
const wallRuns = results.filter((r) => r.profile.startsWith('fortress') && !r.skipped);
console.log(`\nfortress wall segments lost per run: ${wallRuns.map((r) => `${r.segLost}/${r.segTotal}`).join(', ')}`);
console.log(`run time ms: ${results.map((r) => r.ms).join(', ')}`);
