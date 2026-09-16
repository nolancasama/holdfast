// Canvas drawing. Simple shapes only — readability over polish (plan §1).

import { MAP, T, TOWER, PLAYER, DROP, CAMERA, ELEV_BANDS } from './config.js';
import { idx, inBounds, isPassable } from './terrain.js';
import { towerStats } from './game.js';

const TP = MAP.tilePx;

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
      ctx.fillStyle = shade(BASE_COLOR[k], 0.70 + (e / (ELEV_BANDS - 1)) * 0.55);
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
  return c;
}

export function buildMinimapLayer(map, scale) {
  const c = document.createElement('canvas');
  c.width = Math.round(MAP.w * scale);
  c.height = Math.round(MAP.h * scale);
  const ctx = c.getContext('2d');
  for (let y = 0; y < MAP.h; y++) {
    for (let x = 0; x < MAP.w; x++) {
      const i = idx(x, y);
      ctx.fillStyle = shade(BASE_COLOR[map.kind[i]], 0.72 + (map.elev[i] / 3) * 0.5);
      ctx.fillRect(x * scale, y * scale, scale, scale);
      // Only genuinely rich ground is worth a mark, or the whole map goes gold.
      if (map.res[i] > 0.8) {
        ctx.fillStyle = 'rgba(255,205,90,0.55)';
        ctx.fillRect(x * scale, y * scale, scale, scale);
      }
    }
  }
  return c;
}

export function makeCamera() {
  return { x: 0, y: 0 };
}

export function updateCamera(cam, g, viewW, viewH) {
  const px = g.player.x * TP;
  const py = g.player.y * TP;
  const targetX = px - viewW / 2;
  const targetY = py - viewH / 2;
  cam.x += (targetX - cam.x) * CAMERA.lerp;
  cam.y += (targetY - cam.y) * CAMERA.lerp;
  cam.x = Math.max(0, Math.min(MAP.w * TP - viewW, cam.x));
  cam.y = Math.max(0, Math.min(MAP.h * TP - viewH, cam.y));
}

