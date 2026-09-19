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

---

## 2026-09-16 — Pause, road character, legibility, drops, and sound

Third pass. Accepted, with the scope corrected and three things declined.

### D32 — Most of this brief is already built; this pass verifies rather than rebuilds
**Decision:** sections 1, 2, 4, 9, 10, 13, 14, 15, 16, 17, 18, 22, 23 and 24 of
the brief describe work that landed in the roads pass (D18-D31). They are
treated as acceptance criteria to re-verify, not as work to redo. The genuinely
new scope is: pause, road shape variety, elevation legibility, resource
richness display, the three drop categories, and the sound layer.
**Why:** the brief was written without the previous pass in hand. Handing a
worker "implement sections 1-33" would have rewritten a validated terrain
generator, a working aggro model and a measured danger curve to arrive back
where we already are, with all the regression risk that implies.

### D33 — Road character comes from physics in the cost function, not shape templates
**Decision:** get hairpins, switchbacks and river roads by changing what the
carving search finds expensive, not by stamping shapes. Crossing an elevation
band boundary costs a lot, so a road climbing a ridge zigzags across the slope —
which is how real switchbacks form. Ground near water is easy going, so roads
sometimes hug a river to its crossing. Seeded intermediate waypoints make routes
approach the centre obliquely, which is what produces S-bends and doubling back.
Forks and merges already fall out of the cheap-existing-road rule (D20).
**Why:** the brief explicitly warns that the generator must "create
opportunities, not solve the tower-placement puzzle automatically", and that not
every bend should be a perfect defensive position. A template-stamped hairpin is
by construction a designed position; one that emerges from terrain cost is not.

### D34 — Declined: the downhill range bonus
**Decision:** elevation continues to affect line of sight only. No range or
visibility bonus for shooting downhill.
**Why:** the brief offers this conditionally — "do not add this unless it is
visually understandable" — and it is not. A range circle subtly larger on one
side is unreadable on a full-map view, and it reintroduces precisely the
invisible numeric advantage that the same section opens by forbidding. The
problem elevation actually has is that it is invisible, not that it is weak.

### D35 — Elevation is made visible, not more powerful
**Decision:** three named walkable bands (Low / Normal / High) plus cliff, with
contour lines drawn at band boundaries, a distinct shading ramp, and the band
named in the build-site preview alongside what it means for sight.
**Why:** the LOS-over-forest rule has worked since D3 but nothing on screen said
what band anything was, so players could not deliberately seek high ground. This
is a legibility fix for an existing mechanic, which is what section 5 is
actually asking for.

### D36 — Resource richness is drawn per deposit, not per tile
**Decision:** one ▰ / ▰▰ / ▰▰▰ marker per deposit region at its centroid, sized
in screen pixels and culled when the map scale is too small to carry it. The
build preview shows the bars, the word, and the exact figure together.
**Why:** the whole map is on screen at 9-12px per tile. A symbol on every rich
tile would be confetti, and the brief's own playtest question asks whether the
symbols end up too cluttered. Per-region markers answer "where is the money"
at a glance, which is the actual goal.

### D37 — Run-long equipment is rare and capped
**Decision:** three drop categories as briefed. Run-long equipment is rare,
capped per run, and modest per item; Materials caches are deliberately small.
**Why:** uncapped permanent stacking turns a lucky early streak into a run that
plays itself, and oversized caches turn the game into "kill enemies, earn
money", which section 19 explicitly forbids. Extraction stays the economy.

### D38 — Sound is synthesised, not sampled
**Decision:** every cue is generated at runtime with Web Audio oscillators,
filtered noise and envelopes. No audio files, no dependencies. Hard cap on
concurrent voices, per-cue wall-clock rate limiting, the priority order from
section 27, stereo pan and attenuation from position relative to the avatar, and
a master switch.
**Why:** no assets to load, host or 404; pitch variation is free, which section
25 asks for repeatedly; and it cannot bloat the page. The master switch is not
optional — a scripted playthrough fast-forwards thousands of simulation steps,
and an audio layer that fired an event per step would spawn thousands of nodes
and hang the acceptance harness.

### D39 — Pause is P only, not Space
**Decision:** P toggles pause. Space is not bound to it.
**Why:** the brief offers Space "if it does not conflict with existing
controls". It does — Space is the melee swing.

### D40 — Pause is enforced at the simulation boundary and bypassed explicitly by the harness
**Decision:** the ordinary update entry point returns before any simulation or
FX clock advances while paused. Player action functions separately refuse
builds, upgrades and collection, and the browser clears movement/action input.
`fastForward()` uses an explicit `ignorePause` update option and leaves the
visible pause state unchanged.
**Why:** one time boundary prevents partial pauses where income, expiry or an FX
clock keeps running. Separate action guards prevent queued work from resolving
on resume, while the explicit harness path cannot hang on a paused run.

### D41 — Road character is measurable generated data
**Decision:** carve cost now includes elevation-band crossings and a riverbank
discount. A seeded subset of spawn routes uses a passable intermediate waypoint,
and each recovered route is retained as generation metadata for headless shape
checks. Existing-road reuse remains the only merge/fork rule.
**Why:** the stored routes let tests count vertical direction reversals and
water-adjacent travel rather than treating legality as proof of character. They
do not place or score defensive positions.

### D42 — Richness tiers are functions of displayed extraction rate
**Decision:** Poor, Moderate and Rich thresholds live in config and classify the
same Materials/second number shown by the build preview. Deposit centroids cache
that figure and tier for rendering and acceptance. The protected starting area
gets one deliberately modest seam; richer authored seams are excluded nearby
and skew away from central roads.
**Why:** a bar glyph cannot contradict its numeric label when both come from one
function. Moving rich seams away from the safe junction makes economic and
defensive site selection pull in different directions without manufacturing a
specific solution.

