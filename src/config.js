// All tunable numbers live here. Nothing else should hard-code a balance value.
// Distances are in TILES unless the name says px. Times are in seconds.

export const MAP = {
  w: 104,           // compact enough for the entire battlefield to stay visible
  h: 52,            // enough north/south room for alternate routes
};

// --- tile kinds -------------------------------------------------------------
export const T = {
  PLAIN: 0,
  FOREST: 1,
  MARSH: 2,
  SHALLOW: 3,
  DEEP: 4,
  CLIFF: 5,
};

export const TILE_NAME = ['Open ground', 'Forest', 'Marsh', 'Shallow water', 'Deep water', 'Cliff'];

// Movement cost multiplier. Infinity = impassable.
export const MOVE_COST = [1.0, 1.4, 2.5, 2.2, Infinity, Infinity];
export const PASSABLE = MOVE_COST.map((c) => Number.isFinite(c));

// D3: cliffs always block sight. Forest blocks sight unless the shooter stands
// at least one elevation band above the forest tile. No numeric hill bonus.
export const BLOCKS_SIGHT_ALWAYS = [false, false, false, false, false, true];
export const BLOCKS_SIGHT_UNLESS_ABOVE = [false, true, false, false, false, false];

// Three walkable bands. Cliff is a terrain kind, not a fourth height bonus.
export const ELEV_BANDS = 3;
export const ELEVATION_NAMES = ['Low', 'Normal', 'High'];

// --- terrain generation -----------------------------------------------------
export const GEN = {
  elevationCuts: [0.38, 0.68],
  ridges: { min: 2, max: 4, thicknessMin: 2, thicknessMax: 4, wander: 7 },
  ridgeGap: { min: 4, max: 8, minSeparation: 9 },
  river: { widthMin: 3, widthMax: 6, wander: 11 },
  fords: { min: 2, max: 4, heightMin: 4, heightMax: 7 },
  deposits: {
    // D74: background seams are the Poor/Moderate economy. They combine by
    // max, not sum, so overlapping seams cannot stack into a Rich carpet.
    min: 26, max: 38, radiusMin: 4, radiusMax: 9,
    peakMin: 0.30, peakMax: 0.80, startIncomeTarget: 0.90,
    // D74: Rich comes only from a few separated jackpots, each solved so the
    // best site at its centre earns `targetMin..targetMax` Materials/s base.
    rich: {
      min: 3, max: 5, radius: 4.5, targetMin: 1.6, targetMax: 2.2,
      minSeparation: 22, minFromStart: 18, candidates: 30, openNeighbourhood: 0.6,
      seamClearance: 13,     // seam centres keep this far from a jackpot
    },
    startExclusionRadius: 12, startBufferRadius: 18, startBufferRejectChance: 0.70,
    roadSearchRadius: 7, roadDistanceNormalizer: 8,
    distanceWeight: 0.70, roadDistanceWeight: 0.30,
    awkwardnessWeight: 0.65, randomWeight: 0.50,
    distanceMapFraction: 0.48,
  },
  ambientResource: 0.10,   // every site yields a trickle; deposits are where it pays
  startClearRadius: 4,
  maxAttempts: 24,     // strict validation attempts (D2)
  maxRelaxedAttempts: 40,
  readableExtraAttempts: 2, // D55: further valid maps tried when roads are not yet clean
};

// D20-D22: roads are an overlay. These costs are used only while carving the
// network; ordinary movement continues to use MOVE_COST above.
export const ROAD = {
  existingCost: 0.15,
  carveCost: [1.0, 2.8, 4.2, 3.0, Infinity, Infinity],
  elevationCrossingCost: 5.5,
  riverCheapRadius: 2,
  riverbankCostMult: 0.48,
  waypointChance: 0.72,
  waypointYOffsetMin: 8,
  waypointYOffsetMax: 18,
  parallelRouteFraction: 0.9,   // D55: was 0.62; a wide alternate must hold its own line most of the half
  parallelRouteYOffsetMin: 12,
  parallelRoadAvoidRadius: 6,  // D55: was 3, which bred strands 3-4 tiles apart
  branchClearRadius: 7,        // D55: avoidance lifted round an alternate's fork point
  entryTrunkLength: 3,         // D54: tiles an alternate shares with its mouth's primary route
  parallelRoadAvoidCost: 8.0,
  laneDiscount: 0.32,
  connectorsMin: 1,
  connectorsMax: 2,
  startOffset: 4,
};

