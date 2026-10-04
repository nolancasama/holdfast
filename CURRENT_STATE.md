# Holdfast current state

Last updated: 2026-10-05 (expansion pacing D97 and manual walls D98,
implemented in the working tree, awaiting hand-play)

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
- **Keep (D77/D86):** 2,000 hp; wall anchor; min range 3.2.
- **Enemies (D78/D82/D85):** march on the Keep on per-type break-cost flow
  fields; Swarm detours, Heavy breaks walls. Fields rebuild on the next frame
  after a geometry change, one type per frame, coalesced while busy (D90/D95).
- **Waves (D97):** mandatory expansion lasts 120 s before wave 1 and 90 s
  thereafter, including the final 15 s `ASSAULT IMMINENT` warning. Direction
  is known from expansion start. A 4 s aftermath follows a cleared wave;
  `START NEXT WAVE` shortens expansion/warning to at most 4 s, with no reward
  for either waiting or starting early.
- **Manual walls (D98):** `Build Wall` selects two finished Tower/Keep anchors,
  previews tiles, segments, Stone cost, connectivity and refusal reasons, then
  confirms construction. Tower placement never creates or charges for walls.
  Walls retain grow-from-anchor construction, rubble/repair rules and
  coalesced path-field invalidation.
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

- D97/D98 `npm test`: **220 passed, 0 failed**.
- `npm run road-report`: 40 seeds, 0 hard road defects, 0 readability
  defects, generation median 783 ms.
- Nest probe: a lone tower dies to ferals in its blind spot (27-42 s); two
  supporting towers destroy the nest in 68 s at full health (4 seeds).
- `npm run economy-sim`: passed; each finished Tower is followed by an
  explicit 4-segment Keep link (Tower starts at 0.0 s and 3.6 s), Farm and
  Quarry start at 7.2 s, first Gold Mine at 123.9 s (8/8 seeds).
- `npm run wave-report`: passed; outposts fall waves 1-4, fortress falls waves
  8-10, and fortress+ falls waves 8-10. BRAVO has no valid fortress layout;
  the other five seeds run both explicit fan/ring profiles.
- D97/D98 browser hand-play: pending.

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

## Next steps

1. Hand-play the opening: use the full 120 s expansion and try an early start.
2. Hand-play an intermission: repair and extend walls inside the 90 s total.
3. Hand-play the exploration gamble: range far from the Keep and judge the
   return decision once direction and countdown are known.
4. Hand-play a late-nest push during expansion and verify the assault does not
   pause, clear ferals or teleport the player home.
5. Run an idle test to judge whether mandatory waiting feels empty, and a
   deliberately late return to judge whether the warning feels rushed.
