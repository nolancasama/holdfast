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

export const ELEV_BANDS = 4; // 0 low .. 3 high

// --- terrain generation -----------------------------------------------------
export const GEN = {
  ridges: { min: 2, max: 4, thicknessMin: 2, thicknessMax: 4, wander: 7 },
  ridgeGap: { min: 4, max: 8, minSeparation: 9 },
  river: { widthMin: 3, widthMax: 6, wander: 11 },
  fords: { min: 2, max: 4, heightMin: 4, heightMax: 7 },
  deposits: { min: 26, max: 38, radiusMin: 4, radiusMax: 9, peakMin: 0.5, peakMax: 1.5 },
  ambientResource: 0.10,   // every site yields a trickle; deposits are where it pays
  startClearRadius: 4,
  maxAttempts: 24,     // strict validation attempts (D2)
  maxRelaxedAttempts: 40,
};

// D20-D22: roads are an overlay. These costs are used only while carving the
// network; ordinary movement continues to use MOVE_COST above.
export const ROAD = {
  existingCost: 0.15,
  carveCost: [1.0, 2.8, 4.2, 3.0, Infinity, Infinity],
  laneDiscount: 0.32,
  connectorsMin: 1,
  connectorsMax: 2,
  startOffset: 4,
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
};

// --- player -----------------------------------------------------------------
export const PLAYER = {
  maxHp: 100,
  speed: 5.3,               // tiles/sec on open ground; terrain cost divides this
  radius: 0.42,
  presenceRadius: 2.4,      // inside this, a tower is the Occupied Tower
  melee: { damage: 18, cooldown: 0.9, range: 1.2, arc: Math.PI * 0.8 },
  invulnAfterHit: 0.35,
  regen: 2.5,               // hp/sec, prep phase only: surviving a collapse is a
                            // scar you can recover from, not a delayed death
  shelterTime: 0.7,
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

  weapon: { damage: 11, fireRate: 1.6, range: 7.5 },
  extraction: { radius: 4.5, baseRate: 0.85, normalizer: 30 },

  upgrade: {
    maxLevel: 3,
    weaponCost: [140, 230, 360],
    extractionCost: [120, 200, 320],
    weaponDamagePerLevel: 0.45,   // +45% damage per level
    weaponRatePerLevel: 0.18,
    weaponRangePerLevel: 0.8,     // +0.8 tiles per level
    extractRatePerLevel: 0.55,
    extractRadiusPerLevel: 0.7,
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
export const ENEMIES = {
  swarm: {
    name: 'Swarm', color: '#c98bd8', radius: 0.34,
    hp: 30, speed: 4.9, towerDps: 6, playerHit: 32, cost: 4, unlockWave: 1,
  },
  runner: {
    name: 'Runner', color: '#78e08f', radius: 0.30,
    hp: 46, speed: 6.2, towerDps: 8, playerHit: 38, cost: 7, unlockWave: 2,
  },
  heavy: {
    name: 'Heavy', color: '#e8833a', radius: 0.62,
    hp: 270, speed: 1.7, towerDps: 34, playerHit: 55, cost: 22, unlockWave: 3,
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

// D5: aggro moves as a rolling commitment, never a synchronized 180.
export const AGGRO = {
  baseWeight: 1.0,
  occupiedWeight: 4.2,       // the Occupied Tower is by far the juiciest target
  distanceScale: 22,         // score divided by (1 + dist/scale)
  playerWeight: 8.0,         // overwhelming nearby, but deliberately short-sighted
  playerDistanceScale: 1.5,
  switchMargin: 1.35,        // only switch if meaningfully better
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

export const START_MATERIALS = 220;

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
};

// --- drops ------------------------------------------------------------------
export const DROP = {
  chance: 0.18,
  lifetime: 16,
  pickupRadius: 0.9,
  effectDuration: 20,
  types: {
    repair: { name: 'Repair Kit', color: '#5ecbff', instant: true, healFrac: 0.35, playerHeal: 25 },
    damage: { name: 'Damage +60%', color: '#ff6b6b', mult: 1.6 },
    extraction: { name: 'Extraction +80%', color: '#ffd166', mult: 1.8 },
    speed: { name: 'Move Speed +45%', color: '#78e08f', mult: 1.45 },
  },
};

