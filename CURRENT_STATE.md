# Current State

Last updated: 2026-09-19 (D76 enemy roles + committed tower targets, committed and pushed)

## Codex / Delegated Work — none in flight

Codex was out of quota (usage limit until 2026-09-22 11:00 UTC); the router
assigned D72/D73 to Claude, which implemented it directly.

## D76 enemy roles, tower commitment, breach everywhere — COMMITTED AND PUSHED, AWAITING HAND-PLAY

Implemented by Claude directly (router: Codex usage-limited until 2026-09-22,
other workers quarantined). Files: `src/config.js`, `src/game.js`,
`test/run-tests.js`, `DESIGN_DECISIONS.md` (D76), this file. `npm test`:
**135 passed, 0 failed**. 11 old tests migrated (D53 release tests now use
Runners; siege tests became breach-migration tests), new D76-A..O plus
BREACH-F/G rewrites. Eight source mutations (no role, no reachability check,
Euclidean nearest, no replacement on destroy, breach only when occupied, no
unseen alarm, siege DPS alongside breach, no mitigation) each turned the
relevant tests red; source restored byte-identical.

- Runner (`role: 'player'`) is unchanged D53. Swarm/Heavy (`'structures'`) are
  committed to their selected tower; new selection prefers the reachable
  occupied tower, else nearest by lane-field cost; replacement after
  destruction is nearest by path cost; unfinished towers count; no reachable
  tower -> player fallback. Continuous siege removed; every tower contact is
  a breach (6/9/25%, x occupant damageTaken). An unseen breach raises the
  tower alarm.
- Browser (ALPHA, CHARLIE, KILO, R7KD2P; 1600x900; no page/console errors),
  two builds 11/22 tiles away from the wave-1 side, shelter in A for waves 1-2,
  retreat A->B->C on wave 3: Runners released A within ~2s and followed the
  player; Swarm/Heavy stayed on A, breached the abandoned A and moved to the
  path-nearest survivor when it fell (max one target change each; Runners 2-3,
  by role). Open-ground kiting bot: mortal, died in wave 2-3 on every seed
  (Runners closed to 0 tiles). Invulnerable, Runners hold the wave open forever
  (harness artifact). Invulnerable with Runners removed once they are the only
  enemies ("player outruns them"), never sheltering: all three towers lost by
  wave 4-5, `lost/'towers'` on every seed, 42-47 breaches, 0 player hits.
- Wave 1 now costs an unoccupied start tower 7-8 Swarm breaches (~250 hp) when
  the player is out, since those Swarms pick the nearest tower.

**Next steps:** user hand-play of D76 (retreat feel, whether 6/9/25% breach
plus network pressure is too harsh). Pushed at the user's request before hand-play.

## D74–D75 rare Rich jackpots, road speed, fixed extraction footprint — COMMITTED AND PUSHED

Committed on top of `0e9deaf` and pushed at the user's request before hand-play acceptance.
Files: `src/config.js`, `src/game.js`, `src/terrain.js`,
`test/run-tests.js`, new `tools/economy-report.js`, `DESIGN_DECISIONS.md`,
this file. `npm test`: **127 passed, 0 failed** (8 new; the new tests were
mutation-checked: an enemy road bonus, radius growth, no player road bonus and the old
seam peaks each turned the relevant test red).

- D74: Rich comes only from 3-5 solved jackpots; seams combine by max. 44-seed
  `node tools/economy-report.js` before -> after: Rich sites 258/540/817 ->
  99/145/223; two-tile regions 7/11/18 -> 3/4/6 (distinct 6-tile places 3/4/5,
  44/44 in 3-5); largest cluster 76/151/445 -> 37/48/57; best income
  2.05/3.00/3.48 -> 1.84/2.11/2.19 (x2.28/3.33/3.86 -> x2.04/2.35/2.44 start);
  Moderate sites 437/700/965 -> 421/644/923; start 0.900 everywhere; generation
  median ~0.56-0.65s (noise). Rich markers per map 16-27 -> 3-4.
- D75: player x1.25 on road tiles via `playerSpeed(g)`; E0-E3 keep a 4.5
  footprint and `resourceScore`, only the rate multiplier rises.
- Browser (ALPHA, CHARLIE, KILO, R7KD2P; no page/console errors): real-key
  road vs parallel open ground 1.25-1.28x; the frame the player leaves the road,
  speed drops from 6.625 to 5.3 with a max per-frame step of 0.11 tiles; wave-1
  Swarms p90/max 3.8 on road and plain alike; KILO jackpot preview Rich 1.985,
  E0->E3 income x1.00/1.55/2.10/2.65 with radius 4.5 and identical score, old
  income held during each timer; unoccupied tower fired W0 shots during its
  weapon upgrade; Heavy breach still 93.6.

**Next steps:** user playtest of D72-D75 together.

## D72–D73 three-tower opening and occupied-tower breach — COMMITTED AND PUSHED

`START_MATERIALS` is 350 (start tower + builds at 145 and 190, 15 left; a third
at 235 is refused). An enemy targeting the occupied tower at the moment it
reaches contact (`TOWER.radius + enemy radius + BREACH.contactGap 0.25`: Swarm
1.54, Runner 1.50, Heavy 1.82) breaches once for `breachFrac x maxHp x
damageTaken` (4% / 6% / 18%, i.e. 21 / 31 / 94 on 520) and is removed with no
kill, drop or death cue. `stats.breaches`, `breachesByType`, `breachDamage`
record leaks. FX: wall-point burst + shockwave ring (`g.shockwaves`), tower
flash and `t.shake`, `breach`/`heavyBreach` cues, one merged `BREACH -N`
floater per 0.5s drawn above the OCCUPIED label, rate-limited log line. Lethal
breaches use `destroyTower`. Sticky siege of unoccupied towers is unchanged
but, as D73 records, effectively dormant in normal play. Files: `src/config.js`,
`src/game.js`, `src/render.js`, `src/audio.js`, `test/run-tests.js`,
`DESIGN_DECISIONS.md`. `npm test`: **119 passed, 0 failed** (13 new; 5 old
tests migrated off siege-on-the-occupied-tower setups). The new tests were
mutation-checked (no breach branch, no once-guard, kill credit each turn the
relevant tests red).

