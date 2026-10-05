// D111-D113: unannounced assaults and the garrison bell, weather, and the
// player's crossbow - the first-person information and combat layer.

import { WAVE, WATCH, WEATHER, PLAYER, BUILD, WORLD3D } from '../src/config.js';
import {
  tryBuild, update, spawnGroupAt, assignGarrison, fireCrossbow, switchWeapon, drainAudioEvents,
} from '../src/game.js';
import { weatherState, setWeather, cycleWeather, createWeather } from '../src/weather.js';
import { buildHeightField } from '../src/fp/space.js';
import { createTowerSight } from '../src/fp/sight.js';

export function runWorld({ check, assert, gameOn, flatMap, run }) {
  const fp = (g) => {
    g.rules = { ...g.rules, buildReach: BUILD.lookReach, solidTowers: true, exploreRadius: WORLD3D.exploreRadius, announceAssaults: false };
    g.rules.towerSight = createTowerSight(buildHeightField(g.map));
    return g;
  };
  const tower = (g, dx, dy = 0) => {
    const k = g.towers[0];
    const x = Math.floor(k.x + dx) + 0.5; const y = Math.floor(k.y + dy) + 0.5;
    g.player.x = x; g.player.y = y;
    const r = tryBuild(g, x, y, 'tower');
    assert(r.ok, `tower refused: ${(r.reasons || []).join('; ')}`);
    Object.assign(r.structure, { built: true, progress: 1, hp: r.structure.maxHp });
    return r.structure;
  };

  check('D111: first person announces nothing when the assault warning begins; the classic still does', () => {
    const g = fp(gameOn(flatMap()));
    g.res.stone = 1e4;
    g.phaseLeft = 0.01;
    const logBefore = g.log.length ? g.log[0].text : null;
    run(g, WAVE.warning + 1);
    assert(!g.log.some((l) => /Wave \d|incoming/i.test(l.text)), `announced: ${g.log.map((l) => l.text).join(' | ')}`);
    const cues = drainAudioEvents(g).map((e) => e.type);
    assert(!cues.includes('waveWarning') && !cues.includes('waveStart'), `omniscient cue ${cues}`);
    void logBefore;
    const c = gameOn(flatMap());
    c.phaseLeft = 0.01;
    run(c, 0.2);
    assert(c.log.some((l) => /Wave 1 incoming/.test(l.text)), 'classic lost its announcement');
  });

  check('D111: a garrisoned Tower that sees the army rings its bell; an empty one stays silent', () => {
    const g = fp(gameOn(flatMap()));
    g.res.stone = 1e4;
    const a = tower(g, 20);
    const b = tower(g, -20);
    assignGarrison(g, a, 1);
    g.phase = 'combat'; g.phaseLeft = 0; g.pendingSpawns = [{ type: 'swarm', side: 'east', point: 0, at: 1e9 }];
    spawnGroupAt(g, a.x + 25, a.y, 'heavy', 1);
    spawnGroupAt(g, b.x - 25, b.y, 'heavy', 1);
    for (const e of g.enemies) e.wild = false;
    drainAudioEvents(g);
    for (let s = 0; s < 1.5; s += 0.05) { for (const e of g.enemies) e.hitCd = 99; update(g, 0.05); }
    const bells = drainAudioEvents(g).filter((e) => e.type === 'towerBell');
    assert(a.alarmUntil > g.time && bells.some((e) => Math.abs(e.x - a.x) < 1e-6), 'garrisoned tower did not ring');
    assert(!(b.alarmUntil > 0), 'empty tower rang');
    assert(Math.hypot(g.enemies[0].x - a.x, g.enemies[0].y - a.y) > 8, 'the army was already in firing range');
  });

  check('D112: storms shorten the lookouts: the same army is spotted on a clear day, not in a storm', () => {
    const spot = (kind) => {
      const g = fp(gameOn(flatMap()));
      g.res.stone = 1e4;
      const a = tower(g, 20);
      assignGarrison(g, a, 1);
      setWeather(g, kind, { blendSeconds: 0, duration: 999 });
      g.phase = 'combat'; g.pendingSpawns = [{ type: 'swarm', side: 'east', point: 0, at: 1e9 }];
      spawnGroupAt(g, a.x + WATCH.spotRange * 0.8, a.y, 'heavy', 1);
      for (let s = 0; s < 1.2; s += 0.05) { g.enemies[0].x = a.x + WATCH.spotRange * 0.8; g.enemies[0].y = a.y; update(g, 0.05); }
      return a.alarmUntil > 0;
    };
    assert(spot('clear'), 'clear-day lookouts missed the army');
    assert(!spot('storm'), 'storm lookouts saw as far as on a clear day');
  });

  check('D112: weather is seeded, starts clear, blends over seconds and returns to clear', () => {
    const g = gameOn(flatMap());
    assert(weatherState(g).kind === 'clear' && weatherState(g).visibility === 1, 'not clear at start');
    const a = createWeather('SEED-X'); const b = createWeather('SEED-X');
    assert(a.timeLeft === b.timeLeft, 'weather schedule is not seeded');
    assert(a.timeLeft >= WEATHER.firstClear[0], 'first clear spell too short');
    setWeather(g, 'storm', { duration: 30 });
    update(g, 0.5);
    const mid = weatherState(g).visibility;
    assert(mid < 1 && mid > WEATHER.kinds.storm.visibility, `no blend (${mid})`);
    run(g, WEATHER.blendSeconds + 1);
    assert(Math.abs(weatherState(g).visibility - WEATHER.kinds.storm.visibility) < 1e-6, 'blend never finished');
    run(g, 31);
    assert(weatherState(g).kind === 'clear', `storm did not clear (${weatherState(g).kind})`);
    assert(cycleWeather(g) === 'rain', 'debug cycle does not step clear -> rain');
  });

  check('D113: the crossbow - strong single bolt, long reload, then ready again', () => {
    const g = gameOn(flatMap());
    const p = g.player;
    assert(!fireCrossbow(g, {}).ok, 'fired while holding the sword');
    switchWeapon(g, 'crossbow');
    spawnGroupAt(g, p.x + 10, p.y, 'swarm', 1);
    const e = g.enemies.at(-1);
    const r = fireCrossbow(g, { enemyId: e.id, x: e.x, y: e.y, z: 0.6 });
    assert(r.ok && r.hit, 'bolt missed a marked target');
    assert(!g.enemies.includes(e) || e.hp <= 0, `a wave-1 Swarm survived a bolt (${e.hp})`);
    assert(g.tracers.some((t) => t.kind === 'bolt'), 'no bolt tracer');
    assert(!fireCrossbow(g, {}).ok, 'fired again while reloading');
    run(g, PLAYER.crossbow.reload + 0.1);
    assert(fireCrossbow(g, {}).ok, 'never reloaded');
  });

  check('D113: the crossbow cannot outfight the fortress: a Heavy takes many bolts', () => {
    const g = gameOn(flatMap());
    const bolts = Math.ceil(270 / PLAYER.crossbow.damage);
    assert(bolts >= 8, `a Heavy dies to ${bolts} bolts`);
    assert(bolts * PLAYER.crossbow.reload >= 18, 'a Heavy dies in under 18 s of perfect shooting');
    const sustained = PLAYER.crossbow.damage / PLAYER.crossbow.reload;
    assert(sustained < 15, `crossbow sustained dps ${sustained.toFixed(1)} rivals a Tower`);
    void g;
  });
}