### D43 — Drop categories share physical collection but not reward lifetime
**Decision:** temporary effects, modest Materials caches and run-long equipment
use one expiring world-drop pipeline. Category weights are 70/22/8; equipment
rolls are removed after the four-item cap, and held equipment keys cannot repeat.
All six equipment bonuses are direct multipliers on existing systems and reset
with a new game object.
**Why:** shared expiry and pickup preserves the risk decision. Separate reward
application keeps temporary clocks, immediate economy and run-long modifiers
explicit and testable.

### D44 — Parallel approaches are a regenerated road-network requirement
**Decision:** An alternate approach pays a temporary cost for entering the first
road's nearby corridor, so it is carved through a physically different stretch
of terrain before ordinary cheap-road reuse lets it merge nearer the centre.
Validation measures maximal vertical road runs per column on each half and
rejects maps unless both halves have a median of at least two and the network
has several three-run columns.
**Why:** Counting authored gaps proved only that the ground was traversable, not
that enemies had distinct lanes. The road bitfield is the player-facing network,
so the D2 gate measures that network directly while retaining D20's cost-carved
rather than template-stamped character.

### D45 — Pathfinding settles each tile once, and compares in Float32 space
**Decision:** `computeField` marks a tile settled the first time it is popped and
skips stale heap entries, and computes candidate costs with `Math.fround` so they
are compared in the same precision they are stored in.
**Why:** measured. After D44 added corridor-avoidance and elevation-crossing
costs, map generation went from ~19ms to 120ms-30s, CHARLIE took 14.8s on a
single attempt, and QUEBEC crashed with the heap exceeding the maximum array
length. The heap uses lazy deletion but never skipped stale entries, so every
duplicate re-relaxed its neighbours; and `dist` is a Float32Array compared
against a 1e-6 epsilon. Once the new costs pushed path totals into the
hundreds, Float32 rounding (~1e-4) dwarfed the epsilon, so equal-cost paths kept
registering as improvements on rounding noise and the search never converged.
The defect predates D44 - larger costs only exposed it.
**Result:** output-neutral and verified so - road network, terrain, lane field
and direct field are bit-identical before and after on seven fingerprinted
seeds. CHARLIE 14825ms -> 45ms, MIKE 30123ms -> 135ms, QUEBEC crash -> 52ms;
every seed now under 400ms. `npm test` went from never completing to 34 passing
in 5 seconds. Runtime tower and pursuit fields share this function, so in-game
pathfinding is faster too.

### D46 — Audio observes a bounded event queue
**Decision:** gameplay emits small positional cue events into a bounded queue; `audio.js` consumes it with wall-clock rate limits, priority selection, a voice cap and a clamped master bus. The AudioContext is lazy and gesture-resumed; pause suspends it and clears sustained voices. Settings are safe best-effort localStorage values, and scripted runs can switch audio off through `window.holdfast.api.setAudioEnabled(bool)`.
**Why:** simulation must remain exactly deterministic and runnable without Web Audio, while a fast-forward cannot create an unbounded node graph.

### D47 — Audio acceptance fixes: cue identity, rising confirmations, quiet collapse reminder
**Decision:** three corrections to the D46 audio layer, made after instrumenting
Web Audio in a live browser rather than trusting unit tests.
1. `emitAudioEvent` applies the cue `type` after the caller's data, not before.
2. Positive confirmations (victory, construction complete, upgrade, drop collect)
   rise in pitch; everything else still falls.
3. While a tower stays below the COLLAPSING line, a quieter reminder repeats
   every 2.6s of simulation time, after the single full-volume announcement.
**Why:**
1. Measured. Enemy hit and death sounds never played - 0 of each during a
   36-enemy siege - while 44 generic 520Hz fallback beeps did. Enemies carry
   their own `type` ('swarm', 'heavy'), and spreading the enemy object after the
   cue name overwrote it. The 36 passing tests exercised the audio helpers in
   isolation and could not see what the game actually emitted. Two new tests
   drive real play and assert the emitted contract; both were proven by
   reintroducing the bug (they fail naming exactly 'heavy' and 'swarm').
2. Every cue shared one downward pitch ramp, so the victory sting descended
   like the defeat cue. A falling tone reads as failure; the brief asks for an
   "unmistakable success sting" and a "clear positive cue".
3. The announcement fired exactly once on crossing the threshold, but a tower
   can sit collapsing for many seconds, and the brief asks for "announce, then
   fall back to something quieter and intermittent". Verified live: 2 reminders
   per 6s while collapsing, 0 while paused, 2 after resume.
**Rejected:** a continuous alarm, which the brief explicitly forbids.
**Left alone, deliberately:** `selectVoices` only prioritises the incoming batch,
not against voices already sounding, so a full voice cap would starve player
damage. It is unreachable at current rate limits - a 36-enemy siege peaks at 9
of 18 voices and 5 player hits produced 5 damage cues - so it is recorded as a
latent risk rather than fixed.

---

## 2026-09-17 — Road exposure pass

### D48 — Road geometry is judged by tower exposure, not by shape
**Decision:** a road feature succeeds only if a buildable tower site near it can
shoot at an enemy walking that road for substantially longer than beside a
straight road. Visual complexity (reversals, bends, self-approach) earns nothing.
D41's "sustained direction reversal" check is retired as a success criterion.
**Why (measured before any change, 6 seeds):**
1. The knots have three generator causes. Seeded waypoints off the eventual route
   make a leg go out to the waypoint and return along its own cheap road, leaving
   dead-end stubs. Routes carved separately snap together through short parallel
   strands and small triangular junction loops. And D41's test counted vertical
   reversals, which a stub satisfies, so the test rewarded exactly the stubs.
2. The bends buy nothing. The best buildable site on every seed saw 16-20 tiles
   of enemy path within range and line of sight; a tower beside a straight road
   already sees ~14.5. No map had a single site at 1.75x the straight baseline.