Browser runs (1600x900, no page errors), passive Gunner sitting in the start
tower holding repair, W0 towers only, two builds on the west road (~16 and ~10
tiles) - old siege code + 350 vs this pass:

| seed | waves reached, siege / breach | gross occupied-tower damage, siege / breach | breaches S/R/H |
|---|---|---|---|
| ALPHA | 6 / 6 | 752 / 1926 | 25/23/8 |
| CHARLIE | 4 / 4 | 694 / 1338 | 24/22/2 |
| KILO | 6 / 7 | 749 / 2047 | 26/31/6 |
| R7KD2P | 6 / 7 | 926 / 2913 | 25/31/16 |

Siege cost ~0-10 hp in waves 1-4 (low-DPS besiegers died under occupied fire);
breaches cost from wave 1 (0-17 per wave early, 13-25 in waves 5-7), so repair
spending rises and wave 1 from an uncovered side can leak most of its Swarms.
Every run ended `died`: breach destroys the tower with the player inside, so
the D6 collapse (85 hp) always lands. No retune was made.

**Next steps:** user hand-play of the three-tower opening and breach feel;
pushed to `master` at the user's request before hand-play acceptance.

## D67–D70 pacing/economy/forest pass — REVIEWED, ACCEPTED AND COMMITTED

Codex implemented it across two usage-limit stops (final chain
`351fa03c-a728-4888-a63e-66ddc55e0006`). The controller reviewed the source
diff, observed `npm test` **106 passed, 0 failed**, and accepted it in the
browser. The strategy-comparison bots once planned as "part 2" were dropped by
the user (D71); no HP/wave balance pass is queued.

Swarm is 3.8, Runner 5.8, Heavy 1.7 and player 5.3. The start tower is
deterministically calibrated to 0.90 Materials/s base and its anchored marker is
Moderate. Placing either the generated tower or a construction site converts
only Forest tile centres within `sqrt(5)` to Plain, invalidates movement and
normal-LOS visibility caches, and increments a terrain version that rebuilds
both renderer layers. `node tools/pacing-report.js [source-root] [label]`
produced the before/after data below from an `ef78ec7` checkout and this tree.
No HP, wave composition, timer, tower/upgrade, road, LOS-rule, fog, aggro or
player-speed balance changed.

Controller browser acceptance (CHARLIE, 1600x900, no console or page errors):

- Start tower: `towerStats` income 0.90/s base; the occupied Gunner panel reads
  Production 1.35/s (x1.5 occupancy).
- Forest site at (57,37), forest to radius 3 at equal elevation: `tryBuild`
  cleared exactly 21 Forest tiles, `terrainVersion` 0 -> 1, and the next frame
  drew a plain 5x5-minus-corners patch with forest intact beyond it.
- A Heavy placed 2.9 tiles east was visible, besieged the tower and dropped
  270 -> 74 HP in 4s of occupied fire. A Swarm 6 tiles out in forest was
  hidden (`isPointVisible` false) and not drawn.
- Real wave 4 at the start tower, measured over 1s off-siege: Swarm median
  3.74 tiles/s (n=6), Runner 5.35 (n=2, turning/terrain below the 5.8 cap).
  No Heavy in that wave; Heavy speed is unchanged and test-asserted.

## D62–D64 pass — REVIEWED, ACCEPTED AND COMMITTED

Long upgrades (D62), stuck-enemy recovery (D63) and tower-loss defeat (D64)
were finished by Codex on 2026-09-19 after the usage-limit stop, reviewed by
the controller, accepted in the browser and pushed to `master` as `ef78ec7`
(live on GitHub Pages; the previous commit is `9f7b2e2`). It touched `src/game.js`,
`src/config.js`, `src/main.js`, `src/ui.js`, `index.html`, `test/run-tests.js`,
`CURRENT_STATE.md`, `DESIGN_DECISIONS.md`. `npm test`: 97 passed, 0 failed.

Controller browser acceptance (1600x900, no console or page errors):

- **Upgrade timing, W0->W1:** Gunner occupied / unoccupied / leaving halfway
  15.0s each; Engineer unoccupied 15.0s, occupied 4.17s, leaving at 50% 9.6s
  (expected 2.08 + 7.5). The side panel reads `Weapon W0 -> W1`, blue progress
  bar, remaining seconds and `Engineer x3.6`; the rate note and the faster
  countdown disappear as soon as the Engineer leaves.
- **Dense waves 3-8** (CHARLIE, GOLF, KILO, R7KD2P; sheltered and exposed waves
  alternating, player made unkillable): waves 3-7 all ended normally with 0
  enemies left. Detections/recoveries/despawns 12/12/0, 18/18/0, 33/32/1,
  29/29/0. The single KILO despawn did not reproduce on a rerun. Wave 8 exposed
  with one unupgraded tower did not finish in 300s, but all 35 remaining enemies
  were chasing the circling player inside tower range and moving 5-9 tiles per
  5s - a harness artifact (unkillable player), not a stall.
- **Defeat:** last finished tower destroyed with a construction site standing ->
  still playing; site then destroyed -> `lost/'towers'`; last tower at 1 HP
  (COLLAPSING) -> playing; last tower destroyed with no site -> `lost/'towers'`,
  end screen "Position lost / Every tower was destroyed on wave 1 as the
  Engineer."; player HP to 0 with towers standing -> `lost/'died'`, "You died".
