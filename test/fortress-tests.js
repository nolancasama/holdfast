// Phase-2 fortress checks: tower-anchored walls (D81), break-cost pathing and
// Heavy wall breaking (D82), local repair of walls (D83). Uses the harness
// helpers from run-tests.js through `ctx`.

import { MAP, T, PLAYER, WALL, WALL_PATH, ENEMIES, TOWER } from '../src/config.js';
import { idx } from '../src/terrain.js';
import {
  update, tryBuild, wallPlan, tryBuildWall, wallSegments, supercoverLine,
  enemyKeepField, keepFieldState, spawnGroupAt, buildingState, towerStats, repairTarget,
  stuckState, structureClearLine,
} from '../src/game.js';

export function runFortress({ check, assert, gameOn, flatMap, rich, run }) {
  const cy = Math.floor(MAP.h / 2);

  function tower(g, x, y) {
    g.player.x = x; g.player.y = y;
    const r = tryBuild(g, x, y, 'tower');
    assert(r.ok, `tower refused at ${x},${y}: ${r.reasons.join('; ')}`);
    return r.structure;
  }

  function finish(g, ...towers) {
    for (const t of towers) { t.built = true; t.progress = 1; t.hp = t.maxHp; }
  }

  function wall(g, a, b) {
    g.player.x = a.x; g.player.y = a.y;
    const r = tryBuildWall(g, a.id, b.id);
    assert(r.ok, `wall ${a.id}-${b.id} refused: ${r.reasons.join('; ')}`);
    return r.link;
  }

  function completeWalls(g) {
    for (const link of g.walls) {
      link.built = true; link.progress = 1;
      for (const s of link.segments) if (!s.destroyed) s.hp = s.maxHp;
    }
  }

  /** Keep + four corner towers + four walls: a closed ring around the Keep. */
  function ringFixture(map = flatMap()) {
    const g = gameOn(map); rich(g);
    const k = g.towers[0];
    const corners = [[6, -6], [6, 6], [-6, 6], [-6, -6]].map(([dx, dy]) => tower(g, k.x + dx, k.y + dy));
    finish(g, ...corners);
    for (let n = 0; n < 4; n++) wall(g, corners[n], corners[(n + 1) % 4]);
    completeWalls(g);
    g.player.x = k.x; g.player.y = k.y;
    return { g, k, corners };
  }

  /** A real enemy that ignores the player, with plenty of hp so towers cannot decide the test. */
  function enemy(g, type, x, y, hp = 1e6) {
    spawnGroupAt(g, x, y, type, 1);
    const e = g.enemies[g.enemies.length - 1];
    e.x = x; e.y = y; e.hp = e.maxHp = hp;
    e.def = { ...ENEMIES[type], playerHit: 0, playerAggroRange: 0 };
    return e;
  }

  function silenceTowers(g) { for (const t of g.towers) t.shotCd = 1e9; }

  /**
   * All deep water except: a corridor (rows cy-1..cy+1) from the Keep to the
   * east edge; an open court x in [k+8, k+14], y in [cy-7, cy+7] where two
   * towers and a wall seal the corridor; and a long detour loop from the
   * court's north-east corner round to the corridor west of the wall.
   */
  function detourMap(loopHeight = 20) {
    const map = flatMap();
    const kx = map.start.x;
    map.kind.fill(T.DEEP);
    const open = (x0, x1, y0, y1) => {
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) map.kind[idx(x, y)] = T.PLAIN;
    };
    open(kx - 3, MAP.w - 1, cy - 1, cy + 1);          // corridor
    open(kx - 3, kx + 3, cy - 3, cy + 3);              // Keep yard
    open(kx + 8, kx + 14, cy - 7, cy + 7);             // court sealed by the wall
    open(kx + 13, kx + 15, cy - 7 - loopHeight, cy - 7); // detour up...
    open(kx + 4, kx + 15, cy - 9 - loopHeight, cy - 7 - loopHeight); // ...across...
    open(kx + 4, kx + 6, cy - 9 - loopHeight, cy - 2); // ...and down to the corridor
    map.spawns = { west: [{ x: kx - 3, y: cy }], east: [{ x: MAP.w - 2, y: cy }] };
    return map;
  }

  function detourFixture(loopHeight = 20) {
    const g = gameOn(detourMap(loopHeight)); rich(g);
    const k = g.towers[0];
    const a = tower(g, k.x + 11, k.y - 6);
    const b = tower(g, k.x + 11, k.y + 6);
    finish(g, a, b);
    wall(g, a, b);
    completeWalls(g);
    silenceTowers(g);
    g.player.x = k.x - 2; g.player.y = k.y - 2;
    return { g, k, a, b };
  }

  const fieldAt = (field, x, y) => field[idx(Math.floor(x), Math.floor(y))];

  // --- D81 validity -----------------------------------------------------------

  check('D81 wall needs two finished towers, within length, not duplicated', () => {
    const g = gameOn(); rich(g);
    const k = g.towers[0];
    const a = tower(g, k.x + 10, k.y);
    let plan = wallPlan(g, k.id, a.id);
    assert(!plan.ok && plan.reasons.includes('both towers must be finished'), `unfinished anchor accepted: ${plan.reasons}`);
    finish(g, a);
    plan = wallPlan(g, k.id, a.id);
    assert(plan.ok, `valid wall refused: ${plan.reasons}`);
    assert(!wallPlan(g, k.id, 9999).ok, 'a non-tower endpoint was accepted');
    assert(!wallPlan(g, k.id, k.id).ok, 'a tower was allowed to wall to itself');
    const far = tower(g, k.x - 14, k.y); finish(g, far);
    assert(wallPlan(g, k.id, far.id).reasons.some((r) => r.startsWith('too long')), 'over-length wall not refused');
    wall(g, k, a);
    assert(wallPlan(g, a.id, k.id).reasons.includes('these towers are already joined'), 'duplicate link accepted');
  });

  check('D81 wall refuses crossing another tower, an economic building or an existing wall', () => {
    const setup = () => {
      const g = gameOn(); rich(g);
      const k = g.towers[0];
      const a = tower(g, k.x + 12, k.y); finish(g, a);
      return { g, k, a };
    };
    {
      const { g, k, a } = setup();
      const m = tower(g, k.x + 6, k.y + 8); finish(g, m);
      m.y = k.y; // stand it on the line
      assert(wallPlan(g, k.id, a.id).reasons.includes('crosses another tower'), 'crossing a tower accepted');
    }
    {
      const { g, k, a } = setup();
      g.buildings.push({ id: 77, type: 'farm', x: k.x + 4.5, y: k.y, hp: 10, maxHp: 10, built: true, destroyed: false, rate: 0 });
      assert(wallPlan(g, k.id, a.id).reasons.includes('crosses an economic building'), 'crossing a building accepted');
    }
    {
      const { g, k, a } = setup();
      const n = tower(g, k.x + 6, k.y - 6); const s2 = tower(g, k.x + 6, k.y + 6);
      finish(g, n, s2);
      wall(g, n, s2);
      assert(wallPlan(g, k.id, a.id).reasons.includes('crosses an existing wall'), 'crossing a wall accepted');
    }
  });

  check('D81 wall length, segment count and Stone cost; cliffs are skipped and free', () => {
    const map = flatMap();
    const g = gameOn(map); rich(g);
    const k = g.towers[0];
    const a = tower(g, k.x + 12, k.y); finish(g, a);
    const plan = wallPlan(g, k.id, a.id);
    // Keep footprint spans x-1..x+1, tower footprint x+11..x+13: segments x+2..x+10.
    assert(plan.segments.length === 9, `expected 9 segments, got ${plan.segments.length}`);
    assert(plan.cost.stone === 9 * WALL.costStonePerSegment && !plan.cost.food && !plan.cost.gold, `cost ${JSON.stringify(plan.cost)}`);
    map.kind[idx(Math.floor(k.x) + 5, Math.floor(k.y))] = T.CLIFF;
    map.kind[idx(Math.floor(k.x) + 6, Math.floor(k.y))] = T.DEEP;
    const skipped = wallPlan(g, k.id, a.id);
    assert(skipped.skipped === 2 && skipped.segments.length === 7, `skips ${skipped.skipped}, segments ${skipped.segments.length}`);
    assert(skipped.cost.stone === 7 * WALL.costStonePerSegment, 'skipped tiles were charged');
    const stone = g.res.stone;
    g.player.x = k.x; g.player.y = k.y;
    const link = tryBuildWall(g, k.id, a.id).link;
    assert(g.res.stone === stone - skipped.cost.stone, 'Stone not deducted exactly');
    assert(Math.abs(link.duration - (WALL.buildBase + WALL.buildPerTile * 7)) < 1e-9, 'build time does not scale with segments');
  });

  check('D81 supercover lines are 4-connected for every direction', () => {
    for (let a = 0; a < 64; a++) {
      const ang = (a / 64) * Math.PI * 2;
      const x0 = 50.5; const y0 = 50.5;
      const line = supercoverLine(x0, y0, x0 + Math.cos(ang) * 12.3, y0 + Math.sin(ang) * 12.3);
      for (let i = 1; i < line.length; i++) {
        const d = Math.abs(line[i].x - line[i - 1].x) + Math.abs(line[i].y - line[i - 1].y);
        assert(d === 1, `diagonal step at angle ${a}/64`);
      }
    }
  });

  check('D81 wall cannot be started away from both anchors; unaffordable is refused', () => {
    const g = gameOn(); rich(g);
    const k = g.towers[0];
    const a = tower(g, k.x + 10, k.y); finish(g, a);
    g.player.x = k.x; g.player.y = k.y - 20;
    assert(!tryBuildWall(g, k.id, a.id).ok && !g.walls.length, 'remote wall started');
    g.player.x = k.x; g.player.y = k.y;
    g.res.stone = 5;
    const r = tryBuildWall(g, k.id, a.id);
    assert(!r.ok && r.reasons.some((x) => x.startsWith('need')), 'unaffordable wall started');
  });

  check('D81 an unfinished wall blocks at once and is fragile', () => {
    const g = gameOn(); rich(g);
    const k = g.towers[0];
    const a = tower(g, k.x + 10, k.y); finish(g, a);
    const link = wall(g, k, a);
    assert(!link.built, 'wall finished instantly');
    for (const s of link.segments) {
      assert(g.blockerGrid[s.i]?.structure === s, 'unfinished segment is not a blocker');
      assert(Math.abs(s.hp - WALL.segmentHp * WALL.buildHpFraction) < 1e-9, 'unfinished segment hp');
    }
    g.player.x = k.x - 30;
    run(g, link.duration + 0.5, 1 / 60);
    assert(link.built && link.segments.every((s) => s.hp === s.maxHp), 'wall did not finish unassisted at exactly full hp');
    // Float build steps must not leave a finished wall reading as damaged:
    // completion snaps near-full segments, and repair ignores float residue.
    g.player.x = link.segments[2].x + 1.2; g.player.y = link.segments[2].y + 1.2;
    assert(repairTarget(g) === null, 'a finished, undamaged wall is offered for repair');
    link.segments[2].hp = link.segments[2].maxHp - 1e-9;
    assert(repairTarget(g) === null, 'float residue below max hp reads as damage');
    const g2 = gameOn(); rich(g2);
    const a2 = tower(g2, g2.towers[0].x + 10, g2.towers[0].y); finish(g2, a2);
    const link2 = wall(g2, g2.towers[0], a2);
    link2.progress = 1 - 1e-12;
    for (const s2 of link2.segments) s2.hp = s2.maxHp - 1e-7;
    update(g2, 0.01);
    assert(link2.built && link2.segments.every((s2) => s2.hp === s2.maxHp), 'completion did not snap near-full segments to max hp');
  });

  // --- D82 pathing --------------------------------------------------------------

  check('D82 a closed ring is costed as a break, by type; Heavy pays far less than Swarm', () => {
    const { g, k } = ringFixture();
    const sw = enemyKeepField(g, 'swarm');
    const hv = enemyKeepField(g, 'heavy');
    const x = k.x + 20; const y = k.y;
    const swarmBreak = WALL_PATH.breakBias * (WALL.segmentHp / ENEMIES.swarm.structDps) * ENEMIES.swarm.speed;
    const heavyBreak = WALL_PATH.breakBias * (WALL.segmentHp / ENEMIES.heavy.structDps) * ENEMIES.heavy.speed;
    assert(Number.isFinite(fieldAt(sw, x, y)) && fieldAt(sw, x, y) > swarmBreak, `swarm field ${fieldAt(sw, x, y)}`);
    assert(fieldAt(hv, x, y) < fieldAt(sw, x, y) && fieldAt(hv, x, y) < 22 + heavyBreak, `heavy field ${fieldAt(hv, x, y)}`);
    assert(ENEMIES.heavy.structDps > ENEMIES.swarm.structDps * 4 && ENEMIES.heavy.structDps > ENEMIES.runner.structDps * 4,
      'Heavy is not the structural threat');
  });

  check('D82 enemies outside a closed ring attack the wall rather than getting stuck', () => {
    const { g, k } = ringFixture();
    silenceTowers(g);
    const swarms = [0, 1, 2].map((n) => enemy(g, 'swarm', k.x + 22, k.y - 1 + n));
    const before = wallSegments(g).reduce((s, w) => s + w.hp, 0);
    run(g, 18);
    const after = wallSegments(g).reduce((s, w) => s + w.hp, 0);
    assert(after < before - 30, `ring took only ${(before - after).toFixed(1)} damage`);
    assert(swarms.every((e) => g.enemies.includes(e)), 'an enemy despawned or died');
    assert(stuckState(g).despawns === 0, 'stuck despawn at the wall');
    assert(swarms.every((e) => e.blockerTargetId && String(e.blockerTargetId).startsWith('w')), 'swarm not targeting a wall segment');
  });

  check('D82 a reasonable detour is walked; the wall is not attacked', () => {
    const { g, k } = detourFixture(12);
    const sw = enemyKeepField(g, 'swarm');
    const swarmBreak = WALL_PATH.breakBias * (WALL.segmentHp / ENEMIES.swarm.structDps) * ENEMIES.swarm.speed;
    const at = fieldAt(sw, k.x + 18, k.y);
    assert(at < swarmBreak, `swarm field ${at} implies breaking (break ${swarmBreak})`);
    const e = enemy(g, 'swarm', k.x + 20, k.y);
    let minY = e.y;
    for (let t = 0; t < 40 && g.enemies.includes(e); t += 0.05) { update(g, 0.05); minY = Math.min(minY, e.y); }
    assert(wallSegments(g).every((s) => s.hp === s.maxHp), 'swarm damaged the wall despite a detour');
    assert(minY < k.y - 15, `swarm never took the northern detour (min y offset ${(minY - k.y).toFixed(1)})`);
    assert(Math.hypot(e.x - k.x, e.y - k.y) < 4, 'swarm did not reach the Keep by the detour');
    // Pressed right against the wall, a Swarm still prefers the detour.
    const seg = wallSegments(g).find((o) => o.ty === Math.floor(k.y));
    const near = enemy(g, 'swarm', seg.x + 1.5, seg.y);
    for (let t = 0; t < 3; t += 0.05) update(g, 0.05);
    assert(wallSegments(g).every((o) => o.hp === o.maxHp), 'a swarm beside the wall attacked it instead of detouring');
    assert(near.x > seg.x + 1.4, 'swarm beside the wall did not move off toward the detour');
  });

  check('D82 giant detour: a Heavy breaks through where a Swarm still detours', () => {
    const { g, k } = detourFixture(20);
    const extra = fieldAt(enemyKeepField(g, 'swarm'), k.x + 18, k.y) - 18;
    const heavyBreak = WALL_PATH.breakBias * (WALL.segmentHp / ENEMIES.heavy.structDps) * ENEMIES.heavy.speed;
    assert(extra > heavyBreak, `fixture detour (${extra.toFixed(1)}) is not longer than a Heavy break (${heavyBreak.toFixed(1)})`);
    const h = enemy(g, 'heavy', k.x + 18, k.y);
    let engaged = false;
    let minY = h.y;
    for (let t = 0; t < 16; t += 0.05) {
      update(g, 0.05);
      engaged ||= String(h.blockerTargetId || '').startsWith('w');
      minY = Math.min(minY, h.y);
    }
    assert(engaged, 'Heavy did not commit to breaking the wall');
    assert(g.stats.wallSegmentsLost >= 1, 'Heavy did not break a segment');
    assert(minY > k.y - 4, 'Heavy took the long detour');
    assert(Math.hypot(h.x - k.x, h.y - k.y) < 4, 'Heavy did not continue through its breach to the Keep');
  });

  check('D82 a breach reroutes everyone through it and changes the field once', () => {
    const { g, k } = detourFixture(20);
    const before = fieldAt(enemyKeepField(g, 'swarm'), k.x + 18, k.y);
    const recomputes = keepFieldState(g).recomputes;
    const seg = wallSegments(g).find((s) => s.ty === Math.floor(k.y));
    seg.hp = -1;
    update(g, 0.01);
    assert(seg.destroyed && !g.blockerGrid[seg.i], 'segment not destroyed into passable rubble');
    assert(g.stats.wallSegmentsLost === 1, 'segment loss not counted');
    const after = fieldAt(enemyKeepField(g, 'swarm'), k.x + 18, k.y);
    assert(after < before - 10, `breach did not shorten the swarm route (${before} -> ${after})`);
    assert(keepFieldState(g).recomputes === recomputes + 1, 'field recomputed other than exactly once for swarm');
    const e = enemy(g, 'swarm', k.x + 20, k.y);
    let minY = e.y;
    for (let t = 0; t < 12 && Math.hypot(e.x - k.x, e.y - k.y) > 3; t += 0.05) { update(g, 0.05); minY = Math.min(minY, e.y); }
    assert(Math.hypot(e.x - k.x, e.y - k.y) <= 3.5, 'swarm did not reach the Keep through the breach');
    assert(minY > k.y - 4, 'swarm still took the detour after the breach');
  });

  check('D82 fields are not recomputed while geometry is unchanged', () => {
    const { g, k } = ringFixture();
    silenceTowers(g);
    enemy(g, 'swarm', k.x + 12, k.y);
    enemy(g, 'heavy', k.x + 12, k.y + 2);
    run(g, 0.5);
    const settled = keepFieldState(g).recomputes;
    const hp = () => wallSegments(g).reduce((sum, o) => sum + o.hp, 0);
    const before = hp();
    // Sustained attack damage that destroys nothing must not thrash the fields.
    run(g, 5.5);
    assert(hp() < before - 20, 'fixture: enemies never battered the ring');
    assert(g.stats.wallSegmentsLost === 0, 'fixture: a segment fell');
    assert(keepFieldState(g).recomputes === settled, `recomputed ${keepFieldState(g).recomputes - settled} times without a geometry change`);
  });

  check('D82 no diagonal leak between the corners of two blockers', () => {
    // Deep water everywhere except two yards joined by one 2x2 pinch whose
    // off-diagonal tiles are wall segments: the only way through would be a
    // diagonal squeeze between two blocker corners.
    const map = flatMap();
    map.kind.fill(T.DEEP);
    const kx = map.start.x;
    const open = (x0, x1, y0, y1) => { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) map.kind[idx(x, y)] = T.PLAIN; };
    open(kx - 3, kx + 3, cy - 3, cy + 3);   // Keep yard
    open(kx + 4, kx + 9, cy - 1, cy);       // lane to the pinch (rows cy-1..cy)
    open(kx + 10, kx + 11, cy, cy + 1);     // the 2x2 pinch
    open(kx + 12, kx + 30, cy + 1, cy + 3); // far yard
    const g = gameOn(map);
    for (const [x, y] of [[kx + 11, cy], [kx + 10, cy + 1]]) {
      const seg = { id: `test:${x}`, wall: true, linkId: -1, tx: x, ty: y, i: idx(x, y), x: x + 0.5, y: y + 0.5,
        radius: 0.5, maxHp: WALL.segmentHp, hp: WALL.segmentHp, gate: false, destroyed: false, flash: 0, shake: 0 };
      g.blockerGrid[seg.i] = { kind: 'wall', id: seg.id, structure: seg, maxHp: seg.maxHp };
    }
    g.blockerVersion++;
    const sw = enemyKeepField(g, 'swarm');
    const far = fieldAt(sw, kx + 20.5, cy + 2.5);
    const swarmBreak = WALL_PATH.breakBias * (WALL.segmentHp / ENEMIES.swarm.structDps) * ENEMIES.swarm.speed;
    assert(far > swarmBreak, `diagonal squeeze leaked: far field ${far.toFixed(1)} < break ${swarmBreak.toFixed(1)}`);
  });

  check('D82 towers fire over friendly walls', () => {
    const { g, k, corners } = ringFixture();
    const t = corners[0];
    const e = enemy(g, 'swarm', t.x + 4, t.y, 500);
    e.def.speed = 0;
    run(g, 1.5);
    assert(e.hp < 500, 'tower behind its wall did not damage an enemy outside');
    assert(!structureClearLine(g, { x: t.x - 2, y: t.y + 3 }, e), 'fixture: the shot line should cross the wall');
  });

  // --- D81 traversal --------------------------------------------------------------

  check('D81 posterns: the player walks through, enemies cannot', () => {
    const { g, corners } = ringFixture();
    const gate = wallSegments(g).find((s) => s.gate);
    const plain = wallSegments(g).find((s) => !s.gate);
    const vertical = (s) => g.walls.find((w) => w.id === s.linkId).segments.every((o) => o.tx === s.tx);
    // Walk the player perpendicular through the gate tile.
    const walkThrough = (seg) => {
      const across = vertical(seg) ? { x: 1, y: 0 } : { x: 0, y: 1 };
      g.player.x = seg.x - across.x * 1.5; g.player.y = seg.y - across.y * 1.5;
      g.input = { mx: across.x, my: across.y, melee: false, repair: false };
      run(g, 1.0, 1 / 60);
      g.input = { mx: 0, my: 0, melee: false, repair: false };
      return (g.player.x - seg.x) * across.x + (g.player.y - seg.y) * across.y;
    };
    assert(walkThrough(gate) > 0.6, 'player could not pass the postern');
    assert(walkThrough(plain) < 0, 'player passed a plain wall segment');
    assert(corners.length === 4, 'fixture');
    // An enemy pressed against the gate never enters it.
    const outward = vertical(gate) ? { x: 1, y: 0 } : { x: 0, y: 1 };
    const e = enemy(g, 'swarm', gate.x + outward.x * 1.4, gate.y + outward.y * 1.4);
    silenceTowers(g);
    let entered = false;
    for (let t = 0; t < 6; t += 1 / 60) {
      update(g, 1 / 60);
      if (Math.floor(e.x) === gate.tx && Math.floor(e.y) === gate.ty) entered = true;
    }
    assert(!entered, 'enemy walked into a postern');
  });

  check('D81 the player is never trapped inside a closed ring', () => {
    const { g, k } = ringFixture();
    // Player-walkable flood from the Keep: walls block except posterns.
    const seen = new Uint8Array(MAP.w * MAP.h);
    const start = idx(Math.floor(k.x), Math.floor(k.y) + 2);
    const queue = [start]; seen[start] = 1;
    let escaped = false;
    for (let h = 0; h < queue.length && !escaped; h++) {
      const x = queue[h] % MAP.w; const y = (queue[h] / MAP.w) | 0;
      if (Math.abs(x - k.x) > 12 || Math.abs(y - k.y) > 12) escaped = true;
      for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const i = idx(x + ox, y + oy);
        const b = g.blockerGrid[i];
        if (seen[i] || (b && b.kind === 'wall' && !b.structure.gate)) continue;
        seen[i] = 1; queue.push(i);
      }
    }
    assert(escaped, 'no player route out of the ring');
  });

  // --- D83 repair of walls ----------------------------------------------------------

  check('D83 wall repair is local; remote repair is impossible', () => {
    const { g, k } = ringFixture();
    const seg = wallSegments(g)[4];
    seg.hp = 100;
    g.player.x = k.x - 40; g.player.y = k.y;
    g.input = { mx: 0, my: 0, melee: false, repair: true };
    run(g, 1);
    assert(seg.hp === 100, 'remote wall repair happened');
    g.player.x = seg.x + 1.2; g.player.y = seg.y + 1.2;
    const stone = g.res.stone;
    run(g, 1);
    assert(seg.hp > 100 && g.res.stone < stone, 'local wall repair did not spend Stone');
  });

  check('D81/D83 rubble rebuild needs proximity, Stone and an empty tile', () => {
    const { g } = ringFixture();
    const seg = wallSegments(g).find((s) => !s.gate);
    seg.hp = -1; update(g, 0.01);
    assert(seg.destroyed, 'fixture: segment not destroyed');
    const version = g.blockerVersion;
    g.input = { mx: 0, my: 0, melee: false, repair: true };
    g.player.x = seg.x + 30; g.player.y = seg.y;
    run(g, 0.2);
    assert(seg.destroyed, 'rubble rebuilt remotely');
    // A unit standing in the rubble blocks the rebuild.
    g.player.x = seg.x; g.player.y = seg.y;
    run(g, 0.2);
    assert(seg.destroyed, 'rubble rebuilt with the player standing in it');
    g.player.x = seg.x + 1.4; g.player.y = seg.y + 1.4;
    g.res.stone = WALL.costStonePerSegment - 1;
    run(g, 0.2);
    assert(seg.destroyed, 'rubble rebuilt without enough Stone');
    g.res.stone = 1000;
    run(g, 0.05);
    assert(!seg.destroyed && g.blockerGrid[seg.i]?.structure === seg, 'rubble not rebuilt in reach');
    assert(g.blockerVersion > version, 'rebuild did not invalidate fields');
    assert(Math.abs(g.res.stone - (1000 - WALL.costStonePerSegment)) < 2, 'rebuild cost not charged');
  });

  check('D81 anchors falling leave their walls standing', () => {
    const { g, corners } = ringFixture();
    const count = wallSegments(g).filter((s) => !s.destroyed).length;
    corners[0].hp = -1;
    g.player.x = corners[2].x - 20;
    update(g, 0.01);
    assert(!g.towers.includes(corners[0]), 'fixture: anchor survived');
    assert(wallSegments(g).filter((s) => !s.destroyed).length === count, 'walls fell with the anchor');
  });

  // --- D78 economy and walls ---------------------------------------------------------

  check('D78 a wall shelters economy; a breach exposes it', () => {
    const { g, k } = ringFixture();
    silenceTowers(g);
    const farm = { id: 50, type: 'farm', x: k.x + 4.5, y: k.y, hp: 160, maxHp: 160, built: true, progress: 1, destroyed: false, rate: 0.5, siteId: null, flash: 0 };
    const outside = { id: 51, type: 'farm', x: k.x + 16.5, y: k.y + 3.5, hp: 160, maxHp: 160, built: true, progress: 1, destroyed: false, rate: 0.5, siteId: null, flash: 0 };
    g.buildings.push(farm, outside);
    const e = enemy(g, 'swarm', k.x + 18, k.y + 3);
    run(g, 6);
    assert(outside.hp < 160 || outside.destroyed, 'farm outside on the route was not attacked');
    const e2 = enemy(g, 'swarm', k.x + 7.0, k.y);
    run(g, 3);
    assert(farm.hp === 160, 'farm inside an intact wall was attacked from outside');
    // Breach the east wall beside the inner farm.
    for (const s of wallSegments(g)) if (s.tx === Math.floor(k.x) + 6 && Math.abs(s.ty - Math.floor(k.y)) <= 1) s.hp = -1;
    update(g, 0.01);
    run(g, 6);
    assert(farm.hp < 160 || farm.destroyed, 'farm behind a breached wall stayed safe');
    void e; void e2;
  });

  check('D82 a wall built across an enemy path never strands it', () => {
    const g = gameOn(); rich(g);
    const k = g.towers[0];
    const a = tower(g, k.x + 10, k.y - 6); const b = tower(g, k.x + 10, k.y + 6);
    finish(g, a, b);
    silenceTowers(g);
    const e = enemy(g, 'swarm', k.x + 18, k.y);
    run(g, 1.6);
    g.player.x = a.x; g.player.y = a.y;
    // Lay the wall as the enemy reaches it, possibly right over it.
    assert(tryBuildWall(g, a.id, b.id).ok, 'wall refused');
    g.player.x = k.x - 20;
    run(g, 20);
    assert(g.enemies.includes(e), 'enemy despawned after a wall was laid over its route');
    assert(Math.hypot(e.x - k.x, e.y - k.y) < 4 || String(e.blockerTargetId || '').startsWith('w'), 'enemy neither reached the Keep nor engaged the wall');
    assert(stuckState(g).despawns === 0, 'stuck despawn');
  });

  check('D81 wall spam is bounded by anchors, length and cost', () => {
    const g = gameOn(); rich(g);
    const k = g.towers[0];
    // Only towers anchor walls; the cost grows with every segment.
    const a = tower(g, k.x + 8, k.y); finish(g, a);
    const b = tower(g, k.x + 8 + 12, k.y); finish(g, b);
    const short = wallPlan(g, k.id, a.id);
    const long = wallPlan(g, a.id, b.id);
    assert(long.cost.stone > short.cost.stone, 'longer wall is not dearer');
    assert(!wallPlan(g, k.id, b.id).ok, 'a wall spanning past the length cap was allowed');
    assert(typeof tryBuildWall(g, k.id, null).ok === 'boolean' && !g.walls.length, 'wall without a second anchor');
    void TOWER; void PLAYER; void buildingState; void towerStats; void repairTarget;
  });
}
