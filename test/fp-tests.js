// D101 first-person checks: coordinate conversion, terrain height, raycasts,
// picking, Wall endpoint selection, and the simulation rules the 3D shell uses
// (crosshair build reach, solid Towers, perching, gait, repair focus).

import { MAP, T, PLAYER, TOWER, WORLD3D, BUILD, WALL } from '../src/config.js';
import { idx } from '../src/terrain.js';
import {
  update, tryBuild, playerSpeed, perchOnTower, leavePerch, repairTarget, tryBuildWall,
  isTileExplored, recomputeVisibility,
} from '../src/game.js';
import {
  tileToWorld, worldToTile, buildHeightField, heightAt, raycastTerrain, rayCylinder, pickTarget,
  wallAnchorFromPick, headingDegrees, facingFromYaw, moveIntent, snapToTile,
} from '../src/fp/space.js';

const S = WORLD3D.tileMeters;

export function runFirstPerson({ check, assert, gameOn, flatMap, rich, run, maps, seeds }) {
  const fpRules = (g) => { g.rules = { ...g.rules, buildReach: BUILD.lookReach, solidTowers: true, exploreRadius: WORLD3D.exploreRadius }; return g; };
  const finish = (...ts) => ts.forEach((t) => { t.built = true; t.progress = 1; t.hp = t.maxHp; });
  const place = (g, x, y, type = 'tower') => {
    g.player.x = x; g.player.y = y;
    const r = tryBuild(g, x, y, type);
    assert(r.ok, `${type} refused at ${x},${y}: ${(r.reasons || []).join('; ')}`);
    return r.structure;
  };

  check('D101: tile <-> world conversion round-trips at tileMeters scale', () => {
    const w = tileToWorld(12.25, 40.5);
    assert(w.x === 12.25 * S && w.z === 40.5 * S, 'tileToWorld scale');
    const t = worldToTile(w.x, w.z);
    assert(Math.abs(t.x - 12.25) < 1e-9 && Math.abs(t.y - 40.5) < 1e-9, 'round trip');
  });

  check('D101: yaw 0 faces north (-Z / decreasing tile y); headings are compass degrees', () => {
    const f = facingFromYaw(0);
    assert(Math.abs(f.x) < 1e-9 && Math.abs(f.y + 1) < 1e-9, `north facing ${JSON.stringify(f)}`);
    assert(Math.abs(headingDegrees(0, -1)) < 1e-9, 'north = 0');
    assert(Math.abs(headingDegrees(1, 0) - 90) < 1e-9, 'east = 90');
    assert(Math.abs(headingDegrees(0, 1) - 180) < 1e-9, 'south = 180');
    assert(Math.abs(headingDegrees(-1, 0) - 270) < 1e-9, 'west = 270');
  });

  check('D101: WASD intent is camera-relative', () => {
    const fwd = moveIntent(1, 0, 0);
    assert(fwd.my < -0.99 && Math.abs(fwd.mx) < 1e-9, 'W at yaw 0 moves north');
    const right = moveIntent(0, 1, 0);
    assert(right.mx > 0.99 && Math.abs(right.my) < 1e-9, 'D at yaw 0 moves east');
    const west = moveIntent(1, 0, Math.PI / 2);
    assert(west.mx < -0.99, 'W at yaw 90deg left moves west');
  });

  check('D101: flat map height equals the elevation band everywhere, matching mesh corners', () => {
    const map = flatMap();
    const field = buildHeightField(map);
    for (const [x, y] of [[0, 0], [10.3, 20.7], [103.5, 51.5], [MAP.w - 0.01, MAP.h - 0.01]]) {
      const h = heightAt(field, x, y);
      assert(Math.abs(h - WORLD3D.elevStep) < 1e-4, `height ${h} at ${x},${y}`);
    }
    for (let k = 0; k < 50; k++) {
      const vx = (k * 37) % MAP.w;
      const vy = (k * 17) % MAP.h;
      assert(Math.abs(heightAt(field, vx, vy) - field.ground[vy * (MAP.w + 1) + vx]) < 1e-4, 'vertex mismatch');
    }
  });

  check('D101: water sits below its surface, deep lower than shallow; cliff interiors rise', () => {
    const map = flatMap();
    const cy = Math.floor(MAP.h / 2);
    for (let y = cy - 3; y <= cy + 3; y++) for (let x = 20; x <= 26; x++) map.kind[idx(x, y)] = T.DEEP;
    for (let y = cy - 3; y <= cy + 3; y++) for (let x = 40; x <= 46; x++) map.kind[idx(x, y)] = T.SHALLOW;
    for (let y = cy - 3; y <= cy + 3; y++) for (let x = 60; x <= 66; x++) map.kind[idx(x, y)] = T.CLIFF;
    const field = buildHeightField(map);
    const deep = heightAt(field, 23.5, cy + 0.5);
    const shallow = heightAt(field, 43.5, cy + 0.5);
    const plain = heightAt(field, 33.5, cy + 0.5);
    const cliff = heightAt(field, 63.5, cy + 0.5);
    assert(heightAt(field, 23.5, cy + 0.5, 'surface') - deep > 1.2, 'deep water depth');
    assert(deep < shallow && shallow < plain, `deep ${deep} < shallow ${shallow} < plain ${plain}`);
    assert(cliff - plain > WORLD3D.cliffHeight * 0.6, `cliff rise ${cliff - plain}`);
  });

  check('D101: walkable terrain on real maps has no step steeper than ~50 degrees', () => {
    let worst = 0;
    for (const map of maps.slice(0, 6)) {
      const field = buildHeightField(map);
      const vw = MAP.w + 1;
      for (let vy = 1; vy < MAP.h; vy++) {
        for (let vx = 1; vx < MAP.w; vx++) {
          // Only vertices whose four tiles are all walkable, non-water ground.
          let ok = true;
          for (const [ox, oy] of [[-1, -1], [0, -1], [-1, 0], [0, 0]]) {
            const k = map.kind[idx(vx + ox, vy + oy)];
            if (k === T.CLIFF || k === T.DEEP || k === T.SHALLOW) ok = false;
          }
          if (!ok) continue;
          const h = field.ground[vy * vw + vx];
          const right = field.ground[vy * vw + vx + 1];
          const down = field.ground[(vy + 1) * vw + vx];
          worst = Math.max(worst, Math.abs(h - right), Math.abs(h - down));
        }
      }
    }
    assert(worst < S * 1.2, `steepest walkable step ${worst.toFixed(2)} m over ${S} m`);
  });

  check('D101: terrain raycast lands where the ray meets the ground', () => {
    const field = buildHeightField(flatMap());
    const ground = WORLD3D.elevStep;
    const down = raycastTerrain(field, { x: 50 * S, y: ground + 10, z: 30 * S }, { x: 0, y: -1, z: 0 });
    assert(down && Math.abs(down.x - 50) < 0.01 && Math.abs(down.y - 30) < 0.01, 'straight down');
    assert(Math.abs(down.distance - 10) < 0.02, `distance ${down.distance}`);
    // 45 degrees down towards +X from 4 m above ground: lands 4 m (2 tiles) east.
    const slant = raycastTerrain(field, { x: 50 * S, y: ground + 4, z: 30 * S }, { x: 1, y: -1, z: 0 });
    assert(slant && Math.abs(slant.x - (50 + 4 / S)) < 0.02, `slant x ${slant?.x}`);
    const snapped = snapToTile(slant);
    assert(snapped.x === 52.5 && snapped.y === 30.5, `snap ${JSON.stringify(snapped)}`);
    const sky = raycastTerrain(field, { x: 50 * S, y: ground + 4, z: 30 * S }, { x: 1, y: 0.2, z: 0 }, 60);
    assert(sky === null, 'upward ray never hits');
  });

  check('D101: ray-cylinder entry distance and misses', () => {
    const t = rayCylinder({ x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: -1 }, 0, -10, 2, 0, 5);
    assert(Math.abs(t - 8) < 1e-6, `entry ${t}`);
    assert(rayCylinder({ x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: -1 }, 5, -10, 2, 0, 5) === Infinity, 'miss to the side');
    assert(rayCylinder({ x: 0, y: 9, z: 0 }, { x: 0, y: 0, z: -1 }, 0, -10, 2, 0, 5) === Infinity, 'pass over the top');
    assert(rayCylinder({ x: 0, y: 1, z: -10 }, { x: 0, y: 0, z: -1 }, 0, -10, 2, 0, 5) === Infinity, 'a ray from inside ignores that target');
  });

  check('D101: the crosshair picks a Tower in front, but not one hidden behind the ground hit', () => {
    const field = buildHeightField(flatMap());
    const eye = { x: 50 * S, y: WORLD3D.elevStep + WORLD3D.eyeHeight, z: 30 * S };
    const tower = { id: 7, x: 50.5, y: 24.5, radius: TOWER.radius };
    const targets = [{ kind: 'tower', ref: tower, x: tower.x, y: tower.y, radius: tower.radius, height: WORLD3D.towerHeight }];
    const hit = pickTarget(field, eye, { x: 0.02, y: 0, z: -1 }, targets, 80);
    assert(hit?.kind === 'tower' && hit.ref === tower, 'tower in front picked');
    const hidden = pickTarget(field, eye, { x: 0.02, y: 0, z: -1 }, targets, 80, 3);
    assert(hidden === null, 'terrain closer than the tower hides it');
  });

  check('D99/D101: only finished, standing, non-Keep Towers can anchor a Wall', () => {
    const keep = wallAnchorFromPick({ kind: 'tower', ref: { keep: true, built: true, hp: 10 } });
    assert(!keep.ok && keep.reason === 'Walls must connect two Towers.', 'Keep refused with D99 message');
    assert(!wallAnchorFromPick({ kind: 'tower', ref: { keep: false, built: false, hp: 10 } }).ok, 'unfinished refused');
    assert(!wallAnchorFromPick({ kind: 'wall', ref: {} }).ok, 'non-tower refused');
    assert(!wallAnchorFromPick(null).ok, 'nothing refused');
    const t = { keep: false, built: true, hp: 10 };
    const ok = wallAnchorFromPick({ kind: 'tower', ref: t });
    assert(ok.ok && ok.tower === t, 'finished tower accepted');
  });

  check('D101: crosshair build reach — near sites build, far sites are refused', () => {
    const g = fpRules(gameOn());
    rich(g);
    const k = g.towers[0];
    g.player.x = k.x + 10; g.player.y = k.y;
    const near = tryBuild(g, k.x + 10 + BUILD.lookReach - 0.5, k.y, 'tower');
    assert(near.ok, `near refused: ${near.reasons?.join('; ')}`);
    g.player.x = k.x - 20; g.player.y = k.y;
    const far = tryBuild(g, k.x - 20 - BUILD.lookReach - 1, k.y, 'tower');
    assert(!far.ok && far.reasons.includes('move closer to the site'), `far: ${far.reasons?.join('; ')}`);
    // The 2D classic keeps its stand-on-the-site rule.
    const classic = gameOn();
    rich(classic);
    classic.player.x = k.x + 10; classic.player.y = k.y;
    assert(!tryBuild(classic, k.x + 14, k.y, 'tower').ok, 'classic reach unchanged');
  });

  check('D101: Towers and the Keep are solid to the first-person player only', () => {
    const g = fpRules(gameOn());
    const k = g.towers[0];
    g.player.x = k.x - 5; g.player.y = k.y;
    g.input = { mx: 1, my: 0, melee: false, repair: false };
    run(g, 3);
    assert(g.player.x <= k.x - (k.radius + PLAYER.radius) + 0.05, `walked into the Keep: ${g.player.x - k.x}`);
    const classic = gameOn();
    const k2 = classic.towers[0];
    classic.player.x = k2.x - 5; classic.player.y = k2.y;
    classic.input = { mx: 1, my: 0, melee: false, repair: false };
    run(classic, 3);
    assert(classic.player.x > k2.x, 'classic player still passes through');
  });

  check('D101: a player overlapping a Tower can always walk out of it', () => {
    const g = fpRules(gameOn());
    const k = g.towers[0];
    g.player.x = k.x + 0.3; g.player.y = k.y;
    g.input = { mx: 1, my: 0, melee: false, repair: false };
    run(g, 1);
    assert(g.player.x > k.x + k.radius + PLAYER.radius - 0.05, `trapped at ${g.player.x - k.x}`);
  });

  check('D101: climbing a Tower occupies it; climbing down lands outside on open ground', () => {
    const g = fpRules(gameOn());
    rich(g);
    const k = g.towers[0];
    const t = place(g, k.x + 10, k.y);
    g.player.x = t.x - 6; g.player.y = t.y;
    assert(!perchOnTower(g, t).ok, 'unfinished tower refused');
    finish(t);
    assert(!perchOnTower(g, t).ok, 'too far refused');
    g.player.x = t.x - (t.radius + PLAYER.radius + 0.1);
    assert(perchOnTower(g, t).ok, 'adjacent perch accepted');
    g.input = { mx: 1, my: 0, melee: false, repair: false };
    run(g, 1.2);
    assert(g.player.x === t.x && g.player.y === t.y, 'perched player does not walk');
    assert(g.occupiedTowerId === t.id, 'perch occupies the tower');
    leavePerch(g, { x: 0, y: 1 });
    const d = Math.hypot(g.player.x - t.x, g.player.y - t.y);
    assert(g.player.perchId == null && d >= t.radius + PLAYER.radius, `landed ${d} from centre`);
  });

  check('D101/D6: a Tower collapsing under a perched player drops and hurts them', () => {
    const g = fpRules(gameOn());
    rich(g);
    const k = g.towers[0];
    const t = place(g, k.x + 10, k.y);
    finish(t);
    g.player.x = t.x - 1.5; g.player.y = t.y;
    assert(perchOnTower(g, t).ok, 'perch');
    t.hp = -1;
    g.input = { mx: 0, my: 0, melee: false, repair: false };
    run(g, 0.2);
    assert(g.player.perchId == null, 'perch cleared');
    assert(g.player.hp < g.player.maxHp * 0.5, `collapse damage applied (${g.player.hp})`);
  });

  check('D101: walk/sprint gait scales speed and the D75 road bonus still stacks', () => {
    const g = gameOn();
    const tx = Math.floor(g.player.x);
    const ty = Math.floor(g.player.y);
    g.input = { mx: 0, my: 0, speedMult: WORLD3D.walkMult };
    const walk = playerSpeed(g);
    g.input.speedMult = WORLD3D.sprintMult;
    const sprint = playerSpeed(g);
    assert(Math.abs(walk - PLAYER.speed * WORLD3D.walkMult) < 1e-9, `walk ${walk}`);
    assert(Math.abs(sprint / walk - WORLD3D.sprintMult / WORLD3D.walkMult) < 1e-9, 'sprint ratio');
    g.map.road[idx(tx, ty)] = 1;
    const road = playerSpeed(g);
    assert(Math.abs(road - PLAYER.speed * WORLD3D.sprintMult * PLAYER.roadSpeedMult) < 1e-9, `road sprint ${road}`);
    g.input = { mx: 0, my: 0 };
    assert(Math.abs(playerSpeed(g) - PLAYER.speed * PLAYER.roadSpeedMult) < 1e-9, 'classic speed unchanged');
  });

  check('D101/D83: repair works on the structure under the crosshair when it is in reach', () => {
    const g = fpRules(gameOn());
    rich(g);
    const k = g.towers[0];
    const site = g.map.stoneSites[0];
    const q = place(g, site.x, site.y, 'quarry');
    q.built = true; q.progress = 1;
    k.hp = k.maxHp * 0.5;
    q.hp = q.maxHp * 0.5;
    // Between the Keep and the Quarry, nearer the Quarry's edge; both in reach.
    g.player.x = k.x + k.radius + TOWER.repair.reach - 0.15; g.player.y = k.y;
    g.selected = null;
    g.selectedBuildingId = null;
    g.repairFocus = null;
    assert(repairTarget(g) === q, 'without focus the nearest damaged structure is chosen');
    g.repairFocus = k;
    assert(repairTarget(g) === k, 'focus wins over the nearer structure');
    g.player.x = q.x + 6; g.player.y = q.y;
    g.repairFocus = k;
    assert(repairTarget(g) !== k, 'out-of-reach focus is ignored (never remote)');
  });

  check('D101: Tower-only manual walls still work and the posterns let the player through', () => {
    const g = fpRules(gameOn());
    rich(g);
    const k = g.towers[0];
    const a = place(g, k.x + 10, k.y - 5);
    const b = place(g, k.x + 10, k.y + 5);
    finish(a, b);
    assert(g.walls.length === 0, 'towers never create walls');
    g.player.x = a.x - 2; g.player.y = a.y;
    const res = tryBuildWall(g, a.id, b.id);
    assert(res.ok, res.reasons?.join('; '));
    assert(!tryBuildWall(g, k.id, a.id).ok, 'Keep endpoint refused');
    run(g, 30);
    const link = g.walls[0];
    assert(link.built, 'wall finished');
    // Walk east through the middle (solid) -> blocked; through the postern -> passes.
    const mid = link.segments[Math.floor(link.segments.length / 2)];
    g.player.x = mid.x - 3; g.player.y = mid.y;
    g.input = { mx: 1, my: 0, melee: false, repair: false };
    run(g, 2);
    assert(g.player.x < mid.x, 'solid segment blocks');
    const gate = link.segments.find((s) => s.gate);
    g.player.x = gate.x - 3; g.player.y = gate.y;
    run(g, 2.5);
    assert(g.player.x > gate.x + 0.5, `postern passes (x ${g.player.x - gate.x})`);
  });

  check('D101: first-person exploration remembers terrain in sight without widening live vision', () => {
    const g = fpRules(gameOn());
    recomputeVisibility(g, true);
    const p = g.player;
    const far = { x: Math.floor(p.x + 14), y: Math.floor(p.y) };
    assert(isTileExplored(g, far.x, far.y), 'tile 14 away explored');
    assert(!g.fog.visible[idx(far.x, far.y)], 'but not live-visible');
    const classic = gameOn();
    recomputeVisibility(classic, true);
    assert(!isTileExplored(classic, far.x, far.y), 'classic exploration unchanged');
  });

  check('D101: Wall cost stays per segment and manual (no Stone spent by Tower placement)', () => {
    const g = fpRules(gameOn());
    rich(g);
    const before = g.res.stone;
    const k = g.towers[0];
    place(g, k.x + 10, k.y);
    assert(before - g.res.stone === TOWER.cost.stone, `only tower cost charged (${before - g.res.stone})`);
    assert(WALL.costStonePerSegment > 0, 'segment cost configured');
  });

  void seeds;
  void update;
}
