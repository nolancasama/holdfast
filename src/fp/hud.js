// D101: first-person DOM HUD. Reads simulation state and the current look
// target; never changes gameplay state.

import { MAP, WAVE, WALL, WORLD3D, TOWER, PLAYER } from '../config.js';
import {
  assaultIn, garrisonState, populationState, resourceState, towerCost, towerStats, towerMinRange, garrisonSlots,
  farmSupport, upgradeCost, upgradeState, towerConnectivity, repairCostPerHp, towerAlarmState,
  isTileExplored, isTileVisible, canPlaceAt, workerSlots, buildingOutput,
} from '../game.js';
import { headingDegrees } from './space.js';

const $ = (id) => document.getElementById(id);
const S = WORLD3D.tileMeters;
const fmt = (n, d = 1) => Number(n || 0).toFixed(d);
const LABEL = { tower: 'Tower', wall: 'Wall', farm: 'Farm', quarry: 'Quarry', mine: 'Gold Mine' };
const SIDE_HEADING = { west: 270, east: 90 };

function setText(el, text) { if (el.textContent !== text) el.textContent = text; }
function setHtml(el, html) { if (el.innerHTML !== html) el.innerHTML = html; }
function costText(cost) {
  if (!cost) return '';
  const parts = [];
  if (cost.stone > 0) parts.push(`${Math.ceil(cost.stone)} Stone`);
  if (cost.gold > 0) parts.push(`${Math.ceil(cost.gold)} Gold`);
  return parts.join(' · ') || 'free';
}
const clock = (s) => { const n = Math.max(0, Math.ceil(s)); return `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`; };

// --- compass ----------------------------------------------------------------
const PX_PER_DEG = 2.4;
function buildCompassTape() {
  const tape = $('compass-tape');
  const parts = [];
  for (let d = -360; d <= 720; d += 15) {
    const name = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' }[((d % 360) + 360) % 360];
    const left = d * PX_PER_DEG;
    if (name) parts.push(`<span class="cardinal" style="left:${left}px">${name}</span>`);
    else if (d % 45 === 0) parts.push(`<span style="left:${left}px">${((d % 360) + 360) % 360}</span>`);
    parts.push(`<span class="tick" style="left:${left}px"></span>`);
  }
  tape.innerHTML = parts.join('');
}
buildCompassTape();

function placeMarker(el, heading, target, width, label) {
  let delta = ((target - heading + 540) % 360) - 180;
  const half = width / 2 - 24;
  const px = Math.max(-half, Math.min(half, delta * PX_PER_DEG));
  el.style.left = `${width / 2 + px}px`;
  setText(el, `${Math.abs(delta) * PX_PER_DEG > half ? (delta < 0 ? '◀ ' : '') : '▲ '}${label}${Math.abs(delta) * PX_PER_DEG > half && delta > 0 ? ' ▶' : ''}`);
}

function updateCompass(g, intel) {
  const heading = headingDegrees(g.player.facing.x, g.player.facing.y);
  const width = $('compass').clientWidth;
  $('compass-tape').style.transform = `translateX(${-heading * PX_PER_DEG}px)`;
  const keep = g.towers.find((t) => t.keep);
  const keepEl = $('compass-keep');
  const dKeep = keep ? Math.hypot(keep.x - g.player.x, keep.y - g.player.y) : 0;
  keepEl.hidden = !keep || dKeep < 12;
  if (!keepEl.hidden) placeMarker(keepEl, heading, headingDegrees(keep.x - g.player.x, keep.y - g.player.y), width, `KEEP ${Math.round(dKeep * S)}m`);
  const threat = $('compass-threat');
  const sides = g.spawnSides || [];
  // D111: no omniscient assault direction in normal play - debug intel only.
  threat.hidden = !intel || !sides.length || g.phase === 'aftermath';
  if (!threat.hidden) {
    // Point at the nearest known mouth on the incoming side.
    const mouths = sides.flatMap((s) => g.map.spawns?.[s] || []);
    let best = null;
    for (const m of mouths) {
      const d = Math.hypot(m.x - g.player.x, m.y - g.player.y);
      if (!best || d < best.d) best = { ...m, d };
    }
    const target = best ? headingDegrees(best.x - g.player.x, best.y - g.player.y) : SIDE_HEADING[sides[0]];
    placeMarker(threat, heading, target, width, sides.map((s) => s.toUpperCase()).join('+'));
  }
}

