# Current State

Last updated: 2026-09-19 (resumed long-upgrade, stuck-recovery and tower-loss pass)

## D62–D64 pass — REVIEWED, ACCEPTED AND COMMITTED

Long upgrades (D62), stuck-enemy recovery (D63) and tower-loss defeat (D64)
were finished by Codex on 2026-09-19 after the usage-limit stop, reviewed by
the controller, accepted in the browser and committed on `master` (the previous
commit is `9f7b2e2`; push to GitHub Pages pending the user). It touched `src/game.js`,
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
- Weapon and extraction upgrades are timed jobs with
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
- D53 aggro: towers have no baseline aggro. The one strategic target is the
  occupied tower, or the exposed player. An enemy that has physically attacked a
  tower stays committed to it; enemies only heading for a tower the player leaves
  drop it within 0.9s and never start a siege there, and new spawns never pick
  it. Hunters within 12 tiles pursue directly (D31 interception); farther ones
  travel toward the player on the road-discounted lane field.
  `dangerState().hunters` retains the full near-hunter count, while HUD/canvas
  displays use `visibleHunters` only. Swarms are only slightly slower than the
  player, Runners are faster, and ordinary hits kill in roughly two to four hits.
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
- Deposit regions carry a centroid extraction figure and a shared Poor /
  Moderate / Rich classification. One to three gold bars render once per region
  at legible map scales, and the preview shows bars, tier and exact
  Materials/second together. The starting area is kept below the Rich tier.
- Drops now roll approximately 70% temporary effects, 22% small Materials
  caches and 8% run-long equipment. Equipment is one-of-each, capped at four,
  resets on a new run and is listed in the HUD. Category-specific bolt, bars and
  module glyphs accompany numeric expiry countdowns. Acceptance can inspect
  `api.equipmentState(game)` and `api.depositRichness(map, deposit)`.
- `npm run artifact` regenerates `artifact/index.html` from the real page without
  its document wrapper.

## Automated verification

`npm test` runs 97 checks. It covers 20 deterministic seeds,
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
and terminal-state freezing. Resumed-run result: **97 passed, 0 failed**. The
wall-clock road-analysis budget (400ms) remains load-sensitive; no road code
changed.
`npm run road-report` prints per-seed features,
efficiency, knots, readability defects, entry roads and attempts.

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

**Outside is lethal, as intended.** Standing still exposed mid-wave: first hit
after 4.4-5.7s, dead in 5.5-6.0s. Enemy hits are 32/38/55, so 2-4 hits kill.

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

**Richness bars are consistent.** Tiers are disjoint (poor < 0.62 <= moderate <
1.18 <= rich Materials/sec), so a bar can never contradict its number; the
centre sits at the 34th-44th income percentile; single, double and triple bars
remain distinguishable at full-map scale.

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

**Danger tuning did not regress.** Exposed player: first hit 3.0-4.7s, dead in
5.4-5.7s. Circular kiting dies in ~7s on CHARLIE and BRAVO (the seed where it
originally worked). Contested dash: 8t covered 29 HP lost, 13t covered 25, 20t
uncovered 53, 28t uncovered dead.

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
5. From the previous pass: a long uncovered run kills about a quarter of the
   time rather than "usually"; waves run 56-118s.

6. **Road readability is much better, not perfect (D55 known gaps).** About 1 in
   7 maps keeps one short side-by-side band; converging diagonal approaches can
   still look busy because a diagonal road renders as a two-tile staircase. No
   in-game debug overlay shows exposure or readability defects. Where a river
   meets the map edge beside a spawn mouth, a road can be forced along the
   boundary (seen on random seed M4XQ9A only).
7. **Exposed-player pressure rose slightly (D53).** With unoccupied towers no
   longer targets, every enemy not committed to a siege goes after an exposed
   player (far ones by road). Worth judging by hand whether tower-to-tower
   dashes still feel fair.
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

0. Push the D62-D64 commit to `origin/master` (GitHub Pages) if not yet pushed.
1. Play it by hand, with sound on. The unanswered questions are all about feel,
   and now also whether the hairpin tower sites feel worth taking, whether
   exploring the dark is interesting, and the fog-pass questions in risk 8.
2. Road follow-ups: a debug overlay for exposure sites and readability defects;
   if converging diagonals still read as busy in play, consider drawing diagonal
   road segments as diagonal strokes instead of staircases (render-only).
3. If elevation should read as an advantage, the honest lever is terrain, not
   stats: keep more high ground clear of ridge shoulders so it is not
   self-blinded.
4. If the map reads as cluttered in a big wave, cull richness bars during combat
   before removing anything else.