// D49: road exposure and road-knot measurement. Generation (D51/D52) uses it to
// accept or undo knot fixes and exposure features.
export const EXPOSURE = {
  straightOffset: 2.0,
  usefulRatio: 1.35,
  strongRatio: 1.75,
  featureClusterRadius: 8,
  windowMargin: 6,
  knotClusterRadius: 6,
  smallLoopMaxArea: 60,
  braidMinRun: 5,
  readableLegSeparation: 5,
};

// D55: road readability at full-map scale. Exposure scores tower sites; these
// reject road areas a player would have to trace with a finger.
export const READABILITY = {
  nearPassDistance: 4,       // an unrelated strand this close (tiles, Euclidean)...
  nearPassGraphMin: 12,      // ...that is at least this far away along the road
  nearPassClusterRadius: 3,
  nearPassMinTiles: 4,       // a brushing touch of one or two tiles is not a strand
  thickBandMinBlocks: 5,     // solid 2x2 road blocks in one run: strands laid side by side
  junctionRadius: 7,
  maxJunctionsInRadius: 3,
  densityRadius: 5,
  maxDensity: 0.42,          // road tiles per disc tile
  turnChord: 3,
  sharpTurnDegrees: 70,
  turnWindow: 16,            // route steps
  maxSharpTurnsInWindow: 3,
  defectClusterRadius: 6,
  minExposureEfficiency: 0.3, // (exposure - straight baseline) per tile of extra road
};

// D52: authored exposure features - a short impassable spine the road must wrap.
export const EXPOSURE_GEN = {
  targetMin: 2,
  targetMax: 4,
  maxTries: 24,            // candidate stretches tried per map before giving up
  segmentHalf: 14,         // furthest route tiles searched either side for the re-laid stretch ends
  depthMin: 5,             // spine length out from the old road line
  depthMax: 8, 
  rootBehind: 6,           // spine continues behind the road so it cannot be walked round
  legHalfGap: 4,           // each leg this far from the spine centreline (legs ~8 apart)
  bendBeyondTip: 5,        // the bend runs this far past the tip, leaving the tower pocket
  spineWidth: 2,
  waterChance: 0.45,       // water inlet vs rock spur
  pocketOffset: 2.5,       // tower pocket centre past the spine tip
  otherRoadClearance: 2,   // a feature keeps this far from any other road
  minWalkedOnRoad: 0.9,
  minFromStart: 12,
  minApart: 16,
};

// D2: a map must satisfy these or it is thrown away and regenerated.
export const VALID = {
  minRoutesPerBarrier: 2,   // >=2 topologically distinct ways through each barrier
  minGapTiles: 3,           // no single-tile funnel that trivializes the game
  chokepointMaxTiles: 12,   // a pass this narrow or narrower genuinely funnels
  minChokepoints: 2,        // the map must offer real chokepoints, not just routes
  openFracMin: 0.30,        // not a maze
  openFracMax: 0.66,        // not a featureless field
  minForestFrac: 0.05,
  parallelRouteMedianMin: 2,
  parallelRouteColumnsWithThreeMin: 3,
};

// --- player -----------------------------------------------------------------
export const PLAYER = {
  maxHp: 100,
  speed: 5.3,               // tiles/sec on open ground; terrain cost divides this
  roadSpeedMult: 1.25,      // D75: roads are the player's transport network (not enemies')
  radius: 0.42,
  presenceRadius: 2.4,      // inside this, a tower is the Occupied Tower
  melee: { damage: 18, cooldown: 0.9, range: 1.2, arc: Math.PI * 0.8 },
  invulnAfterHit: 0.35,
  regen: 2.5,               // hp/sec, prep phase only: surviving a collapse is a
                            // scar you can recover from, not a delayed death
  shelterTime: 0.7,
};

export const BUILD = {
  reach: 1.5,
};

