# Holdfast current state

Last updated: 2026-10-05 (first-person Three.js conversion D101-D107;
committed, awaiting human hand-play)

## What this is

A fortress-defense prototype, now played in **first person** (`index.html`).
Walk out from the Keep, claim Stone/Gold/farmland, raise Towers, join them
with Walls, feed a garrison, besiege wilderness Nests, and get home before
each assault. Survive ten assaults. Defeat: the Keep falls or the player dies.
The previous top-down build is still playable at `classic.html` (D107).

## Architecture

- `src/game.js` is still the whole simulation on the 208x104 tile grid
  (flow fields, break-cost walls, nests, garrison, assault timing). The 3D
  shell selects presentation rules via `g.rules`
  (`buildReach`, `solidTowers`, `exploreRadius`); the classic keeps defaults.
- `src/fp/` is the first-person layer (D101): `space.js` (pure maths, tested),
  `terrain3d.js`, `models.js`, `entities3d.js`, `overlays.js`, `hud.js`,
  `main.js`. Three.js r186 is vendored in `vendor/` (import map, no build).
- Scale (D102): 1 tile = 2 m; walk ~8 m/s, Shift sprint ~12.7 m/s, roads
  x1.25 on top.

## Implemented (first person)

- Terrain with elevation bands, cliffs, water, marsh reeds, instanced forest,
  road ribbons, stone/gold deposits; distance fog; sun shadows near the player.
- Keep, Towers (turret tracks targets, outpost/connected pennant, visible
  garrison soldiers), Walls with posterns, Farm, Quarry, Gold Mine, Nests,
  Swarm/Runner/Heavy/Feral placeholders; construction growth; damage tint;
  shots with bolts; debris, dust and shake on breaches and collapses; dust
  plumes at the incoming road mouths during warning/assault.
- Controls: WASD, mouse (pointer lock), Shift sprint, E climb onto/down from
  a Tower (D103), 1-5 build, click place/pick, right-click/Q back out, R repair
  (crosshair target), G/Shift+G garrison, U upgrade, T start assault early,
  Esc/P pause (D105).
- Build UX (D104): snapped crosshair ghost within 12 m, valid/invalid colour
  and reasons, draped blind-zone disc + firing annulus, Tower-only wall
  preview with Stone cost, Keep refused with the D99 message.
- HUD: resources, compass with Keep and assault-direction markers, assault
  plaque (NEXT ASSAULT -> ENEMY MOVEMENT DETECTED (<=45 s) -> ASSAULT
  IMMINENT -> ASSAULT -> REPELLED), crosshair prompt and inspect panel,
  structure-under-attack/breach alerts with compass bearing, minimap
  (explored terrain, structures, live visible hostiles, approach arrows).
- Debug (pause card or keys): F2 fly/no-clip, F3 coordinates/fps, F4 teleport
  to Keep, tower ranges, nest territory, wall nav blockers, H path field,
  M resources, N next assault, Y spawn at crosshair, K/J damage/destroy the
  looked-at Tower, L pause spawning, O regenerate.

## Verification

- `npm test`: **241 passed, 0 failed** on a clean run; 240/1 when the flaky
  check below fails (adds 22 D101 checks in
  `test/fp-tests.js`: coordinates, heights, raycast, picking, wall anchors,
  build reach, solid Towers, perch, gait, repair focus, posterns,
  exploration). The pre-existing "full run simulates several waves" check
  uses `Math.random` and fails intermittently, both before and after this
  change.
- Scripted browser passes (Playwright, SwiftShader, 1280x720; scripts are in
  the session scratchpad, not the repo): renders with no page errors; walking
  and sprinting move the player; crosshair Tower placement; Tower A -> Tower B
  wall preview and build; the Keep is refused as an endpoint; climbing a Tower;
  Nest agitation and feral defenders; Farm and Quarry placement; a 4-Tower
  ring around the Keep breached by Heavies, with debris, a toast and Swarm
  pouring through the gap; warning dust; 2D classic still boots and moves.
  Software rendering ran at 20-40 fps (~180-270k triangles); a real GPU
  should be well above that.
- Not verified: real pointer-lock mouse feel (headless cannot lock), audio
  by ear, frame rate on target hardware. **No human hand-play yet.**

## Known risks / open questions

1. The core question is unanswered until a human plays: does first person
   beat the classic, or is it "the same game, harder to control"?
2. Movement feel (8 / 12.7 m/s, FOV 75, mouse sensitivity 0.0022) is
   untuned. The map may now feel small rather than large (Keep -> edge ~13 s
   on a road sprint).
3. Walls (3.2 m) block the ground view; watching assaults relies on climbing
   Towers (D103). Judge whether that is satisfying or a chore.
4. Forest density (half the forest tiles carry a tree) is a readability
   compromise; sim forest LOS still blocks Tower fire through visually
   sparse woods.
5. Enemies are small at range (Swarm ~1.4 m). There are no floating health
   bars or labels; check whether assaults are readable from the Keep top.
6. Audio is the old synth cues panned by facing; no true 3D positional audio.
7. No chunking/LOD; the whole terrain is one mesh (~86k triangles).
8. `generate-artifact.js` still inlines only HTML/CSS; the 3D page needs the
   `src/` and `vendor/` files served, so the artifact build is not a working
   standalone page.

## Next steps

1. Hand-play the brief's seven experiences (§73): leaving home, resource
   discovery, Nest discovery, outpost Tower with the range overlay, a manual
   wall, standing inside a perimeter during an assault, and a late run home
   in the 15 s warning.
2. A/B the same seed in `classic.html` and decide whether first person is
   better.
3. Tune gait, FOV, sensitivity, tree density and wall height from that play.
4. If assaults are hard to read, consider enemy silhouettes/markers on the
   compass before adding anything in-world.