- Review notes: a player-hunting enemy's progress episode restarts whenever the
  player changes tile, so a stuck enemy chasing a constantly moving player
  relies on the older 1.5s nudge rather than the 3s recovery. `spawnEnemy`
  now drops an enemy silently if no authored mouth tile on its side is passable
  with a finite field (never observed).

## What this is

`holdfast` is a playable 2D top-down tower-defense/survival prototype. The
current loop is: read the generated terrain and road network, build towers
beside the lanes, shelter in a tower during combat, and survive eight waves.
Victory is surviving the final wave; defeat follows player death or destruction
of the entire tower network.

## Implemented state

- The authored-and-validated terrain generator remains intact on a 104x52 map.
  Its ridges, deliberate gaps, river, explicit fords, open-ground band and
  seeded regeneration still pass through the validation gate.
- Three-state fog is simulation-owned: player vision is 8 tiles and built-tower
  vision is `max(9, current weapon range + 1.5)`, both using the existing D3
  cliff/forest LOS rule. Visible tiles become permanently explored. Terrain is
  bright while visible, dim/desaturated while remembered, and opaque near-black
  while unexplored; units and effects do not leak through fog.
- Every map has a separate `road` bitfield. Cost-carved west/east routes meet at
  the centre, reuse existing road cheaply, pass through the authored gaps and
  fords, and gain one or two connected lateral branches where unused gaps are
  available. Roadbeds grade forest and marsh to plain but preserve shallow
  fords and never cross impassable terrain.
- Tower-target flow fields use `lane` cost, which discounts roads. The player
  pursuit field uses `direct` cost and ignores the road bitfield. Tower fields
  remain lazily cached. The existing 1.5s narrow-pass nudge remains first;
  field-progress detection now confirms after 3s without a 0.75-unit gain,
  performs radius-clear BFS recovery (local radius 6, then a wider fallback),
  and silently despawns only after 9s from first detection or three recoveries.
- The camera, minimap and edge markers are gone. Resize computes an integer tile
  scale that fits the complete map and centres it with letterboxing. Towers,
  player, enemies, health bars and labels have minimum screen sizes.
- Towers cannot be placed with any footprint tile on a road. Construction is
  local: Build mode previews the nearest valid tile centre within 1.5 tiles of
  the player and Enter, left click, or Build here confirms that site. The
  starting tower is kept beside the central junction and generation verifies
  its footprint is road-free. Unfinished construction continues unassisted when
  the player leaves, with the existing presence multiplier when nearby.
- Weapon and extraction upgrades are timed jobs (D75: Extraction raises the
  rate only; the 4.5-tile footprint never grows) with
  `{which,toLevel,progress,duration}` state and 15/25/40 second base durations
  for levels 1/2/3. A tower keeps its old combat and extraction stats while the
  job runs. Only an Engineer occupying that exact tower accelerates it (x3.6:
  4.17/6.94/11.11s); every unoccupied tower and every other archetype runs at
  x1. New-tower construction keeps its separate proximity rule unchanged. Only
  one job runs per tower, and destruction loses it without a refund.
- Enemy mouth spawns are constrained to a passable authored mouth with a finite
  target field. Progress tracking uses the exact tower-lane/player-lane/direct
  field selected for steering, excludes sieging and attack-reach states, and
  records compact diagnostic snapshots for nudges and confirmations. Recovery
  destinations prefer road at equal range and require a Heavy-clear 3x3.
- End state is resolved once, at the end of each simulation step. Player death
  has priority; otherwise zero towers means `lost/'towers'`. Unfinished and
  positive-HP COLLAPSING towers count. Terminal updates advance FX only.
- Shelter takes 0.7 seconds of continuous presence in a built tower. Occupancy
  bonuses and melee immunity begin only when that timer completes; leaving
  immediately resets shelter.
- D53/D76 aggro: Runners take the occupied tower or the exposed player, drop a
  tower the player leaves within 0.9s and never breach it. Swarm/Heavy commit
  to the tower they select (occupied if reachable, else nearest by path) until
  it dies or becomes unreachable, then take the nearest by path; every tower
  contact is a breach, and nothing sieges. Hunters within 12 tiles pursue directly (D31 interception); farther ones
  travel toward the player on the road-discounted lane field. D73: the occupied
  tower is breached at contact, never sieged, so no new siege begins in play.
  `dangerState().hunters` retains the full near-hunter count, while HUD/canvas
  displays use `visibleHunters` only. Runner 5.8 remains faster than the 5.3
  player; Swarm 3.8 is substantially slower, and Heavy remains 1.7. Ordinary
  hits still kill in roughly two to four hits.
- Warning highlights the incoming half of the road network, clipped to explored
  road tiles. Combat HUD and canvas feedback show EXPOSED state, shelter progress
  and visible hunter count. Damage from an unseen attacker triggers a 1.5-second
  tower ring/UNDER ATTACK label and HUD notice, rate-limited sound, and episode
  log without revealing the attacker.
- `window.holdfast` retains `game`, `start()`, `errors`, `fastForward()` and all
  prior `api` methods. New read-only acceptance surfaces are
  `isTileVisible`, `isTileExplored`, `isPointVisible`, `visibilityState`,
  `playerBuildSite`, `upgradeState`, `towerAlarmState`, `stuckState`, and
  `endState`; `dangerState(game)` exposes both `hunters` and `visibleHunters`.
  `upgradeState(game,tower)` adds from/to levels, duration, and rate-adjusted
  remaining time while the browser API preserves `upgradeState(tower)`.