export const VISION = {
  player: 8,
  towerMin: 9,
  towerRangeMargin: 1.5,
};

// --- towers -----------------------------------------------------------------
export const TOWER = {
  cost: 100,
  costPerExisting: 45,      // each tower you already own makes the next dearer:
                            // a materials sink, and a cap on blanketing the map
  maxHp: 520,
  radius: 0.95,
  minSpacing: 7.0,          // no stacking towers in one tiny area
  buildTime: 9.0,
  buildHpFraction: 0.35,    // an unfinished tower is fragile but real
  collapsingAt: 0.20,       // D6: visible COLLAPSING state below 20% hp
  collapseDamageFrac: 0.85, // of player MAX hp, to anyone in the footprint
  collapseRadius: 2.2,
  // D69: max siege reach is 0.95 + 1.5 + 0.62 = 3.07. Because LOS ignores
  // its endpoint, the farthest possible blocking lattice tile is offset (2,1):
  // sqrt(5), the 5x5 neighbourhood minus its four corners.
  forestClearRadius: Math.sqrt(5),

  weapon: { damage: 11, fireRate: 1.6, range: 7.5 },
  extraction: { radius: 4.5, baseRate: 0.85, normalizer: 30 },

  upgrade: {
    maxLevel: 3,
    buildTime: [15, 25, 40],
    weaponCost: [140, 230, 360],
    extractionCost: [120, 200, 320],
    weaponDamagePerLevel: 0.45,   // +45% damage per level
    weaponRatePerLevel: 0.18,
    weaponRangePerLevel: 0.8,     // +0.8 tiles per level
    extractRatePerLevel: 0.55,  // D75: efficiency only; the 4.5-tile footprint never grows
  },

  repair: { hpPerSec: 11, costPerHp: 0.6, occupiedMult: 4.0 },
};

// D7/§7: base Occupied Tower bonus, before archetype. Deliberately strong.
export const OCCUPANCY = {
  damage: 1.5,
  fireRate: 1.35,
  extraction: 1.5,
  repair: TOWER.repair.occupiedMult,
  construction: 2.5,
  damageTaken: 1.0,
};

// --- archetypes -------------------------------------------------------------
// Each REPLACES the matching base occupancy multiplier, so the three feel
// clearly different rather than sharing one bonus with a garnish.
export const ARCHETYPES = {
  engineer: {
    name: 'Engineer',
    color: '#5ecbff',
    blurb: 'Occupied tower repairs fast and cheap, and shrugs off damage.',
    occupancy: { repair: 6.5, damageTaken: 0.75, construction: 3.6 },
    repairCostMult: 0.55,
    detail: ['Repair x6.5 (vs x4)', 'Repair cost x0.55', 'Occupied tower takes 25% less damage', 'Builds x3.6 faster'],
  },
  prospector: {
    name: 'Prospector',
    color: '#ffd166',
    blurb: 'Occupied tower pulls far more Materials out of the ground.',
    occupancy: { extraction: 2.6 },
    repairCostMult: 1.0,
    detail: ['Extraction x2.6 (vs x1.5)', 'Standard weapon and repair bonus'],
  },
  gunner: {
    name: 'Gunner',
    color: '#ff6b6b',
    blurb: 'Occupied tower fights far above its level.',
    occupancy: { damage: 2.4, fireRate: 1.7 },
    repairCostMult: 1.0,
    detail: ['Damage x2.4 (vs x1.5)', 'Fire rate x1.7 (vs x1.35)', 'Standard economy'],
  },
};

// --- enemies ----------------------------------------------------------------
// D76: towerDps is unused since every tower contact became a breach; kept for reference.
export const ENEMIES = {
  swarm: {
    name: 'Swarm', color: '#c98bd8', radius: 0.34,
    hp: 30, speed: 3.8, towerDps: 6, playerHit: 32, cost: 4, unlockWave: 1,
    breachFrac: 0.06,        // D73/D76: of the target tower's max hp, once, on contact
    role: 'structures',      // D76: commits to a tower and ignores the player's retreat
  },
  runner: {
    name: 'Runner', color: '#78e08f', radius: 0.30,
    hp: 46, speed: 5.8, towerDps: 8, playerHit: 38, cost: 7, unlockWave: 2,
    breachFrac: 0.09,
    role: 'player',          // D76: hunts the exposed player, drops an abandoned tower
  },
  heavy: {
    name: 'Heavy', color: '#e8833a', radius: 0.62,
    hp: 270, speed: 1.7, towerDps: 34, playerHit: 55, cost: 22, unlockWave: 3,
    breachFrac: 0.25,
    role: 'structures',
  },
};

