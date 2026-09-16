# Current State

Last updated: 2026-09-16 (third implementation pass)

## What this is

`holdfast` is a playable 2D top-down tower-defense/survival prototype. The
current loop is: read the generated terrain and road network, build towers
beside the lanes, shelter in a tower during combat, and survive eight waves.
Victory is surviving the final wave; only player death ends the run in defeat.

## Implemented state

- The authored-and-validated terrain generator remains intact on a 104x52 map.
  Its ridges, deliberate gaps, river, explicit fords, open-ground band and
  seeded regeneration still pass through the validation gate.
- Every map has a separate `road` bitfield. Cost-carved west/east routes meet at
  the centre, reuse existing road cheaply, pass through the authored gaps and
  fords, and gain one or two connected lateral branches where unused gaps are
  available. Roadbeds grade forest and marsh to plain but preserve shallow
  fords and never cross impassable terrain.
- Tower-target flow fields use `lane` cost, which discounts roads. The player
  pursuit field uses `direct` cost and ignores the road bitfield. Tower fields
  remain lazily cached, and the existing narrow-pass collision probe and stuck
  nudge remain active.
- The camera, minimap and edge markers are gone. Resize computes an integer tile
  scale that fits the complete map and centres it with letterboxing. Towers,
  player, enemies, health bars and labels have minimum screen sizes.
- Towers cannot be placed with any footprint tile on a road. The starting tower
  is kept beside the central junction and generation verifies its footprint is
  road-free.
- Shelter takes 0.7 seconds of continuous presence in a built tower. Occupancy
  bonuses and melee immunity begin only when that timer completes; leaving
  immediately resets shelter.
- An exposed player participates in the existing staggered aggro scoring with a
  strong, short-distance score. Nearby non-sieging enemies can switch to the
  player and use the direct field, while enemies already besieging a tower stay
  committed. Swarms are only slightly slower than the player, Runners are
  faster, and ordinary hits now kill in roughly two to four hits.
- Warning highlights the incoming half of the road network. Combat HUD and
  canvas feedback show EXPOSED state, shelter progress and current hunter count.
- `window.holdfast` retains `game`, `start()`, `errors`, `fastForward()` and all
  prior `api` methods. `api.dangerState(game)` additionally exposes
  `{ sheltered, shelterTowerId, shelterProgress, hunters }` for acceptance.
- Pause is available from the HUD and P. The normal simulation boundary freezes
  movement, combat, spawning and phase clocks, construction, extraction,
  repairs, drop/effect expiry and FX. Build, upgrade and collection functions
  refuse actions while paused. `fastForward()` explicitly bypasses pause, and
  `api.pauseState(game)` exposes the semantic state.
- Road carving now charges for elevation-band transitions, discounts ground one
  or two tiles from water and sends a seeded subset of approaches through an
  intermediate waypoint. Existing-road reuse still produces the merges. Across
  six measured seeds, 15 recovered spawn routes included sustained vertical
  reversals and consecutive four-tile riverbank runs above the checked 35% / 20%
  floors, and roads used 107 shallow-ford tiles. Maps accepted in 1-3 generation
  attempts.
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

`npm test` runs 34 headless checks. It covers 20 deterministic seeds, terrain
validation, road connectivity and legality, seed variation, lane/direct field
behavior, road placement refusal, ford use and generated route character,
delayed shelter occupancy, line of sight, richness thresholds, pause freezing
and action refusal, equipment uniqueness/cap, collapse, aggro commitment,
economy, escalation and a long simulation. Current result: 33 passed, 0 failed.

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

## Next steps

1. Play it by hand, with sound on. The unanswered questions are all about feel.
2. If elevation should read as an advantage, the honest lever is terrain, not
   stats: keep more high ground clear of ridge shoulders so it is not
   self-blinded.
3. If the map reads as cluttered in a big wave, cull richness bars during combat
   before removing anything else.