- Pause is available from the HUD and P. The normal simulation boundary freezes
  movement, combat, spawning and phase clocks, construction, extraction,
  repairs, drop/effect expiry and FX. Build, upgrade and collection functions
  refuse actions while paused. `fastForward()` explicitly bypasses pause, and
  `api.pauseState(game)` exposes the semantic state.
- Road carving charges for elevation-band transitions, discounts ground one or
  two tiles from water and sends a seeded subset of approaches through an
  intermediate waypoint. Existing-road reuse still produces the merges. Maps
  typically take 1-20 generation attempts (the D2/D44 gates reject most builds;
  the old "1-3 attempts" figure was stale before this pass).
- D54: every entry route starts on the boundary column at its spawn mouth and
  the renderer draws it through to the canvas edge; spawn coordinates are
  unchanged (x=1 / MAP.w-2). Roads avoid the outer two columns/rows elsewhere.
- D55: `analyseRoadReadability(map)` measures near-self-passes, thick
  side-by-side bands, junction clutter, density and zigzags. Tangles are
  prevented in carving (wide alternate corridors, deeper alternate waypoint,
  direction-independent diagonal corners), repaired by D51 merging, and
  generateMap prefers a clean valid map within 2 extra attempts. Features report
  exposure `efficiency`; authored ones need >= 0.3.
- The D2 road gate now measures maximal vertical road runs per column on each
  battlefield half. Each accepted map has a median of at least two separate
  approaches per half and several three-run columns; alternate approaches avoid
  the first road corridor for their outer stretch, then merge through ordinary
  cost carving. The debug panel reports each half's median, maximum and 3+ run
  columns.
- Walkable elevation is now Low / Normal / High, with a stronger shading ramp,
  quiet contour boundaries and build-preview sight explanations. Height still
  changes line of sight only; it provides no range or damage bonus.
- D74: background seams (max-combined) give Poor/Moderate ground; Rich exists
  only at 3-5 separated, solved jackpots (1.6-2.2/s at their centre).
- Deposit regions carry an extraction figure and a shared Poor /
  Moderate / Rich classification. One to three gold bars render once per region
  at legible map scales, and the preview shows bars, tier and exact
  Materials/second together. The start kernel is applied after remote deposits
  and ambient resources, then its peak is solved deterministically so the real
  start tower earns 0.90/s base. Its marker is anchored to that tower and is
  Moderate; other markers stay at their deposit centroids.
- Tower placement clears only Forest to Plain inside `sqrt(5)` (21 possible tile
  centres, a 5x5 square without corners). Elevation, resources, roads, marsh,
  shallow/deep water and cliffs are unchanged. All tower/player movement fields,
  LOS-derived visibility and cached bright/dim terrain layers are refreshed.
- Drops now roll approximately 70% temporary effects, 22% small Materials
  caches and 8% run-long equipment. Equipment is one-of-each, capped at four,
  resets on a new run and is listed in the HUD. Category-specific bolt, bars and
  module glyphs accompany numeric expiry countdowns. Acceptance can inspect
  `api.equipmentState(game)` and `api.depositRichness(map, deposit)`.
- `npm run artifact` regenerates `artifact/index.html` from the real page without
  its document wrapper.

## Automated verification

`npm test` runs 127 checks. It covers 20 deterministic seeds,
terrain validation, road connectivity and legality, seed variation, lane/direct
field behavior, road placement refusal, ford use and generated route character,
road exposure and knots, D55 readability (synthetic clean/tangled shapes and all
20 seeds), D54 entry roads, delayed shelter occupancy, line of sight, richness
thresholds, pause freezing and action refusal, equipment uniqueness/cap,
collapse, D53 aggro (A-E), economy, escalation and a long simulation. It now
also covers fog persistence/LOS, enemy hiding, built/unfinished tower vision,
resource discovery, local and unassisted construction, exact three-level upgrade
timing/function/pause/destruction, alarms, visibility performance, and five-seed
prep scouting. It now also covers cliff recovery and resumed progress, silent
unreachable despawn, siege/crowd exclusions, Heavy clearance, mouth-spawn validity,
waves 3-8 dense diagnostics on eight seeds, all tower-loss/death priority cases,
and terminal-state freezing. D67-D69 add exact speed/order and increased
isolated-engagement checks, 20-seed start-income/remote-Rich assertions, and
all-angle forest siege/fire, distant blocking, elevation, layer-invariant,
open-ground and cache-invalidation tests plus a real-seed reproduction. D72-D73
add the 350 opening (A-C) and breach A-J; D74-D75 add road speed (A-D),
extraction footprint/upgrade function (E-G) and canonical jackpot rarity.
D76 adds role/commitment/replacement/breach tests (D76-A..O).
Final result: **135 passed, 0 failed**. The
wall-clock road-analysis budget (400ms) remains load-sensitive; no road code
changed.
`npm run road-report` prints per-seed features,
efficiency, knots, readability defects, entry roads and attempts.

## D67-D70 pacing/economy/forest measurements — 2026-09-19

`tools/pacing-report.js` ran unchanged against a detached `ef78ec7` checkout
(`before`) and this working tree (`after`). Simulation rows use ALPHA-HOTEL,
seeded `Math.random`, real wave-8 composition/spawning and W0 occupied Gunner
towers. Engagement pools the same 162 Swarms, 83 Runners and 60 Heavies in each
version. Hairpin sites were the best D52 hairpin on each seed (39.5,36.5;
20.5,15.5; 27.5,28.5; 26.5,38.5; 60.5,7.5; 62.5,24.5; 74.5,27.5;
20.5,37.5 respectively) and were built through the real placement path. No
harness precondition failed.

Configured movement changed only as D67 specifies:

| unit | before | after |
|---|---:|---:|
| Player | 5.3 | 5.3 |
| Swarm | 4.9 | 3.8 |
| Runner | 6.2 | 5.8 |
| Heavy | 1.7 | 1.7 |