export const ENEMY = {
  attackRange: 1.5,          // reach past the target's radius
  playerAttackRange: 0.95,   // enemies en route swipe at a player who gets close
  playerHitCooldown: 1.0,
  separation: 0.55,
  // D31: hunters aim where the player is GOING, not where they are. This is
  // what closes circular kiting - a curve is trivial to intercept once the
  // pursuer cuts the corner - without a leash, an aura or a speed buff.
  pursuitLeadTime: 1.15,     // seconds of lead, capped by time-to-intercept
  pursuitLeadRange: 12,      // only lead when close enough to actually cut in
};

// D73: the occupied tower is the endpoint. An enemy that touches it breaches
// once - burst damage, then it is gone - instead of sieging it over time.
export const BREACH = {
  contactGap: 0.25,          // contact = tower radius + enemy radius + this
  floaterMerge: 0.5,         // seconds: close breaches share one BREACH floater
  messageInterval: 3.0,      // seconds between log lines per tower
  shake: 0.35,               // seconds of tower jitter per breach
  ring: { life: 0.45, radius: 2.4, heavyRadius: 3.6 },
};

export const STUCK = {
  detectAfter: 3.0,
  minProgress: 0.75,
  searchRadius: 6,
  despawnAfter: 9.0,
  maxRecoveries: 3,
};

// D5: aggro moves as a rolling commitment, never a synchronized 180.
export const AGGRO = {
  // D53: towers have no baseline aggro; the occupied tower or the exposed
  // player is the one strategic target, so score weights are gone.
  directPursuitRange: 12,    // beyond this, hunters travel toward the player by road
  releaseDelayMax: 0.9,      // D76: Runners drop a just-abandoned tower within this
  retargetMin: 2.0,
  retargetMax: 4.0,
};

// --- waves ------------------------------------------------------------------
export const WAVE = {
  totalToSurvive: 8,
  prepFirst: 40,
  prep: 20,
  warning: 7,
  aftermath: 3,
  budgetBase: 40,
  budgetPerWave: 40,
  spawnWindowMin: 14,
  spawnWindowMax: 24,
  maxClusters: 5,
  clusterSpread: 1.4,        // seconds a single cluster takes to come through
  bothSidesFromWave: 4,
  hpScalePerWave: 0.15,      // enemies get steadily tougher, not just more numerous
  heavyBiasPerWave: 0.30,    // later waves lean on Heavies rather than more Swarms
};

// D72: the start tower plus two immediate builds (145 + 190), 15 left over.
export const START_MATERIALS = 350;

// Readability floors for the fixed whole-map view. World-space rings still use
// the fitted tile scale; only the important entities and their labels/bars floor.
export const RENDER = {
  baseTilePx: 18,
  towerMinRadiusPx: 10,
  playerMinRadiusPx: 5,
  enemyMinRadiusPx: 3.5,
  healthBarMinWidthPx: 16,
  labelMinPx: 9,
  roadWidthFrac: 0.58,
  resourceMarkerMinTilePx: 10,
};

// The exact extraction-rate thresholds used by both labels and bar glyphs.
export const RICHNESS = {
  poorMax: 0.62,
  moderateMax: 1.18,
  tiers: [
    { key: 'poor', name: 'Poor', bars: 1 },
    { key: 'moderate', name: 'Moderate', bars: 2 },
    { key: 'rich', name: 'Rich', bars: 3 },
  ],
};

export function richnessTierForRate(rate) {
  return rate < RICHNESS.poorMax ? RICHNESS.tiers[0]
    : rate < RICHNESS.moderateMax ? RICHNESS.tiers[1]
    : RICHNESS.tiers[2];
}

