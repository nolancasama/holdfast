# Holdfast current state

Last updated: 2026-10-05 (expansion pacing D97, Tower-only manual walls D99,
classic RTS interface D100; committed, awaiting human hand-play)

## What this is

A 2D top-down fortress-defense prototype. Build a fortress around the Keep,
expand for Stone/Gold, feed a garrison with Farms, besiege wilderness nests,
survive ten waves that march on the Keep. Defeat: Keep falls or player dies.

## Implemented state

- **World (D79):** 208x104, follow camera, explored-only minimap (towers
  coloured by connectivity, walls, buildings, sites, nests, incoming arrows).
- **Roads (D96, `src/roads.js`):** 2-4 simple roads: one main road per side
  to the hub north of the Keep, at most one branch per side joining as a T.
  Turn-penalised router, line-of-sight straightening, hard validation (no
  self-crossing, loops, knots, hairpins; spacing; turn budget). Enemies spawn
  only at road mouths (1-2 per side). `U` toggles the road debug overlay.
- **Keep (D77/D86/D99):** 2,000 hp; the protected goal, not a wall endpoint;
  min range 3.2.
- **Enemies (D78/D82/D85):** march on the Keep on per-type break-cost flow
  fields; Swarm detours, Heavy breaks walls. Fields rebuild on the next frame
  after a geometry change, one type per frame, coalesced while busy (D90/D95).
- **Waves (D97):** mandatory expansion lasts 120 s before wave 1 and 90 s
  thereafter, including the final 15 s `ASSAULT IMMINENT` warning. Direction
  is known from expansion start. A 4 s aftermath follows a cleared wave;
  `START NEXT WAVE` shortens expansion/warning to at most 4 s, with no reward
  for either waiting or starting early.
- **Manual walls (D98/D99):** `Build Wall` selects two finished Towers,
  previews tiles, segments, Stone cost, connectivity and refusal reasons, then
  confirms construction. The Keep is not an endpoint. Tower placement never
  creates or charges for walls. A Tower is `connected` when it belongs to a
  wall-linked network of at least two Towers; otherwise it is an `outpost`.
  Walls retain grow-from-anchor construction, rubble/repair rules and
  coalesced path-field invalidation.
- **Interface (D100):** RTS layout: top resource bar, phase plaque, bottom
  console (minimap canvas / selection panel / 5x3 command card with hotkeys
  Q tower, X wall, F farm, C quarry, E mine, B build, 1, G, Enter, Esc), menu
  drawer (F10) holding controls, sound, seed and debug (F1).
- **Blind spot (D93):** towers fire only between 2.8 and max range (Keep
  3.2); `towerMinRange` reads `t.closeDefense` for a future upgrade. Range
  display hatches the blind zone.
- **Economy (D80/D91):** Stone and Gold are spent; Food is not a resource but
  support: each Farm feeds `round(3 x fertility)` soldiers. Tower 60 + 25/
  tower, Farm 35 + 8/farm, Quarry 40, Gold Mine 120; start 340 Stone.
- **Garrison (D91):** Keep 4 slots, tower 1 (2 at W2+); `G`/`Shift+G` or the
  panel's +/-; +20% fire rate, +15% damage per soldier. Deficit: 30 s grace,
  then one soldier stands down every 8 s (outposts first, Keep last).
- **Nests (D92):** 5-8 per map by rich Gold/Stone, never by the guaranteed
  middle Gold, >= 30 tiles from the Keep. Dormant -> agitated (player or a
  structure within 9 tiles) -> ferals (max 6, leashed) attack structures and
  the player; UNDER SIEGE when a tower can hit it (annulus, LOS, visible);
  1,400 hp; +40 Stone +15 Gold on destruction; never respawn.

## Verification

- D99 `npm test`: **221 passed, 0 failed**.
- `npm run road-report`: 40 seeds, 0 hard road defects, 0 readability
  defects, generation median 783 ms.
- Nest probe: a lone tower dies to ferals in its blind spot (27-42 s); two
  supporting towers destroy the nest in 68 s at full health (4 seeds).
- `npm run economy-sim`: passed; Tower 1 starts at 0.0 s, Tower 2 at 3.6 s,
  then a 9-segment Tower-to-Tower wall costs 54 Stone; Farm and Quarry start
  at 7.2 s and the first Gold Mine at 137.2 s (8/8 seeds).
- `npm run wave-report`: passed; outposts fall waves 1-4, fortress falls waves
  3-10, and fortress+ wins 1/5 valid layouts and otherwise falls waves 9-10.
  BRAVO has no valid fortress layout; all built walls are Tower-only arcs/rings.
- D99/D100 scripted browser pass (Playwright, real clicks/keys, 1280x720 and
  1600x900): two Towers create no wall; clicking the Keep in wall mode is
  refused with "Walls must connect two Towers."; Tower A -> Tower B previews
  5 segments / 30 Stone; Enter charges 30 Stone and the wall completes; no
  page errors. Human hand-play: pending.

## Known risks / open questions

1. **Feel is unverified by a human:** in particular, whether expansion creates
   idle time and whether the 15 s warning or 4 s early-start readiness feels
   rushed.
2. A Keep with no supporting tower is nearly defenceless at its base (D93);
   intended, but may feel harsh in the first minute.
3. Farms placed on blob edges feed only 1-2 soldiers; whether players notice
   fertility quality is untested.
4. Fewer spawn mouths (1-2 per side) concentrate waves on the roads; the
   wave report shows unchanged pressure, but hand-play should confirm.
5. The effect of manual wall spending on opening tempo and late-wave repair
   pressure needs hand-play confirmation.
6. D99 weakened the scripted 3-Tower arc: wave-report `fortress` now falls on
   waves 3-10 (was 8-10 with Keep spokes). A perimeter needs more Towers, so
   tower cost and wall length may need retuning after hand-play.
7. The D100 map viewport is shorter (about 480 px at 720p) because the console
   is opaque; judge whether the default zoom shows enough ground.

## Next steps

1. Hand-play the opening: use the full 120 s expansion and try an early start.
2. Hand-play an intermission: repair and extend walls inside the 90 s total.
3. Hand-play the exploration gamble: range far from the Keep and judge the
   return decision once direction and countdown are known.
4. Hand-play a late-nest push during expansion and verify the assault does not
   pause, clear ferals or teleport the player home.
5. Run an idle test to judge whether mandatory waiting feels empty, and a
   deliberately late return to judge whether the warning feels rushed.
