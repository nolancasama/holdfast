# Holdfast

A first-person fortress-defense **prototype** built with Three.js. It exists to
answer one question, not to look good: does physically inhabiting, building,
expanding and defending a fortress make the game more fun?

> Start at the Keep. Walk into the wilderness. Claim Stone, Gold and farmland.
> Raise Towers and join them with Walls. Get home before the assault arrives.

Walk a 208x104-tile (416 x 208 m) procedural world, build farms, quarries and
mines, place Towers and deliberately join them with Walls (never to the Keep).
Stone builds, Gold upgrades weapons, Food feeds the soldiers you garrison.
Towers cannot shoot at their own base, so they must cover each other.
Wilderness Nests guard the best sites and must be besieged with Towers. Ten
assaults march on the Keep; climb a Tower to watch them hit what you built.

The previous top-down version is still playable at `classic.html`.

## Run it

ES modules will not load from `file://`, so serve the folder:

```
npm start                 # http://localhost:8000  (no dependencies)
# or
python -m http.server 8000
npx serve .
```

Then open `http://localhost:8000`. Opening `index.html` directly shows
instructions instead of failing silently.

```
npm test                  # headless terrain, pathing, LOS and simulation checks
```

## Controls

| | |
|---|---|
| `WASD` · mouse | move · look (click the view to capture the mouse) |
| `Shift` | sprint (roads are faster still) |
| `E` | climb onto / down from the Tower or Keep you face |
| `1`–`5` | build Tower · Wall · Farm · Quarry · Gold Mine (again or `Q` to cancel) |
| **click** | place the ghost / pick Wall Towers A then B · otherwise a weak swing |
| **right-click** | step back (Wall corner, then build mode) |
| `R` (hold) | repair what you look at, in reach — costs Stone |
| `G` / `Shift+G` | assign / withdraw a soldier on the Tower you face |
| `U` | weapon upgrade (beside the Tower; Stone + Gold) |
| `T` | start the next assault early |
| `Esc` / `P` | release the mouse and pause (menu, sound, debug) |

Debug: `F2` fly/no-clip · `F3` coordinates · `F4` teleport to Keep · `M`
resources · `N` next assault · `Y` spawn at crosshair · `K`/`J` damage/destroy
the Tower you face · `H` path field · `L` pause spawning · `O` regenerate. The
pause card also toggles Tower ranges, Nest territory and Wall nav blockers.

Extra reports: `npm run economy-sim` (opening economy), `npm run wave-report`
(ten-wave pressure against scripted fortresses), `npm run road-report` (road
quality on 40 seeds), `npm run nest-probe` (one vs two towers against a nest).

## Run objective

Survive 10 waves. The run is lost if the Keep falls or you die.

## How it works

| File | Job |
|---|---|
| `src/config.js` | every tunable number, nothing else (`WORLD3D` holds the 3D scale) |
| `src/rng.js` | seeded PRNG, value noise, fbm |
| `src/terrain.js` | multi-pass generation, the validation gate, line of sight |
| `src/flowfield.js` | shared Dijkstra distance fields and steering |
| `src/game.js` | the whole simulation, on the tile grid |
| `src/fp/space.js` | tile <-> world mapping, height field, raycasts, picking (pure, tested) |
| `src/fp/terrain3d.js` · `models.js` | static world meshes · primitive models |
| `src/fp/entities3d.js` · `overlays.js` | sim -> mesh sync and effects · build/debug overlays |
| `src/fp/hud.js` · `main.js` | DOM HUD and minimap · first-person bootstrap, input, frame loop |
| `src/render.js` · `ui.js` · `main.js` | the 2D classic (`classic.html`) |
| `vendor/three.*.js` | Three.js r186 (MIT), loaded through an import map |

Five things are worth knowing before you change anything:

**The 3D world is a view of the 2D simulation.** One tile is 2 m; tile (x, y)
is world (x*2, height, y*2) with north at -Z. Gameplay state lives only in
`src/game.js`; `src/fp/` reads it and writes `g.input`. Presentation rules the
first-person shell needs are opt-in through `g.rules`.

**Terrain is authored, then validated.** Generation runs in deliberate passes —
elevation, a carved river with explicit fords, cliff ridges with deliberate
gaps, forest, marsh, resource deposits — and the result is *thrown away and
regenerated* unless it has two usable routes through every barrier, at least two
tight passes, both edges connected to the centre, and an open-ground fraction
inside a band. See `VALID` in `config.js`. Pure noise does not reliably produce
chokepoints; generate-and-check does.

**Elevation matters through sight, not through stats.** Cliffs block line of
sight always. Forest blocks it unless the firing tower stands at least one
elevation band above the trees. There is no "+20% hill damage" anywhere.

**One flow field per enemy type, shared, aimed at the Keep.** Walls and tower
footprints are not impassable in it: each costs the distance the enemy could
walk in the time it takes to break it. Swarms walk a long way round a wall;
Heavies smash through after a short detour. Fields recompute only when walls or
towers change. Press `H` to see one.

Seeds are visible in the HUD and can be typed back in on the start screen, so
any interesting map can be revisited exactly.

## Tuning

Everything balance-related lives in `src/config.js`. The debug panel (`F1`)
reports how the current map was generated: attempts taken, open/forest/water
fractions, and the routes and narrowest pass through each barrier.

`DESIGN_DECISIONS.md` records what was decided and why, including the deltas
from the original brief. `CURRENT_STATE.md` is the handoff: what is true now,
what the playtests showed, and what to do next.
