// Canvas drawing. Simple shapes only — readability over polish (plan §1).

import { MAP, T, TOWER, PLAYER, DROP, RENDER, richnessTierForRate } from './config.js';
import { idx, inBounds, isPassable } from './terrain.js';
import { isHunting, towerStats } from './game.js';

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

/** Pre-render the whole battlefield once; per-frame we only blit the visible slice. */
export function buildTerrainLayer(map) {
  const c = document.createElement('canvas');
  c.width = MAP.w * TP;
  c.height = MAP.h * TP;
  const ctx = c.getContext('2d');

  for (let y = 0; y < MAP.h; y++) {
    for (let x = 0; x < MAP.w; x++) {
      const i = idx(x, y);
      const k = map.kind[i];
      const e = map.elev[i];
      const px = x * TP;
      const py = y * TP;
      // Higher ground reads brighter, so hills are visible without a legend.
      ctx.fillStyle = shade(BASE_COLOR[k], ELEV_SHADE[e] ?? ELEV_SHADE[1]);
      ctx.fillRect(px, py, TP, TP);

      if (k === T.FOREST) {
        ctx.fillStyle = 'rgba(20,38,20,0.75)';
        for (let n = 0; n < 3; n++) {
          const ox = ((x * 7 + y * 13 + n * 29) % 11) / 11 * TP;
          const oy = ((x * 17 + y * 5 + n * 41) % 11) / 11 * TP;
          ctx.beginPath();
          ctx.arc(px + ox, py + oy, TP * 0.19, 0, Math.PI * 2);
          ctx.fill();
        }
      } else if (k === T.MARSH) {
        ctx.strokeStyle = 'rgba(120,150,120,0.35)';
        ctx.lineWidth = 1;
        for (let n = 0; n < 2; n++) {
          const oy = py + ((x * 11 + y * 7 + n * 23) % 13) / 13 * TP;
          ctx.beginPath();
          ctx.moveTo(px + 2, oy);
          ctx.lineTo(px + TP - 2, oy);
          ctx.stroke();
        }
      } else if (k === T.SHALLOW) {
        ctx.strokeStyle = 'rgba(190,230,240,0.25)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(px + 1, py + TP * 0.55);
        ctx.lineTo(px + TP - 1, py + TP * 0.45);
        ctx.stroke();
      } else if (k === T.CLIFF) {
        // A dark face on any exposed south edge gives the ridge visible height.
        if (y + 1 < MAP.h && map.kind[idx(x, y + 1)] !== T.CLIFF) {
          ctx.fillStyle = 'rgba(20,18,16,0.55)';
          ctx.fillRect(px, py + TP * 0.62, TP, TP * 0.38);
        }
        ctx.fillStyle = 'rgba(255,255,255,0.10)';
        ctx.fillRect(px, py, TP, 2);
      }

      if (map.road[i]) {
        const roadColor = k === T.SHALLOW ? 'rgba(211,180,117,0.92)' : 'rgba(91,73,49,0.92)';
        const half = TP * RENDER.roadWidthFrac * 0.5;
        const cx = px + TP * 0.5;
        const cy = py + TP * 0.5;
        ctx.fillStyle = roadColor;
        ctx.fillRect(cx - half, cy - half, half * 2, half * 2);
        if (x > 0 && map.road[idx(x - 1, y)]) ctx.fillRect(px, cy - half, TP * 0.5, half * 2);
        if (x + 1 < MAP.w && map.road[idx(x + 1, y)]) ctx.fillRect(cx, cy - half, TP * 0.5, half * 2);
        if (y > 0 && map.road[idx(x, y - 1)]) ctx.fillRect(cx - half, py, half * 2, TP * 0.5);
        if (y + 1 < MAP.h && map.road[idx(x, y + 1)]) ctx.fillRect(cx - half, cy, half * 2, TP * 0.5);
        // D54: an entry road on the boundary column runs out through the map edge.
        if (x === 0) ctx.fillRect(px, cy - half, TP * 0.5, half * 2);
        if (x === MAP.w - 1) ctx.fillRect(cx, cy - half, TP * 0.5, half * 2);
        ctx.fillStyle = 'rgba(244,214,144,0.34)';
        ctx.fillRect(cx - half, cy - 1, half * 2, 2);
      }

      // D9: deposits are visible on the ground, so "why here" is readable.
      const r = map.res[i];
      if (r > 0.18) {   // the ambient floor never draws; only real deposits do
        const dots = Math.min(4, Math.round(r * 3));
        ctx.fillStyle = `rgba(255,205,90,${Math.min(0.75, 0.22 + r * 0.35)})`;
        for (let n = 0; n < dots; n++) {
          const ox = ((x * 31 + y * 19 + n * 37) % 13) / 13 * TP;
          const oy = ((x * 23 + y * 43 + n * 11) % 13) / 13 * TP;
          ctx.fillRect(px + ox, py + oy, 2, 2);
        }
      }
    }
  }

  // D35: quiet contour strokes make band changes explicit without covering
  // the terrain symbols. Each shared edge is drawn only once.
  ctx.lineWidth = 1.5;
  for (let y = 0; y < MAP.h; y++) {
    for (let x = 0; x < MAP.w; x++) {
      const i = idx(x, y);
      const e = map.elev[i];
      const cliff = map.kind[i] === T.CLIFF;
      const px = x * TP;
      const py = y * TP;
      const edge = (nx, ny, x0, y0, x1, y1) => {
        if (!inBounds(nx, ny)) return;
        const ni = idx(nx, ny);
        if (map.elev[ni] === e && (map.kind[ni] === T.CLIFF) === cliff) return;
        ctx.strokeStyle = cliff || map.kind[ni] === T.CLIFF
          ? 'rgba(25,20,16,0.52)' : 'rgba(244,236,195,0.26)';
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.stroke();
      };
      edge(x + 1, y, px + TP, py, px + TP, py + TP);
      edge(x, y + 1, px, py + TP, px + TP, py + TP);
    }
  }
  return c;
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

export function draw(ctx, g, layers, view) {
  const { terrain } = layers;
  ctx.clearRect(0, 0, view.w, view.h);
  ctx.imageSmoothingEnabled = false;

  ctx.save();
  ctx.translate(view.offsetX, view.offsetY);
  ctx.scale(view.tilePx / TP, view.tilePx / TP);
  ctx.drawImage(terrain, 0, 0);

  if (g.phase === 'warning') drawIncomingRoads(ctx, g);
  if (g.debug.showPaths) drawFlowField(ctx, g);

  drawDepositMarkers(ctx, g, view);
  drawTowerRings(ctx, g);
  drawDrops(ctx, g, view);
  drawTowers(ctx, g, view);
  drawEnemies(ctx, g, view);
  drawPlayer(ctx, g, view);
  drawFx(ctx, g, view);
  if (g.buildMode) drawBuildPreview(ctx, g);

  ctx.restore();

  if (g.paused) drawPaused(ctx, view);
}

const localPx = (view, pixels) => pixels * TP / view.tilePx;

function drawIncomingRoads(ctx, g) {
  const pulse = 0.5 + 0.5 * Math.sin(g.time * 6);
  ctx.save();
  ctx.fillStyle = `rgba(255,92,72,${0.20 + pulse * 0.24})`;
  for (let y = 0; y < MAP.h; y++) {
    for (let x = 0; x < MAP.w; x++) {
      if (!g.map.road[idx(x, y)]) continue;
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
    ctx.strokeStyle = 'rgba(255,220,120,0.35)';
    ctx.beginPath();
    ctx.arc(t.x * TP, t.y * TP, s.extractRadius * TP, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(180,210,255,0.4)';
    ctx.beginPath();
    ctx.arc(t.x * TP, t.y * TP, s.range * TP, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
}

function drawTowers(ctx, g, view) {
  for (const t of g.towers) {
    const cx = t.x * TP;
    const cy = t.y * TP;
    const r = Math.max(TOWER.radius * TP, localPx(view, RENDER.towerMinRadiusPx));
    const frac = t.hp / t.maxHp;
    const collapsing = t.built && frac < TOWER.collapsingAt;
    const occupied = t.id === g.occupiedTowerId;

    if (occupied) {
      const pulse = 0.5 + 0.5 * Math.sin(g.time * 6);
      ctx.strokeStyle = `rgba(255,214,102,${0.6 + pulse * 0.4})`;
      ctx.lineWidth = localPx(view, 3);
      ctx.beginPath();
      ctx.arc(cx, cy, r + localPx(view, 7 + pulse * 3), 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.fillStyle = t.built ? '#3f4754' : 'rgba(63,71,84,0.55)';
    ctx.strokeStyle = collapsing && Math.sin(g.time * 14) > 0 ? '#ff4d4d'
      : t.id === g.selected ? '#cfe4ff' : '#20252e';
    ctx.lineWidth = localPx(view, t.id === g.selected ? 3 : 2);
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // Barrel pointing at whatever it is shooting.
    const target = g.enemies.find((e) => e.id === t.targetId);
    if (t.built && target) {
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
      ctx.strokeStyle = '#7be196';
      ctx.lineWidth = localPx(view, 3);
      ctx.beginPath();
      ctx.arc(cx, cy, r + localPx(view, 4), -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * t.progress);
      ctx.stroke();
    }

    const barW = Math.max(r * 2, localPx(view, RENDER.healthBarMinWidthPx));
    healthBar(ctx, cx - barW / 2, cy - r - localPx(view, 10), barW, localPx(view, 4), frac,
      collapsing ? '#ff4d4d' : frac < 0.5 ? '#ffb02e' : '#7be196');

    ctx.font = `bold ${localPx(view, RENDER.labelMinPx)}px ui-monospace, monospace`;
    ctx.textAlign = 'center';
    if (collapsing) {
      ctx.fillStyle = '#ff6b6b';
      ctx.fillText('COLLAPSING', cx, cy - r - localPx(view, 14));
    } else if (occupied) {
      ctx.fillStyle = '#ffd666';
      ctx.fillText('OCCUPIED', cx, cy - r - localPx(view, 14));
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
    ctx.fillStyle = '#e6ecf5';
    ctx.fillText(`W${t.wLevel} E${t.eLevel}`, cx, cy + localPx(view, 3));
  }
}

function drawEnemies(ctx, g, view) {
  for (const e of g.enemies) {
    const cx = e.x * TP;
    const cy = e.y * TP;
    const r = Math.max(e.def.radius * TP, localPx(view, RENDER.enemyMinRadiusPx));
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
    const hunters = g.enemies.filter((e) => isHunting(g, e)).length;
    ctx.font = `bold ${localPx(view, RENDER.labelMinPx + 2)}px ui-monospace, monospace`;
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ff5a5a';
    ctx.fillText(`EXPOSED · ${hunters} HUNTING`, cx, cy - r - localPx(view, 16));
  }
}

function drawDepositMarkers(ctx, g, view) {
  if (view.tilePx < RENDER.resourceMarkerMinTilePx) return;
  const barW = localPx(view, 3.5);
  const gap = localPx(view, 1.5);
  const height = localPx(view, 7);
  for (const d of g.map.deposits) {
    const tier = richnessTierForRate(d.income);
    const totalW = tier.bars * barW + (tier.bars - 1) * gap;
    const x = (d.x + 0.5) * TP - totalW / 2;
    const y = (d.y + 0.5) * TP - height / 2;
    ctx.fillStyle = 'rgba(18,15,9,0.68)';
    ctx.fillRect(x - gap, y - gap, totalW + gap * 2, height + gap * 2);
    ctx.fillStyle = 'rgba(255,205,74,0.88)';
    for (let n = 0; n < tier.bars; n++) ctx.fillRect(x + n * (barW + gap), y, barW, height);
  }
}

function drawDrops(ctx, g, view) {
  for (const d of g.drops) {
    const cx = d.x * TP;
    const cy = d.y * TP;
    const left = 1 - d.t / DROP.lifetime;
    const bob = Math.sin(g.time * 5 + d.x) * localPx(view, 2);
    const radiusPx = d.category === 'equipment' ? 13 : 10;
    const r = localPx(view, radiusPx);
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
    } else if (d.category === 'materials') {
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
    ctx.strokeStyle = tr.color;
    ctx.globalAlpha = 1 - tr.t / tr.life;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(tr.x0 * TP, tr.y0 * TP);
    ctx.lineTo(tr.x1 * TP, tr.y1 * TP);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  for (const p of g.particles) {
    ctx.globalAlpha = Math.max(0, 1 - p.t / p.life);
    ctx.fillStyle = p.color;
    ctx.fillRect(p.x * TP - p.size / 2, p.y * TP - p.size / 2, p.size, p.size);
  }
  ctx.globalAlpha = 1;
  ctx.font = `bold ${localPx(view, 12)}px ui-monospace, monospace`;
  ctx.textAlign = 'center';
  for (const f of g.floaters) {
    ctx.globalAlpha = Math.max(0, 1 - f.t / f.life);
    ctx.fillStyle = f.color;
    ctx.fillText(f.text, f.x * TP, f.y * TP);
  }
  ctx.globalAlpha = 1;
}

function drawBuildPreview(ctx, g) {
  const { x, y } = g.cursor;
  const check = g.buildCheck;
  if (!check) return;
  const cx = x * TP;
  const cy = y * TP;
  ctx.save();
  ctx.globalAlpha = 0.85;
  ctx.fillStyle = check.ok ? 'rgba(123,225,150,0.25)' : 'rgba(255,90,90,0.25)';
  ctx.strokeStyle = check.ok ? '#7be196' : '#ff5a5a';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(cx, cy, TOWER.radius * TP, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  ctx.setLineDash([5, 5]);
  ctx.strokeStyle = 'rgba(255,220,120,0.55)';
  ctx.beginPath();
  ctx.arc(cx, cy, TOWER.extraction.radius * TP, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(180,210,255,0.5)';
  ctx.beginPath();
  ctx.arc(cx, cy, TOWER.weapon.range * TP, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);

  // Minimum-spacing rings around existing towers, so refusals are legible.
  for (const t of g.towers) {
    ctx.strokeStyle = 'rgba(255,120,120,0.25)';
    ctx.beginPath();
    ctx.arc(t.x * TP, t.y * TP, TOWER.minSpacing * TP, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

function drawFlowField(ctx, g) {
  const t = g.towers.find((o) => o.id === (g.selected ?? g.occupiedTowerId)) || g.towers[0];
  if (!t || !t.field) return;
  const field = t.field;
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.28)';
  ctx.lineWidth = 1;
  for (let y = 0; y < MAP.h; y += 2) {
    for (let x = 0; x < MAP.w; x += 2) {
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