Engagement seconds are p25 / median / p75 of time both inside W0 range and in
LOS. The last column is fraction killed in range / fraction that reached siege
distance. Real-wave per-enemy medians do not move monotonically with speed:
slower arrivals spread the crowd and reduce time queued inside a saturated
single tower's range. The separate isolated-approach regression test removes
that crowd interaction and asserts that lowering Swarm/Runner speed strictly
increases engagement time (Heavy is unchanged).

| site/type | before seconds | after seconds | before killed/reached | after killed/reached |
|---|---:|---:|---:|---:|
| start / Swarm | 6.06 / 12.15 / 23.64 | 6.22 / 10.90 / 18.49 | 100.0% / 98.8% | 100.0% / 96.9% |
| start / Runner | 3.37 / 7.00 / 15.85 | 2.97 / 5.00 / 11.08 | 100.0% / 98.8% | 100.0% / 97.6% |
| start / Heavy | 25.30 / 39.30 / 54.31 | 22.44 / 42.67 / 59.59 | 96.7% / 98.3% | 96.7% / 96.7% |
| hairpin / Swarm | 6.06 / 12.08 / 45.41 | 6.01 / 11.88 / 39.21 | 100.0% / 96.9% | 99.4% / 92.6% |
| hairpin / Runner | 4.62 / 10.85 / 33.43 | 3.50 / 5.95 / 26.08 | 100.0% / 95.2% | 100.0% / 91.6% |
| hairpin / Heavy | 22.00 / 34.30 / 52.91 | 24.78 / 36.70 / 52.19 | 93.3% / 95.0% | 91.7% / 91.7% |

Exposure starts only after six real wave-8 enemies are within 12 tiles. Standing
trials place the player four to six tiles from the start tower; all eight died.
Dashes build a second real W0 tower across a straight passable corridor. Times
and HP loss are p25 / median / p75; dash maximum is included because the short
median is zero in both versions.

| exposed measure | before | after |
|---|---:|---:|
| time to first hit | 0.89 / 1.72 / 1.99 s | 1.02 / 1.22 / 1.49 s |
| time to death | 2.32 / 2.85 / 2.92 s | 1.97 / 2.08 / 2.48 s |

| dash corridor (8 runs) | before HP loss (max), deaths | after HP loss (max), deaths |
|---|---:|---:|
| short covered, 8 tiles | 0 / 0 / 0 (76), 0/8 | 0 / 0 / 0 (38), 0/8 |
| mid covered, 13 tiles | 0 / 35 / 100 (100), 3/8 | 0 / 19 / 82 (100), 2/8 |
| long uncovered, ~24 tiles | 0 / 35 / 82 (100), 2/8 | 0 / 0 / 53.5 (100), 2/8 |

Sheltered outcomes use fresh Gunner runs sitting in the start W0 tower with no
repair, upgrades or building. HP loss is gross damage, not end-minus-start.

| outcome | before | after |
|---|---:|---:|
| waves survived, min / median / max | 2 / 3 / 3 | 2 / 3 / 4 |
| wave duration, p25 / median / p75 | 27.8 / 29.9 / 41.65 s | 31.2 / 34.6 / 45.55 s |
| tower HP lost/wave, p25 / median / p75 | 47.0 / 86.6 / 214.6 | 26.7 / 76.3 / 223.25 |
| enemies reaching/wave, p25 / median / p75 | 8 / 10 / 13.5 | 5 / 8.5 / 13.25 |

| seed | waves before | waves after |
|---|---:|---:|
| ALPHA | 3 | 3 |
| BRAVO | 3 | 4 |
| CHARLIE | 2 | 2 |
| DELTA | 3 | 3 |
| ECHO | 3 | 3 |
| FOXTROT | 3 | 3 |
| GOLF | 3 | 3 |
| HOTEL | 3 | 3 |

D68 removes the fixed `startPeak: 0.36`. The two seeded jitter rolls and radius
5 are unchanged; remote seams are laid with the unchanged 12-tile exclusion and
18-tile buffer, then the ambient floor is added. Only then a 32-pass monotone
binary search solves the start kernel peak against the real start tower,
including overlap and the 1.8 per-cell cap. The start marker is anchored to that
site (D70). Remote best income, road geometry and road bitfields are unchanged.

| 44 generated seeds | before min / median / max | after min / median / max |
|---|---:|---:|
| start base income | 0.311 / 0.368 / 0.392 (Poor) | 0.900 / 0.900 / 0.900 (Moderate) |
| remote Rich build sites/map | 258 / 540 / 817 | 258 / 540 / 817 |
| best remote / start ratio | 5.71 / 8.29 / 10.35x | 2.28 / 3.33 / 3.86x |

Canonical 20-seed details follow. `Rich` counts tile-centre build sites at least
12 tiles from start with base income >= 1.18; `road` is raw road tiles within W0
range. Best income and both road/count columns are unchanged before/after.

