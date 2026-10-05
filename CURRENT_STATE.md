# Holdfast current state

Last updated: 2026-10-06 (first-person hand-play pass D108-D114; committed,
awaiting human hand-play)

## What this is

A fortress-defense prototype played in **first person** (`index.html`).
Explore, build, staff, watch, fight when necessary, hold the fortress: walk out
from the Keep, claim Stone/Gold/farmland, raise Towers and join them with
Walls, put your people to work or on the walls, read the land and the weather
for the coming assault, and survive ten. Defeat: the Keep falls or the player
dies. The top-down build is still at `classic.html` (D107).

## Architecture

- `src/game.js` is the whole simulation on the 208x104 tile grid (flow fields,
  break-cost walls, nests, population, garrison watch, crossbow, assault
  timing). The 3D shell selects presentation rules via `g.rules`
  (`buildReach`, `solidTowers`, `exploreRadius`, `announceAssaults: false`,
  `towerSight`); the classic keeps defaults.
- `src/weather.js`: seeded weather schedule and blended visibility (pure).
- `src/fp/` is the first-person layer: `space.js` (maths + height field incl.
  D114 relief), `sight.js` (D109 height-aware Tower sight, shared tree
  placement), `terrain3d.js`, `models.js`, `entities3d.js` (sync + effects +
  world cues + cosmetic workers), `overlays.js` (build/debug incl. LOS rays),
  `weather.js` (sky/fog/rain/dust), `weapon.js` (view models), `hud.js`,
  `main.js`. Three.js r186 vendored (import map, no build).
- Scale (D102): 1 tile = 2 m; walk ~8 m/s, sprint ~12.7 m/s.

## Implemented this pass

- **D108** Keep roof without spires/turrets; banner pole at the roof centre.
- **D109** Tower sight traced from the muzzle through the rendered terrain and
  trees (one crown is a gap, two block); legible shots (streak, big muzzle
  flash + smoke, impact flash, recoil, stronger cue); perched Tower shows its
  annulus; `F6` LOS rays. Range/blind zone/damage unchanged.
- **D110** Population: 8 founders, Keep stores feed 8; Farm (1) / Quarry (2) /
  Mine (2) jobs drive output; garrison uses the same people; growth every 40 s
  under Food support; Food Shortage with 45 s grace, then departures; garrison
  dies with its Tower; auto-staffing of new buildings/newcomers; `G`/`Shift+G`
  on buildings; HUD "People n / support · Workers · Garrison · Free"; inspect
  panels show workers and output; cosmetic workers.
- **D111** No assault plaque/timer/direction/compass marker/approach arrows in
  normal play (`F8` debug shows them). Mouth dust ~35 s ahead, dust over the
  march, scattering birds, distant horn (75%) and roar, garrison bell + red
  pennant when lookouts see the army.
- **D112** Weather: clear / rain / storm / dust, long clear spells, 10 s blends;
  fog distance, light, sky, rain streaks, dust motes, thunder, rain/wind beds;
  height recovers lost distance; lookout range scales with visibility. `F7`.
- **D113** Sword (existing melee, now visible with swing) and crossbow (30 dmg,
  2.4 s reload, unlimited bolts); `F`/wheel switch; reload bar.
- **D114** Broad landforms; hill crowns up to 8 m in 3D; bands 3 m apart.

## Verification

- `npm test`: **261 passed, 0 failed** on the last full run. The pre-existing,
  `Math.random`-driven "full run simulates several waves" check still fails
  intermittently (it failed on the untouched baseline, 240/1, and on one run
  during this pass; it uses no economy, so population cannot affect it). New
  suites:
  `test/sight-tests.js` (9: basic fire incl. tracer/damage/turret yaw, every
  annulus distance, blind zone, max range, hill vs cliff ridge, sparse vs thick
  forest, supporting Tower, classic unchanged), `test/world-tests.js` (6:
  silent assaults vs classic, bell garrisoned vs empty, storm shortens
  lookouts, weather seeding/blend/return, crossbow reload/damage, Heavy needs
  many bolts), and 8 D110 population checks replacing the D91 food checks.
  The sight harness was shown to fail when the old tile LOS is forced.
  `TEST_FILTER=<regex> node test/run-tests.js` runs a subset.
- `npm run economy-sim` and `npm run wave-report` still run.
- Scripted browser passes (Playwright, SwiftShader, 1280x720; scripts in the
  session scratchpad, not the repo): no page errors; Keep-roof panorama in four
  directions; a Tower visibly firing on Heavies from ~24 m (HP 270 -> 182 in
  under a second); crossbow one-shots a Swarm, reload animation and bar; sword
  swing; Quarry inspect "Workers 1/2 · Stone +0.23/s"; rain/storm/dust render;
  from the Keep roof, dust plumes and birds over the incoming road before the
  assault with no HUD text; the 2D classic boots and keeps its announcements.
- Not verified: real pointer-lock feel, audio by ear (horn, bell, thunder,
  rain beds are synthesized and unheard), frame rate on real hardware,
  **any human hand-play**.

## Known risks / open questions

1. **Tower range (15 m) may still feel short** in first person once LOS and
   visuals are fixed (D109 investigation, point 1). Next lever:
   `TOWER.weapon.range` - deliberately not changed in this pass.
2. Unannounced assaults may feel unfair. If so, strengthen world cues (larger
   or earlier dust, a more reliable horn) before restoring any HUD timer.
3. Population numbers (8 founders, Keep feeds 8, 40 s growth, 45 s grace) are
   first guesses; check whether pulling workers into the garrison feels like a
   real decision and whether auto-staffing removes enough clicking.
4. Weather visibility values (rain 0.62, storm 0.38, dust 0.5) are untuned;
   check that storms are atmospheric, not miserable.
5. Hill crowns (8 m) and 3 m bands change the look of every map; check that
   walking stays comfortable and hills read as high ground.
6. The crossbow ignores trees (bolts pass through crowns); fine for a first
   prototype.
7. Audio cues are synth placeholders; no true 3D positional audio.
8. `generate-artifact.js` still inlines only HTML/CSS; the 3D page needs
   `src/` and `vendor/` served.

## Next steps

1. Hand-play the brief's evaluation (§49-§57): Tower firing cases (clear
   field, hill, sparse forest, blind zone, supporting Tower), 360° from the
   Keep roof, an unannounced assault without debug, the worker-to-garrison
   emergency, two comparable Towers low vs on a hill, and debug-forced heavy
   rain/dust.
2. Answer the 15 final-evaluation questions; above all, does it feel like a
   strategy game you physically live inside?
3. Tune from that play: Tower range (if needed), cue strength, population
   numbers, weather visibility, hill height.