// --- assault plaque -----------------------------------------------------------
function updatePhase(g, intel) {
  const el = $('phase');
  // D111: the assault schedule is internal. Its timer, direction and size are
  // debug intel; in normal play the player reads the world instead.
  el.hidden = !intel;
  if (!intel) return;
  const left = assaultIn(g);
  const sides = (g.spawnSides || []).map((s) => s.toUpperCase()).join(' + ') || 'UNKNOWN';
  let head = 'NEXT ASSAULT';
  let time = clock(left);
  let sub = `Approach: ${sides} · assault ${g.wave} of ${WAVE.totalToSurvive}`;
  let cls = 'panel';
  if (g.paused) { head = 'PAUSED'; }
  else if (g.phase === 'prep') {
    // D101: the plaque escalates; internally waves stay numbered.
    if (left <= 45) { head = `ENEMY MOVEMENT DETECTED — ${sides}`; cls += ' warn'; }
  } else if (g.phase === 'warning') {
    head = `ASSAULT IMMINENT — ${sides}`;
    cls += ' imminent';
    if (left <= 5) cls += ' urgent';
  } else if (g.phase === 'combat') {
    const n = g.enemies.filter((e) => !e.wild).length + (g.pendingSpawns || []).length;
    head = 'ASSAULT';
    time = `${n} attackers`;
    sub = `from the ${sides} · assault ${g.wave} of ${WAVE.totalToSurvive}`;
    cls += ' siege';
  } else if (g.phase === 'aftermath') {
    head = 'ASSAULT REPELLED';
    time = '';
    sub = 'Repair and expand.';
  }
  el.className = `hud ${cls} debug-intel`;
  setText($('phase-head'), head);
  setText($('phase-time'), time);
  setText($('phase-sub'), `${sub} · DEBUG`);
  $('start-early').hidden = g.paused || (g.phase !== 'prep' && g.phase !== 'warning');
}

// --- resources ------------------------------------------------------------------
function updateResources(g) {
  const rates = resourceState(g)?.rates || { stone: 0, gold: 0 };
  setText($('r-stone'), String(Math.floor(g.res.stone || 0)));
  setText($('r-gold'), String(Math.floor(g.res.gold || 0)));
  setText($('r-stone-rate'), rates.stone ? `+${fmt(rates.stone, 2)}/s` : '');
  setText($('r-gold-rate'), rates.gold ? `+${fmt(rates.gold, 2)}/s` : '');
  // D110: Population n / Food support, then where the people are.
  const pop = populationState(g);
  setText($('r-pop'), `${pop.total} / ${pop.support}`);
  setText($('r-pop-note'), pop.shortage ? 'FOOD SHORTAGE' : pop.growing ? 'growing' : '');
  $('r-pop-note').style.color = pop.shortage ? 'var(--red)' : '';
  setHtml($('r-roles'), `Workers <b>${pop.workers}</b> · Garrison <b>${pop.garrison}</b> · Free <b class="${pop.free ? 'free' : ''}">${pop.free}</b>`);
  const hp = Math.max(0, g.player.hp);
  setText($('r-hp'), String(Math.round(hp)));
  const frac = hp / g.player.maxHp;
  $('r-hpbar').style.width = `${frac * 100}%`;
  $('r-hpbar').style.background = frac < 0.34 ? 'var(--red)' : frac < 0.66 ? 'var(--gold)' : 'var(--green)';
}