| seed | Rich sites | best income | best/start before | best/start after | road |
|---|---:|---:|---:|---:|---:|
| ALPHA | 585 | 2.820 | 7.58x | 3.13x | 36 |
| BRAVO | 738 | 2.650 | 6.79x | 2.94x | 18 |
| CHARLIE | 539 | 2.693 | 6.96x | 2.99x | 34 |
| DELTA | 541 | 2.497 | 7.00x | 2.77x | 28 |
| ECHO | 521 | 2.440 | 6.43x | 2.71x | 27 |
| FOXTROT | 579 | 3.056 | 9.21x | 3.40x | 40 |
| GOLF | 817 | 2.994 | 7.86x | 3.33x | 29 |
| HOTEL | 470 | 2.999 | 7.88x | 3.33x | 24 |
| INDIA | 594 | 3.092 | 8.01x | 3.44x | 31 |
| JULIET | 773 | 2.738 | 8.05x | 3.04x | 23 |
| KILO | 431 | 2.947 | 7.78x | 3.27x | 14 |
| LIMA | 352 | 2.744 | 8.55x | 3.05x | 32 |
| MIKE | 395 | 2.912 | 7.59x | 3.24x | 7 |
| NOVEMBER | 545 | 3.231 | 8.60x | 3.59x | 28 |
| OSCAR | 558 | 3.414 | 9.97x | 3.79x | 29 |
| PAPA | 468 | 3.347 | 10.35x | 3.72x | 23 |
| QUEBEC | 447 | 2.318 | 5.98x | 2.58x | 28 |
| ROMEO | 337 | 2.950 | 8.39x | 3.28x | 22 |
| SIERRA | 258 | 2.999 | 8.86x | 3.33x | 23 |
| TANGO | 521 | 3.170 | 8.13x | 3.52x | 27 |

D69's radius is exactly `sqrt(5) = 2.236...`: maximum Heavy reach is
`0.95 + 1.5 + 0.62 = 3.07`, and because Bresenham ignores shooter and target
endpoint tiles, the farthest possible intervening lattice offset is (2,1).
Thus the clear set is the 5x5 neighbourhood minus four corners. Tests sample 32
angles at both full reach and the `reach - 0.35` settle ring for all three enemy
types and verify actual tower damage, not LOS alone.

Concrete root cause: on generated seed ALPHA a tower at tile (70,3), centre
(70.5,3.5), could be sieged by a Heavy at (73.22,3.5); LOS was false because
intermediate same-height Forest tile (71,3) blocked it. Clearing makes that same
LOS true. A target six tiles away on the same bearing remains hidden (`false`),
proving forest beyond the ring still works. High-over-Normal-forest behavior is
also unchanged. Only Forest becomes Plain; elevation, resources, roads and all
other terrain kinds are byte-identical. Start placement normally clears zero
tiles because generation already has a radius-4 open start, but it uses the same
safe path.

Performance (wall clock is load-sensitive): across the same 44 maps generation
median/p75/max was 539.8/816.5/1964.6ms before and
584.9/893.6/2138.1ms after. A warmed isolated calibration body measured 0.54ms
per final map, so the much noisier process-level difference should not be
attributed wholly to D68. Forest clearing examines at most 49 cells; 2,000
reset-map placements measured 0.0012ms median, 0.0019ms p75 and 0.0967ms max.
Renderer rebuilding happens only after an actual change, on the next frame.

## Stuck diagnosis and measurements — 2026-09-19

- Root causes: unchecked mouth scatter could enter adjacent invalid terrain;
  even centre-in-tile jitter could put a collision probe into adjacent cliff or
  deep water; embedded terrain produced zero expected speed so the old strict
  nudge test never accumulated; and non-finite fields fell through to direct
  steering against a wall while the local nudge had no finite neighbour. A
  moving player's replacement fields were also being compared as one metric,
  causing one false last-resort despawn on CHARLIE wave 6 before the goal-tile
  key/reset fix and zero after. Separation remained collision-checked. D52
  spines are revalidated after stamping and were not an unchecked mutation.
- Before/after cause fixtures: embedded cliff 1 permanent episode -> 1
  detection, 1 recovery, 0 despawns; isolated non-finite pocket 1 permanent
  episode -> 4 confirmations, 0 recoveries, 1 silent despawn; moving-target
  field mismatch 1 false dense-wave despawn -> 0 after the field-key fix.
  Unchecked scatter was structural but did not reproduce across the 43 canonical
  mouths; the runtime audit sampled 387 spawns with 0 invalid centres or probes.
- Dense waves 3–8, alternating sheltered and exposed/moving play, reported
  detections/recoveries/despawns: ALPHA 17/17/0; BRAVO 17/17/0; CHARLIE 9/9/0;
  DELTA 16/16/0; ECHO 16/16/0; FOXTROT 6/6/0; GOLF 24/24/0; HOTEL 16/16/0.
  Instrumentation recorded 507 two-second no-progress snapshots, 25 legacy
  nudges and 121 recoveries: recovery sources were 114 steering+separation,
  5 separation-push and 2 steering-only episodes.
- Tracking-inclusive dense enemy updates measured 0.5676ms/frame. This is a
  conservative upper bound for stuck tracking because it also includes
  steering, collision and O(N²) crowd separation for the same 18-enemy frames.

## Fog and expansion measurements — 2026-09-18

- Initial explored area on `FOG-INITIAL`: 190 / 5,408 tiles (3.51%).
- Visibility recompute: 0.130ms average over 40 forced player-tile changes in
  the latest headless run.
- Prep expansion bot (time to a valid Moderate+ site at least 10 tiles from the
  start tower / explored tiles): SCOUT-A 2.8s / 276; SCOUT-B 2.4s / 379;
  SCOUT-C 3.3s / 421; SCOUT-D 2.6s / 367; SCOUT-E 1.9s / 355. This bot knows
  the map, so it only proves such a site is near.
- Controller browser acceptance (1600x900, no console errors): a *blind*
  road-frontier scout (explored knowledge only) during the first 40s prep reached
  a valid Moderate+ site 10+ tiles out at 3.3s (CHARLIE), 3.7s (GOLF), 3.4s
  (KILO), 13.2s (HOTEL) and explored 28-45% of the map. Prep time is not a
  constraint; exploration may be too cheap rather than too slow.
