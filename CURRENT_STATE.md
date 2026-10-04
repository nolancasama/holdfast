# Holdfast current state

Last updated: 2026-10-04 (fortress rework D77-D88, committed and pushed,
awaiting hand-play)

## Codex / Delegated Work — none in flight

Phase 1 (Keep, Keep-seeking enemies, 208x104 map, camera/minimap,
Food/Stone/Gold economy) was implemented by Codex and stopped on a usage limit
at the very end; the controller reviewed and accepted it in the browser.
Phase 2 (walls, break-cost pathing, retune) and the phase-1 correction
(restored tests, field-cost bug, road mouth fix) were done by Claude directly
at the user's instruction.

## What this is

A 2D top-down fortress-defense prototype. Build a fortress around the Keep,
expand for Food/Stone/Gold, connect towers with walls, survive ten waves that
march on the Keep. Defeat: the Keep falls (`lost/'keep'`) or the player dies
(`lost/'died'`, priority). Victory: survive wave 10.

## Implemented state

- **World (D79):** 208x104, validated generator (5-6 barriers, four spawn
  mouths per side, eight main road routes, fords, exposure features).
  Follow camera at 18 px/tile, zoom 10-28 (wheel, `-`/`=`), view-culled
  chunked terrain cache. Explored-only minimap with roads, walls, towers,
  Keep, buildings, discovered sites, player/facing, camera rect and announced
  incoming-side arrows; edge arrow to an off-screen Keep.
- **Keep (D77/D86):** the start tower; 2,000 hp, radius 1.25, fires/upgrades
  like a tower, occupiable, `KEEP` label and bastion drawing.
- **Enemies (D78/D82/D85):** all march on the Keep on per-type cached fields.
  Wall segments and non-Keep tower footprints are blockers costing
  `1.5 x maxHp / structDps x speed` (the blocker tile carries it). Swarm
  detours up to ~300 tiles before breaking a full segment, Heavy ~15.
  Sustained structure DPS 5 / 4 / 45 (x1 + 0.06 per wave). Opportunistic
  economy (2 tiles) and player (3 / 6 / 1.5 tiles, 4 s leash) diversions need
  a line no wall crosses. Fields recompute only on geometry change.
- **Economy (D80):** `g.res = {food, stone, gold}`; Farm (fertile 3x3),
  Quarry (stone site), Gold Mine (gold site; none within ~28 tiles); automatic
  production, no depletion; buildings are non-blocking and destructible.
  Start 150 Food / 280 Stone / 0 Gold. Steward archetype (old Prospector key).
- **Walls (D81/D84):** select a finished tower (or stand in it), `X`, click
  another finished tower within 13 tiles (or Enter). 4-connected tile line,
  cliffs/deep water skipped free, 6 Stone/segment, 260 hp segments, build
  `3 + 0.8 x segments` s from 30% hp, blocking at once. Posterns at both ends
  pass the player only. Destroyed segments become rubble; hold R beside it to
  rebuild (6 Stone). Walls never block LOS.
- **Repair/upgrades (D83/D84):** local only; repair target is the occupied
  tower, else the selected structure in reach, else the nearest damaged one in
  reach (cyan brackets). Upgrades need tower presence; W1-W3 cost Stone+Gold.
- **Waves (D86):** ten; budget `40 + 36(w-1) + 2(w-1)^2`, Heavy bias 0.40,
  hp +15%/wave, speeds 3.8 / 5.8 / 1.7 unchanged.

## Verification

- `npm test`: **205 passed, 0 failed** (phase-1 checks, 98 restored
  preserved-system checks in `test/preserved-tests.js`, 22 wall/pathing
  checks in `test/fortress-tests.js`). Wall-test mutations (wrong-tile break
  cost, no corner rule, economy aggro through walls, field recompute on hp,
  destroyed segment still blocking, remote repair, weak Heavy) each turned a
  test red; "posterns open to enemies" is an equivalent mutation (the field
  already makes a gate a break target).
- Generation: median ~2.1 s, p90 ~3.4 s, max ~7 s per map (Node).
- Field recompute (all three types) ~43 ms median / 87 ms max per geometry
  change; dense walled wave 9 (47 enemies) ~0.09 ms per simulation frame.
- `npm run economy-sim`: opening (2 towers, farm, quarry) at 0 s, both opening
  walls (4-9 segments) at ~9 s when towers finish, first Gold Mine ~3.4 min.
- `npm run wave-report`: open network falls on wave 5-6; Keep-enclosing
  3-tower fortress first breaches on waves 3-6 and falls on 9-10 (1/6 won);
  with 3 outer towers reaches wave 10 on 4/6 (1/6 won). Passive bot.
- Browser (1600x900, no page/console errors): walls built through the real UI
  (X + click), preview and refusal reasons, gates, Swarms battering a ring,
  towers firing over walls, a Heavy committing to and breaking a gate segment,
  rubble rebuild prompt. In the brief's KEEP-B-C triangle the army walks round
  to the Keep's exposed side (D87).

## Known risks / open questions

1. **Feel is unverified by a human.** Whether walls create anticipation,
   whether breaches read as drama, whether the economy is chores, and whether
   waves 9-10 are fair all need hand-play. The scripted bot is passive.
2. **The Keep must be enclosed for walls to defend it (D87).** That needs
   ~3 towers and ~30 segments, unaffordable in the opening by design.
3. **Field recompute hitch** of ~40-90 ms on each wall start/breach/rebuild.
4. **Road gaps (D88):** HOTEL central loop, TANGO edge road, 0-5 readability
   defects per map.
5. Occupied Keep repair is fast (x4, ~44 hp/s) but Stone-bound; a Stone-rich
   player may make the Keep very hard to kill.
6. Long waves: ~100-150 s of combat each on the larger map; a full run is
   roughly 20 minutes.

## Next steps

1. Hand-play several runs (sound on): opening walls, expanding to stone/gold,
   enclosing the Keep, the first Heavy breach, waves 8-10.
2. If walls feel weak or tedious, adjust segment hp / cost / max length before
   adding mechanics; if waves 9-10 are unfair, lower `budgetAccel` to 1.
3. Consider spreading the three field recomputes over frames if the hitch is
   felt.
