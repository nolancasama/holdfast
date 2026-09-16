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

---

## 2026-09-16 — Roads, whole-map view, and the hunted player

Second pass. The brief: make it read as a recognisable tower-defence survival
game, and make being outside a tower during combat genuinely frightening.
Accepted nearly in full. Deltas and the decisions it left open:

### D18 — Victory is survival; the objective zone is deleted outright
**Decision:** win by surviving the final wave. The objective zone, its aggro
weight, its guaranteed deposits, its UI and its validation predicate are all
removed rather than disabled.
**Why:** the brief asks for it, and a disabled-but-present system is a liability
in a prototype that is still being cut about.
**Known risk, deliberately accepted:** the objective existed specifically to
stop "sit in the centre forever" (original plan §15). Removing it re-opens that
question. The brief says to measure turtling and report the cause before adding
any new system, so that is what happens — no replacement mechanic in this pass.

### D19 — Fixed whole-map view, dynamic scale, floors on entity size
**Decision:** the camera is deleted. Tile scale is computed each resize to fit
the whole map in the stage. Map shrinks to 104x52. Entities get **minimum
on-screen sizes** independent of world scale (player and enemies never smaller
than a few px radius, towers never smaller than a readable disc). The minimap
and off-screen edge markers are removed as redundant.
**Why:** at the old 132x58 the whole map only fits at ~8px/tile, where the
avatar is a 3px dot — technically visible, practically unreadable. Shrinking the
map and decoupling entity size from world scale is what makes "see everything at
a glance" actually true. The shrink also cuts the edge-to-centre walk from 66 to
52 tiles, which helps the over-long waves noted in CURRENT_STATE.

### D20 — Roads are carved by pathfinding, and later roads merge onto earlier ones
**Decision:** route each spawn mouth to the centre with a cost-based search over
the real terrain, then carve the result. Tiles that are *already road* are made
very cheap, so each subsequent route prefers to join the existing network.
**Why:** this produces every property the brief asks for without any of them
being special-cased. Gaps and fords are the only passable ways through
barriers, so routes use them automatically. The cheap-road rule produces genuine
branching and merging, and the seeded search makes the layout vary per seed.
**Rejected:** splines from spawn to centre, which is the straight-line result the
brief explicitly forbids.

### D21 — Two pathfinding cost modes: lanes for towers, cross-country for hunting
**Decision:** flow fields toward a *tower* discount road tiles heavily. The flow
field toward the *player* does not discount roads at all.
**Why:** this is the whole "ordinary movement is road-biased, pursuit is direct"
behaviour falling out of one number rather than a second pathfinding system. A
wave marching on a tower flows down the lanes; the moment it switches to hunting
an exposed player it cuts straight across country. The change in movement
character is itself the tell that you have been noticed.

### D22 — Roads overlay terrain, they are not a tile kind
**Decision:** a separate `road` bitfield. A road through forest grades the tile
to open ground; a road through a ford stays shallow water.
**Why:** keeps the tile taxonomy and all line-of-sight rules untouched (D3), and
is physically right — you clear trees for a roadbed, you do not drain a river.

### D23 — Shelter takes time, and shelter is real
**Decision:** ~0.7s inside the tower footprint before it counts as Occupied. The
player is fully hittable throughout that window. Once sheltered, the player
cannot be hit by melee at all.
**Why:** the brief wants the enemy on your heels to still matter. It also makes
"towers are safe islands, open ground belongs to the enemy" (§7) a rule rather
than a hope — a stated binary the player can trust, which is what makes the
decision to leave one legible.

### D24 — Exposed-player aggro is loud but short-sighted
**Decision:** the player becomes a target with a very high weight and a *small*
distance scale, so the score falls away steeply with range. Sieging enemies stay
committed as before (D5).
**Why:** the brief wants local hunting without map-wide magical retargeting.
High weight plus short range gives exactly that from the existing scoring
function — no new aggro system, no leash, no radius check bolted on the side.

### D25 — Anti-kiting comes from Runner speed, not from a leash
**Decision:** Runners are faster than the player outright. Swarms are only
slightly slower. Enemy hits are raised so 2-4 of them kill.
**Why:** the brief forbids arbitrary outside-health drain and asks that kiting a
whole wave be impossible. A unit that is simply faster than you closes that
exploit honestly — the counter is reaching a tower, which is the intended
response — where a leash or an aura would be a rule the fiction has to apologise
for.

### D26 — Road tiles are invalid build sites
**Decision:** a tower footprint may not include a road tile; immediately beside
is fine.
**Why:** as briefed. Towers overlook the lanes rather than corking them, which
keeps the lanes legible and stops placement from degenerating into plugging
every chokepoint.

### D27 — The artifact page is generated, not maintained twice
**Decision:** `npm run artifact` strips the document wrapper from `index.html`
to produce `artifact/index.html`.
**Why:** this pass rewrites the page markup. Two hand-maintained copies of it
would silently drift, and the hosted page is the one people actually play.

### D28 — The central junction and starting tower are adjacent, not overlapping
**Decision:** roads converge on a central junction while the starting tower is
placed a few tiles beside it. Generation verifies that the complete starting
tower footprint is road-free and relocates it within the cleared centre if a
route approaches too closely.
**Why:** roads must reach the map centre, but D26 applies to the starting tower
as much as to player-built towers. Separating the junction from the tower keeps
both rules literal and makes the first placement teach the intended
"overlook the lane" relationship.

### D29 — Player pursuit is represented by an ordinary target ID
**Decision:** the player uses a sentinel target ID in the existing enemy target
slot. The same staggered retarget function scores exposed-player and tower
candidates; only field mode and score constants differ.
**Why:** this preserves D5 commitment and makes hunting observable through the
same state the rest of combat already uses. It also lets the acceptance surface
report shelter progress and hunter count without introducing a parallel aggro
system.

### D30 — Whole-map rendering keeps a prerendered terrain coordinate space
**Decision:** the canvas computes an integer fitted tile scale and centred
letterbox offsets on resize, then transforms the existing prerendered terrain
coordinate space at draw time. Entity radii, labels and bars apply inverse-scale
floors before that transform.
**Why:** terrain remains cheap to draw while the map is always fully visible,
and important entities retain minimum screen sizes without changing world-space
simulation sizes.

### D31 — Hunters intercept: they aim where the player is going
**Decision:** an enemy hunting an exposed player, within ~12 tiles and with a
clear walkable line, steers at the player's position projected forward by up to
1.15s of their actual measured velocity, instead of at where they currently are.
Blocked lines fall back to the pursuit flow field.
**Why:** measured. Circular kiting survived a full wave on 2 of 6 seeds (90
seconds, 10 laps, only 55 of 100 HP lost) because hunters chased a position
refreshed every 0.5s and so permanently trailed a curving target — towers picked
off the pursuers while the player looped safely out of reach. After the change
every one of six seeds died, the longest surviving 23.9s. A curve is trivial to
cut off once the pursuer aims ahead of it.
**Rejected:** raising Swarm speed to match the player, which the brief allows but
which would have made the honest straight-line escape to a tower impossible at
the same time as closing the kite; and any leash, tether or pursuit speed aura,
which D25 rules out.
**Known side effect, accepted:** pursuers now over-commit to a single intercept
point, so a long straight sprint is slightly cheaper than before (a 24-tile
uncovered crossing kills 3 runs in 12 rather than most of them) while short
covered dashes cost slightly more. The covered/uncovered distinction the brief
asked for survives intact; the absolute lethality of a long run is a tuning knob
left for the next pass.