export function screenToWorld(cam, sx, sy) {
  return { x: (cam.x + sx) / TP, y: (cam.y + sy) / TP };
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

export function draw(ctx, g, cam, layers, view) {
  const { terrain } = layers;
  ctx.clearRect(0, 0, view.w, view.h);
  ctx.imageSmoothingEnabled = false;

  ctx.save();
  ctx.translate(-Math.round(cam.x), -Math.round(cam.y));

  const sx = Math.max(0, Math.floor(cam.x));
  const sy = Math.max(0, Math.floor(cam.y));
  const sw = Math.min(terrain.width - sx, view.w + 2);
  const sh = Math.min(terrain.height - sy, view.h + 2);
  ctx.drawImage(terrain, sx, sy, sw, sh, sx, sy, sw, sh);

  drawObjectiveZone(ctx, g);
  if (g.debug.showPaths) drawFlowField(ctx, g, cam, view);

  drawTowerRings(ctx, g);
  drawDrops(ctx, g);
  drawTowers(ctx, g);
  drawEnemies(ctx, g);
  drawPlayer(ctx, g);
  drawFx(ctx, g);
  if (g.buildMode) drawBuildPreview(ctx, g);

  ctx.restore();
  drawEdgeMarkers(ctx, g, cam, view);
}

function drawObjectiveZone(ctx, g) {
  const o = g.map.objective;
  const pulse = 0.5 + 0.5 * Math.sin(g.time * 2);
  ctx.save();
  ctx.setLineDash([9, 7]);
  ctx.lineWidth = 3;
  ctx.strokeStyle = `rgba(120,225,150,${0.45 + pulse * 0.4})`;
  ctx.beginPath();
  ctx.arc((o.x + 0.5) * TP, (o.y + 0.5) * TP, o.r * TP, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = `rgba(120,225,150,${0.05 + pulse * 0.04})`;
  ctx.fill();
  ctx.fillStyle = 'rgba(180,255,200,0.9)';
  ctx.font = 'bold 13px ui-monospace, monospace';
  ctx.textAlign = 'center';
  ctx.fillText('OBJECTIVE ZONE', (o.x + 0.5) * TP, (o.y - o.r - 0.4) * TP);
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

function drawTowers(ctx, g) {
  for (const t of g.towers) {
    const cx = t.x * TP;
    const cy = t.y * TP;
    const r = TOWER.radius * TP;
    const frac = t.hp / t.maxHp;
    const collapsing = t.built && frac < TOWER.collapsingAt;
    const occupied = t.id === g.occupiedTowerId;

    if (occupied) {
      const pulse = 0.5 + 0.5 * Math.sin(g.time * 6);
      ctx.strokeStyle = `rgba(255,214,102,${0.6 + pulse * 0.4})`;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(cx, cy, r + 7 + pulse * 3, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.fillStyle = t.built ? '#3f4754' : 'rgba(63,71,84,0.55)';
    ctx.strokeStyle = collapsing && Math.sin(g.time * 14) > 0 ? '#ff4d4d'
      : t.isObjective ? '#7be196'
      : t.id === g.selected ? '#cfe4ff' : '#20252e';
    ctx.lineWidth = t.id === g.selected || t.isObjective ? 3 : 2;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // Barrel pointing at whatever it is shooting.
    const target = g.enemies.find((e) => e.id === t.targetId);
    if (t.built && target) {
      const a = Math.atan2(target.y - t.y, target.x - t.x);
      ctx.strokeStyle = occupied ? '#ffe680' : '#aab4c2';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(a) * (r + 7), cy + Math.sin(a) * (r + 7));
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
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(cx, cy, r + 4, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * t.progress);
      ctx.stroke();
    }

    healthBar(ctx, cx - r, cy - r - 12, r * 2, 5, frac,
      collapsing ? '#ff4d4d' : frac < 0.5 ? '#ffb02e' : '#7be196');

    ctx.font = 'bold 10px ui-monospace, monospace';
    ctx.textAlign = 'center';
    if (collapsing) {
      ctx.fillStyle = '#ff6b6b';
      ctx.fillText('COLLAPSING', cx, cy - r - 17);
    } else if (occupied) {
      ctx.fillStyle = '#ffd666';
      ctx.fillText('OCCUPIED', cx, cy - r - 17);
    }
    ctx.fillStyle = '#e6ecf5';
    ctx.fillText(`W${t.wLevel} E${t.eLevel}`, cx, cy + 4);
  }
}

function drawEnemies(ctx, g) {
  for (const e of g.enemies) {
    const cx = e.x * TP;
    const cy = e.y * TP;
    const r = e.def.radius * TP;
    ctx.fillStyle = e.flash > 0 ? '#ffffff' : e.def.color;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    if (e.hp < e.maxHp) healthBar(ctx, cx - r, cy - r - 6, r * 2, 3, e.hp / e.maxHp, '#ff8a8a');
  }
}

function drawPlayer(ctx, g) {
  const p = g.player;
  const cx = p.x * TP;
  const cy = p.y * TP;
  const r = PLAYER.radius * TP;

  ctx.strokeStyle = 'rgba(255,255,255,0.13)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(cx, cy, PLAYER.presenceRadius * TP, 0, Math.PI * 2);
  ctx.stroke();

  ctx.fillStyle = g.arch.color;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#10141a';
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + p.facing.x * r * 1.7, cy + p.facing.y * r * 1.7);
  ctx.stroke();

  healthBar(ctx, cx - 18, cy - r - 13, 36, 5, p.hp / p.maxHp,
    p.hp / p.maxHp < 0.34 ? '#ff4d4d' : '#7be196');
}

function drawDrops(ctx, g) {
  for (const d of g.drops) {
    const cx = d.x * TP;
    const cy = d.y * TP;
    const left = 1 - d.t / DROP.lifetime;
    const bob = Math.sin(g.time * 5 + d.x) * 2;
    ctx.save();
    ctx.fillStyle = d.def.color;
    ctx.strokeStyle = '#0c0f14';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.rect(cx - 6, cy - 6 + bob, 12, 12);
    ctx.fill();
    ctx.stroke();
    // Expiry ring: the reason to decide now rather than later.
    ctx.strokeStyle = left < 0.3 ? '#ff6b6b' : 'rgba(255,255,255,0.8)';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(cx, cy + bob, 12, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * left);
    ctx.stroke();
    ctx.restore();
  }
}

function drawFx(ctx, g) {
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
  ctx.font = 'bold 12px ui-monospace, monospace';
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

function drawFlowField(ctx, g, cam, view) {
  const t = g.towers.find((o) => o.id === (g.selected ?? g.occupiedTowerId)) || g.towers[0];
  if (!t || !t.field) return;
  const field = t.field;
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.28)';
  ctx.lineWidth = 1;
  const x0 = Math.max(0, Math.floor(cam.x / TP));
  const y0 = Math.max(0, Math.floor(cam.y / TP));
  const x1 = Math.min(MAP.w - 1, Math.ceil((cam.x + view.w) / TP));
  const y1 = Math.min(MAP.h - 1, Math.ceil((cam.y + view.h) / TP));
  for (let y = y0; y <= y1; y += 2) {
    for (let x = x0; x <= x1; x += 2) {
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

/** Arrows at the screen edge pointing at off-screen towers and the objective. */
function drawEdgeMarkers(ctx, g, cam, view) {
  const marks = g.towers.map((t) => ({ x: t.x, y: t.y, color: t.isObjective ? '#7be196' : '#cfe4ff' }));
  marks.push({ x: g.map.objective.x, y: g.map.objective.y, color: '#7be196' });

  for (const m of marks) {
    const px = m.x * TP - cam.x;
    const py = m.y * TP - cam.y;
    if (px > 10 && py > 10 && px < view.w - 10 && py < view.h - 10) continue;
    const cx = Math.max(14, Math.min(view.w - 14, px));
    const cy = Math.max(14, Math.min(view.h - 14, py));
    const a = Math.atan2(py - view.h / 2, px - view.w / 2);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(a);
    ctx.fillStyle = m.color;
    ctx.globalAlpha = 0.75;
    ctx.beginPath();
    ctx.moveTo(7, 0);
    ctx.lineTo(-5, 5);
    ctx.lineTo(-5, -5);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
}

export function drawMinimap(ctx, g, base, cam, view, scale) {
  ctx.clearRect(0, 0, base.width, base.height);
  ctx.drawImage(base, 0, 0);

  const o = g.map.objective;
  ctx.strokeStyle = '#7be196';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(o.x * scale, o.y * scale, o.r * scale, 0, Math.PI * 2);
  ctx.stroke();

  for (const t of g.towers) {
    ctx.fillStyle = t.id === g.occupiedTowerId ? '#ffd666' : t.isObjective ? '#7be196' : '#cfe4ff';
    ctx.fillRect(t.x * scale - 2, t.y * scale - 2, 4, 4);
  }
  ctx.fillStyle = '#ff6b6b';
  for (const e of g.enemies) ctx.fillRect(e.x * scale - 1, e.y * scale - 1, 2, 2);
  ctx.fillStyle = '#ffd166';
  for (const d of g.drops) ctx.fillRect(d.x * scale - 1.5, d.y * scale - 1.5, 3, 3);

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(g.player.x * scale - 2, g.player.y * scale - 2, 4, 4);

  ctx.strokeStyle = 'rgba(255,255,255,0.55)';
  ctx.lineWidth = 1;
  ctx.strokeRect(cam.x / TP * scale, cam.y / TP * scale, view.w / TP * scale, view.h / TP * scale);
}
