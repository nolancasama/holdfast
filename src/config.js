// All tunable numbers live here. Nothing else should hard-code a balance value.
// Distances are in TILES unless the name says px. Times are in seconds.

export const MAP = {
  // D79: four times the old map area. Rendering uses a follow camera; these
  // dimensions are deliberately still only 2x each axis, not a 16x-area map.
  w: 208,
  h: 104,
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
  // D79: retain the old feature scale and author more barriers rather than
  // stretching the old 104x52 layout over the larger world.
  ridges: { min: 4, max: 6, thicknessMin: 2, thicknessMax: 5, wander: 10 },
  ridgeGap: { min: 5, max: 10, minSeparation: 11 },
  river: { widthMin: 4, widthMax: 7, wander: 15 },
  fords: { min: 4, max: 6, heightMin: 5, heightMax: 9, minSeparation: 10 },
  startClearRadius: 7,
  maxAttempts: 4,      // bounded strict retries keep the 4x-area generator practical
  maxRelaxedAttempts: 10,
};

// D80: physical resource geography. Fertility is a tile layer (0/1/1.5),
// while stone and gold are point sites with the matching multipliers.
export const RESOURCE_GEN = {
  nearRadius: 16,
  goldExclusionRadius: 28,
  middleRadius: 58,
  farRadius: 62,
  siteEdgeMargin: 4,
  farmland: {
    minBlobs: 14, maxBlobs: 20, radiusMin: 3, radiusMax: 5,
    minNearFarms: 2, nearCentreMin: 5, minSeparation: 7,
    fertile: 1.0, rich: 1.5,
    richFrom: 22, richChanceMiddle: 0.72, richChanceFar: 0.9,
  },
  stone: {
    min: 9, max: 13, minSeparation: 10, minNear: 1,
    nearCentreMin: 7, normal: 1.0, rich: 1.6, richFrom: 52,
  },
  gold: {
    min: 4, max: 7, minSeparation: 18,
    normal: 1.0, rich: 1.6, richFrom: 62,
  },
};

// D20-D22/D96: roads are an overlay. Carve costs are used only while laying
// roads; ordinary movement uses MOVE_COST above (enemy Keep fields discount
// road tiles by laneDiscount, the player runs faster on them).
// D96: roads are simple - few, straight, tree-shaped, validated hard.
export const ROAD = {
  existingCost: 0.15,
  carveCost: [1.0, 2.8, 4.2, 3.0, Infinity, Infinity],
  elevationCrossingCost: 5.5,
  riverCheapRadius: 2,
  laneDiscount: 0.32,
  mouthsPerSide: 4,          // candidate mouths; only those with roads become spawns
  mouthMinSeparation: 16,
  startOffset: 6,
  // Routing: turning is expensive, so roads bend only where terrain forces it.
  turn45: 1.5,
  turn90: 25,                // sharper than 90 degrees is never allowed
  edgeCost: 8,               // the 2-tile boundary band, except the entry tile
  spacing: 6,                // proximity to other roads is priced inside this...
  proximityCost: 1.5,        // ...per tile closer
  pullSlack: 1.05,           // a straightened segment may cost 5% more than the raw path
  // Validation (a failing road is skipped, never forced).
  minSeparation: 4,          // unrelated roads stay this far apart (Chebyshev)
  selfPassGap: 12,           // tiles this far apart along one road...
  selfPassDistance: 3,       // ...must not come this close on the map
  turnDegrees: 30,           // a bend sharper than this counts as a turn
  maxTurnsMain: 5,
  maxTurnsBranch: 3,
  maxTurnDegrees: 95,
  hairpinDegrees: 120,       // bends adding up to this...
  hairpinWindow: 16,         // ...within this many tiles of road are a hairpin
  minTilesPerSegment: 7,     // a road averages at least this many tiles per straight segment
  // Network shape: one main road per side, at most one branch per side.
  maxRoads: 4,
  branchChance: 0.75,
  branchMouthSeparation: 24,
  branchMaxLengthFrac: 0.6,  // of map width
  junctionSpacing: 14,       // a branch never joins this close to another junction
  joinEdgeClear: 14,         // or this close to the west/east edge
};

// D49: road-knot measurement; D96 validation requires zero knots.
export const EXPOSURE = {
  knotClusterRadius: 6,
  smallLoopMaxArea: 60,
  braidMinRun: 5,
};

// D55: road readability at full-map scale: road areas a player would have to
// trace with a finger.
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
};

