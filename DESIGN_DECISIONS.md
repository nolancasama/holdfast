# Design Decisions

Durable record of what was decided and why. Append; don't rewrite history.

---

## 2026-09-16 — Prototype scope and plan adjudication

The source plan (2D top-down tower-defense/survival prototype) is accepted
almost in full. The purpose is to test one loop: explore terrain → place towers
→ towers auto-harvest and auto-defend → move the avatar between towers →
presence makes a tower much stronger but pulls aggro → stay and save it, or
abandon it and run. Visual polish is explicitly not a goal.

Decisions below are deltas from that plan.

### Accepted as written
Materials as the only currency. One tower type. Three archetypes (Engineer,
Prospector, Gunner). Three enemy types (Swarm, Runner, Heavy). Free placement
with minimum spacing. Explicit wave/prep cycle with build+repair allowed during
combat. Expansion objective forcing a tower near one edge. Debug panel. The
full "do NOT build yet" exclusion list.

### D1 — Terrain is authored-by-algorithm, not noise-filtered
**Decision:** generate terrain in deliberate passes (base elevation noise →
carve one river with 2–4 explicit fords → stamp 2–4 cliff ridges each with a
deliberate gap → scatter forest by moisture → marsh in low wet ground →
resource deposits as discrete visible nodes), then *validate* the result.
**Why:** pure noise thresholded into biomes reliably produces mush, not
chokepoints. The plan asks for chokepoints as a regular occurrence, which is a
guarantee, and guarantees need generate-and-check.
**Rejected:** tuning a noise field until chokepoints "usually" emerge.

### D2 — Map validation gate with regeneration
**Decision:** a generated map is rejected and regenerated (bounded retries,
then relaxed constraints) unless: west edge and east edge both reach map centre
by land; at least 2 topologically distinct routes exist from each side; the
narrowest route gap is >= 3 tiles (no single-tile funnel that trivializes the
game); and walkable-open-ground fraction sits inside a band so the map is
neither a maze nor a featureless field.
**Why:** the plan names both failure modes (one tiny gap trivializes it /
featureless field) as things to avoid. Stating them as testable predicates is
the only way to actually avoid them.

### D3 — Elevation matters through line of sight, not stat bonuses
**Decision:** LOS is blocked by cliffs always, and by forest unless the firing
tower is at least one elevation band above the intervening forest tile. No
numeric "hill bonus" anywhere.
**Why:** the plan asks for physical/geometric effects over arbitrary
percentages. "A hill tower shoots over the treeline" is physical, is readable
on screen, and makes hills desirable without a hidden modifier.

### D4 — Flow-field pathing, not per-enemy A*
**Decision:** one Dijkstra distance field per *target*, shared by every enemy
targeting it, recomputed on target change or terrain change. Terrain cost:
open 1, marsh/shallow ~2.5, forest ~1.4, cliff/deep water impassable.
**Why:** swarm counts make per-enemy A* both slow and harder to read. A shared
field is fewer lines, is trivially visualizable for the debug overlay, and
gives the "enemies funnel through the pass" behaviour for free.

### D5 — Aggro transitions are per-enemy commitment, staggered
**Decision:** an enemy actively sieging a tower keeps that target until the
tower dies. Non-sieging enemies re-evaluate on a staggered personal timer
(~2–4 s, randomly offset so the herd never turns as one) and only switch if the
new target scores meaningfully better, where score weights player presence
heavily but divides by travel distance.
**Why:** the plan's requirement is that abandoning a tower buys real breathing
room and that the map never performs an instant 180. Commitment + stagger +
switch margin produces a rolling, legible turn rather than a snap.

### D6 — Tower collapse is telegraphed, and lethal by fixed proportion
**Decision:** below 20% HP a tower enters a visible, audible-in-UI COLLAPSING
state. Collapse deals 85% of the player's *maximum* HP to anyone within the
tower footprint plus a small margin.
**Why:** the plan wants "lethal or near-lethal". A fixed proportion of max HP
is always near-lethal and is actually lethal to an already-hurt player, which
is the correct shape. The telegraph matters more: the intended drama is a
decision, and a decision the player could not see coming is a gotcha instead.
**Rejected:** random collapse damage, and instant unsignalled collapse.

### D7 — Spawn side is telegraphed during the warning countdown
**Decision:** the warning phase names which edge(s) the wave comes from.
**Why:** the loop under test is a positioning decision. Without knowing the
approach side, choosing where to stand is a coin flip, and a coin flip cannot
be evaluated for fun.

