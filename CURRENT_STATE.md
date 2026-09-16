# Current State

Last updated: 2026-09-16

## What this is

`holdfast` — a playable 2D top-down tower-defense/survival prototype testing one
loop: presence makes a tower much stronger and makes it the target, so the
player must decide whether to hold a failing tower or abandon it. First pass is
complete and playable end to end. See `README.md` to run it,
`DESIGN_DECISIONS.md` for what was decided and why.

## Status

Feature-complete against the original brief. All 20 numbered sections of the
plan are implemented except the deliberate cuts recorded in D10 (Emergency
Armor and rare-module drops deferred). `npm test` — 23 checks, all passing.
No console errors across scripted browser runs.

## Architecture

- Plain ES modules, no build step, no dependencies. `npm start` serves it.
- `src/config.js` holds every balance number; nothing else hard-codes one.
- Terrain is generated in authored passes and then **validated**, regenerating
  until it satisfies the predicates in `VALID` (routes per barrier, minimum
  pass width, chokepoint count, open-ground band). Typically accepted on
  attempt 1–2; ~19ms per map.
- Pathing is one shared Dijkstra flow field per target, cached on the tower.
- `window.holdfast` exposes `game`, `fastForward(seconds, onStep)`, `api.*` and
  `start()` for scripted playthroughs and console work.

## What the playtests actually showed

Measured with a scripted browser player across seeds BRAVO, CHARLIE, DELTA,
ECHO, FOXTROT and all three archetypes.

- **Chokepoints appear reliably.** 7–11 tight passes (≤12 tiles) per map, 2–3
  usable routes through every barrier, narrowest 4–8 tiles. Open-ground fraction
  0.47–0.63. No map needed relaxed validation.
- **Placement is a real trade-off.** Income across candidate sites spans
  0.17 /s (p5) to 3.04 /s (p100) — an 18x spread; payback ranges 588s to 33s.
  Line-of-sight coverage spans 9% to 100%. A site can be rich and blind, or
  commanding and barren.
- **Presence is felt.** An Occupied Gunner tower runs at 71.8 dps against 17.6
  automated — 4.1x. Sieges peak at 8–11 enemies on one tower by wave 7.
- **The naive strategy falls just short.** A bot that never abandons a tower and
  never dodges dies on waves 6–8 against an 8-wave objective, always to collapse
  damage. That is the intended shape: refusing the decision loses.
- **The objective works.** Reliably established by wave 3 and held thereafter,
  and the zone is seeded with deposits so expansion pays.

## Known problems

1. **Fleeing is not yet clearly the better play.** A crude flee bot (abandon at
   30% tower HP, run in a straight line) did *worse* than sitting on two of
   three seeds — it stops repairing, and it eats hits crossing the siege.
   Unresolved whether this is bad bot play or a genuine balance gap. **This is
   the single most important thing to test with a human.**
2. **Waves run long** — 70–110s each, occasionally 160–190s. A full 8-wave run
   is 12–15 minutes. Most of it is approach time (23s for Swarm, 39s for Heavy,
   from edge to centre) and slow stragglers.
3. **Mid-game Materials still accumulate** past wave 5 even with escalating
   costs; upgrades are not an expensive enough sink.
4. The event log bottom-right can overlap a tower near that corner.

## Next steps

1. **Play it by hand, several maps.** Specifically: does abandoning a tower ever
   feel like the right call, and does terrain ever make you think "that would be
   a good place for a tower"? Nothing automated can answer either.
2. If waves drag: cut `WAVE.totalToSurvive` to 6, or raise enemy speeds again.
3. If Materials still pile up: raise upgrade costs, or add a third upgrade tier.
4. If fleeing stays weak: reduce `ENEMY.playerAttackRange` or raise the
   collapse warning threshold above 20% so abandoning is possible earlier.

## Delegated work

None outstanding. This was implemented directly by Claude — the router
(`route.js`) reported no delegating worker available: Gemini and the Antigravity
workers are under global readiness quarantine, and Codex is skipped because this
project is not a git repository (`workspace-incompatible: git-repo-required`).
`git init` was deliberately **not** run; say the word and Codex becomes
available for follow-up work.