- Seen in the rendered game: black unexplored, grey-but-navigable remembered
  ground (roads, forest, cliffs, water, deposit bars legible), full-colour live
  vision; the wave warning highlights explored road only; build preview snaps
  at the player; scaffold + BUILD % and a cyan UPG ring + brackets read at
  12px/tile; enemies hidden until seen (0/8 and 0/5 visible early in wave 1);
  fog debug (V) shows state tint, vision circles and LOS-blocked tiles; an
  unfinished tower sieged out of sight (KILO) pulsed red with UNDER ATTACK, HUD
  chip and one log line while its attackers stayed hidden.
- The first dim level (filter + black overlay, ~42% brightness) made
  remembered ground nearly black; raised to grayscale 0.7 / brightness 0.64 with
  the overlay only as a no-filter fallback (D61).

## Controller acceptance — measured, 2026-09-16

Scripted browser playthroughs across seeds BRAVO/CHARLIE/DELTA/ECHO/FOXTROT/GOLF.
No console errors at 1600x900 or 1280x800.

**Roads work.** Networks span the full map width (cols 1-102 of 104), contain
**zero** tiles on impassable terrain, and genuinely use the fords (10-31 ford
tiles per map). **86-94% of enemy travel happens on road.** Peak stuck time
0-0.1s: no congestion at crossings, fords or passes. Roads serve 5/10, 6/7 and
5/6 of the authored barrier gaps — taking most but not all, so off-road
alternates survive and multiple routes remain.

**Full-map view is readable.** At 1600x900 the map renders at 12px/tile, at
1280x800 at 9px/tile; the minimum entity sizes keep towers, player and enemies
legible at both. The 2:1 map in a ~1.4:1 stage letterboxes top and bottom.

**Historical pre-D67 exposure result (superseded above).** Standing still
exposed mid-wave took 4.4-5.7s to first hit and 5.5-6.0s to death under that
older harness. Enemy hit values remain 32/38/55.

**Tower-to-tower escape has the right gradient** (24 sampled dashes across a
contested corridor):

| corridor | avg HP lost | deaths |
|---|---|---|
| short, covered (8t) | 34 | 0/6 |
| mid, covered (13t) | 26 | 0/6 |
| long, uncovered (24t) | 45 | 3/12 |

**Central turtling does not dominate.** A bot that only ever builds within 14
tiles of the centre died on wave 7.

**Stay-versus-run still bites.** A bot that never abandons a tower died on waves
6 and 8 of 8, both times crushed by the collapse it refused to leave.

## Third pass acceptance — measured, 2026-09-16

Pause, road character, elevation legibility, richness bars, drop categories and
the synthesised sound layer. `npm test`: 39 passed, 0 failed, ~5s. No console
errors across scripted browser runs.

**Pause is airtight.** Driving real animation frames with input held while
paused, all 7 tracked quantities stay frozen (Materials, wave, phase timer,
enemy positions, drop timers, tower HP, player position); build and upgrade are
refused at a site known valid before pausing; the audio context suspends and
starts 0 voices; everything resumes cleanly.

**Roads now carry real geometry.** Across 10 seeds: every map has bands of 3+
parallel routes (medians 2-3 lanes, previously 1), and every map has U-turns or
hairpins. 8-28% of road tiles hug a river on most seeds; switchbacks climb
beside ridges; rivers show multiple ford crossings. Roads still never touch
impassable terrain, and 86-94% of enemy travel stays on them.

**A pathfinding defect was found and fixed (D45).** The parallel-routes
correction exposed a latent Dijkstra bug: generation went to 30s per map and
seed QUEBEC crashed with the heap overflowing. Fixed output-neutrally (roads,
terrain and both runtime fields bit-identical on 7 seeds); every seed now
generates in under 400ms.

**Elevation is legible but its advantage is modest (see known risks).**

**Historical pre-D68 richness result (superseded above).** Tiers remain disjoint
(poor < 0.62 <= moderate < 1.18 <= rich Materials/sec). The old centre sat at
the 34th-44th percentile; D68 now directly calibrates home to 0.90 Moderate.

**Rich and defensible sites are independent.** Of the top-quartile-income sites,
26% are also top-quartile for sightlines - essentially the 25% expected if the
two were unrelated, so neither choice is made for the player.

**Drops behave as specified.** Roll 69/22/8 against a 70/22/8 spec; equipment
caps at exactly 4 with no duplicates; Materials caches average 33, about 5% of a
run's economy.

**Audio, measured without ears.** Context stays unborn until the first gesture,
then runs. A 36-enemy siege peaks at 9 of 18 voices. 20s of fast-forward with
audio on costs 65-94ms and starts ~6 voices. Enemy hit/death cues were silently
replaced by a generic beep until D47 fixed it. COLLAPSING announces once, then
reminds quietly every 2.6s, and is silent while paused.

**Historical pre-D67 danger result (superseded above).** This older harness saw
first hit in 3.0-4.7s, death in 5.4-5.7s and contested dash losses of 29/25/53
HP at 8/13/20 tiles. The current same-checkout before/after harness is the D67
table above.

## Road exposure pass - measured, 2026-09-17 (shipped as-is)

Road shape is now judged by how long a tower can shoot enemies walking it
(D48-D52), not by how twisty it looks. `npm test`: 48 passed. `npm run
road-report` prints per-seed features, exposure ratios and knot counts.

- **Knots:** before, every one of the 20 test seeds had 1-8 (stubs, small
  loops, braids). Now 18 have 0; GOLF and KILO keep one small loop each.
- **Exposure features:** rock-spur and water-inlet hairpins/horseshoes. Straight
  road baseline 14.46 tiles of path in range. Strong features per map 0-4
  (9 maps with 2-4, 6 with 1, 5 with 0); best ratios 1.78-2.25x where present.
  Before the pass, 18 of 20 maps had no strong site at all.
