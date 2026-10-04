// Canvas drawing. Simple shapes only — readability over polish (plan §1).

import { MAP, T, TOWER, PLAYER, DROP, RENDER, VISION, BREACH, WALL } from './config.js';
import { idx, inBounds, isPassable, hasLineOfSight } from './terrain.js';
import { towerStats, repairTarget } from './game.js';

const TP = RENDER.baseTilePx;
const ELEV_SHADE = [0.72, 0.96, 1.22];

const BASE_COLOR = {
  [T.PLAIN]: [0x74, 0x7f, 0x55],
  [T.FOREST]: [0x33, 0x4e, 0x30],
  [T.MARSH]: [0x4c, 0x55, 0x42],
  [T.SHALLOW]: [0x4d, 0x82, 0x99],
  [T.DEEP]: [0x22, 0x47, 0x5c],
  [T.CLIFF]: [0x59, 0x54, 0x4e],
};

function shade([r, g, b], mult) {
  const f = (v) => Math.max(0, Math.min(255, Math.round(v * mult)));
  return `rgb(${f(r)},${f(g)},${f(b)})`;
}

/**
 * D79: the 208x104 map is rendered from visible tiles. Keeping this lightweight
 * descriptor preserves the old layer API without allocating several full-map
 * canvases (which would exceed the terrain cache budget at maximum zoom).
 */
export function buildTerrainLayer(map) {
  return { map, width: MAP.w * TP, height: MAP.h * TP, chunks: new Map() };
}

/** Compatibility surface: dimming is applied per visible tile. */
export function buildTerrainDimLayer(terrain) {
  return terrain;
}

function tileVisible(g, tx, ty) {
  return !g.fog || !!(inBounds(tx, ty) && g.fog.visible[idx(tx, ty)]);
}

function tileExplored(g, tx, ty) {
  return !g.fog || !!(inBounds(tx, ty) && g.fog.explored[idx(tx, ty)]);
}

function pointVisible(g, x, y) {
  return tileVisible(g, Math.floor(x), Math.floor(y));
}

export function screenToWorld(view, sx, sy) {
  return { x: (sx - view.offsetX) / view.tilePx, y: (sy - view.offsetY) / view.tilePx };
}

// ---------------------------------------------------------------------------

function healthBar(ctx, x, y, w, h, frac, color, bg = 'rgba(0,0,0,0.6)') {
  ctx.fillStyle = bg;
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w * Math.max(0, Math.min(1, frac)), h);
  ctx.strokeStyle = 'rgba(0,0,0,0.7)';
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
}

function visibleBounds(view, margin = 2) {
  return {
    x0: Math.max(0, Math.floor(-view.offsetX / view.tilePx) - margin),
    y0: Math.max(0, Math.floor(-view.offsetY / view.tilePx) - margin),
    x1: Math.min(MAP.w - 1, Math.ceil((view.w - view.offsetX) / view.tilePx) + margin),
    y1: Math.min(MAP.h - 1, Math.ceil((view.h - view.offsetY) / view.tilePx) + margin),
  };
}

function drawTerrainTile(ctx, g, x, y, reveal = false) {
  const i = idx(x, y);
  const px = x * TP;
  const py = y * TP;
  if (!reveal && !g.debug.showFog && !tileExplored(g, x, y)) {
    ctx.fillStyle = '#07090c';
    ctx.fillRect(px, py, TP, TP);
    return;
  }
  const kind = g.map.kind[i];
  const live = reveal || g.debug.showFog || tileVisible(g, x, y);
  const light = ELEV_SHADE[g.map.elev[i]] ?? ELEV_SHADE[1];
  ctx.fillStyle = shade(BASE_COLOR[kind], light * (live ? 1 : 0.52));
  ctx.fillRect(px, py, TP + 0.5, TP + 0.5);

  if (kind === T.FOREST) {
    ctx.fillStyle = live ? 'rgba(20,38,20,0.75)' : 'rgba(15,23,18,0.72)';
    for (let n = 0; n < 3; n++) {
      const ox = ((x * 7 + y * 13 + n * 29) % 11) / 11 * TP;
      const oy = ((x * 17 + y * 5 + n * 41) % 11) / 11 * TP;
      ctx.beginPath();
      ctx.arc(px + ox, py + oy, TP * 0.19, 0, Math.PI * 2);
      ctx.fill();
    }
  } else if (kind === T.SHALLOW) {
    ctx.strokeStyle = 'rgba(190,230,240,0.25)';
    ctx.beginPath(); ctx.moveTo(px + 1, py + TP * 0.55); ctx.lineTo(px + TP - 1, py + TP * 0.45); ctx.stroke();
  } else if (kind === T.CLIFF) {
    ctx.fillStyle = 'rgba(20,18,16,0.45)';
    ctx.fillRect(px, py + TP * 0.62, TP, TP * 0.38);
  }

  if (g.map.road[i]) {
    const half = TP * RENDER.roadWidthFrac * 0.5;
    const cx = px + TP * 0.5;
    const cy = py + TP * 0.5;
    ctx.fillStyle = live ? 'rgba(105,83,54,0.94)' : 'rgba(62,57,49,0.82)';
    ctx.fillRect(cx - half, cy - half, half * 2, half * 2);
    if (x > 0 && g.map.road[idx(x - 1, y)]) ctx.fillRect(px, cy - half, TP * 0.5, half * 2);
    if (x + 1 < MAP.w && g.map.road[idx(x + 1, y)]) ctx.fillRect(cx, cy - half, TP * 0.5, half * 2);
    if (y > 0 && g.map.road[idx(x, y - 1)]) ctx.fillRect(cx - half, py, half * 2, TP * 0.5);
    if (y + 1 < MAP.h && g.map.road[idx(x, y + 1)]) ctx.fillRect(cx - half, cy, half * 2, TP * 0.5);
  }

  // D80: fertility is readable ground, but only after the tile is explored.
  const fertility = g.map.fertility?.[i] || 0;
  if (fertility > 0) {
    ctx.strokeStyle = fertility > 1 ? 'rgba(245,211,91,0.72)' : 'rgba(184,191,79,0.58)';
    ctx.lineWidth = 1;
    for (let n = 0; n < 3; n++) {
      const xx = px + TP * (0.22 + n * 0.28);
      ctx.beginPath(); ctx.moveTo(xx, py + TP * 0.2); ctx.lineTo(xx - TP * 0.08, py + TP * 0.8); ctx.stroke();
    }
  }
}

const TERRAIN_CHUNK_TILES = 16;
const TERRAIN_CHUNK_LIMIT = 72; // <=24 MB at the 18px source resolution.