// D2: a map must satisfy these or it is thrown away and regenerated.
export const VALID = {
  minRoutesPerBarrier: 2,   // >=2 topologically distinct ways through each barrier
  minGapTiles: 3,           // no single-tile funnel that trivializes the game
  chokepointMaxTiles: 12,   // a pass this narrow or narrower genuinely funnels
  minChokepoints: 4,        // the larger map must offer several meaningful funnels
  openFracMin: 0.30,        // not a maze
  openFracMax: 0.66,        // not a featureless field
  minForestFrac: 0.05,
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
  // D101: in first person the site is where the crosshair meets the ground,
  // so the player must be this close to it (tiles), not standing on it.
  lookReach: 6,
};

// D101: first-person presentation. The simulation stays in tiles on the old
// x/y grid; the 3D world maps tile (x, y) to Three.js (x * tileMeters, height,
// y * tileMeters). North is -Z (decreasing tile y). Every 3D size derives from
// tileMeters so towers, walls and enemies share one scale.
export const WORLD3D = {
  tileMeters: 2,
  eyeHeight: 1.7,             // metres above the ground
  elevStep: 2.2,              // metres per elevation band (Low/Normal/High)
  smoothPasses: 3,            // box-blur passes on the walkable height field
  cliffHeight: 5.5,           // metres a cliff interior rises above its band
  shallowDepth: 0.55,
  deepDepth: 1.8,
  fov: 75,
  // Player speed multipliers applied to PLAYER.speed (5.3 tiles/s = 10.6 m/s).
  walkMult: 0.75,             // ~8 m/s walk
  sprintMult: 1.2,            // ~12.7 m/s sprint; roads stack on top (D75)
  interactRange: 7,           // tiles: inspect / garrison / upgrade prompts
  exploreRadius: 16,          // tiles of terrain in sight remembered on the minimap
  pickRange: 40,              // tiles: wall anchor B and inspection rays
  towerHeight: 9,             // metres
  keepHeight: 15,
  wallHeight: 3.2,
  wallThickness: 1.3,
  drawDistance: 330,          // metres (camera far / atmospheric fog end)
  fogNear: 70,
  mouseSensitivity: 0.0022,
};

export const VISION = {
  player: 8,
  towerMin: 9,
  towerRangeMargin: 1.5,
};

// --- towers -----------------------------------------------------------------
export const TOWER = {
  // D91: Stone only; the next tower costs more Stone per non-Keep tower owned.
  cost: { stone: 60 },
  costStonePerExisting: 25,
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

  weapon: { damage: 11, fireRate: 1.6, range: 7.5, minRange: 2.8 },
  upgrade: {
    maxLevel: 3,
    buildTime: [15, 25, 40],
    weaponCost: [
      { stone: 50, gold: 30 },
      { stone: 90, gold: 70 },
      { stone: 150, gold: 130 },
    ],
    weaponDamagePerLevel: 0.45,   // +45% damage per level
    weaponRatePerLevel: 0.18,
    weaponRangePerLevel: 0.8,     // +0.8 tiles per level
  },

  repair: { hpPerSec: 11, costPerHp: 0.35, occupiedMult: 4.0, reach: 2.5 },
};

// D77: the Keep is the generated starting tower, but has its own footprint and
// durability. Its weapon and upgrades continue to use TOWER values.
export const KEEP = {
  maxHp: 2000,
  radius: 1.25,
  minRange: 3.2,
};

// D80: one-tile, non-blocking economic buildings. D91: costs are Stone only;
// farm cost escalation is applied by the game from `costStonePerExisting`.
// A Farm's `baseRate` is not a stockpile rate: it scales the Food support the
// farm provides (supportPerFarm x rate / baseRate).
export const BUILDINGS = {
  farm: {
    type: 'farm', name: 'Farm', cost: { stone: 35 }, costStonePerExisting: 8, minSpacing: 3,
    buildTime: 8, maxHp: 160, baseRate: 0.55, resource: 'food',
  },
  quarry: {
    type: 'quarry', name: 'Quarry', cost: { stone: 40 },
    buildTime: 10, maxHp: 220, baseRate: 0.45, resource: 'stone', siteRange: 1.5,
  },
  mine: {
    type: 'mine', name: 'Gold Mine', cost: { stone: 120 },
    buildTime: 12, maxHp: 260, baseRate: 0.18, resource: 'gold', siteRange: 1.5,
  },
};

export const START_RESOURCES = { stone: 340, gold: 0 };

// D91: Food is support, not currency. Farms set how many soldiers the fortress
// can feed; soldiers are assigned to towers and make them hit harder and faster.
export const GARRISON = {
  supportPerFarm: 3,        // x the farm's fertility multiplier, rounded
  slots: { keep: 4, tower: 1, towerUpgraded: 2 },
  upgradedFromLevel: 2,     // weapon level at which a tower gains its second slot
  fireRatePerSoldier: 0.20,
  damagePerSoldier: 0.15,
  graceSeconds: 30,         // deficit grace before anyone stands down
  standDownInterval: 8,     // then one soldier every this many seconds
};