// --- alerts / toasts / log -------------------------------------------------------
const toastSeen = new WeakSet();
const toastList = [];
function updateAlerts(g) {
  const alerts = [];
  for (const alarm of towerAlarmState(g)) {
    if (!alarm.active) continue;
    // Tower and building ids are separate sequences.
    const tower = alarm.kind === 'tower' ? g.towers.find((t) => t.id === alarm.id) : null;
    const building = alarm.kind === 'building' ? g.buildings.find((b) => b.id === alarm.id) : null;
    const target = building ? (LABEL[building.type] || 'Building') : tower?.keep ? 'KEEP' : 'Tower';
    const pos = tower || building;
    const where = pos ? compassWord(g, pos) : '';
    alerts.push(`<div class="alert">${target.toUpperCase()} UNDER ATTACK${where ? ` · ${where}` : ''}</div>`);
    if (alerts.length >= 2) break;
  }
  const pop = populationState(g);
  if (pop.shortage) alerts.push(`<div class="alert">FOOD SHORTAGE · ${pop.leaving ? 'PEOPLE ARE LEAVING' : 'staff or build a Farm'}</div>`);
  if (g.wallNotice?.until > g.time) alerts.push(`<div class="alert info">${g.wallNotice.text}</div>`);
  setHtml($('alerts'), alerts.join(''));

  // Simulation floaters (BREACH, NEST AGITATED...) become brief centre toasts.
  for (const f of g.floaters) {
    if (toastSeen.has(f)) continue;
    toastSeen.add(f);
    if (/^-?\d/.test(f.text)) continue;
    const d = Math.hypot(f.x - g.player.x, f.y - g.player.y);
    const important = /BREACH|CLEARED|AGITATED|CRUSHED/.test(f.text);
    if (!important && d > 25) continue;
    const text = /BREACH/.test(f.text) ? `WALL BREACHED · ${compassWord(g, f)}` : f.text;
    if (toastList.some((t) => t.text === text && g.time - t.at < 2)) continue;
    toastList.unshift({ text, color: f.color || '#fff', at: g.time });
  }
  while (toastList.length > 4 || (toastList.length && g.time - toastList[toastList.length - 1].at > 3.2)) toastList.pop();
  setHtml($('toasts'), toastList.map((t) => `<div class="toast" style="color:${t.color}">${t.text}</div>`).join(''));
  setHtml($('log'), g.log.slice(0, 5).map((l) => `<div>${l.text}</div>`).join(''));
}

/** Where something is relative to the player, as "WEST, 60m". */
function compassWord(g, pos) {
  const d = Math.hypot(pos.x - g.player.x, pos.y - g.player.y);
  if (d < 6) return 'HERE';
  const h = headingDegrees(pos.x - g.player.x, pos.y - g.player.y);
  const names = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return `${names[Math.round(h / 45) % 8]} ${Math.round(d * S)}m`;
}

// --- look target prompt + inspect panel -------------------------------------------
function hpLine(s) {
  const frac = Math.max(0, s.hp / s.maxHp);
  const color = frac < 0.34 ? 'var(--red)' : frac < 0.6 ? 'var(--gold)' : 'var(--green)';
  return `<div class="hpbar hpline"><i style="width:${frac * 100}%;background:${color}"></i></div>`;
}