3. Enemies do not walk an open U-turn. Lane fields price road at 0.32 and open
   ground at 1.0, so an enemy crosses a U at its neck whenever that is cheaper
   than walking round, which for any long U is always. Synthetic check, legs
   running to the map edge: a U with plain or marsh inside - enemy cuts across at
   the neck, 0 tiles of exposure at the interior site. The same U with a one-tile
   deep-water or cliff spine inside, stopping 5 tiles short of the bend - enemy
   follows 94-100% on road, best pocket site 23-33 tiles (1.6-2.3x straight).
**Consequence:** a real hairpin, switchback or horseshoe needs an impassable
spine (rock spur, water inlet, river) between its legs from the neck to near the
bend, and the tower site is the pocket past the spine's tip. This is terrain
causality, not a TD track template: roads wrap round the tip of an obstacle they
cannot cross.
**Rejected:** strengthening the lane discount so enemies stay on any bend (changes
all pathing and road adherence globally); hairpin/bend damage bonuses (the brief
forbids them, and they would hide a geometry that does not work); marsh-filled
bend interiors (measured: enemies still cut the neck).

### D49 — How road exposure is measured
**Decision:**
- *Exposure of a site* = the length of path an enemy actually walks that lies
  within base weapon range (level-0 `TOWER.weapon.range`) of the site AND in line
  of sight from it (`hasLineOfSight`: cliffs, forest-unless-above). Summed per
  segment at segment midpoints.
- *The path an enemy actually walks* is not the carved route polyline, which can
  contain stubs and detours enemies skip. For each road route passing near a
  site, take the route window around the site (extended by a margin) and trace
  the lane-field descent between the window's ends. A cut-across or an unused
  stub therefore scores what it is actually worth.
- A site counts only if it passes the terrain part of tower placement (footprint
  not cliff, deep water or road; not too steep) - the same rules `canPlaceAt`
  uses, from one shared function so they cannot drift.
- *Straight baseline* = the chord a straight road gives a tower 2 tiles from its
  centreline: 2*sqrt(R^2 - 2^2), ~14.5 tiles at R 7.5. Derived from range, not
  hard-coded.
- *Useful* >= 1.35x baseline; *strong* >= 1.75x. Strong sites within 8 tiles are
  one feature.
- *Knot* = a dead-end road stub, a small enclosed loop, or a braid (strands 0-1
  tiles apart running alongside). Defects within 6 tiles are one knot.
**Why:** it answers the brief's question directly - how long would an enemy on
this road stay targetable from here - and it cannot be satisfied by shape alone.

### D50 — Exposure windows and feature labels use deterministic geometric heuristics
**Decision:** when one route passes a site more than once, its measurement window
runs from the first nearby route point to the last, then expands by the D49 point
margin. This deliberately retains both legs and the intervening bend so lane
descent can expose a neck shortcut. Debug `counted` ranges are inclusive segment
index ranges. Feature labels use
counted segment headings: antiparallel means at least 150 degrees, horseshoe
radius variation may be at most 28% of its mean, and label priority is switchback,
horseshoe, hairpin, s-bend, terrain-loop, bend. Defect and feature clustering is
deterministic in scan/score order.
**Why:** D49 specifies the measurements and label meanings but leaves these
boundary cases and the meaning of debug index ranges open. Fixing them here keeps
the report, tests and future overlay consistent without affecting generation.

### D51 — Knots are removed at their cause, then cleaned up locally
**Decision:** after the road network is carved, every route and connector path
has its out-and-back revisits erased, the road layer is rebuilt from those
paths, remaining dead ends are pruned, and near each remaining small loop or
braid one path is moved onto road another path already provides - kept only if
the D49 knot count falls.
**Why:** measured. Stubs came from seeded waypoints: a leg went out to the
waypoint and returned along its own road, and the stored route kept both
directions. Loop erasure alone took the 20 test seeds from 1-8 knots each to 0
on 13; the local merge takes it to 0 on 18 (GOLF and KILO keep one small loop).
Some parallel "runs" the D44 gate counted were braids, so a few seeds now need
more regeneration attempts to pass it.
**Rejected:** rewriting the carve costs to prevent near-parallel strands (a
global change to every road for a local defect).

### D52 — Exposure features are laid round an authored spine, after validation
**Decision:** once a map's road network validates, up to 2-4 exposure features
are attempted. Each stamps a short impassable spine - a rock spur or a water
inlet - across a straight road stretch and re-lays that stretch (for every route
sharing it) as an explicit U round the spine's tip: legs ~8 tiles apart, bend
~5 past the tip, the bend interior cleared to buildable ground. A feature is
kept only if the D49 measurement finds a strong (>= 1.75x) readable buildable
site there, enemies' walked lane through it is >= 90% road, no knot appears and
the map still validates; otherwise the snapshot is restored exactly. Feature
placement never reads deposits or income.
**Why:** D48 showed a U needs a spine or enemies cut its neck. Three things were
tried and measured before this shape:
1. A whole-map gate requiring 2-4 features (Codex attempt) forced regeneration
   and took ~9s per map. Authoring after validation undoes a failed feature
   locally instead.
2. Letting the carve pathfinder route round the spine failed two ways: distant
   cheap road beat rounding the tip (the stretch simply merged elsewhere), and
   when confined it hugged the spine so tightly no 3-tile tower footprint fit
   (best site 1.19x).
3. With the U laid explicitly, every attempt that got past the geometry checks
   was strong (1.75-2.25x). Supply of free space is the limit, not quality.
