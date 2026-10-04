# Holdfast current state

Last updated: 2026-10-04 (fortress phase 3, D89-D95, committed and pushed,
awaiting hand-play; road simplification is the next task)

## Codex / Delegated Work — none in flight

Phase 3 slice A (automatic walls, coalesced fields, blind spots) was written
by Codex, which hit its usage limit during validation; Claude reviewed it,
fixed the D90 recompute timing and implemented slice B (garrison, nests) and
the D94 evaluation directly. Nothing delegated is pending.

## What this is

A 2D top-down fortress-defense prototype. Build a fortress around the Keep,
expand for Stone/Gold, feed a garrison with Farms, besiege wilderness nests,
survive ten waves that march on the Keep. Defeat: Keep falls or player dies.

## Implemented state

- **World (D79):** 208x104, follow camera, explored-only minimap (towers
  coloured by connectivity, walls, buildings, sites, nests, incoming arrows).
- **Keep (D77/D86):** 2,000 hp; wall anchor; min range 3.2.
- **Enemies (D78/D82/D85):** march on the Keep on per-type break-cost flow
  fields; Swarm detours, Heavy breaks walls. Fields rebuild on the next frame
  after a geometry change, one type per frame, coalesced while busy (D90/D95).
- **Automatic walls (D89):** placing a tower plans up to two links (max 13
  tiles, no crossings, angle >= 50, degree caps 3/6), preferring the Keep's
  component, then bridging outposts or closing loops. Preview shows planned
  links, Tower/Walls/Total Stone and CONNECTED/OUTPOST/BRIDGES OUTPOST.
  Segments grow from the anchor during construction. No manual wall mode.
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

- `npm test`: **225 passed, 0 failed**.
- Nest probe: a lone tower dies to ferals in its blind spot (27-42 s); two
  supporting towers destroy the nest in 68 s at full health (4 seeds).
- `npm run economy-sim`: opening (2 connected towers with walls, Farm,
  Quarry) at 0 s; first Gold Mine ~115 s.
- `npm run wave-report`: lone Keep falls waves 1-2; fortress falls 8-10;
  fortress+ won 2/5 (see D95). Bots are passive.
- Browser (1600x900, no errors): tower preview with links/costs/blind zone,
  wall growth, Keep-A-B triangle, garrison pips and HUD, agitated nest with
  territory ring, minimap.

## Known risks / open questions

1. **Feel is unverified by a human** (the brief's 20 hand-play questions).
2. A Keep with no supporting tower is nearly defenceless at its base (D93);
   intended, but may feel harsh in the first minute.
3. Farms placed on blob edges feed only 1-2 soldiers; whether players notice
   fertility quality is untested.
4. Road generator still has knots/hairpins (D88) — next task.
5. Long waves on the large map (~100-150 s each).

## Next steps

1. Road simplification (user brief, 2026-10-04): remove exposure/hairpin
   generation, fewer straighter tree-like roads, hard validation.
2. Hand-play several runs; tune nest hp/feral pressure and Farm support.
3. Raise wave pressure only if hand-play finds the fortress too strong.
