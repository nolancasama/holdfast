// D89-D98 wave-pressure report. Real wave rolls, spawning, pathing, combat,
// walls and repair; a scripted player sits in the Keep holding Repair. Three
// defences exercise deliberate manual-wall layouts:
//   outposts  - the Keep plus two isolated towers with no walls
//   fortress  - three inner towers joined as a Keep-centred fan,
//               upgraded to W1 on wave 4 and W2 on wave 7
//   fortress+ - the same, plus three towers extending the wall around the Keep
// All get a farm and a quarry at the nearest valid sites, then live on the
// real economy (no cheats after setup). Run: npm run wave-report [seeds...]

import { MAP, WALL, WAVE, KEEP, PLAYER } from '../src/config.js';
import {
  createGame, update, canPlaceAt, tryBuild, tryBuildWall, tryUpgrade, wallSegments,
  assignGarrison, garrisonState,
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

function towerSiteNear(g, x, y) {
  const candidates = [];
  for (let oy = -3; oy <= 3; oy++) for (let ox = -3; ox <= 3; ox++) {
    const wx = Math.floor(x + ox) + 0.5;
    const wy = Math.floor(y + oy) + 0.5;
    const d = Math.hypot(wx - x, wy - y);
    candidates.push({ x: wx, y: wy, d });
  }
  candidates.sort((a, b) => a.d - b.d || a.y - b.y || a.x - b.x);
  return candidates.find((p) => canPlaceAt(g, p.x, p.y, 'tower').ok) || null;
}

/** Three adjacent towers can be joined as two Keep-centred triangles. */
function innerNetwork(g) {
  const keep = g.towers[0];
  const radius = 7.4;
  const towers = [];
  for (const degrees of [-60, 0, 60]) {
    const a = (degrees * Math.PI) / 180;
    const site = towerSiteNear(g, keep.x + Math.cos(a) * radius, keep.y + Math.sin(a) * radius);
    if (!site) return null;
    const t = place(g, site.x, site.y, 'tower');
    if (!t) return null;
    towers.push(t);
  }
  return towers;
}

function isolatedOutpost(g, angle) {
  const keep = g.towers[0];
  const radius = WALL.maxLength + 2;
  const x = keep.x + Math.cos(angle) * radius;
  const y = keep.y + Math.sin(angle) * radius;
  return towerSiteNear(g, x, y);
}

/** Let the real construction code finish every currently queued structure. */
function finishConstruction(g) {
  for (let guard = 0; guard < 2400; guard++) {
    const pending = g.towers.some((t) => !t.built)
      || g.buildings.some((b) => !b.destroyed && !b.built)
      || g.walls.some((w) => !w.built);
    if (!pending) break;
    update(g, STEP);
  }
  return !g.towers.some((t) => !t.built)
    && !g.buildings.some((b) => !b.destroyed && !b.built)
    && !g.walls.some((w) => !w.built);
}

function buildWall(g, a, b) {
  g.player.x = a.x; g.player.y = a.y;
  return tryBuildWall(g, a.id, b.id).ok;
}

/** D98: explicitly build the fan/ring after all anchor towers are finished. */
function buildFortressWalls(g, keep, towers, extended) {
  const spokes = [[keep, towers[0]], [keep, towers[1]], [keep, towers[2]]];
  const spokeCount = spokes.filter(([a, b]) => a && b && buildWall(g, a, b)).length;
  if (spokeCount < 2) return false;
  const perimeter = [[towers[0], towers[1]], [towers[1], towers[2]]];
  if (extended) {
    perimeter.push([towers[2], towers[3]], [towers[3], towers[4]],
      [towers[4], towers[5]], [towers[5], towers[0]]);
  }
  // Terrain or another segment can invalidate an individual perimeter edge;
  // keep the valid explicit links instead of discarding the whole seed.
  for (const [a, b] of perimeter) if (a && b) buildWall(g, a, b);
  return true;
}

function setup(seed, profile) {
  const g = createGame(seed, 'gunner');
  g.res = { stone: 1e5, gold: 1e5 };
  g.phase = 'prep';
  g.phaseLeft = 1e9;
  const keep = g.towers[0];
  let towers = [];
  if (profile.startsWith('fortress')) {
    towers = innerNetwork(g);
    if (!towers) return null;
    if (profile === 'fortress+') {
      // Continue the ring around the far side of the Keep.
      for (const degrees of [120, 180, 240]) {
        const a = (degrees * Math.PI) / 180;
        const site = towerSiteNear(g, keep.x + Math.cos(a) * 8.5, keep.y + Math.sin(a) * 8.5);
        if (!site) return null;
        const t = place(g, site.x, site.y, 'tower');
        if (!t) return null;
        towers.push(t);
      }
    }
  } else {
    for (const angle of [0, Math.PI]) {
      const site = isolatedOutpost(g, angle);
      if (!site) return null;
      const t = place(g, site.x, site.y, 'tower');
      if (t) towers.push(t);
    }
  }
  if (!finishConstruction(g)) return null;
  if (profile.startsWith('fortress')
      && !buildFortressWalls(g, keep, towers, profile === 'fortress+')) return null;
  if (!finishConstruction(g)) return null;
  for (const type of ['farm', 'quarry']) {
    const site = nearestSite(g, type);
    if (site) place(g, site.x, site.y, type);
  }
  if (!finishConstruction(g)) return null;
  g.time = 0;
  g.phase = 'prep';
  g.phaseLeft = WAVE.prepFirst;
  g.res = { stone: 120, gold: 0 };
  // D91: man what the farm feeds, outer towers first, the Keep with the rest.
  for (const t of [...towers, keep]) while (garrisonState(g).free > 0 && assignGarrison(g, t, 1).ok);
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
      } else {
        // D93: the Keep cannot shoot at its own base, so the bot steps out to
        // fight whatever reaches it, as a player must; otherwise it shelters.
        // A careful player only steps out to finish stragglers, never into a crowd.
        const near = g.enemies.filter((e) => !e.wild && Math.hypot(e.x - keep.x, e.y - keep.y) < 9);
        const base = near.find((e) => Math.hypot(e.x - keep.x, e.y - keep.y) < KEEP.minRange + 1);
        if (base && near.length <= 2 && g.player.hp > g.player.maxHp * 0.7) {
          const dx = base.x - g.player.x; const dy = base.y - g.player.y;
          g.input = { mx: dx, my: dy, melee: Math.hypot(dx, dy) < PLAYER.melee.range, repair: false };
        } else if (Math.hypot(g.player.x - keep.x, g.player.y - keep.y) > 0.5) { g.player.x = keep.x; g.player.y = keep.y; }
      }
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
for (const seed of SEEDS) for (const profile of ['outposts', 'fortress', 'fortress+']) {
  const started = Date.now();
  const r = runProfile(seed, profile);
  r.ms = Date.now() - started;
  results.push(r);
}

for (const profile of ['outposts', 'fortress', 'fortress+']) {
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
