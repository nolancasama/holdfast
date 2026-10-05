// D109 Tower combat in first person: the basic firing case, blind zone, range,
// hills, sparse versus thick forest, and a supporting Tower covering another's
// blind spot - all under the height-aware sight the 3D shell installs.

import { T, MAP, BUILD, WORLD3D, TOWER } from '../src/config.js';
import { idx, hasLineOfSight } from '../src/terrain.js';
import { tryBuild, spawnGroupAt, update, towerMinRange, towerStats } from '../src/game.js';
import { buildHeightField, facingFromYaw } from '../src/fp/space.js';
import { createTowerSight, traceSight, treeAt, turretYaw, muzzleHeight } from '../src/fp/sight.js';

export function runSight({ check, assert, gameOn, flatMap }) {
  const finish = (t) => { t.built = true; t.progress = 1; t.hp = t.maxHp; };

  /** A first-person game with built Towers at the given offsets from the Keep. */
  function scenario(offsets, shape = () => {}) {
    const g = gameOn(flatMap());
    g.rules = { ...g.rules, buildReach: BUILD.lookReach, solidTowers: true, exploreRadius: WORLD3D.exploreRadius };
    g.res.stone = 1e5;
    g.res.gold = 1e5;
    const k = g.towers.find((t) => t.keep);
    const towers = offsets.map(([dx, dy]) => {
      const x = Math.floor(k.x + dx) + 0.5;
      const y = Math.floor(k.y + dy) + 0.5;
      g.player.x = x; g.player.y = y;
      const r = tryBuild(g, x, y, 'tower');
      assert(r.ok, `tower refused at ${dx},${dy}: ${(r.reasons || []).join('; ')}`);
      finish(r.structure);
      return r.structure;
    });
    // Terrain is shaped after placement so forest clearing (D69) cannot undo it.
    shape(g.map, towers);
    g.rules.towerSight = createTowerSight(buildHeightField(g.map));
    g.player.x = k.x - 40; // far away: no presence bonus, no aggro
    g.player.y = k.y;
    return { g, towers };
  }

  /** Pin one Heavy at (x, y) for `seconds`; count shots each Tower fires at it. */
  function pinned(g, x, y, seconds = 2) {
    spawnGroupAt(g, x, y, 'heavy', 1);
    const e = g.enemies.at(-1);
    const hp0 = e.hp;
    const shots = new Map();
    const push = g.tracers.push.bind(g.tracers);
    g.tracers.push = (...items) => {
      for (const tr of items) shots.set(tr.towerId, (shots.get(tr.towerId) || 0) + 1);
      return push(...items);
    };
    for (let s = 0; s < seconds; s += 0.05) {
      e.x = x; e.y = y;
      update(g, 0.05);
    }
    return { e, hpLoss: hp0 - e.hp, shots };
  }

  check('D109: basic case - Tower acquires a clear target 5 tiles away, fires, tracer, damage, turret tracks', () => {
    const { g, towers: [t] } = scenario([[20, 0]]);
    const { e, hpLoss, shots } = pinned(g, t.x + 5, t.y);
    assert(t.targetId === e.id, `target acquired (${t.targetId} vs ${e.id})`);
    assert((shots.get(t.id) || 0) >= 2, `fired ${shots.get(t.id) || 0} shots in 2 s`);
    assert(hpLoss > 0, `enemy lost hp (${hpLoss})`);
    // The 3D turret yaw for this target faces the enemy.
    const f = facingFromYaw(turretYaw(t, { x: t.x + 5, y: t.y }));
    assert(Math.abs(f.x - 1) < 1e-6 && Math.abs(f.y) < 1e-6, `turret faces east ${JSON.stringify(f)}`);
  });

  check('D109: every distance across the firing annulus fires on clear ground', () => {
    for (const d of [3.2, 4, 5, 6, 7]) {
      const { g, towers: [t] } = scenario([[20, 0]]);
      const { hpLoss } = pinned(g, t.x, t.y + d, 1.5);
      assert(hpLoss > 0, `no damage at ${d} tiles`);
    }
  });

  check('D109: a target inside the blind zone is never fired on', () => {
    const { g, towers: [t] } = scenario([[20, 0]]);
    assert(towerMinRange(g, t) > 2, 'blind zone configured');
    const { hpLoss, shots } = pinned(g, t.x + 2, t.y);
    assert(hpLoss === 0 && !shots.get(t.id), `blind zone fired (${hpLoss})`);
  });

  check('D109: a target beyond maximum range is never fired on', () => {
    const { g, towers: [t] } = scenario([[20, 0]]);
    const { hpLoss, shots } = pinned(g, t.x + towerStats(g, t).range + 1.5, t.y);
    assert(hpLoss === 0 && !shots.get(t.id), `out of range fired (${hpLoss})`);
  });

  check('D109: a target standing on a hill is fired on; one behind a cliff ridge is not', () => {
    const hill = scenario([[20, 0]], (map, [t]) => {
      for (let y = Math.floor(t.y) - 4; y <= Math.floor(t.y) + 4; y++) {
        for (let x = Math.floor(t.x) + 3; x <= Math.floor(t.x) + 9; x++) map.elev[idx(x, y)] = 2;
      }
    });
    const onHill = pinned(hill.g, hill.towers[0].x + 5.5, hill.towers[0].y);
    assert(onHill.hpLoss > 0, 'enemy on the hill takes fire');

    const ridge = scenario([[20, 0]], (map, [t]) => {
      for (let y = Math.floor(t.y) - 4; y <= Math.floor(t.y) + 4; y++) {
        for (const x of [Math.floor(t.x) + 3, Math.floor(t.x) + 4]) { map.kind[idx(x, y)] = T.CLIFF; map.elev[idx(x, y)] = 2; }
      }
    });
    const behind = pinned(ridge.g, ridge.towers[0].x + 6, ridge.towers[0].y);
    assert(behind.hpLoss === 0, `fired through a cliff ridge (${behind.hpLoss})`);
  });

  check('D109: sparse trees do not wall off a 9 m Tower (the 2D model said they did)', () => {
    let tree = null;
    const { g, towers: [t] } = scenario([[20, 0]], (map, [tw]) => {
      // One forest tile with a rendered tree on the line, two tiles short of the target.
      const ty = Math.floor(tw.y);
      for (let x = Math.floor(tw.x) + 3; x <= Math.floor(tw.x) + 4; x++) {
        map.kind[idx(x, ty)] = T.FOREST;
        if (!tree && treeAt(map, x, ty)) tree = { x, y: ty };
        else map.kind[idx(x, ty)] = T.PLAIN;
      }
    });
    assert(tree, 'a rendered tree on the line');
    assert(!hasLineOfSight(g.map, t.x, t.y, t.x + 6, t.y), 'the old tile LOS blocks');
    const { hpLoss } = pinned(g, t.x + 6, t.y);
    assert(hpLoss > 0, 'height-aware sight fires past one tree');
  });

  check('D109: thick woods still block a low target', () => {
    const { g, towers: [t] } = scenario([[20, 0]], (map, [tw]) => {
      for (let y = Math.floor(tw.y) - 3; y <= Math.floor(tw.y) + 3; y++) {
        for (let x = Math.floor(tw.x) + 3; x <= Math.floor(tw.x) + 8; x++) map.kind[idx(x, y)] = T.FOREST;
      }
    });
    const field = buildHeightField(g.map);
    const z0 = field.ground[0] + muzzleHeight(t); // flat map: every vertex is one band high
    const tr = traceSight(g.map, field, t.x, t.y, z0, t.x + 7, t.y, field.ground[0] + 1.9);
    assert(!tr.clear && tr.blockedBy === 'canopy', `woods trace ${JSON.stringify(tr)}`);
    const { hpLoss } = pinned(g, t.x + 7, t.y);
    assert(hpLoss === 0, `fired through thick woods (${hpLoss})`);
  });

  check('D109: a supporting Tower covers another Tower\'s blind spot', () => {
    const { g, towers: [a, b] } = scenario([[18, 0], [25, 0]]);
    const x = a.x + 1.6; // inside A's blind zone, 5.4 tiles from B
    assert(Math.hypot(x - a.x, 0) < towerMinRange(g, a), 'in A blind zone');
    const { hpLoss, shots } = pinned(g, x, a.y);
    assert(!shots.get(a.id), 'A holds fire');
    assert((shots.get(b.id) || 0) >= 2 && hpLoss > 0, `B covers (${shots.get(b.id) || 0} shots)`);
  });

  check('D109: the classic shell keeps the tile LOS (no sight hook)', () => {
    const g = gameOn(flatMap());
    assert(!g.rules?.towerSight, 'classic has no height-aware sight');
    void MAP; void TOWER;
  });
}