**Result (20 test seeds, shipped as-is at the user's request):** strong
features per map 0-4 - 9 maps have 2-4, 6 have 1, 5 have 0; best-site ratios on
maps with a feature 1.78-2.25x against a 14.46-tile straight baseline. Enemy
lanes stay 95-98% on road (was 94-97%). Generation mean ~470ms, max ~1.1s
(was ~100ms / 420ms).
**Known gaps:** 5 of 20 maps get no strong feature (crowded roads leave no room
for a U); no debug overlay for exposure was built; the D41 reversal test was not
replaced by exposure tests; feature counts are not a validation requirement.

### D53 — An abandoned tower keeps only the enemies already sieging it
**Date:** 2026-09-17
**Decision:** towers have no baseline aggro. The one strategic target is the
occupied tower, or the exposed player when no tower is occupied. An enemy that
has physically attacked a tower (`siegedId`, set every frame it is in reach)
stays committed to it until it dies, even if separation later shoves it off the
wall. When the player leaves a tower, enemies merely heading for it get their
retarget timer cut to a random 0-0.9s, so they peel away rather than turn as one;
one that reaches the tower before re-reading never starts a siege there.
Hunters within 12 tiles pursue the player directly (D31 interception); farther
ones travel toward the player on a road-discounted lane field, and only the near
ones count as "HUNTING" in the HUD.
**Why:** measured in live combat (4 seeds x 2, wave 5, player walks A -> B).
Every tower scored `1.0 / (1 + d/22)` just for existing, and the current target
kept a 1.35x switch margin, so an enemy near A could hold A over a distant
occupied B or a distant exposed player indefinitely. Before: up to 11
non-sieging enemies per transfer went on to besiege the abandoned A, and 5 of 5
enemies spawned after one transfer chose A. After: 0 and 0; enemies already
sieging stayed (5/5).
**Consequence:** with a single candidate, D24's distance-weighted score and D5's
switch margin no longer do anything and were removed. D24's short sight now lives
in pursuit mode instead of score. Standing exposed beside a besieged tower
kills slightly faster (mean death 4.3s -> 3.4s over 8 noisy runs), because
nearby enemies stop idling on the old target.
**Rejected:** keeping baseline aggro but zeroing it only for the last occupied
tower (other unoccupied towers would still be picked at random); sending every
enemy after a far exposed player by the direct field (drops road adherence
map-wide); an instant retarget of every enemy on leaving (a synchronized turn).

### D54 — Entry roads run out through the map boundary
**Date:** 2026-09-17
**Decision:** every primary route starts on the boundary column (x=0 west,
x=MAP.w-1 east) on its spawn mouth's row, or the adjacent row if that tile is
impassable, and steps straight to the mouth. Spawn coordinates are unchanged
(x=1 / MAP.w-2): enemies still appear one tile in, so no spawn, flow-field or
stuck behaviour at the boundary changed. An alternate approach from the same
mouth shares the primary's first 3 tiles and forks from there. Every carved leg
and connector prices the outer two columns and rows like an avoided corridor,
except the tiles beside each mouth, so roads meet the boundary only where they
enter. The renderer extends a boundary-column road tile through its outer half
so the road visibly reaches the canvas edge.
**Why:** mouths sat at x=1, leaving a strip of terrain between road and edge,
and up to three routes left one mouth separately and splayed into loops at the
edge. The first two attempts (a delegated worker) turned the entire map border
into cliff to keep roads off it and capped spawn mouths at 3/2. Both were
rejected: the first redesigned terrain (a visible cliff frame, rivers ending in
a wall), and the second removed enemy entry points.
**Known gap:** where a river meets the map edge next to a mouth, the only land
south of the mouth can be the boundary column itself (random seed M4XQ9A), so
the soft boundary price lets that road run along the edge. Seen on 1 of 27
seeds checked; none of the 20 test seeds.

### D55 — Road readability: prevent the tangles at their cause, measure the rest
**Date:** 2026-09-17
**Decision:**
1. *Causes fixed in carving.* Alternate approaches avoid the first road within
   6 tiles, not 3; their forced waypoint sits 0.9 of the way to the centre, not
   0.62; the avoided corridor is lifted within 7 tiles of the fork. Diagonal
   steps fill their corner tile the same way whichever direction the road is
   walked.
2. *Measured.* `analyseRoadReadability(map)` (src/roadexposure.js, READABILITY
   config) reports near-self-passes (road within 4 tiles that is 12+ steps away
   along the road, 4+ tiles), thick bands (5+ solid 2x2 road blocks within a
   knight-move of each other: strands laid side by side), junction clutter (more
   than 3 junctions within 7 tiles), density (> 0.42 road tiles per disc tile at
   radius 5) and zigzags (more than 3 sharp turns of 70+ degrees within 16 route
   steps). Features also report `extraLength` and exposure `efficiency` =
   (exposure - straight baseline) / extra road length.
3. *Repaired locally.* D51's path merging now works on readability defects too
   (a wider 13-tile window for strands), keeps a merge only if knots do not rise,
   the combined count falls and the D44 gate is not broken, and its detour walks
   other paths' own tiles rather than their corner fills. An authored feature is
   rejected if it adds a readability defect or its efficiency is below 0.3.
4. *Preferred, not gated.* generateMap keeps a valid map whose roads still carry
   a defect and tries up to 2 more valid maps for a clean one, returning the
   least-defective. Features and deposits are laid only on the map kept, with that
   attempt's own rng.
**Why D49 missed the tangles:** its loop detector ignored every region touching
the border and its spur detector protected every tile within 2 of an edge, which
hid the mouth splays; its braid scan only looked for 1-2 tile gaps along rows and
columns, so diagonal strands 2-4 apart passed.
**Why prevention, not a gate (measured):** a strict "0 defects" gate was tried
twice by a delegated worker; generation went to ~1.2s mean / ~3s max with 3 seeds
relaxed, then to all 20 relaxed. The original generator accepted only 8 of 61
builds on 9 seeds, and 6 of those 8 had knot or readability defects, so a gate
alone multiplies attempts. The narrow 3-tile avoidance ring was itself the cause
of the strands: alternates ran just outside it, 3-4 tiles from the first road -
which is also what satisfied D44's "separate runs" check. Widening it alone took
near-parallel strand tiles over 20 seeds from 511 to 50 with no loss of attempts;
the deeper waypoint then took attempts from 129 to 73 (alternates hold their own
line long enough for D44). Thick bands had two further causes: the direction-
dependent corner fill (two routes sharing a diagonal in opposite directions
painted both corners) and merge detours cutting corner to corner.
**Result (20 test seeds):** knots 2 -> 0; readability defects 3 (one short band
each on BRAVO, DELTA, PAPA); strong exposure features 29 -> 51; maps with no
strong feature 5 -> 0; best-site ratio 1.79-2.25x; generation mean ~470 -> ~680ms,
max ~1.1 -> ~1.3-1.4s; npm test ~29 -> ~40s. Runtime road adherence during a
sheltered wave 77-91% (mean 86%) against 75-93% (mean 87%) before.
**Rejected:** a strict readability gate (above); leaving road tiles un-penalised
inside the avoided corridor so squeezed alternates share the road (attempts
73 -> 753, 18 seeds relaxed: alternates simply rode the primary road); a 4-block
thick-band minimum (6 maps still flagged, slower, fewer features); border cliffs
and spawn caps (D54).
**Known gaps:** short side-by-side merges below the thresholds still read as a
double line where two approaches converge on a diagonal (KILO centre-left); a
diagonal road renders as a two-tile staircase, which makes converging diagonals
look busier than their tile count says.

## 2026-09-18 — Fog of war, local construction, timed upgrades

### D56 — Three-state fog; vision is line of sight from the player and built towers
**Date:** 2026-09-18
**Decision:** every tile is unexplored, explored (remembered) or visible. The
simulation owns two per-tile arrays: `explored` (sticky) and `visible` (rebuilt
when the player changes tile or the set/range of vision-giving towers changes).
A tile is visible if the player or any *built* tower sees it using the existing
D3 `hasLineOfSight` rule within a radius: player 8 tiles; tower
max(9, current weapon range + 1.5), so a tower never fires into the dark after
range upgrades or the Targeting Module. Unfinished towers give no vision.
Terrain, roads, elevation, contours and deposit markers show once explored
(dimmed and desaturated when not visible). Enemies, drops, tracers, particles
and floaters render only on visible tiles. Own towers always render with their
state. The wave-warning road highlight only covers explored road.
**Why:** height is useful only if it changes what you see. Reusing the D3 rule
makes high ground an observation post and forest a blindfold, with no numeric
bonus (D34 still holds). Tying tower vision to range avoids tracers leaving
visible towers toward invisible targets.
**Rejected:** a fixed tower vision radius (breaks at range 11.9); a separate
height bonus for vision; ghost markers or last-known enemy positions.

### D57 — Towers are built where the player stands
**Date:** 2026-09-18
**Decision:** Build mode previews a site snapped to the nearest valid tile
centre within 1.5 tiles of the player (falling back to the player's own tile
with its refusal reasons). Confirming builds there. `tryBuild` refuses any site
more than 1.5 tiles from the player, so remote construction is impossible for
the harness as well as the UI. Construction continues after the player leaves,
using the existing rate rule. Upgrades can still be bought for any selected
tower (the plan did not ask for local upgrades; left open).
**Why:** placement becomes a commitment ("build here") and exploration becomes
a precondition for knowing a site's value.

### D58 — Upgrades take time and keep the old level until complete
**Date:** 2026-09-18
**Decision:** buying an upgrade pays the full cost and starts one job per tower.
Unassisted durations are 6 / 9 / 13 s for levels 1 / 2 / 3, the same scale as the
9 s tower build. The tower keeps firing and extracting at its old level, and the
new level applies only on completion. A destroyed tower loses its job with no
refund. The speed-up is the existing construction rule: player within
`PLAYER.presenceRadius` multiplies the rate by `occupancy.construction`
(x2.5 base, x3.6 Engineer). No new Engineer bonus.
**Why:** turns upgrades into a timing decision without making them
self-sabotage. Reusing the build rate rule keeps one construction system.
**Known concern:** attended upgrades are short (L3 5.2 s, Engineer 3.6 s), so the
timing decision mostly bites when the player is away. Tune after play.

### D59 — Tower alarm fires on damage from an unseen attacker
**Date:** 2026-09-18
**Decision:** when a tower takes damage from an enemy on a tile that is not
currently visible, the tower's known position pulses, an UNDER ATTACK label and
HUD notice appear, the log records it once per episode, and a rate-limited audio
cue plays. Attackers are not revealed.
**Why:** the plan's literal trigger ("the tower is unseen") almost never happens:
a built tower always sees its own tile, and under D53 unfinished and never-
occupied towers are not targets. The case that does happen is committed
besiegers hidden behind forest, plus the construction-site case if it ever
arises.

### D60 — Visible hunter count only
**Date:** 2026-09-18
**Decision:** the HUD and canvas "N HUNTING" count only hunters on visible
tiles. `dangerState().hunters` keeps its old meaning for acceptance. A new
`visibleHunters` field drives the display.
**Why:** hunters within 12 tiles include enemies outside the 8-tile vision; the
count would leak their presence and movement.

### D61 — Fog compositing uses exact tile copies at unexplored boundaries
**Date:** 2026-09-18
**Decision:** the cached terrain view begins with the dim terrain layer, copies
bright terrain in exact visible-tile rectangles, then covers every unexplored
tile with an opaque near-black rectangle. Debug reveal bypasses this composite
but does not mutate simulation visibility or exploration.
**Why:** canvas masks and filtering can sample across a tile edge at the fitted
9–12 px scale, leaking a sliver of unexplored terrain. Exact source and
destination rectangles keep the unexplored boundary hard while retaining a
single cached full-map blit during ordinary rendering.
**Remembered-ground level (controller, from screenshots):** the dim layer is
`grayscale(0.7) brightness(0.64)`. The first version stacked a black overlay on
a 0.55 brightness filter (~42% effective); remembered roads and forest were
barely distinguishable from unexplored black, which the plan forbids. The
overlay now applies only where canvas `filter` is unsupported.

## 2026-09-18 — Long upgrades, stuck-enemy recovery, tower-loss defeat

### D62 — Upgrades are long, and only the Engineer can hurry them
**Date:** 2026-09-18
**Decision:** upgrade durations are 15 / 25 / 40 s to reach levels 1 / 2 / 3
(was 6 / 9 / 13, D58). Upgrade progress is multiplied only by the archetype's
own `occupancy.construction` override (Engineer x3.6; every other archetype
x1), and only while the player *occupies* that tower. New-tower construction
keeps the D58 rule unchanged: within the presence radius, x2.5 base, x3.6
Engineer. Engineer times while occupying: 4.2 / 6.9 / 11.1 s.
**Why:** the plan's stated experience is "other classes wait a long time for
major upgrades; Engineer can personally oversee one and get it online much
faster". Reusing the construction rule verbatim would give every class x2.5
(Gunner 6 / 10 / 16 s), leaving the Engineer only 1.44x faster, and would
collapse the long timers the plan asks for. This reuses the Engineer's existing
multiplier rather than inventing a new bonus.
**Rejected:** base x2.5 for everyone (defeats the long timers); a new upgrade-
specific Engineer number.

### D63 — Stuck enemies: fix causes, then recover, then despawn as a last resort
**Date:** 2026-09-18
**Decision:** stuck episodes are measured and their causes fixed first. The
existing 1.5 s one-tile nudge stays as the first rung. Above it: an enemy with a
movement goal that is not sieging or attacking, and that has made no progress
along its target field for ~3 s, is recovered to the nearest passable tile that
clears its radius, has a finite field to its target and prefers road. Stale
steering state is cleared. After ~9 s of total stuck time, or repeated failed
recoveries, it is despawned with no kill credit, drop, reward or death effect.
Detections, recoveries and despawns are counted and exposed for acceptance.
**Why:** despawning silently makes waves easier and hides bugs; the counters
make a regression visible.

### D64 — Defeat when the tower network is gone
**Date:** 2026-09-18
**Decision:** the run is lost when the player dies, or when no tower remains
(finished or under construction). An unfinished tower and a COLLAPSING tower
both count as a remaining tower; only its destruction removes it from the
network. The end state is resolved in one place at the end of each simulation
step: player death takes priority over tower loss, so a last-tower collapse
that crushes the player reads as a death, and one the player survives reads as
losing the position. The end screen names the cause.
**Why:** a single resolution point prevents contradictory double end states
(player death was previously only checked inside the player update).

### D65 — Recovery crosses invalid geometry, but destinations obey full clearance
**Date:** 2026-09-18
**Decision:** the recovery search expands geometrically through coordinate
neighbours, including blocked tiles, because a flood restricted to passable
tiles cannot escape an enemy embedded in a cliff or enclosed pocket. Candidate
destinations must be passable, finite in the exact field currently steering the
enemy, no farther along that field, and radius-clear; Heavies conservatively
require the surrounding 3x3. The normal collision probe remains unchanged.
Spawn jitter is kept inside an authored mouth tile (falling back only to another
authored mouth on that side), and direct `normTo` fallback is allowed only with
a finite local field and a clear walk to the target.
**Root causes found:** unchecked spawn scatter could cross into an adjacent
cliff/deep tile; once embedded, infinite terrain cost made speed zero and the
old `moved < expected * 0.2` check become `0 < 0`, so its nudge never fired.
Separately, a non-finite field made `steer` return null, `normTo` point into a
wall, and the 3x3 neighbour nudge repeatedly find no finite tile. Separation
was not a terrain-entry cause because its vector still passes through collision.
D52 feature spines were also cleared: they are revalidated after stamping,
though validation remains point-sized rather than Heavy-clearance-sized.
**Measured diagnosis:** all 43 authored mouths in the canonical 20 seeds
happened to have safe adjacent rows, so the unchecked-spawn cause was structural
rather than reproduced there. The
deterministic embedded-cliff fixture was one permanent episode before and one
detection/recovery after; the deliberately non-finite pocket was one permanent
episode before and four confirmations followed by one silent despawn after.

### D66 — Moving-target fields start a new progress metric
**Date:** 2026-09-19
**Decision:** player-target progress keys include the player's current goal
tile and whether steering uses the lane or direct field. A goal-tile or field-
mode change resets the current stuck episode and recovery count because values
from the replaced field are not comparable. A stationary exposed player still
has a stable key and remains eligible for detection.
**Why:** the first 36-second dense diagnostic produced one false last-resort
despawn on CHARLIE wave 6 while the player was moving. The enemy was on passable
terrain with a finite field; the apparent lack of progress came from comparing
successive fields to different player positions. After keying the metric, all
eight dense seeds completed waves 3–8 with zero despawns.

## 2026-09-19 — Pacing, a worthwhile home, and forest self-defence

Playtest problems: combat resolves too fast to enjoy watching; the dominant play
is to abandon the start tower for one rich outpost; forest towers can be sieged
by enemies they cannot shoot. Not in this pass: depletion, Extraction Threat,
new tower types, changes to extraction-upgrade percentages or upgrade costs.

### D67 — Slower enemies, but Runners stay faster than the player
**Date:** 2026-09-19
**Decision:** Swarm 4.9 -> 3.8, Runner 6.2 -> 5.8, Heavy stays 1.7. Player speed
(5.3), tower damage and weapon upgrades are unchanged. No HP or wave changes in
the implementation pass; they wait for measurements.
**Why:** more time under fire makes a working defence visible. Runner 5.0 was
proposed but rejected: it would be slower than the player, so nothing but D31
interception could catch a moving exposed player, which dissolves the "outside
is lethal" loop (D53). 5.8 keeps Runners the exposure punisher, ~1.5x Swarm.
**Expectation:** a Swarm crosses a 15-tile firing diameter in ~4s at 3.8, so the
5-8s engagement target comes from road geometry (hairpins, horseshoes), not
from straight approaches. Exposed-player danger and dash survival are
re-measured and reported, not retuned, in this pass.

### D68 — The start tower is a solid Moderate site
**Date:** 2026-09-19
**Decision:** after generation, calibrate the start deposit per map so the start
tower's base extraction (before occupancy/archetype) lands in 0.8-1.0 Materials/s
(target ~0.9), inside the Moderate tier (0.62-1.18) and never Rich. Richer
seams stay beyond the existing start exclusion/buffer, and every map must still
offer genuine Rich sites farther out.
**Why:** a ~0.58/s home made "rush one rich outpost and neglect home" the
automatic play. Home should be worth keeping while the rich site stays tempting.
**Rejected:** changing extraction-upgrade scaling (+55%/level) or adding
Extraction Threat/depletion now; test the economy under the new conditions first.
The start tower's tactical relevance is measured (road tiles in range per seed),
not enforced by a road-generator change.

### D69 — Forest towers get a small cleared ring at placement
**Date:** 2026-09-19
**Decision:** when a tower is placed (construction start, and the generated start
tower), forest tiles within the minimum radius that gives LOS from the tower to
every siege position are converted to plain. Elevation, deposits, roads, marsh,
water and cliffs are untouched. The radius is derived from siege geometry
(tower radius 0.95 + attack range 1.5 + enemy radius, up to ~3.1 tiles for
Heavies; LOS ignores only the endpoint tiles), expected ~2.2 tiles (5x5 minus
corners), not the 1-1.5 first proposed, which leaves Heavies hidden at range 2.
Caches that depend on terrain (flow fields, terrain render layers, visibility)
are refreshed.
**Why:** a besieged tower that cannot return fire is a bug, and the clearing
explains itself visually. Forest beyond the ring still blocks long sightlines
and fog vision; there is no special "towers ignore forest" rule. A few nearby
tiles may become visible through the normal LOS rule; no extra reveal is added.

### D70 — The calibrated start marker belongs to the tower site
**Date:** 2026-09-19
**Decision:** the start deposit keeps its seeded, jittered kernel, but its map
marker is anchored to the generated start-tower tile and reports extraction at
that tile. Other deposit markers remain at their kernel centroids.
**Why:** D68 calibrates the home tower, not the random kernel centre. On LIMA and
PAPA the raised, overlapping kernel made the old jittered centroid a genuinely
Rich preview while the marker was labelled with the tower's Moderate 0.90/s.
Anchoring this one marker to the site it describes keeps the bars, exact preview
and starting-tower panel consistent without moving the deposit or any remote
seam.

### D71 — Strategy-comparison bots dropped
**Date:** 2026-09-19
**Decision:** the planned "part 2" (Gunner and Prospector bots comparing home
investment against a rich-outpost rush) will not be built. The D67–D70 pass
ships on its own measurements, and no HP/wave balance pass is queued from it.
**Why:** the user's call after part 1 landed. The start-income calibration and
the remote Rich-site counts already answer the economic question well enough
for a prototype, and the remaining questions are about feel, answered by hand
play.
**Rejected:** a measurement-only Codex order for the bots, followed by HP/wave
changes drawn from its results.

### D72 — A three-tower opening
**Date:** 2026-09-19
**Decision:** `START_MATERIALS` 220 -> 350. With the free start tower counted,
the first two builds cost 145 and 190 (335), leaving 15; the third (235) must
wait for income. Tower, extraction and upgrade costs are unchanged.
**Why:** one tower plus one build gave no defensive chain to plan. Three towers
at the outset let the player lay out outer tower -> inner tower -> occupied
endpoint before the first wave, which the D73 breach endpoint is built around.
**Rejected:** cheaper towers (changes the whole late-game sink); compensating
enemy buffs in the same pass (the opening and breach are tested in isolation
first).

### D73 — The occupied tower is a breach endpoint, not a siege target
**Date:** 2026-09-19
**Decision:** an enemy whose target is the occupied tower at the moment it
touches it - `dist <= TOWER.radius + enemy radius + BREACH.contactGap (0.25)`,
i.e. Swarm 1.54, Runner 1.50, Heavy 1.82 - breaches once: the tower loses
`breachFrac x maxHp x towerStats.damageTaken` (Swarm 4%, Runner 6%, Heavy 18%;
21/31/94 of 520 on an unarmoured occupant) and the enemy is removed. It is
never sieged over time. A breach is a leak, not a kill: no kill credit, no drop,
no death cue; `stats.breaches`, `breachesByType` and `breachDamage` record it.
Feedback is a wall-point explosion and shockwave (larger for a Heavy), tower
flash and shake, a distinct full-volume `breach`/`heavyBreach` cue, and one
merged `BREACH -N` floater for breaches within 0.5s. A lethal breach calls the
ordinary `destroyTower`, so collapse damage, tower-loss stats and the D64
defeat rules apply unchanged; later enemies in the same frame lose their target
as usual and do not breach. No player HP is taken directly.
D53 is untouched: the stale-target check still runs first at the old siege
reach, so an enemy walking at a tower the player has left re-targets instead
of breaching it. A besieger already committed to an unoccupied tower keeps its
sticky DPS siege; if the player shelters in that tower again, the besieger
closes to contact and breaches (siegedId kept, so leaving again leaves it
committed).
**Why:** a traditional TD endpoint: every leak is a discrete, legible event
("one got through"), a Heavy that survives the chain is a serious hit, and the
occupied tower keeps firing right up to contact so last-second kills are
possible. Contact is deliberately tighter than the old siege reach (3.07 for a
Heavy): towers do not block movement, and breaching at attack range would make
enemies explode ~1.5 tiles off the wall and pre-empt last-second kills.
**Known consequence:** under D53 a siege could only *begin* at the occupied
tower. With that replaced by breach, no new siege starts in normal play; the
sticky-siege path is preserved but effectively dormant, so unoccupied towers
are now practically never damaged and tower loss comes from breaches.
**Rejected:** breaching at the old siege reach; direct player damage on
breach; removing the siege code outright.

### D74 — Rich ground is a handful of authored jackpots
**Date:** 2026-09-19
**Decision:** resource generation now has two layers. Background seams (still
26-38, radius 4-9) keep the Poor/Moderate economy, with peaks lowered from
0.45-1.55 to 0.30-0.80, and they combine by `max` instead of `+`, so
overlapping seams can no longer stack into Rich. Rich comes only from 3-5
jackpots (`GEN.deposits.rich`). They are sited first on buildable tiles whose
5x5 neighbourhood is at least 60% buildable, at least 18 tiles from the start and
22 from each other, chosen from 30 candidates by the existing awkwardness score
(far from start and roads) plus jitter. Seam centres keep 13 tiles clear of a
jackpot, so the jackpot's own falloff is its Moderate halo. Once every seam is
down, each jackpot's peak is solved with the D68 binary search, which is now
shared as `solveKernelPeak`, so its centre site earns 1.6-2.2 Materials/s base.
The start tower is still solved last at 0.90/s (Moderate). Deposits are placed
after terrain, roads and features, so the map geometry is byte-identical.
**Why:** the old additive seams made Rich a carpet: 258-817 buildable remote
Rich sites per map, 7-18 regions, the largest a single 445-site blob, best
income 2.05-3.48/s. "Find 3-bar land, build, max Extraction" was automatic.
Measured on 44 seeds (`node tools/economy-report.js`), there are now 3-5
distinct Rich places on every map (43/44 at 3-5 two-tile clusters; the
exceptions are one core split by terrain), 99-223 Rich sites, a largest
cluster of 37-57, best income 1.84-2.19/s (2.04-2.44x start) and 421-923
Moderate sites. 3-bar markers dropped from 16-27 per map to 3-4.
**Rejected:** raising `RICHNESS.moderateMax` (relabels dominant income without
changing it); fewer additive seams alone (overlaps still carpet); a narrower
jackpot kernel (the 4.5-tile extraction disc blurs any kernel, so core size
tracks the income target and background level, not the kernel radius).

### D75 — Roads carry the player; Extraction upgrades are efficiency only
**Date:** 2026-09-19
**Decision:** the player moves at `PLAYER.roadSpeedMult` (1.25) on any road tile,
multiplied with terrain cost, boots and the speed effect (`playerSpeed(g)`).
Speed follows the tile under the player's centre, so it changes in one frame
with no position snap. Enemy movement is unchanged. Extraction upgrades keep
the 4.5-tile footprint at E0-E3: `extractRadiusPerLevel` is removed,
`towerStats.extractRadius` is constant, and completing an upgrade no longer
resamples `resourceScore`. Only the x1.00/1.55/2.10/2.65 rate rises. Upgrades
still keep the old level working until 100%, and D73 breach values are unchanged.
**Why:** roads become the fast way to rotate between towers, which makes
road-connected sites valuable and supports leaving damaged positions. The
growing extraction circle let E3 vacuum up ever more of a rich region, which
made one premium outpost the automatic answer.
**Consequence:** on road the player (6.63 tiles/s) outruns a Runner (5.8),
which was previously faster than the player everywhere. Off-road the D67
ordering is unchanged.
**Rejected:** giving enemies the bonus; compensating with a higher Extraction
rate multiplier.

### D76 — Runners hunt the player; Swarms and Heavies hunt the tower network
**Date:** 2026-09-19
**Decision:** enemies carry a role (`ENEMIES[type].role`). The Runner
(`'player'`) keeps D53 exactly: it targets the occupied tower or the exposed
player, and on leaving a tower it drops that tower within
`AGGRO.releaseDelayMax` on a personal stagger, then hunts with the existing
direct/road pursuit and intercept. Swarm and Heavy (`'structures'`) are
committed to the tower they select from the moment they select it, and nothing
the player does moves them. They keep it until it is destroyed or its lane
field reads Infinity from where they stand, and then only if another tower is
reachable. Choosing afresh (spawn, or after the player target lapses), they
take the occupied tower if reachable, otherwise the nearest tower by lane-field
path cost. When their target is destroyed they take the nearest surviving tower
by path cost, never "the occupied one". Unfinished towers are valid targets.
If no tower is reachable they fall back to the player rather than stand idle
holding the wave open.
Every tower contact is now the D73 breach, whether the tower is occupied,
abandoned or unfinished. The continuous siege branch is removed, so no enemy
deals `towerDps` any more (the values stay in config, unused). A pre-D76
enemy left in `sieging`/`siegedId` state is still committed and closes in to
one breach. The stale-target check still runs first at the old siege reach,
so a Runner that has lost its reason never breaches an abandoned tower. Breach
fractions rise to Swarm 6%, Runner 9%, Heavy 25% (31/47/130 on 520 unmitigated),
still multiplied by the occupant's `damageTaken` (Engineer 0.75). An abandoned
tower has no occupant and takes the full fraction. A breach whose attacker is
hidden raises the tower alarm (`unseenHitAt`, `towerUnderAttack`, "Tower #N UNDER
ATTACK."), the job the siege branch used to do.
**Why:** retreat becomes a real trade: "I can save myself, but what I leave
behind may be destroyed." Slow enemies no longer trail uselessly after a
player they cannot catch, so kiting is answered by the network falling and the
D64 no-towers defeat, not by speed buffs.
**Rejected:** raising Swarm/Heavy siege DPS (6->10, 34->50), since breach
replaces prolonged siege; re-choosing the closest tower every retarget
(zigzag); Euclidean replacement (ranks towers behind cliffs); per-enemy A*;
keeping the dormant siege path alongside breach (it risked siege DPS and a
breach from one arrival).