function terrainChunk(layers, g, chunkX, chunkY) {
  const key = `${chunkX},${chunkY}`;
  const cache = layers.terrain.chunks;
  if (cache.has(key)) {
    const canvas = cache.get(key);
    cache.delete(key); cache.set(key, canvas);
    return canvas;
  }
  const x0 = chunkX * TERRAIN_CHUNK_TILES;
  const y0 = chunkY * TERRAIN_CHUNK_TILES;
  const tilesW = Math.min(TERRAIN_CHUNK_TILES, MAP.w - x0);
  const tilesH = Math.min(TERRAIN_CHUNK_TILES, MAP.h - y0);
  const canvas = document.createElement('canvas');
  canvas.width = tilesW * TP; canvas.height = tilesH * TP;
  const chunkCtx = canvas.getContext('2d');
  chunkCtx.translate(-x0 * TP, -y0 * TP);
  for (let y = y0; y < y0 + tilesH; y++) {
    for (let x = x0; x < x0 + tilesW; x++) drawTerrainTile(chunkCtx, g, x, y, true);
  }
  cache.set(key, canvas);
  while (cache.size > TERRAIN_CHUNK_LIMIT) cache.delete(cache.keys().next().value);
  return canvas;
}

function drawVisibleTerrain(ctx, g, layers, view) {
  const b = visibleBounds(view);
  const cx0 = Math.floor(b.x0 / TERRAIN_CHUNK_TILES);
  const cy0 = Math.floor(b.y0 / TERRAIN_CHUNK_TILES);
  const cx1 = Math.floor(b.x1 / TERRAIN_CHUNK_TILES);
  const cy1 = Math.floor(b.y1 / TERRAIN_CHUNK_TILES);
  for (let cy = cy0; cy <= cy1; cy++) {
    for (let cx = cx0; cx <= cx1; cx++) {
      ctx.drawImage(terrainChunk(layers, g, cx, cy), cx * TERRAIN_CHUNK_TILES * TP, cy * TERRAIN_CHUNK_TILES * TP);
    }
  }
  if (!g.fog || g.debug.showFog) return;
  for (let y = b.y0; y <= b.y1; y++) {
    for (let x = b.x0; x <= b.x1; x++) {
      const i = idx(x, y);
      if (g.fog.visible[i]) continue;
      ctx.fillStyle = g.fog.explored[i] ? 'rgba(7,9,12,0.55)' : '#07090c';
      ctx.fillRect(x * TP, y * TP, TP + 0.5, TP + 0.5);
    }
  }
}

export function draw(ctx, g, layers, view) {
  ctx.clearRect(0, 0, view.w, view.h);
  ctx.imageSmoothingEnabled = false;

  ctx.save();
  ctx.translate(view.offsetX, view.offsetY);
  ctx.scale(view.tilePx / TP, view.tilePx / TP);
  drawVisibleTerrain(ctx, g, layers, view);

  if (g.debug.showFog) drawFogStateTint(ctx, g);

  if (g.phase === 'warning') drawIncomingRoads(ctx, g, view);
  if (g.debug.showPaths) drawFlowField(ctx, g, view);

  drawResourceSites(ctx, g, view);
  drawTowerRings(ctx, g);
  drawDrops(ctx, g, view);
  drawBuildings(ctx, g, view);
  drawWalls(ctx, g, view);
  drawTowers(ctx, g, view);
  drawRepairTarget(ctx, g, view);
  drawEnemies(ctx, g, view);
  drawPlayer(ctx, g, view);
  drawFx(ctx, g, view);
  if (g.buildMode) drawBuildPreview(ctx, g);
  if (g.wallMode) drawWallPreview(ctx, g, view);
  if (g.debug.showFog) drawFogDebug(ctx, g, view);

  ctx.restore();

  drawKeepArrow(ctx, g, view);
  drawMinimap(ctx, g, layers, view);

  if (g.paused) drawPaused(ctx, view);
}

const localPx = (view, pixels) => pixels * TP / view.tilePx;
const inView = (view, x, y, margin = 2) => {
  const sx = view.offsetX + x * view.tilePx;
  const sy = view.offsetY + y * view.tilePx;
  const m = margin * view.tilePx;
  return sx >= -m && sy >= -m && sx <= view.w + m && sy <= view.h + m;
};

function drawIncomingRoads(ctx, g, view) {
  const pulse = 0.5 + 0.5 * Math.sin(g.time * 6);
  ctx.save();
  ctx.fillStyle = `rgba(255,92,72,${0.20 + pulse * 0.24})`;
  const b = visibleBounds(view, 0);
  for (let y = b.y0; y <= b.y1; y++) {
    for (let x = b.x0; x <= b.x1; x++) {
      if (!g.map.road[idx(x, y)] || (!g.debug.showFog && !tileExplored(g, x, y))) continue;
      const fromWest = g.spawnSides.includes('west') && x <= g.map.roadCenter.x;
      const fromEast = g.spawnSides.includes('east') && x >= g.map.roadCenter.x;
      if (fromWest || fromEast) ctx.fillRect(x * TP + TP * 0.2, y * TP + TP * 0.2, TP * 0.6, TP * 0.6);
    }
  }
  ctx.restore();
}