// D92: wilderness nests guard valuable sites. One nest type, one defender.
export const NEST = {
  countMin: 5,
  countMax: 8,
  minFromKeep: 30,
  minSeparation: 16,
  siteOffsetMin: 3,
  siteOffsetMax: 6,
  normalGoldChance: 0.6,
  stoneChance: 0.5,         // for rich stone, or normal stone in the middle/far bands
  maxHp: 1400,
  radius: 1.1,
  territory: 9,
  structureReach: 3,        // ferals attack player structures within territory + this
  leash: 6,                 // ferals turn home beyond territory + this
  spawnInterval: 4.5,
  maxAlive: 6,
  calmAfter: 25,
  siegeCheckInterval: 0.5,
  reward: { stone: 40, gold: 15 },
  feralFadeSeconds: 3,
};

export const WILD = {
  feral: {
    name: 'Feral', color: '#b5d16b', radius: 0.36,
    hp: 42, speed: 3.6, structDps: 7, playerAggroRange: 9,
    playerHit: 26, cost: 0,
  },
};

// D82: a blocker (wall segment or non-Keep tower footprint tile) costs
// breakBias x the distance an enemy could walk in the time it takes to break it.
export const WALL_PATH = { breakBias: 1.5, recomputeInterval: 0.5 };

// D81: walls run tile by tile between two finished tower anchors.
export const WALL = {
  maxLength: 13,            // tower centre to tower centre, tiles
  maxDegree: { tower: 3, keep: 6 },
  keepPreference: 0.85,
  minLinkAngle: 50,
  costStonePerSegment: 6,
  segmentHp: 260,
  buildBase: 3.0,           // seconds; a link takes buildBase + buildPerTile x segments
  buildPerTile: 0.8,
  buildHpFraction: 0.30,    // every segment blocks from the start, at 30% hp
  crackAt: [0.66, 0.33],    // visible crack stages
  breachMessageInterval: 2.0,
};

// D7/§7: base Occupied Tower bonus, before archetype. Deliberately strong.
export const OCCUPANCY = {
  damage: 1.5,
  fireRate: 1.35,
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
  // Preserve the long-standing key for saved/UI selections while D80 changes
  // the archetype's player-facing identity and removes occupancy extraction.
  prospector: {
    name: 'Steward',
    color: '#ffd166',
    blurb: 'Builds farms, quarries and mines more cheaply and quickly, and feeds two extra soldiers.',
    occupancy: {},
    buildingCostMult: 0.75,
    buildingBuildMult: 1.6,
    foodSupportBonus: 2,
    repairCostMult: 1.0,
    detail: ['Economic building cost x0.75', 'Economic building construction x1.6', '+2 Food support', 'Standard weapon and repair bonus'],
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
    hp: 30, speed: 3.8, structDps: 5, playerAggroRange: 3,
    playerHit: 32, cost: 4, unlockWave: 1,
  },
  runner: {
    name: 'Runner', color: '#78e08f', radius: 0.30,
    hp: 46, speed: 5.8, structDps: 4, playerAggroRange: 6,
    playerHit: 38, cost: 7, unlockWave: 2,
  },
  heavy: {
    name: 'Heavy', color: '#e8833a', radius: 0.62,
    hp: 270, speed: 1.7, structDps: 45, playerAggroRange: 1.5,
    playerHit: 55, cost: 22, unlockWave: 3,
  },
};

export const ENEMY = {
  attackRange: 1.5,          // reach past the target's radius
  playerAttackRange: 0.95,   // enemies en route swipe at a player who gets close
  playerHitCooldown: 1.0,
  separation: 0.55,
  econAggroRange: 2.0,
  playerLeash: 4.0,
  playerGiveUpRangeMult: 1.6,
  // D31: hunters aim where the player is GOING, not where they are. This is
  // what closes circular kiting - a curve is trivial to intercept once the
  // pursuer cuts the corner - without a leash, an aura or a speed buff.
  pursuitLeadTime: 1.15,     // seconds of lead, capped by time-to-intercept
  pursuitLeadRange: 12,      // only lead when close enough to actually cut in
};

