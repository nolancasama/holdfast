# Current State

Last updated: 2026-09-16

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
- `npm run artifact` regenerates `artifact/index.html` from the real page without
  its document wrapper.

## Automated verification

`npm test` runs 27 headless checks. It covers 20 deterministic seeds, terrain
validation, road connectivity and legality, seed variation, lane/direct field
behavior, road placement refusal, delayed shelter occupancy, line of sight,
collapse, aggro commitment, economy, escalation and a long simulation. Current
result: 27 passed, 0 failed.

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

## Acceptance status and known risks


Controller acceptance has now been run; results above.

**Circular kiting was a real exploit and is now closed.** Before the fix a
player looping at radius 11 survived a full wave on 2 of 6 seeds (90s, 10 laps,
55 of 100 HP lost) while towers shot the pursuers. Hunters now intercept (D31);
all six seeds now die, the longest lasting 23.9s.

Turtling was measured rather than pre-empted, and does not dominate (bot died
wave 7). Material accumulation is also much reduced - repair spend now absorbs
income, and one seed finished waves at zero Materials.

Remaining concerns, in priority order:

1. **A long uncovered run is dangerous but not "usually fatal"** - 3 deaths in
   12, arriving at ~55% HP. The brief's wording implies harsher. Note the probe
   seeds a fixed 9-enemy group in the corridor, which likely understates a real
   wave, so measure again before tuning.
2. **Interception has a side effect**: pursuers over-commit to one intercept
   point, making a long straight sprint slightly cheaper and a short covered
   dash slightly costlier than before the fix.
3. **Waves still run 56-118s**, so a full 8-wave run is 10-12 minutes.
4. The map's 2:1 aspect leaves large letterbox bands at typical window shapes.

## Next steps

1. Play it by hand. The automated probes cannot answer whether a *human* finds
   the collapse decision tense rather than arbitrary.
2. If long runs should be deadlier, raise Swarm `playerHit` or widen
   `pursuitLeadRange` rather than adding any new mechanic.
3. If waves drag, cut `WAVE.totalToSurvive` to 6.
