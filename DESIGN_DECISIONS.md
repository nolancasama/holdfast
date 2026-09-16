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