// D78 keeps the old breach audiovisual vocabulary for sustained structure
// impacts; these values affect feedback only, never damage or enemy lifetime.
export const BREACH = {
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

// --- waves ------------------------------------------------------------------
export const WAVE = {
  // D97: prepFirst/prep are the total time to assault. The warning is the
  // final portion of that total, not extra time added afterward.
  totalToSurvive: 10,
  prepFirst: 120,
  prep: 90,
  warning: 15,
  aftermath: 4,
  earlyStartReady: 4,
  budgetBase: 40,
  budgetPerWave: 36,
  budgetAccel: 2,           // extra budget x (wave-1)^2: late waves become formations
  structScalePerWave: 0.06,    // structural damage grows with the wave
  spawnWindowMin: 14,
  spawnWindowMax: 24,
  maxClusters: 5,
  clusterSpread: 1.4,        // seconds a single cluster takes to come through
  bothSidesFromWave: 4,
  hpScalePerWave: 0.15,      // enemies get steadily tougher, not just more numerous
  heavyBiasPerWave: 0.40,    // later waves lean on Heavies rather than more Swarms
};

// D79: camera defaults and D19 readability floors for important entities.
export const RENDER = {
  baseTilePx: 18,
  minTilePx: 10,
  maxTilePx: 28,
  minimapWidthPx: 260,
  minimapHeightPx: 130,
  towerMinRadiusPx: 10,
  playerMinRadiusPx: 5,
  enemyMinRadiusPx: 3.5,
  healthBarMinWidthPx: 16,
  labelMinPx: 9,
  roadWidthFrac: 0.58,
  resourceMarkerMinTilePx: 10,
};

// --- drops ------------------------------------------------------------------
export const DROP = {
  chance: 0.18,
  lifetime: 16,
  pickupRadius: 0.9,
  effectDuration: 20,
  categoryWeights: { temporary: 0.70, supply: 0.22, equipment: 0.08 },
  supplyCache: { name: 'Supply Cache', color: '#ffd166', min: 24, max: 42, resources: ['stone'] },
  equipmentCap: 4,
  temporary: {
    repair: { name: 'Repair Kit', color: '#5ecbff', instant: true, healFrac: 0.35, playerHeal: 25 },
    damage: { name: 'Damage +60%', color: '#ff6b6b', mult: 1.6 },
    speed: { name: 'Move Speed +45%', color: '#78e08f', mult: 1.45 },
  },
  equipment: {
    reinforcedBarrel: { name: 'Reinforced Barrel', color: '#ffe08a', towerDamage: 1.25 },
    targetingModule: { name: 'Targeting Module', color: '#d8c4ff', towerRange: 1.20 },
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
    heavyTowerHit: 0.22, breach: 0.12, heavyBreach: 0.2, towerUnderAttack: 2.5,
    wallHit: 0.14, heavyWallHit: 0.2, wallBreak: 0.25, collapsing: 0.75, repair: 0.16, nestAmbient: 3.0, default: 0.08,
  },
  limiter: { threshold: -12, ratio: 16 },
  envelope: { attack: 0.008, normal: 0.09, occupied: 0.16, urgent: 0.14, noiseLow: 0.09, noiseHigh: 0.035 },
  cues: {
    towerFire: [260, .10, 'square'], enemyHit: [430, .045, 'sine'], enemyDeath: [330, .14, 'triangle'],
    towerHit: [75, .18, 'triangle'], heavyTowerHit: [48, .30, 'triangle'],
    breach: [64, .42, 'sawtooth'], heavyBreach: [38, .75, 'sawtooth'], towerDestroy: [56, .72, 'triangle'],
    wallHit: [92, .16, 'triangle'], heavyWallHit: [44, .34, 'sawtooth'], wallBreak: [34, .9, 'sawtooth'],
    collapsing: [92, .70, 'sawtooth'], playerDamage: [880, .11, 'square'], exposed: [720, .16, 'sawtooth'],
    towerEntry: [145, .18, 'triangle'], constructionStart: [180, .13, 'square'], constructionComplete: [620, .24, 'triangle'],
    repair: [760, .06, 'sine'], upgradeStart: [180, .13, 'square'], upgrade: [720, .18, 'triangle'],
    towerUnderAttack: [105, .32, 'sawtooth'], waveWarning: [185, .40, 'sawtooth'],
    waveStart: [230, .32, 'sawtooth'], finalWave: [155, .48, 'sawtooth'], victory: [660, .38, 'triangle'], playerDeath: [110, .44, 'sawtooth'],
    nestAgitated: [120, .38, 'sawtooth'], nestDestroyed: [42, 1.1, 'sawtooth'], supplyDeficit: [300, .30, 'square'],
    nestAmbient: [58, .9, 'sawtooth'],   // D101: low growl near an undestroyed nest
  },
  dropFrequencies: { temporary: 620, supply: 310, equipment: 880 },
  // D47: positive confirmations RISE in pitch; everything else falls. A falling
  // tone reads as failure, so a descending victory sting says the wrong thing.
  risingCues: ['victory', 'constructionComplete', 'upgrade', 'dropCollect'],
  risingPitchMult: 1.6,
  collapsingReminderInterval: 2.6,   // seconds between quiet COLLAPSING reminders
  collapsingReminderGain: 0.4,       // relative to the first announcement
};
