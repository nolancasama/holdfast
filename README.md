# Holdfast

A 2D top-down tower-defense / survival **prototype**. It exists to answer one
question, not to look good:

> Explore procedural terrain → place towers → towers automatically harvest and
> defend → move your avatar between them → your presence makes a tower much
> stronger *and* makes it the thing everything wants to kill → stay and try to
> save a failing tower, or abandon it and run.

Towers are expendable. You are not.

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
| `B` | toggle build mode, then **click** to place |
| **click** | select a tower |
| `R` (hold) | repair the selected tower — far faster while you are standing in it |
| `1` / `2` | weapon / extraction upgrade |
| `Space` | weak melee swing |
| `Esc` | cancel build mode |
| `F1` | debug panel |

Debug keys: `M` +500 Materials · `N` next wave · `G` spawn a group at the cursor ·
`K` damage selected tower · `J` destroy it · `P` path overlay · `L` pause
spawning · `O` regenerate the map.

## Run objective

Survive 8 waves **and** hold a finished tower inside the objective zone, which
appears on the west or east edge. Dying ends the run; losing towers does not.

## How it works

| File | Job |
|---|---|
| `src/config.js` | every tunable number, nothing else |
| `src/rng.js` | seeded PRNG, value noise, fbm |
| `src/terrain.js` | multi-pass generation, the validation gate, line of sight |
| `src/flowfield.js` | shared Dijkstra distance fields and steering |
| `src/game.js` | the whole simulation |
| `src/render.js` | canvas drawing and the minimap |
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

**One flow field per target, shared.** Every enemy attacking a given tower reads
the same Dijkstra field, which is why they funnel through the passes. Press `P`
to see it.

**Aggro rolls, it does not snap.** An enemy already besieging a tower keeps that
target until the tower dies. Everyone else re-evaluates on a staggered personal
timer and only switches past a margin. Abandoning a tower buys real time.

Seeds are visible in the HUD and can be typed back in on the start screen, so
any interesting map can be revisited exactly.

## Tuning

Everything balance-related lives in `src/config.js`. The debug panel (`F1`)
reports how the current map was generated: attempts taken, open/forest/water
fractions, and the routes and narrowest pass through each barrier.

`DESIGN_DECISIONS.md` records what was decided and why, including the deltas
from the original brief. `CURRENT_STATE.md` is the handoff: what is true now,
what the playtests showed, and what to do next.