function updatePrompt(g, look, ui) {
  const prompt = $('prompt');
  const inspect = $('inspect');
  const t = look?.target;
  if (!t || ui.buildMode) { prompt.hidden = true; inspect.hidden = true; return; }
  const ref = t.ref;
  const dTiles = Math.hypot(ref.x - g.player.x, ref.y - g.player.y);
  const near = dTiles <= WORLD3D.interactRange;
  let title = '';
  let body = '';
  const keys = [];
  let hostile = false;
  let rows = null;
  if (t.kind === 'tower') {
    const tower = ref;
    const stats = towerStats(g, tower);
    title = tower.keep ? 'KEEP' : `TOWER · ${towerConnectivity(g, tower) === 'outpost' ? 'OUTPOST' : 'CONNECTED'}`;
    body = !tower.built ? `under construction ${Math.round((tower.progress || 0) * 100)}%`
      : `HP ${Math.round(tower.hp)} / ${tower.maxHp} · garrison ${tower.garrison || 0}/${garrisonSlots(tower)}`;
    if (tower.built && dTiles <= PLAYER.presenceRadius + tower.radius + 0.3 && g.player.perchId !== tower.id) keys.push('<kbd>E</kbd> climb');
    if (tower.hp < tower.maxHp - 0.5 && ui.repairable) keys.push('<kbd>R</kbd> repair');
    if (near && tower.built) {
      const food = garrisonState(g);
      if ((tower.garrison || 0) < garrisonSlots(tower)) keys.push(food.free > 0 ? '<kbd>G</kbd> garrison' : '<span class="warn">no free people</span>');
      if (tower.garrison > 0) keys.push('<kbd>⇧G</kbd> withdraw');
      const up = upgradeCost(tower);
      if (up && !tower.upgrade) keys.push(`<kbd>U</kbd> upgrade (${costText(up)})`);
    }
    if (near) {
      const up = upgradeState(g, tower);
      rows = [
        ['Damage', `${fmt(stats.damage)} × ${fmt(stats.fireRate, 2)}/s`],
        ['Range', `${fmt(towerMinRange(g, tower))}–${fmt(stats.range)} tiles`],
        ['Blind spot', `inside ${Math.round(towerMinRange(g, tower) * S)} m`],
        ['Weapon', `W${tower.wLevel}${up ? ` → W${up.toLevel} (${up.remaining.toFixed(0)}s)` : ''}`],
        ['Garrison', `${tower.garrison || 0} / ${garrisonSlots(tower)}${stats.occupied ? ' · occupied' : ''}`],
        ['Repair', tower.hp < tower.maxHp - 0.5 ? `${Math.ceil((tower.maxHp - tower.hp) * repairCostPerHp(g))} Stone` : 'undamaged'],
      ];
    }
  } else if (t.kind === 'building') {
    const b = ref;
    title = LABEL[b.type].toUpperCase();
    // D110: cause and effect - workers in, output out.
    const slots = workerSlots(b);
    const out = buildingOutput(b);
    const outText = b.type === 'farm' ? `Food support +${out}` : `${b.type === 'quarry' ? 'Stone' : 'Gold'} +${fmt(out, 2)}/s`;
    const idle = b.built && !(b.workers > 0) ? ' <span class="warn">· idle: needs workers</span>' : '';
    body = !b.built ? `under construction ${Math.round((b.progress || 0) * 100)}% · Workers ${b.workers || 0} / ${slots}`
      : `Workers ${b.workers || 0} / ${slots} · ${outText}${idle}`;
    if (near) {
      if ((b.workers || 0) < slots) keys.push(populationState(g).free > 0 ? '<kbd>G</kbd> assign' : '<span class="warn">no free people</span>');
      if (b.workers > 0) keys.push('<kbd>⇧G</kbd> remove');
    }
    if (b.hp < b.maxHp - 0.5 && ui.repairable) keys.push('<kbd>R</kbd> repair');
    if (near && b.built) {
      rows = [
        ['Workers', `${b.workers || 0} / ${slots}`],
        [b.type === 'farm' ? 'Food support' : b.type === 'quarry' ? 'Stone' : 'Gold',
          b.type === 'farm' ? `+${out} (full: ${farmSupport(b)})` : `+${fmt(out, 2)}/s (full: ${fmt(b.rate, 2)})`],
        ['HP', `${Math.round(b.hp)} / ${b.maxHp}`],
      ];
    }
  } else if (t.kind === 'wall') {
    const seg = ref;
    title = seg.gate ? 'POSTERN' : 'WALL';
    body = seg.destroyed ? '<span class="warn">BREACHED — rubble</span>' : `HP ${Math.round(seg.hp)} / ${seg.maxHp}${seg.gate ? ' · you can pass, enemies cannot' : ''}`;
    if (ui.repairable) keys.push(seg.destroyed ? `<kbd>R</kbd> rebuild (${WALL.costStonePerSegment} Stone)` : '<kbd>R</kbd> repair');
  } else if (t.kind === 'nest') {
    title = 'NEST';
    hostile = true;
    body = t.ref.destroyed ? 'cleared' : `${t.ref.state === 'agitated' ? '<span class="warn">AGITATED</span>' : 'dormant'}${t.ref.underSiege ? ' · <span class="good">under siege</span>' : ''} · Towers destroy nests; they cannot fire inside their blind spot`;
  } else if (t.kind === 'enemy') {
    title = (t.ref.def?.name || t.ref.type).toUpperCase();
    hostile = true;
    body = `HP ${Math.round(t.ref.hp)}`;
  } else if (t.kind === 'site') {
    const site = ref;
    const gold = site.type === 'gold' || (g.map.goldSites || []).includes(site);
    title = gold ? 'GOLD DEPOSIT' : 'STONE DEPOSIT';
    body = `${site.mult > 1 ? 'Rich · ' : ''}${gold ? 'build a Gold Mine here' : 'build a Quarry here'}`;
    keys.push(`<kbd>${gold ? 5 : 4}</kbd> build`);
  }
  prompt.hidden = false;
  setText($('prompt-title'), title);
  $('prompt-title').className = hostile ? 'hostile' : '';
  setHtml($('prompt-body'), body + (ref.maxHp && !t.ref.destroyed && t.kind !== 'enemy' ? hpLine(ref) : ''));
  setHtml($('prompt-keys'), keys.join(' '));
  inspect.hidden = !rows;
  if (rows) setHtml(inspect, `<h3>${title}</h3>${rows.map(([k, v]) => `<div class="row"><span>${k}</span><span>${v}</span></div>`).join('')}`);
}