function drawTowerRings(ctx, g) {
  const show = g.towers.filter((t) => t.id === g.selected || t.id === g.occupiedTowerId);
  for (const t of show) {
    const s = towerStats(g, t);
    ctx.save();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(180,210,255,0.4)';
    ctx.beginPath();
    ctx.arc(t.x * TP, t.y * TP, s.range * TP, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
}

function drawTowers(ctx, g, view) {
  for (const t of g.towers) {
    if (!inView(view, t.x, t.y, 4)) continue;
    // D78: sustained structure hits reuse the old breach jolt.
    const jolt = t.shake > 0 ? localPx(view, 3.5) * (t.shake / BREACH.shake) : 0;
    const cx = t.x * TP + (jolt ? (Math.random() - 0.5) * 2 * jolt : 0);
    const cy = t.y * TP + (jolt ? (Math.random() - 0.5) * 2 * jolt : 0);
    const towerRadius = t.radius ?? (t.keep ? 1.25 : TOWER.radius);
    const r = Math.max(towerRadius * TP, localPx(view, RENDER.towerMinRadiusPx));
    const frac = t.hp / t.maxHp;
    const collapsing = t.built && frac < TOWER.collapsingAt;
    const occupied = t.id === g.occupiedTowerId;
    const alarm = Number.isFinite(t.unseenHitAt) && g.time - t.unseenHitAt < 1.5;

    if (occupied) {
      const pulse = 0.5 + 0.5 * Math.sin(g.time * 6);
      ctx.strokeStyle = `rgba(255,214,102,${0.6 + pulse * 0.4})`;
      ctx.lineWidth = localPx(view, 3);
      ctx.beginPath();
      ctx.arc(cx, cy, r + localPx(view, 7 + pulse * 3), 0, Math.PI * 2);
      ctx.stroke();
    }
    if (alarm) {
      const pulse = 0.5 + 0.5 * Math.sin(g.time * 12);
      ctx.strokeStyle = `rgba(255,64,64,${0.55 + pulse * 0.45})`;
      ctx.lineWidth = localPx(view, 3);
      ctx.beginPath();
      ctx.arc(cx, cy, r + localPx(view, 8 + pulse * 5), 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.fillStyle = t.keep ? (t.built ? '#626875' : 'rgba(98,104,117,0.55)')
      : t.built ? '#3f4754' : 'rgba(63,71,84,0.55)';
    ctx.strokeStyle = collapsing && Math.sin(g.time * 14) > 0 ? '#ff4d4d'
      : t.id === g.selected ? '#cfe4ff' : '#20252e';
    ctx.lineWidth = localPx(view, t.id === g.selected ? 3 : 2);
    ctx.beginPath();
    if (t.keep) ctx.rect(cx - r, cy - r, r * 2, r * 2);
    else ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill(); ctx.stroke();

    if (t.keep) {
      // D77: a square bastion and banner make the objective unmistakable.
      ctx.strokeStyle = '#d8c88d';
      ctx.lineWidth = localPx(view, 2);
      ctx.beginPath(); ctx.moveTo(cx, cy - r); ctx.lineTo(cx, cy - r * 2.1); ctx.stroke();
      ctx.fillStyle = '#d84e4e';
      ctx.beginPath();
      ctx.moveTo(cx, cy - r * 2.1); ctx.lineTo(cx + r * 0.75, cy - r * 1.78); ctx.lineTo(cx, cy - r * 1.48); ctx.closePath(); ctx.fill();
    }

    // Barrel pointing at whatever it is shooting.
    const target = g.enemies.find((e) => e.id === t.targetId);
    if (t.built && target && (g.debug.showFog || pointVisible(g, target.x, target.y))) {
      const a = Math.atan2(target.y - t.y, target.x - t.x);
      ctx.strokeStyle = occupied ? '#ffe680' : '#aab4c2';
      ctx.lineWidth = localPx(view, 4);
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(a) * (r + localPx(view, 7)), cy + Math.sin(a) * (r + localPx(view, 7)));
      ctx.stroke();
    }

    if (t.flash > 0) {
      ctx.fillStyle = `rgba(255,90,90,${t.flash * 0.45})`;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
    }

    if (!t.built) {
      // Crossed structural members and deterministic flickering weld sparks
      // keep a tiny construction site distinct from a damaged finished tower.
      ctx.strokeStyle = 'rgba(192,214,205,0.78)';
      ctx.lineWidth = localPx(view, 1.5);
      ctx.beginPath();
      ctx.moveTo(cx - r * 0.62, cy - r * 0.62);
      ctx.lineTo(cx + r * 0.62, cy + r * 0.62);
      ctx.moveTo(cx + r * 0.62, cy - r * 0.62);
      ctx.lineTo(cx - r * 0.62, cy + r * 0.62);
      ctx.stroke();
      ctx.fillStyle = '#ffe28a';
      for (let n = 0; n < 3; n++) {
        const flicker = 0.35 + 0.65 * Math.abs(Math.sin(g.time * (13 + n * 3) + t.id * 1.7 + n));
        const a = g.time * (2.7 + n * 0.4) + t.id + n * 2.1;
        ctx.globalAlpha = flicker;
        ctx.fillRect(cx + Math.cos(a) * r * 0.72 - localPx(view, 1),
          cy + Math.sin(a) * r * 0.72 - localPx(view, 1), localPx(view, 2), localPx(view, 2));
      }
      ctx.globalAlpha = 1;
      ctx.strokeStyle = '#7be196';
      ctx.lineWidth = localPx(view, 3);
      ctx.beginPath();
      ctx.arc(cx, cy, r + localPx(view, 4), -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * t.progress);
      ctx.stroke();
    }

    if (t.upgrade) {
      const progress = Math.max(0, Math.min(1, t.upgrade.progress));
      ctx.strokeStyle = '#65e8f4';
      ctx.lineWidth = localPx(view, 3);
      ctx.beginPath();
      ctx.arc(cx, cy, r + localPx(view, 5), -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * progress);
      ctx.stroke();
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(g.time * 1.8);
      ctx.strokeStyle = 'rgba(101,232,244,0.9)';
      ctx.lineWidth = localPx(view, 2);
      const br = r + localPx(view, 9);
      const tick = localPx(view, 5);
      for (let n = 0; n < 4; n++) {
        ctx.rotate(Math.PI / 2);
        ctx.beginPath();
        ctx.moveTo(br - tick, -br);
        ctx.lineTo(br, -br);
        ctx.lineTo(br, -br + tick);
        ctx.stroke();
      }
      ctx.restore();
    }

    const barW = Math.max(r * 2, localPx(view, RENDER.healthBarMinWidthPx));
    healthBar(ctx, cx - barW / 2, cy - r - localPx(view, 10), barW, localPx(view, 4), frac,
      collapsing ? '#ff4d4d' : frac < 0.5 ? '#ffb02e' : '#7be196');

    ctx.font = `bold ${localPx(view, RENDER.labelMinPx)}px ui-monospace, monospace`;
    ctx.textAlign = 'center';
    if (collapsing) {
      ctx.fillStyle = '#ff6b6b';
      ctx.fillText('COLLAPSING', cx, cy - r - localPx(view, 14));
    } else if (alarm) {
      ctx.fillStyle = '#ff5a5a';
      ctx.fillText('UNDER ATTACK', cx, cy - r - localPx(view, 14));
    } else if (occupied) {
      ctx.fillStyle = '#ffd666';
      ctx.fillText('OCCUPIED', cx, cy - r - localPx(view, 14));
    } else if (t.upgrade) {
      const which = t.upgrade.which === 'weapon' ? 'W' : 'E';
      ctx.fillStyle = '#77eef6';
      ctx.fillText(`UPG ${which}${t.upgrade.toLevel} ${(t.upgrade.progress * 100).toFixed(0)}%`,
        cx, cy - r - localPx(view, 14));
    } else if (!t.built) {
      ctx.fillStyle = '#9aefad';
      ctx.fillText(`BUILD ${(t.progress * 100).toFixed(0)}%`, cx, cy - r - localPx(view, 14));
    } else if (g.shelter.towerId === t.id && g.shelter.progress > 0) {
      const progress = g.shelter.progress / g.shelter.required;
      ctx.strokeStyle = '#7be196';
      ctx.lineWidth = localPx(view, 3);
      ctx.beginPath();
      ctx.arc(cx, cy, r + localPx(view, 5), -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * progress);
      ctx.stroke();
      ctx.fillStyle = '#bff5cc';
      ctx.fillText(`SHELTER ${(progress * 100).toFixed(0)}%`, cx, cy - r - localPx(view, 14));
    }
    ctx.fillStyle = t.keep ? '#ffe59b' : '#e6ecf5';
    ctx.fillText(t.keep ? 'KEEP' : `W${t.wLevel}`, cx, cy + localPx(view, 3));
  }
}

function drawEnemies(ctx, g, view) {
  for (const e of g.enemies) {
    if (!inView(view, e.x, e.y, 2)) continue;
    const visible = pointVisible(g, e.x, e.y);
    const cx = e.x * TP;
    const cy = e.y * TP;
    const r = Math.max(e.def.radius * TP, localPx(view, RENDER.enemyMinRadiusPx));
    if (!visible) {
      if (g.debug.showFog) {
        ctx.strokeStyle = 'rgba(255,110,110,0.8)';
        ctx.lineWidth = localPx(view, 1.5);
        ctx.setLineDash([localPx(view, 3), localPx(view, 2)]);
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      continue;
    }
    ctx.fillStyle = e.flash > 0 ? '#ffffff' : e.def.color;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.lineWidth = localPx(view, 1.5);
    ctx.stroke();
    if (e.hp < e.maxHp) {
      const barW = Math.max(r * 2, localPx(view, RENDER.healthBarMinWidthPx));
      healthBar(ctx, cx - barW / 2, cy - r - localPx(view, 5), barW, localPx(view, 3), e.hp / e.maxHp, '#ff8a8a');
    }
  }
}

function drawPlayer(ctx, g, view) {
  const p = g.player;
  const cx = p.x * TP;
  const cy = p.y * TP;
  const r = Math.max(PLAYER.radius * TP, localPx(view, RENDER.playerMinRadiusPx));

  ctx.strokeStyle = 'rgba(255,255,255,0.13)';
  ctx.lineWidth = localPx(view, 1);
  ctx.beginPath();
  ctx.arc(cx, cy, PLAYER.presenceRadius * TP, 0, Math.PI * 2);
  ctx.stroke();

  ctx.fillStyle = g.arch.color;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#10141a';
  ctx.lineWidth = localPx(view, 2);
  ctx.stroke();

  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = localPx(view, 2);
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + p.facing.x * r * 1.7, cy + p.facing.y * r * 1.7);
  ctx.stroke();

  const barW = Math.max(localPx(view, RENDER.healthBarMinWidthPx), r * 3.2);
  healthBar(ctx, cx - barW / 2, cy - r - localPx(view, 9), barW, localPx(view, 4), p.hp / p.maxHp,
    p.hp / p.maxHp < 0.34 ? '#ff4d4d' : '#7be196');

  if (g.phase === 'combat' && g.occupiedTowerId === null) {
    const hunters = g.enemies.filter((e) =>
      (e.targetKind === 'player' || e.aggroPlayer || e.playerAggro) && pointVisible(g, e.x, e.y)).length;
    ctx.font = `bold ${localPx(view, RENDER.labelMinPx + 2)}px ui-monospace, monospace`;
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ff5a5a';
    ctx.fillText(`EXPOSED · ${hunters} AGGRO`, cx, cy - r - localPx(view, 16));
  }
}

function drawResourceSites(ctx, g, view) {
  const groups = [
    ['stone', g.map.stoneSites || [], '#aeb6bd'],
    ['gold', g.map.goldSites || [], '#f2c94c'],
  ];
  for (const [type, sites, color] of groups) {
    for (const site of sites) {
      if (!inView(view, site.x, site.y, 2)) continue;
      if (!g.debug.showFog && !tileExplored(g, Math.floor(site.x), Math.floor(site.y))) continue;
      const cx = site.x * TP;
      const cy = site.y * TP;
      const r = Math.max(TP * 0.35, localPx(view, 5));
      ctx.fillStyle = color;
      ctx.strokeStyle = 'rgba(20,22,24,0.85)';
      ctx.lineWidth = localPx(view, 1.5);
      ctx.beginPath();
      if (type === 'gold') {
        ctx.moveTo(cx, cy - r); ctx.lineTo(cx + r, cy); ctx.lineTo(cx, cy + r); ctx.lineTo(cx - r, cy); ctx.closePath();
      } else {
        ctx.moveTo(cx - r, cy + r * 0.7); ctx.lineTo(cx - r * 0.6, cy - r * 0.5);
        ctx.lineTo(cx + r * 0.25, cy - r); ctx.lineTo(cx + r, cy + r * 0.65); ctx.closePath();
      }
      ctx.fill(); ctx.stroke();
      if ((site.mult || site.tier === 'rich') > 1) {
        ctx.fillStyle = '#fff4c2';
        ctx.fillRect(cx - localPx(view, 1), cy - localPx(view, 1), localPx(view, 2), localPx(view, 2));
      }
    }
  }
}

const BUILDING_STYLE = {
  farm: { color: '#c6a85b', label: 'FARM', resource: 'food' },
  quarry: { color: '#9da7ad', label: 'QUARRY', resource: 'stone' },
  mine: { color: '#d3a92f', label: 'GOLD MINE', resource: 'gold' },
};

function drawBuildings(ctx, g, view) {
  for (const b of g.buildings || []) {
    if (!inView(view, b.x, b.y, 3)) continue;
    if (!g.debug.showFog && !tileExplored(g, Math.floor(b.x), Math.floor(b.y))) continue;
    const style = BUILDING_STYLE[b.type] || BUILDING_STYLE.farm;
    const cx = b.x * TP;
    const cy = b.y * TP;
    const r = Math.max(TP * 0.48, localPx(view, 7));
    const selected = g.selectedBuildingId === b.id || g.selectedBuilding?.id === b.id;
    const alarm = Number.isFinite(b.unseenHitAt) && g.time - b.unseenHitAt < 1.5;

    if (b.destroyed || b.hp <= 0) {
      ctx.fillStyle = 'rgba(70,65,58,0.85)';
      for (let n = 0; n < 4; n++) {
        const a = n * 1.7 + b.id;
        ctx.fillRect(cx + Math.cos(a) * r * 0.7 - r * 0.2, cy + Math.sin(a) * r * 0.45 - r * 0.12, r * 0.4, r * 0.24);
      }
      continue;
    }

    ctx.fillStyle = b.built ? style.color : 'rgba(137,126,103,0.62)';
    ctx.strokeStyle = alarm ? '#ff5a5a' : selected ? '#e7f2ff' : '#2b2924';
    ctx.lineWidth = localPx(view, selected ? 3 : 2);
    ctx.beginPath();
    if (b.type === 'farm') ctx.rect(cx - r, cy - r * 0.62, r * 2, r * 1.24);
    else if (b.type === 'quarry') {
      ctx.moveTo(cx - r, cy + r * 0.65); ctx.lineTo(cx - r * 0.55, cy - r * 0.75);
      ctx.lineTo(cx + r * 0.28, cy - r); ctx.lineTo(cx + r, cy + r * 0.62); ctx.closePath();
    } else {
      ctx.rect(cx - r * 0.75, cy - r * 0.8, r * 1.5, r * 1.6);
    }
    ctx.fill(); ctx.stroke();

    if (b.type === 'farm') {
      ctx.strokeStyle = '#78652e'; ctx.lineWidth = localPx(view, 1);
      for (let n = -1; n <= 1; n++) {
        ctx.beginPath(); ctx.moveTo(cx + n * r * 0.48, cy - r * 0.48); ctx.lineTo(cx + n * r * 0.48, cy + r * 0.48); ctx.stroke();
      }
    } else if (b.type === 'mine') {
      ctx.fillStyle = '#292722';
      ctx.beginPath(); ctx.arc(cx, cy + r * 0.2, r * 0.38, Math.PI, 0); ctx.fill();
    }

    if (!b.built) {
      ctx.strokeStyle = '#e7d6a5'; ctx.lineWidth = localPx(view, 1.5);
      ctx.beginPath(); ctx.moveTo(cx - r, cy - r); ctx.lineTo(cx + r, cy + r);
      ctx.moveTo(cx + r, cy - r); ctx.lineTo(cx - r, cy + r); ctx.stroke();
      ctx.strokeStyle = '#7be196'; ctx.lineWidth = localPx(view, 3);
      ctx.beginPath(); ctx.arc(cx, cy, r + localPx(view, 4), -Math.PI / 2,
        -Math.PI / 2 + Math.PI * 2 * Math.max(0, Math.min(1, b.progress || 0))); ctx.stroke();
    } else {
      const pulse = 0.48 + Math.sin(g.time * 3 + b.id) * 0.18;
      ctx.fillStyle = `rgba(123,225,150,${pulse})`;
      ctx.beginPath(); ctx.arc(cx + r * 0.78, cy - r * 0.78, localPx(view, 3), 0, Math.PI * 2); ctx.fill();
    }

    const frac = Math.max(0, b.hp / b.maxHp);
    if (frac < 1 || selected) healthBar(ctx, cx - r, cy - r - localPx(view, 7), r * 2, localPx(view, 4), frac,
      frac < 0.35 ? '#ff5a5a' : '#7be196');
    ctx.font = `bold ${localPx(view, RENDER.labelMinPx)}px ui-monospace, monospace`;
    ctx.textAlign = 'center'; ctx.fillStyle = '#f0eadb';
    ctx.fillText(alarm ? 'UNDER ATTACK' : b.built ? style.label : `BUILD ${Math.round((b.progress || 0) * 100)}%`,
      cx, cy - r - localPx(view, 11));
  }
}

// D81: stone segments; posterns read as a dark gate slot; damage as cracks.
function drawWalls(ctx, g, view) {
  for (const link of g.walls || []) {
    for (const seg of link.segments) {
      if (!inView(view, seg.x, seg.y, 2)) continue;
      if (!g.debug.showFog && !tileExplored(g, seg.tx, seg.ty)) continue;
      const jolt = seg.shake > 0 ? localPx(view, 2.5) * (seg.shake / BREACH.shake) : 0;
      const x = seg.tx * TP + (jolt ? (Math.random() - 0.5) * 2 * jolt : 0);
      const y = seg.ty * TP + (jolt ? (Math.random() - 0.5) * 2 * jolt : 0);
      if (seg.destroyed) {
        ctx.fillStyle = 'rgba(96,88,76,0.9)';
        for (let n = 0; n < 5; n++) {
          const a = n * 2.3 + seg.tx * 0.7 + seg.ty;
          ctx.fillRect(x + TP * (0.5 + Math.cos(a) * 0.3) - TP * 0.12,
            y + TP * (0.5 + Math.sin(a) * 0.3) - TP * 0.09, TP * 0.24, TP * 0.18);
        }
        continue;
      }
      const frac = Math.max(0, seg.hp / seg.maxHp);
      const pad = TP * 0.04;
      ctx.fillStyle = seg.flash > 0.5 ? '#f3e2c4' : link.built ? '#a59c8c' : 'rgba(184,174,152,0.72)';
      ctx.fillRect(x + pad, y + pad, TP - pad * 2, TP - pad * 2);
      ctx.strokeStyle = '#3b362e';
      ctx.lineWidth = localPx(view, 1.5);
      ctx.strokeRect(x + pad, y + pad, TP - pad * 2, TP - pad * 2);
      // Coursing, so a run of segments reads as masonry rather than road.
      const joint = (seg.tx + seg.ty) % 2 ? 0.35 : 0.65;
      ctx.strokeStyle = 'rgba(59,54,46,0.55)';
      ctx.lineWidth = localPx(view, 1);
      ctx.beginPath();
      ctx.moveTo(x + pad, y + TP / 2); ctx.lineTo(x + TP - pad, y + TP / 2);
      ctx.moveTo(x + TP * joint, y + pad); ctx.lineTo(x + TP * joint, y + TP / 2);
      ctx.stroke();
      if (seg.gate) {
        ctx.fillStyle = '#4a3420';
        ctx.fillRect(x + TP * 0.3, y + TP * 0.22, TP * 0.4, TP * 0.56);
        ctx.strokeStyle = '#d6b36a';
        ctx.lineWidth = localPx(view, 1.2);
        ctx.strokeRect(x + TP * 0.3, y + TP * 0.22, TP * 0.4, TP * 0.56);
      }
      if (!link.built) {
        ctx.strokeStyle = 'rgba(231,214,165,0.85)';
        ctx.lineWidth = localPx(view, 1);
        ctx.beginPath(); ctx.moveTo(x + pad, y + pad); ctx.lineTo(x + TP - pad, y + TP - pad); ctx.stroke();
      }
      if (frac < WALL.crackAt[0]) {
        ctx.strokeStyle = '#1f1b16';
        ctx.lineWidth = localPx(view, 1.6);
        ctx.beginPath();
        ctx.moveTo(x + TP * 0.2, y + TP * 0.15); ctx.lineTo(x + TP * 0.45, y + TP * 0.5); ctx.lineTo(x + TP * 0.35, y + TP * 0.85);
        if (frac < WALL.crackAt[1]) {
          ctx.moveTo(x + TP * 0.85, y + TP * 0.2); ctx.lineTo(x + TP * 0.55, y + TP * 0.55); ctx.lineTo(x + TP * 0.75, y + TP * 0.9);
        }
        ctx.stroke();
      }
      // HP bars only once damage matters: a finished wall below full, or any hit.
      if ((link.built && frac < 1) || seg.flash > 0) {
        healthBar(ctx, x + TP * 0.08, y - localPx(view, 5), TP * 0.84, localPx(view, 3), frac,
          frac < 0.34 ? '#ff5a5a' : frac < 0.66 ? '#ffd166' : '#7be196');
      }
    }
    if (!link.built) {
      const mid = link.segments[Math.floor(link.segments.length / 2)];
      if (mid && inView(view, mid.x, mid.y, 3) && (g.debug.showFog || tileExplored(g, mid.tx, mid.ty))) {
        ctx.font = `bold ${localPx(view, RENDER.labelMinPx)}px ui-monospace, monospace`;
        ctx.textAlign = 'center'; ctx.fillStyle = '#f0eadb';
        ctx.fillText(`WALL ${Math.round(link.progress * 100)}%`, mid.x * TP, mid.ty * TP - localPx(view, 8));
      }
    }
  }
}

function drawWallPreview(ctx, g, view) {
  const mode = g.wallMode;
  if (!mode || mode.fromId === null) return;
  const from = g.towers.find((t) => t.id === mode.fromId);
  if (!from) return;
  ctx.save();
  ctx.strokeStyle = 'rgba(255,214,102,0.8)';
  ctx.lineWidth = localPx(view, 2);
  ctx.setLineDash([6, 4]);
  ctx.beginPath(); ctx.arc(from.x * TP, from.y * TP, (from.radius + 0.4) * TP, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = 'rgba(255,214,102,0.22)';
  ctx.beginPath(); ctx.arc(from.x * TP, from.y * TP, WALL.maxLength * TP, 0, Math.PI * 2); ctx.stroke();
  ctx.setLineDash([]);
  const plan = mode.plan;
  if (plan) {
    const ok = plan.ok;
    plan.segments.forEach((tile, k) => {
      ctx.fillStyle = ok ? 'rgba(123,225,150,0.38)' : 'rgba(255,90,90,0.38)';
      ctx.fillRect(tile.x * TP, tile.y * TP, TP, TP);
      ctx.strokeStyle = ok ? '#7be196' : '#ff5a5a';
      ctx.lineWidth = localPx(view, k === 0 || k === plan.segments.length - 1 ? 2.5 : 1);
      ctx.strokeRect(tile.x * TP, tile.y * TP, TP, TP);
    });
    const to = g.towers.find((t) => t.id === plan.b);
    if (to) {
      ctx.font = `bold ${localPx(view, 11)}px ui-monospace, monospace`;
      ctx.textAlign = 'center';
      ctx.fillStyle = ok ? '#c9f7d4' : '#ffb0b0';
      ctx.fillText(ok ? `${plan.cost.stone} Stone` : plan.reasons[0],
        (from.x + to.x) / 2 * TP, (from.y + to.y) / 2 * TP - localPx(view, 12));
    }
  }
  ctx.restore();
}

/** Cyan brackets on what holding R would repair from here (D83: local only). */
function drawRepairTarget(ctx, g, view) {
  const t = repairTarget(g);
  if (!t) return;
  const r = t.wall ? TP * 0.62 : Math.max((t.radius ?? 0.55) * TP + localPx(view, 4), localPx(view, 10));
  const cx = t.x * TP;
  const cy = t.y * TP;
  const k = r * 0.45;
  ctx.save();
  ctx.strokeStyle = g.input.repair ? '#5ecbff' : 'rgba(94,203,255,0.55)';
  ctx.lineWidth = localPx(view, 2);
  ctx.beginPath();
  for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    ctx.moveTo(cx + sx * r, cy + sy * (r - k)); ctx.lineTo(cx + sx * r, cy + sy * r); ctx.lineTo(cx + sx * (r - k), cy + sy * r);
  }
  ctx.stroke();
  if (t.wall && t.destroyed) {
    ctx.font = `bold ${localPx(view, 10)}px ui-monospace, monospace`;
    ctx.textAlign = 'center'; ctx.fillStyle = '#9fe3ff';
    // Below the rubble: the player standing beside it carries labels above.
    ctx.fillText(`R: rebuild ${WALL.costStonePerSegment} Stone`, cx, cy + r + localPx(view, 12));
  }
  ctx.restore();
}

function drawKeepArrow(ctx, g, view) {
  const keep = g.towers.find((t) => t.keep);
  if (!keep) return;
  const sx = view.offsetX + keep.x * view.tilePx;
  const sy = view.offsetY + keep.y * view.tilePx;
  if (sx >= 16 && sy >= 16 && sx <= view.w - 16 && sy <= view.h - 16) return;
  const cx = view.w / 2;
  const cy = view.h / 2;
  const a = Math.atan2(sy - cy, sx - cx);
  const margin = 28;
  const scale = Math.min(
    Math.abs((cx - margin) / (Math.cos(a) || 1e-6)),
    Math.abs((cy - margin) / (Math.sin(a) || 1e-6)),
  );
  const x = cx + Math.cos(a) * scale;
  const y = cy + Math.sin(a) * scale;
  ctx.save(); ctx.translate(x, y); ctx.rotate(a);
  ctx.fillStyle = '#ffd666'; ctx.strokeStyle = '#17130a'; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(14, 0); ctx.lineTo(-9, -9); ctx.lineTo(-5, 0); ctx.lineTo(-9, 9); ctx.closePath(); ctx.fill(); ctx.stroke();
  ctx.rotate(-a); ctx.font = 'bold 11px ui-monospace, monospace'; ctx.textAlign = 'center'; ctx.fillStyle = '#fff1ba';
  ctx.fillText('KEEP', 0, -15); ctx.restore();
}

function ensureMinimap(layers) {
  if (layers.minimap) return layers.minimap;
  const canvas = document.createElement('canvas');
  canvas.width = MAP.w; canvas.height = MAP.h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#020304'; ctx.fillRect(0, 0, MAP.w, MAP.h);
  layers.minimap = { canvas, ctx, explored: new Uint8Array(MAP.w * MAP.h), exploredTiles: 0, fogVersion: -1 };
  return layers.minimap;
}

function updateMinimapTerrain(g, layers) {
  const mini = ensureMinimap(layers);
  if (mini.fogVersion === (g.fog?.version ?? 0)) return mini;
  for (let y = 0; y < MAP.h; y++) {
    for (let x = 0; x < MAP.w; x++) {
      const i = idx(x, y);
      if (mini.explored[i] || (g.fog && !g.fog.explored[i])) continue;
      mini.explored[i] = 1;
      mini.exploredTiles++;
      const base = BASE_COLOR[g.map.kind[i]];
      mini.ctx.fillStyle = shade(base, 0.62);
      mini.ctx.fillRect(x, y, 1, 1);
      if (g.map.road[i]) {
        mini.ctx.fillStyle = '#a58a5c'; mini.ctx.fillRect(x, y, 1, 1);
      } else if ((g.map.fertility?.[i] || 0) > 0) {
        mini.ctx.fillStyle = g.map.fertility[i] > 1 ? '#b5a84c' : '#7d8348';
        mini.ctx.fillRect(x, y, 1, 1);
      }
    }
  }
  mini.fogVersion = g.fog?.version ?? 0;
  return mini;
}

function miniPoint(ctx, rect, x, y, color, size = 2) {
  const px = rect.x + x / MAP.w * rect.w;
  const py = rect.y + y / MAP.h * rect.h;
  ctx.fillStyle = color; ctx.fillRect(px - size / 2, py - size / 2, size, size);
}

function drawMinimap(ctx, g, layers, view) {
  const mini = updateMinimapTerrain(g, layers);
  const maxW = Math.min(RENDER.minimapWidthPx || 260, Math.max(150, view.w * 0.27));
  const height = Math.min(RENDER.minimapHeightPx || 130, maxW * MAP.h / MAP.w);
  const rect = { w: maxW, h: height, x: view.w - maxW - 10, y: view.h - height - 10 };
  ctx.save();
  ctx.fillStyle = 'rgba(2,3,5,0.94)'; ctx.fillRect(rect.x - 3, rect.y - 3, rect.w + 6, rect.h + 6);
  ctx.imageSmoothingEnabled = false; ctx.drawImage(mini.canvas, rect.x, rect.y, rect.w, rect.h);

  for (const site of [...(g.map.stoneSites || []), ...(g.map.goldSites || [])]) {
    if (!tileExplored(g, Math.floor(site.x), Math.floor(site.y))) continue;
    const gold = (g.map.goldSites || []).includes(site);
    miniPoint(ctx, rect, site.x, site.y, gold ? '#ffd64f' : '#d8e0e5', 2);
  }
  for (const b of g.buildings || []) {
    if (b.destroyed || b.hp <= 0 || !tileExplored(g, Math.floor(b.x), Math.floor(b.y))) continue;
    miniPoint(ctx, rect, b.x, b.y, BUILDING_STYLE[b.type]?.color || '#ddd', 3);
  }
  for (const link of g.walls || []) {
    for (const seg of link.segments) {
      if (seg.destroyed || !tileExplored(g, seg.tx, seg.ty)) continue;
      miniPoint(ctx, rect, seg.x, seg.y, link.built ? '#d9d1c0' : '#9b937f', 2);
    }
  }
  for (const t of g.towers) {
    if (!tileExplored(g, Math.floor(t.x), Math.floor(t.y))) continue;
    miniPoint(ctx, rect, t.x, t.y, t.keep ? '#ffd666' : '#a8d2ff', t.keep ? 6 : 4);
  }
  miniPoint(ctx, rect, g.player.x, g.player.y, '#ffffff', 4);
  const px = rect.x + g.player.x / MAP.w * rect.w;
  const py = rect.y + g.player.y / MAP.h * rect.h;
  ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(px, py);
  ctx.lineTo(px + g.player.facing.x * 7, py + g.player.facing.y * 7); ctx.stroke();

  const wx0 = Math.max(0, -view.offsetX / view.tilePx);
  const wy0 = Math.max(0, -view.offsetY / view.tilePx);
  const ww = Math.min(MAP.w - wx0, view.w / view.tilePx);
  const wh = Math.min(MAP.h - wy0, view.h / view.tilePx);
  ctx.strokeStyle = 'rgba(255,255,255,0.8)'; ctx.lineWidth = 1;
  ctx.strokeRect(rect.x + wx0 / MAP.w * rect.w, rect.y + wy0 / MAP.h * rect.h,
    ww / MAP.w * rect.w, wh / MAP.h * rect.h);

  if (g.phase === 'warning' || g.phase === 'combat') {
    ctx.fillStyle = '#ff5b5b';
    for (const side of g.spawnSides || []) {
      const west = side === 'west';
      const x = west ? rect.x + 3 : rect.x + rect.w - 3;
      const y = rect.y + rect.h * 0.5;
      ctx.beginPath();
      if (west) { ctx.moveTo(x + 8, y); ctx.lineTo(x, y - 5); ctx.lineTo(x, y + 5); }
      else { ctx.moveTo(x - 8, y); ctx.lineTo(x, y - 5); ctx.lineTo(x, y + 5); }
      ctx.closePath(); ctx.fill();
    }
  }
  ctx.strokeStyle = '#697384'; ctx.strokeRect(rect.x - 0.5, rect.y - 0.5, rect.w + 1, rect.h + 1);
  ctx.restore();
  layers.minimapState = { ...rect, exploredTiles: mini.exploredTiles };
}

function drawDrops(ctx, g, view) {
  for (const d of g.drops) {
    if (!inView(view, d.x, d.y, 2)) continue;
    const cx = d.x * TP;
    const cy = d.y * TP;
    const left = 1 - d.t / DROP.lifetime;
    const bob = Math.sin(g.time * 5 + d.x) * localPx(view, 2);
    const radiusPx = d.category === 'equipment' ? 13 : 10;
    const r = localPx(view, radiusPx);
    if (!pointVisible(g, d.x, d.y)) {
      if (g.debug.showFog) {
        ctx.save();
        ctx.strokeStyle = 'rgba(255,185,90,0.85)';
        ctx.lineWidth = localPx(view, 1.5);
        ctx.setLineDash([localPx(view, 3), localPx(view, 2)]);
        ctx.strokeRect(cx - r * 0.72, cy - r * 0.72, r * 1.44, r * 1.44);
        ctx.restore();
      }
      continue;
    }
    ctx.save();
    ctx.fillStyle = d.def.color;
    ctx.strokeStyle = '#0c0f14';
    ctx.lineWidth = localPx(view, d.category === 'equipment' ? 3 : 2);
    ctx.beginPath();
    if (d.category === 'equipment') {
      ctx.moveTo(cx, cy - r + bob);
      ctx.lineTo(cx + r, cy + bob);
      ctx.lineTo(cx, cy + r + bob);
      ctx.lineTo(cx - r, cy + bob);
      ctx.closePath();
    } else {
      ctx.rect(cx - r * 0.72, cy - r * 0.72 + bob, r * 1.44, r * 1.44);
    }
    ctx.fill();
    ctx.stroke();

    // Category glyphs are geometric, so they remain readable without colour.
    ctx.strokeStyle = '#10141a';
    ctx.fillStyle = '#10141a';
    ctx.lineWidth = localPx(view, 2.2);
    if (d.category === 'equipment') {
      ctx.beginPath();
      ctx.arc(cx - r * 0.18, cy - r * 0.18 + bob, r * 0.23, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx, cy + bob);
      ctx.lineTo(cx + r * 0.48, cy + r * 0.48 + bob);
      ctx.stroke();
    } else if (d.category === 'supply' || d.category === 'resource') {
      for (let n = 0; n < 3; n++) {
        const h = r * (0.35 + n * 0.2);
        ctx.fillRect(cx - r * 0.5 + n * r * 0.34, cy + r * 0.42 + bob - h, r * 0.2, h);
      }
    } else {
      ctx.beginPath();
      ctx.moveTo(cx + r * 0.10, cy - r * 0.55 + bob);
      ctx.lineTo(cx - r * 0.30, cy + bob);
      ctx.lineTo(cx + r * 0.05, cy + bob);
      ctx.lineTo(cx - r * 0.10, cy + r * 0.55 + bob);
      ctx.lineTo(cx + r * 0.38, cy - r * 0.10 + bob);
      ctx.lineTo(cx, cy - r * 0.10 + bob);
      ctx.closePath();
      ctx.fill();
    }
    // Expiry ring: the reason to decide now rather than later.
    ctx.strokeStyle = left < 0.3 ? '#ff6b6b' : 'rgba(255,255,255,0.8)';
    ctx.lineWidth = localPx(view, 2.5);
    ctx.beginPath();
    ctx.arc(cx, cy + bob, r + localPx(view, 3), -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * left);
    ctx.stroke();
    ctx.font = `bold ${localPx(view, 8)}px ui-monospace, monospace`;
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ffffff';
    ctx.fillText(`${Math.ceil(DROP.lifetime - d.t)}`, cx, cy + r + localPx(view, 12));
    ctx.restore();
  }
}

function drawPaused(ctx, view) {
  ctx.save();
  ctx.fillStyle = 'rgba(5,7,10,0.30)';
  ctx.fillRect(0, 0, view.w, view.h);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = 'bold 34px ui-monospace, monospace';
  ctx.lineWidth = 6;
  ctx.strokeStyle = 'rgba(5,7,10,0.92)';
  const labelY = Math.max(42, view.h * 0.12);
  ctx.strokeText('PAUSED', view.w / 2, labelY);
  ctx.fillStyle = '#ffd666';
  ctx.fillText('PAUSED', view.w / 2, labelY);
  ctx.font = 'bold 12px ui-monospace, monospace';
  ctx.fillStyle = '#ffffff';
  ctx.fillText('P TO RESUME', view.w / 2, labelY + 30);
  ctx.restore();
}

function drawFx(ctx, g, view) {
  for (const tr of g.tracers) {
    if (!g.debug.showFog && (!pointVisible(g, tr.x0, tr.y0) || !pointVisible(g, tr.x1, tr.y1))) continue;
    ctx.strokeStyle = tr.color;
    ctx.globalAlpha = 1 - tr.t / tr.life;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(tr.x0 * TP, tr.y0 * TP);
    ctx.lineTo(tr.x1 * TP, tr.y1 * TP);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  for (const w of g.shockwaves || []) {
    if (!g.debug.showFog && !pointVisible(g, w.x, w.y)) continue;
    const k = w.t / w.life;
    ctx.globalAlpha = Math.max(0, 1 - k) * 0.9;
    ctx.strokeStyle = w.color;
    ctx.lineWidth = localPx(view, 2 + 4 * (1 - k));
    ctx.beginPath();
    ctx.arc(w.x * TP, w.y * TP, Math.max(1, w.radius * TP * (0.25 + 0.75 * Math.sqrt(k))), 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  for (const p of g.particles) {
    if (!g.debug.showFog && !pointVisible(g, p.x, p.y)) continue;
    ctx.globalAlpha = Math.max(0, 1 - p.t / p.life);
    ctx.fillStyle = p.color;
    ctx.fillRect(p.x * TP - p.size / 2, p.y * TP - p.size / 2, p.size, p.size);
  }
  ctx.globalAlpha = 1;
  ctx.font = `bold ${localPx(view, 12)}px ui-monospace, monospace`;
  ctx.textAlign = 'center';
  for (const f of g.floaters) {
    if (!g.debug.showFog && !pointVisible(g, f.x, f.y)) continue;
    ctx.globalAlpha = Math.max(0, 1 - f.t / f.life);
    ctx.fillStyle = f.color;
    ctx.fillText(f.text, f.x * TP, f.y * TP);
  }
  ctx.globalAlpha = 1;
}

function drawBuildPreview(ctx, g) {
  const { x, y } = g.buildSite || g.cursor;
  const check = g.buildCheck;
  if (!check) return;
  const cx = x * TP;
  const cy = y * TP;
  ctx.save();
  ctx.globalAlpha = 0.85;
  ctx.fillStyle = check.ok ? 'rgba(123,225,150,0.25)' : 'rgba(255,90,90,0.25)';
  ctx.strokeStyle = check.ok ? '#7be196' : '#ff5a5a';
  ctx.lineWidth = 2;
  const type = g.buildType || 'tower';
  const radius = type === 'tower' ? TOWER.radius * TP : TP * 0.52;
  ctx.beginPath();
  if (type === 'tower') ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  else ctx.rect(cx - radius, cy - radius, radius * 2, radius * 2);
  ctx.fill();
  ctx.stroke();

  if (type === 'tower') {
    ctx.setLineDash([5, 5]);
    ctx.strokeStyle = 'rgba(180,210,255,0.5)';
    ctx.beginPath();
    ctx.arc(cx, cy, TOWER.weapon.range * TP, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Minimum-spacing rings around existing towers, so refusals are legible.
  for (const t of type === 'tower' ? g.towers : []) {
    ctx.strokeStyle = 'rgba(255,120,120,0.25)';
    ctx.beginPath();
    ctx.arc(t.x * TP, t.y * TP, TOWER.minSpacing * TP, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

function drawFogStateTint(ctx, g) {
  if (!g.fog) return;
  ctx.save();
  for (let y = 0; y < MAP.h; y++) {
    for (let x = 0; x < MAP.w; x++) {
      const i = idx(x, y);
      ctx.fillStyle = g.fog.visible[i] ? 'rgba(55,235,105,0.16)'
        : g.fog.explored[i] ? 'rgba(255,180,45,0.18)'
          : 'rgba(255,45,45,0.20)';
      ctx.fillRect(x * TP, y * TP, TP, TP);
    }
  }
  ctx.restore();
}

function drawFogDebug(ctx, g, view) {
  if (!g.fog) return;
  const sources = [{ x: g.player.x, y: g.player.y, radius: VISION.player }];
  for (const t of g.towers) {
    if (!t.built) continue;
    sources.push({
      x: t.x,
      y: t.y,
      radius: Math.max(VISION.towerMin, towerStats(g, t).range + VISION.towerRangeMargin),
    });
  }

  ctx.save();
  for (const source of sources) {
    ctx.strokeStyle = 'rgba(195,245,255,0.8)';
    ctx.lineWidth = localPx(view, 1.5);
    ctx.beginPath();
    ctx.arc(source.x * TP, source.y * TP, source.radius * TP, 0, Math.PI * 2);
    ctx.stroke();

    const minX = Math.max(0, Math.floor(source.x - source.radius));
    const maxX = Math.min(MAP.w - 1, Math.ceil(source.x + source.radius));
    const minY = Math.max(0, Math.floor(source.y - source.radius));
    const maxY = Math.min(MAP.h - 1, Math.ceil(source.y + source.radius));
    ctx.strokeStyle = 'rgba(255,50,50,0.82)';
    ctx.lineWidth = localPx(view, 1);
    const arm = localPx(view, 2.5);
    for (let ty = minY; ty <= maxY; ty++) {
      for (let tx = minX; tx <= maxX; tx++) {
        const x = tx + 0.5;
        const y = ty + 0.5;
        if (Math.hypot(x - source.x, y - source.y) > source.radius) continue;
        if (hasLineOfSight(g.map, source.x, source.y, x, y)) continue;
        const cx = x * TP;
        const cy = y * TP;
        ctx.beginPath();
        ctx.moveTo(cx - arm, cy - arm);
        ctx.lineTo(cx + arm, cy + arm);
        ctx.moveTo(cx + arm, cy - arm);
        ctx.lineTo(cx - arm, cy + arm);
        ctx.stroke();
      }
    }
  }
  ctx.restore();
}

function drawFlowField(ctx, g, view) {
  // D82 keeps one cached field per enemy type. Prefer Runner for a readable
  // middle-speed diagnostic, then whichever field has already been requested.
  const cached = g.keepFields?.runner || Object.values(g.keepFields || {})[0];
  const field = cached?.field || cached;
  if (!field) return;
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.28)';
  ctx.lineWidth = 1;
  const bounds = visibleBounds(view, 0);
  for (let y = bounds.y0; y <= bounds.y1; y += 2) {
    for (let x = bounds.x0; x <= bounds.x1; x += 2) {
      if (!isPassable(g.map, x, y)) continue;
      let bd = field[idx(x, y)];
      if (!Number.isFinite(bd)) continue;
      let bx = 0;
      let by = 0;
      for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        if (!inBounds(x + ox, y + oy)) continue;
        const d = field[idx(x + ox, y + oy)];
        if (d < bd) { bd = d; bx = ox; by = oy; }
      }
      if (!bx && !by) continue;
      const px = (x + 0.5) * TP;
      const py = (y + 0.5) * TP;
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(px + bx * TP * 0.8, py + by * TP * 0.8);
      ctx.stroke();
    }
  }
  ctx.restore();
}