- **Enemies still use roads:** walked lanes 95-98% on road on 7 seeds.
- **Generation time:** mean ~470ms, max ~1.1s (was ~100ms / 420ms).
- Browser smoke: game loads and plays waves on NOVEMBER with no console errors;
  hairpins read clearly at full-map scale.

## Aggro + road readability pass - measured, 2026-09-17

- **Stale aggro fixed (D53).** Live combat, 4 seeds x 2, player walks A -> B:
  non-sieging enemies that went on to besiege abandoned A 0-11 per run -> 0;
  new spawns choosing A up to 5/5 -> 0; committed siegers stayed. Browser run
  on CHARLIE: 3 siegers + 17 approaching A; 1.2s into the walk 10 target the
  player and 7 are still peeling off; 5s after occupying B, 17 target B, 0
  uncommitted enemies remain on A, 1 surviving sieger stays on A. Standing
  exposed beside a besieged tower kills a little faster (mean 4.3s -> 3.4s).
- **Roads (D54/D55), 20 test seeds:** knots 2 -> 0; readability defects 3 (one
  short band each on BRAVO, DELTA, PAPA); strong exposure features 29 -> 51;
  maps with none 5 -> 0; best-site ratio 1.79-2.25x; every entry road reaches
  the boundary. Generation mean ~680ms, max ~1.3-1.4s (was ~470ms / ~1.1s).
  Runtime road adherence during a sheltered wave 77-91% (mean 86%) vs 75-93%
  (mean 87%) on the old generator.
- **Browser, full-map screenshots judged by the controller:** GOLF, HOTEL, KILO,
  BRAVO, PAPA, ALPHA-era seeds plus random R7KD2P, M4XQ9A. Approaches read as
  separate lanes with clean loops and hairpins; entries meet the canvas edge.
  Still busy: KILO centre-left where two approaches converge on a diagonal, and
  R7KD2P centre where two roads run almost side by side (its one flagged band).
  No console errors.

## Acceptance status and known risks

1. **Elevation's advantage is real but not obvious.** Where forest is present,
   High-ground sites see 47% of the ground in range against 36% for Normal - a
   genuine gain from the D3 rule. But across ALL sites, Low ground averages the
   best visibility (75%), because low ground is open riverbank and marsh where
   forest rarely grows, and High ground sits beside ridges whose own cliffs
   block one side. A player is unlikely to perceive "high ground is better".
   This is the physics as designed (D3, D34); changing it is a design decision,
   not a bug fix.
2. **The map is busy.** Roads, contours, richness bars, towers and enemies all
   share one full-map canvas at 9-12px per tile. Legible in screenshots, but
   worth judging by hand during a large wave.
3. **Audio priority is latent-unsafe.** Voices already playing are never
   pre-empted, so a full voice cap would drop player-damage cues. Unreachable at
   current rate limits (peak 9/18); recorded in D47.
4. **Feel is unverified.** Whether equipment drops are worth the risk, whether
   COLLAPSING gives enough time to decide, whether reaching a tower feels like
   relief, and whether repeated gunfire becomes irritating all need a human.
5. **Current D67 exposure remains noisy.** In the eight-seed headless harness,
   long uncovered dashes killed 2/8 both before and after; median HP loss fell
   35 -> 0, but standing median death also fell 2.85 -> 2.08s because the fixed
   six-enemy trigger presents a different crowd shape at the lower speeds.
   Controller play remains the authority for feel.

6. **Road readability is much better, not perfect (D55 known gaps).** About 1 in
   7 maps keeps one short side-by-side band; converging diagonal approaches can
   still look busy because a diagonal road renders as a two-tile staircase. No
   in-game debug overlay shows exposure or readability defects. Where a river
   meets the map edge beside a spawn mouth, a road can be forced along the
   boundary (seen on random seed M4XQ9A only).
7. **D67 has mixed exposure effects.** With unoccupied towers still excluded by
   D53, every uncommitted enemy attacks an exposed player. Covered dash damage
   improved in the headless before/after runs, but stationary mid-wave death did
   not; controller acceptance should judge whether tower-to-tower travel feels
   fair under real play.
8. **Fog pass open questions (2026-09-18).** (a) Unfinished and unoccupied
   towers are not enemy targets (D53), so a construction site is only attacked
   by enemies already committed to it; the "leave an unfinished tower" tension
   is weaker than the plan assumed. (b) Upgrades now take 15/25/40s at x1;
   only an occupying Engineer gets x3.6 (4.17/6.94/11.11s). The timings are
   verified in the browser; whether they create the intended timing commitment
   is a feel question for hand play.
   (c) A road-following scout reveals 28-45% of the map in the first prep;
   vision 8 may be generous. (d) Upgrades can still be bought for a remote
   tower; only new construction is local. (e) Positional audio (tower hits,
   pan) still carries direction for unseen sieges - intended as a hint, not
   judged by ear.

## Next steps

1. Play it by hand, with sound on. The unanswered questions are all about feel,
   and now also whether the hairpin tower sites feel worth taking, whether
   exploring the dark is interesting, the fog-pass questions in risk 8, and
   whether the slower Swarm/Runner pacing (D67) feels right.
2. Road follow-ups: a debug overlay for exposure sites and readability defects;
   if converging diagonals still read as busy in play, consider drawing diagonal
   road segments as diagonal strokes instead of staircases (render-only).
3. If elevation should read as an advantage, the honest lever is terrain, not
   stats: keep more high ground clear of ridge shoulders so it is not
   self-blinded.
4. If the map reads as cluttered in a big wave, cull richness bars during combat
   before removing anything else.
5. D67 left two measured questions for hand play rather than a tuning pass:
   standing exposed mid-wave now dies faster (median 2.85 -> 2.08s), and
   slower enemies do not raise per-enemy time in range in crowded real waves
   (see risk 5 and the D67-D70 tables).