// --- build panel + bar ---------------------------------------------------------------
function updateBuild(g, ui) {
  const panel = $('build-panel');
  const ch = $('crosshair');
  const costs = {
    tower: towerCost(g),
    wall: null,
    farm: canPlaceAt(g, g.player.x, g.player.y, 'farm').cost,
    quarry: canPlaceAt(g, g.player.x, g.player.y, 'quarry').cost,
    mine: canPlaceAt(g, g.player.x, g.player.y, 'mine').cost,
  };
  for (const type of ['tower', 'wall', 'farm', 'quarry', 'mine']) {
    const slot = $(`slot-${type}`);
    slot.classList.toggle('on', ui.buildMode && ui.buildType === type);
    const cost = costs[type];
    setText(slot.querySelector('.c'), type === 'wall' ? `${WALL.costStonePerSegment} Stone/seg` : costText(cost));
    slot.classList.toggle('poor', !!cost && (g.res.stone < (cost.stone || 0) || g.res.gold < (cost.gold || 0)));
  }
  if (!ui.buildMode) {
    panel.hidden = true;
    ch.className = 'hud';
    return;
  }
  panel.hidden = false;
  let status = '';
  let ok = false;
  if (ui.buildType === 'wall') {
    const w = ui.wall || {};
    const a = g.towers.find((t) => t.id === w.a);
    if (!a) status = 'Look at a finished Tower you stand at (or on) and click — corner A.';
    else if (!w.plan) status = `Tower A chosen. Look at a second Tower and click to build. ${w.hoverReason ? `<span class="warn">${w.hoverReason}</span>` : ''}`;
    else {
      const reasons = [...(w.plan.reasons || [])];
      if (!w.near) reasons.push('stand at (or on) one of the two Towers');
      ok = reasons.length === 0;
      status = `${w.plan.segments.length} segments · ${Math.round(w.plan.length * S)} m · ${Math.ceil(w.plan.cost.stone)} Stone<br />`
        + (ok ? '<span class="good">Click to build the wall.</span>' : `<span class="warn">${[...new Set(reasons)].join(' · ')}</span>`);
    }
    if (w.notice) status += `<br /><span class="warn">${w.notice}</span>`;
  } else {
    const site = ui.site;
    const check = site?.check;
    if (!site) status = '<span class="warn">Look at open ground within reach.</span>';
    else {
      ok = !!check?.ok;
      const info = [];
      info.push(costText(check.cost));
      if (ui.buildType === 'tower') info.push(`fires ${Math.round(TOWER.weapon.minRange * S)}–${Math.round(TOWER.weapon.range * S)} m · red disc = blind spot`);
      if (ui.buildType === 'farm' && Number.isFinite(check.fertility)) info.push(`fertility ×${fmt(check.fertility, 2)} · Food support +${farmSupport({ rate: check.rate })} with 1 worker`);
      if ((ui.buildType === 'quarry' || ui.buildType === 'mine') && check.rate) info.push(`${fmt(check.rate, 2)}/s with 2 workers`);
      status = `${info.join(' · ')}<br />${ok ? '<span class="good">Click to build.</span>'
        : `<span class="warn">${(check.reasons || []).join(' · ')}</span>`}`;
    }
  }
  setText($('build-name'), `BUILD ${LABEL[ui.buildType].toUpperCase()}`);
  setHtml($('build-status'), status);
  ch.className = `hud ${ok ? 'build' : 'bad'}`;
}

