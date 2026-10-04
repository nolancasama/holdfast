# Holdfast

A 2D top-down fortress-defense **prototype**. It exists to answer one
question, not to look good: is building and defending territory fun?

> Start with a Keep. Claim useful land. Build a fortress. Protect what makes
> the fortress worth having. Hold until the walls fail.

Explore a 208x104 procedural map, raise farms, quarries and mines, and place
towers whose automatic links shape the walls. Stone builds, Gold upgrades
weapons, and Food feeds the soldiers you garrison in towers. Towers cannot
shoot at their own base, so they must cover each other. Wilderness nests guard
the best Gold and Stone and must be besieged with towers. Ten waves march on
the Keep; walls redirect them into tower fire until a Heavy smashes a breach.

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
| `WASD` / arrows | move |
| `B` | build menu (Tower, Farm, Quarry, Gold Mine); `Enter`/click builds where you stand |
| **click** | select a tower or building |
| `R` (hold) | repair what is in reach (or rebuild wall rubble) — costs Stone |
| `1` | weapon upgrade (at the tower; Stone + Gold) |
| `G` / `Shift+G` | assign / withdraw a soldier on the selected tower (needs Food support) |
| wheel / `-` `=` | zoom |
| `Space` | weak melee swing |
| `P` | pause |
| `Esc` | cancel build mode |
| `F1` | debug panel |

Debug keys: `M` resources · `N` next wave · `Y` spawn a group at the cursor ·
`K` damage selected tower · `J` destroy it · `H` path overlay · `V` fog debug ·
`L` pause spawning · `O` regenerate the map.

Extra reports: `npm run economy-sim` (opening economy), `npm run wave-report`
(ten-wave pressure against scripted fortresses), `npm run road-report`.

## Run objective

Survive 10 waves. The run is lost if the Keep falls or you die.

## How it works

| File | Job |
|---|---|
| `src/config.js` | every tunable number, nothing else |
| `src/rng.js` | seeded PRNG, value noise, fbm |
| `src/terrain.js` | multi-pass generation, the validation gate, line of sight |
| `src/flowfield.js` | shared Dijkstra distance fields and steering |
| `src/game.js` | the whole simulation |
| `src/render.js` | camera-culled canvas drawing and the minimap |
| `src/ui.js` | DOM HUD |
| `src/main.js` | bootstrap, input, frame loop, debug handle |

Four things are worth knowing before you change anything:

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