// --- drops ------------------------------------------------------------------
export const DROP = {
  chance: 0.18,
  lifetime: 16,
  pickupRadius: 0.9,
  effectDuration: 20,
  categoryWeights: { temporary: 0.70, materials: 0.22, equipment: 0.08 },
  materialsCache: { name: 'Materials Cache', color: '#ffd166', min: 24, max: 42 },
  equipmentCap: 4,
  temporary: {
    repair: { name: 'Repair Kit', color: '#5ecbff', instant: true, healFrac: 0.35, playerHeal: 25 },
    damage: { name: 'Damage +60%', color: '#ff6b6b', mult: 1.6 },
    extraction: { name: 'Extraction +80%', color: '#ffd166', mult: 1.8 },
    speed: { name: 'Move Speed +45%', color: '#78e08f', mult: 1.45 },
  },
  equipment: {
    reinforcedBarrel: { name: 'Reinforced Barrel', color: '#ffe08a', towerDamage: 1.25 },
    targetingModule: { name: 'Targeting Module', color: '#d8c4ff', towerRange: 1.20 },
    extractionChip: { name: 'Extraction Chip', color: '#ffd166', extraction: 1.25 },
    armourPlate: { name: 'Armour Plate', color: '#a9c6d9', playerDamageTaken: 0.75 },
    boots: { name: 'Boots', color: '#78e08f', playerSpeed: 1.20 },
    repairRig: { name: 'Repair Rig', color: '#5ecbff', repairCost: 0.60, repairSpeed: 1.40 },
  },
};

// D46: audio is observer-only. These values are deliberately separate from
// gameplay tuning so synthesis/load can be adjusted without changing a run.
export const AUDIO = {
  masterVolume: 0.62,
  voiceCap: 18,
  eventQueueCap: 96,
  nearDistance: 3,
  farDistance: 42,
  rateLimits: {
    towerFire: 0.075, enemyHit: 0.16, enemyDeath: 0.11, towerHit: 0.18,
    heavyTowerHit: 0.22, breach: 0.12, heavyBreach: 0.2, towerUnderAttack: 2.5, collapsing: 0.75, repair: 0.16, default: 0.08,
  },
  limiter: { threshold: -12, ratio: 16 },
  envelope: { attack: 0.008, normal: 0.09, occupied: 0.16, urgent: 0.14, noiseLow: 0.09, noiseHigh: 0.035 },
  cues: {
    towerFire: [260, .10, 'square'], enemyHit: [430, .045, 'sine'], enemyDeath: [330, .14, 'triangle'],
    towerHit: [75, .18, 'triangle'], heavyTowerHit: [48, .30, 'triangle'],
    breach: [64, .42, 'sawtooth'], heavyBreach: [38, .75, 'sawtooth'], towerDestroy: [56, .72, 'triangle'],
    collapsing: [92, .70, 'sawtooth'], playerDamage: [880, .11, 'square'], exposed: [720, .16, 'sawtooth'],
    towerEntry: [145, .18, 'triangle'], constructionStart: [180, .13, 'square'], constructionComplete: [620, .24, 'triangle'],
    repair: [760, .06, 'sine'], upgradeStart: [180, .13, 'square'], upgrade: [720, .18, 'triangle'],
    towerUnderAttack: [105, .32, 'sawtooth'], waveWarning: [185, .40, 'sawtooth'],
    waveStart: [230, .32, 'sawtooth'], finalWave: [155, .48, 'sawtooth'], victory: [660, .38, 'triangle'], playerDeath: [110, .44, 'sawtooth'],
  },
  dropFrequencies: { temporary: 620, materials: 310, equipment: 880 },
  // D47: positive confirmations RISE in pitch; everything else falls. A falling
  // tone reads as failure, so a descending victory sting says the wrong thing.
  risingCues: ['victory', 'constructionComplete', 'upgrade', 'dropCollect'],
  risingPitchMult: 1.6,
  collapsingReminderInterval: 2.6,   // seconds between quiet COLLAPSING reminders
  collapsingReminderGain: 0.4,       // relative to the first announcement
};