// --- minimap ------------------------------------------------------------------------
const KIND_RGB = [[96, 128, 66], [58, 92, 44], [80, 86, 58], [86, 136, 160], [36, 72, 108], [128, 124, 116]];
let miniTerrain = null;
let miniFogVersion = -1;
let miniGame = null;

function ensureMiniTerrain(g) {
  if (miniGame !== g || !miniTerrain) {
    miniGame = g;
    miniTerrain = document.createElement('canvas');
    miniTerrain.width = MAP.w;
    miniTerrain.height = MAP.h;
    miniFogVersion = -1;
  }
  if (miniFogVersion === g.fog.version) return miniTerrain;
  miniFogVersion = g.fog.version;
  const ctx = miniTerrain.getContext('2d');
  const img = ctx.createImageData(MAP.w, MAP.h);
  for (let i = 0; i < MAP.w * MAP.h; i++) {
    let rgb = [8, 9, 10];
    const explored = g.fog.explored[i];
    if (explored) {
      rgb = KIND_RGB[g.map.kind[i]] || rgb;
      const fert = g.map.fertility?.[i] || 0;
      if (fert > 0) rgb = fert > 1 ? [176, 166, 74] : [126, 132, 70];
      const band = [0.8, 1, 1.18][g.map.elev[i]] || 1;
      rgb = rgb.map((v) => Math.min(255, v * band));
    }
    // Roads stay readable beyond explored ground (strategic landmarks).
    if (g.map.road[i]) rgb = explored ? [170, 142, 96] : [86, 72, 50];
    img.data[i * 4] = rgb[0];
    img.data[i * 4 + 1] = rgb[1];
    img.data[i * 4 + 2] = rgb[2];
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return miniTerrain;
}

function updateMinimap(g, intel) {
  const canvas = $('minimap');
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  const sx = W / MAP.w;
  const sy = H / MAP.h;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(ensureMiniTerrain(g), 0, 0, W, H);
  const pt = (x, y, color, size) => { ctx.fillStyle = color; ctx.fillRect(x * sx - size / 2, y * sy - size / 2, size, size); };
  const explored = (x, y) => isTileExplored(g, Math.floor(x), Math.floor(y));
  for (const site of g.map.stoneSites || []) if (explored(site.x, site.y)) pt(site.x, site.y, '#dfe6ea', 3);
  for (const site of g.map.goldSites || []) if (explored(site.x, site.y)) pt(site.x, site.y, '#ffd64f', 3);
  for (const n of g.nests) {
    if (!explored(n.x, n.y)) continue;
    pt(n.x, n.y, n.destroyed ? '#55603a' : n.state === 'agitated' ? '#e8ff6a' : '#a2c94a', n.destroyed ? 3 : 6);
    if (!n.destroyed) pt(n.x, n.y, '#20280c', 2);
  }
  for (const b of g.buildings) {
    if (b.destroyed) continue;
    pt(b.x, b.y, b.type === 'farm' ? '#c6e07a' : b.type === 'quarry' ? '#cfd6dc' : '#ffcf3f', 4);
  }
  for (const link of g.walls) for (const seg of link.segments) {
    if (!seg.present || seg.cancelled) continue;
    pt(seg.x, seg.y, seg.destroyed ? '#ff5a3a' : '#e8dfcc', 2.5);
  }
  for (const t of g.towers) {
    const color = t.keep ? '#ffd666' : towerConnectivity(g, t) === 'outpost' ? '#f2a93b' : '#70c9ff';
    pt(t.x, t.y, color, t.keep ? 8 : 5);
  }
  // Live hostile information only where currently observed.
  for (const e of g.enemies) {
    if (!intel && !isTileVisible(g, Math.floor(e.x), Math.floor(e.y))) continue;
    pt(e.x, e.y, e.wild ? '#d7f36b' : '#ff4a3a', e.type === 'heavy' ? 4 : 2.5);
  }
  // Assault approach arrows at the incoming map edge: debug intel only (D111).
  if (intel && g.phase !== 'aftermath') {
    const warn = g.phase === 'warning' || g.phase === 'combat';
    const pulse = 0.5 + 0.5 * Math.sin(g.time * (warn ? 8 : 2.5));
    ctx.fillStyle = warn ? `rgba(255,75,75,${0.55 + pulse * 0.45})` : 'rgba(255,214,102,0.85)';
    for (const side of g.spawnSides || []) {
      for (const m of g.map.spawns?.[side] || []) {
        const x = side === 'west' ? 2 : W - 2;
        const y = (m.y + 0.5) * sy;
        const s = 6;
        ctx.beginPath();
        if (side === 'west') { ctx.moveTo(x + s + 4, y); ctx.lineTo(x, y - s); ctx.lineTo(x, y + s); }
        else { ctx.moveTo(x - s - 4, y); ctx.lineTo(x, y - s); ctx.lineTo(x, y + s); }
        ctx.closePath();
        ctx.fill();
      }
    }
  }
  // Player with a view cone.
  const px = g.player.x * sx;
  const py = g.player.y * sy;
  const a = Math.atan2(g.player.facing.y, g.player.facing.x);
  ctx.fillStyle = 'rgba(255,255,255,0.18)';
  ctx.beginPath();
  ctx.moveTo(px, py);
  ctx.arc(px, py, 22, a - 0.6, a + 0.6);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.moveTo(px + Math.cos(a) * 6, py + Math.sin(a) * 6);
  ctx.lineTo(px + Math.cos(a + 2.5) * 4, py + Math.sin(a + 2.5) * 4);
  ctx.lineTo(px + Math.cos(a - 2.5) * 4, py + Math.sin(a - 2.5) * 4);
  ctx.closePath();
  ctx.fill();
}

// --- weapon (D113) ----------------------------------------------------------------
function updateWeapon(g, ui) {
  const p = g.player;
  const crossbow = p.weapon === 'crossbow';
  $('weapon').classList.toggle('dim', ui.buildMode);
  setText($('weapon-name'), ui.buildMode ? 'BUILDING' : crossbow ? 'CROSSBOW' : 'SWORD');
  const reloading = crossbow && p.boltCd > 0;
  setHtml($('weapon-sub'), ui.buildMode ? 'click places · <kbd>Q</kbd> back out'
    : reloading ? 'reloading…' : crossbow ? 'loaded · <kbd>F</kbd> sword' : '<kbd>F</kbd> crossbow');
  $('weapon-reload').hidden = !reloading;
  if (reloading) $('weapon-reload-bar').style.width = `${(1 - p.boltCd / PLAYER.crossbow.reload) * 100}%`;
}

export function updateHud(g, look, ui, debug = {}) {
  const intel = !!debug.intel;
  updateWeapon(g, ui);
  updateResources(g);
  updateCompass(g, intel);
  updatePhase(g, intel);
  updateAlerts(g);
  updatePrompt(g, look, ui);
  updateBuild(g, ui);
  updateMinimap(g, intel);
  $('perch').hidden = g.player.perchId == null;
  setText($('mini-seed'), `seed ${g.seed}`);
}

/** Red edge flash proportional to recent damage. */
export function setVignette(amount) {
  $('vignette').style.opacity = String(Math.max(0, Math.min(1, amount)));
}