### D8 — Seeded, reproducible generation, seed visible and re-enterable
**Decision:** one seeded PRNG drives all generation; the seed is shown in the
UI and can be typed back in to regenerate the identical map.
**Why:** the plan's final step is "play several generated maps and report".
That report is worthless if an interesting map cannot be revisited, and tuning
cannot be compared across runs on different terrain.

### D9 — Resource density is shown as discrete deposits
**Decision:** resource richness renders as visible deposit nodes with visible
extraction radii, not as an invisible continuous field.
**Why:** the plan requires the player to understand *why* one site is
economically better. A continuous field is not readable at a glance; nodes
inside or outside a ring are.

### D10 — Cut from the first pass
**Decision:** drop types limited to Repair Kit, Damage boost, Extraction boost,
Movement Speed boost. Emergency Armor and "rare tower module" are deferred.
The player keeps a weak, slow, short-range melee strike — enough to not be
completely helpless when caught alone, far too weak to farm a wave.
**Why:** each extra drop type is a tuning surface that does not test the core
question. The melee stays because "the player is not a hero" is a statement
about power level, not about having zero agency.

### D11 — ES modules over a static server
**Decision:** plain ES modules, no build step, no dependencies; served by any
static file server (`python -m http.server 8000`). index.html detects `file://`
and prints instructions instead of failing silently.
**Why:** "simple, readable, easy to modify" outranks double-click launch, and a
silent CORS failure is the worst possible first-run experience.

---

## 2026-09-16 — Decisions forced by the first playtest pass

These were not in the original plan. Each replaced something that measurably
did not work when the prototype was actually run.

### D12 — Waves arrive in clusters, not as an even trickle
**Decision:** each wave's units are grouped into 2–5 clusters that come through
together from one mouth, rather than being spread evenly across the spawn
window.
**Why:** measured. With an even drip, a single Occupied tower killed 45 enemies
across three waves without taking one point of damage, because units arrived in
range one at a time and died individually. The siege mechanic never fired. A
cluster is actual pressure, and it is far easier to read on screen.

### D13 — Tower cost escalates with the number you already own
**Decision:** a tower costs `100 + 45 × (towers you have)`.
**Why:** measured. With a flat cost, a scripted player reached 3,400 Materials
by wave 9 with nothing to spend them on, and blanketing the map with towers had
no downside. Escalation is both a materials sink and the cap on sprawl that the
brief wanted without making placement itself more restrictive.
**Rejected:** lowering income, which would have punished good site selection —
the exact judgement the prototype is meant to test.

### D14 — A survived collapse is recoverable
**Decision:** out-of-combat regeneration raised to 2.5 hp/s during prep, and the
Repair Kit drop heals the player 25 as well as patching the tower.
**Why:** measured. Collapse costs 85% of max HP by design (D6), but with the
original 0.8 hp/s regen a player who survived one collapse simply died to the
next wave with no way back. That turns the intended decision into a delayed
execution. It should be a scar, not a sentence.

### D15 — Enemies get an unstick, and collision probes are smaller than bodies
**Decision:** movement collision probes at most 0.3 tiles regardless of body
size, plus a nudge for any non-besieging enemy that fails to make progress for
1.5s.
**Why:** a Heavy is 0.62 tiles wide and wedged permanently in one-tile fords the
flow field considered open. One stuck enemy holds the wave open forever, because
combat only ends when the field is clear. Observed directly: a wave ran 250+
seconds with one enemy alive and no tower ever taking damage.

### D16 — Barrier routes are measured along the barrier, not on a straight cut
**Decision:** `analyseBarrier` walks each authored gap along the barrier's own
wandering line.
**Why:** the first validator cut a straight vertical column at the barrier's
mean x. Barriers wander ±7 tiles, so the cut frequently missed the barrier
entirely and reported one 46-tile "route". 11 of 20 maps were being rejected and
regenerated under relaxed rules for a defect that was in the ruler, not the map.

### D17 — Later waves lean on Heavies rather than simply more Swarms
**Decision:** Heavy spawn weight rises 30% per wave past its unlock.
**Why:** with fixed weights, scaling a wave only ever meant more small things,
which a mature tower network filters out. Heavies are what actually threaten a
tower, so escalation has to mean more of them.
