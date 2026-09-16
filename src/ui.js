// DOM HUD. Functional, not pretty (plan §16).

import { ARCHETYPES, TOWER, WAVE, TILE_NAME, DROP } from './config.js';
import { towerStats, upgradeCost, repairCostPerHp, towerCost, dangerState } from './game.js';

export const $ = (id) => document.getElementById(id);

const fmt = (n, d = 1) => n.toFixed(d);

export function renderPicks(selectedKey, onPick) {
  const wrap = $('picks');
  wrap.innerHTML = '';
  for (const [key, a] of Object.entries(ARCHETYPES)) {
    const el = document.createElement('div');
    el.className = 'pick' + (key === selectedKey ? ' on' : '');
    el.innerHTML = `<h3 style="color:${a.color}">${a.name}</h3>
      <div class="muted">${a.blurb}</div>
      <ul>${a.detail.map((d) => `<li>${d}</li>`).join('')}</ul>`;
    el.onclick = () => onPick(key);
    wrap.appendChild(el);
  }
}

let lastLogLen = -1;

export function updateHud(g) {
  const phaseLabel = { prep: 'PREP', warning: 'INCOMING', combat: 'COMBAT', aftermath: 'CLEAR' }[g.phase];

  $('hud-mat').textContent = Math.floor(g.materials);
  $('hud-wave').textContent = `${g.wave}/${WAVE.totalToSurvive}`;
  $('hud-phase').textContent = g.phase === 'warning'
    ? `INCOMING — ${g.spawnSides.map((s) => s.toUpperCase()).join(' + ')}`
    : phaseLabel;
  $('hud-timer').textContent = g.phase === 'combat'
    ? `${g.enemies.length + g.pendingSpawns.length} left`
    : `${Math.max(0, g.phaseLeft).toFixed(0)}s`;
  $('hud-phase-chip').className = `chip phase-${g.phase}`;
  $('hud-hp').textContent = Math.max(0, Math.round(g.player.hp));
  $('hud-seed').textContent = `seed ${g.seed}`;

  const occ = g.towers.find((t) => t.id === g.occupiedTowerId);
  const occChip = $('hud-occ');
  const danger = dangerState(g);
  const shelterPct = Math.round(danger.shelterProgress * 100);
  occChip.textContent = occ ? `OCCUPIED tower #${occ.id}`
    : danger.shelterTowerId ? `SHELTERING ${shelterPct}%` : 'Unoccupied';
  occChip.style.color = occ ? 'var(--gold)' : danger.shelterTowerId ? 'var(--green)' : 'var(--dim)';

  const dangerChip = $('hud-danger');
  if (g.phase === 'combat' && !danger.sheltered) {
    dangerChip.textContent = `EXPOSED · ${danger.hunters} HUNTING`;
    dangerChip.style.color = 'var(--red)';
    dangerChip.style.borderColor = 'var(--red)';
  } else {
    dangerChip.textContent = danger.sheltered ? 'SHELTERED · MELEE SAFE' : 'OPEN GROUND SAFE · PREP';
    dangerChip.style.color = danger.sheltered ? 'var(--green)' : 'var(--dim)';
    dangerChip.style.borderColor = '';
  }

  const fx = Object.entries(g.effects);
  const fxChip = $('hud-effects');
  fxChip.hidden = fx.length === 0;
  if (fx.length) {
    fxChip.innerHTML = fx.map(([k, t]) =>
      `<span style="color:${DROP.types[k].color}">${DROP.types[k].name} ${t.toFixed(0)}s</span>`).join(' · ');
  }

  // --- side panel: run ---
  $('p-arch').textContent = g.arch.name;
  $('p-hp').textContent = `${Math.max(0, Math.round(g.player.hp))} / ${g.player.maxHp}`;
  const hpFrac = Math.max(0, g.player.hp / g.player.maxHp);
  $('p-hpbar').style.width = `${hpFrac * 100}%`;
  $('p-hpbar').style.background = hpFrac < 0.34 ? 'var(--red)' : hpFrac < 0.66 ? 'var(--gold)' : 'var(--green)';
  const income = g.towers.filter((t) => t.built).reduce((s, t) => s + towerStats(g, t).income, 0);
  $('p-income').textContent = `${fmt(income, 2)} /s`;
  $('p-towers').textContent = `${g.towers.filter((t) => t.built).length} built${
    g.towers.some((t) => !t.built) ? ` (+${g.towers.filter((t) => !t.built).length} building)` : ''}`;
  $('p-danger').innerHTML = danger.sheltered
    ? '<span class="good">sheltered</span>'
    : g.phase === 'combat'
      ? `<span class="warn">EXPOSED · ${danger.hunters} hunting</span>`
      : danger.shelterTowerId ? `<span class="good">sheltering ${shelterPct}%</span>` : 'safe during prep';

  // --- side panel: selected tower ---
  const sel = g.towers.find((t) => t.id === (g.selected ?? g.occupiedTowerId));
  $('sel-empty').hidden = !!sel;
  $('sel-body').hidden = !sel;
  if (sel) {
    const s = towerStats(g, sel);
    const frac = sel.hp / sel.maxHp;
    const collapsing = sel.built && frac < TOWER.collapsingAt;
    $('sel-title').textContent = `Tower #${sel.id}`;
    $('sel-state').innerHTML = !sel.built
      ? `<span class="muted">building ${(sel.progress * 100).toFixed(0)}%</span>`
      : collapsing ? '<span class="warn">COLLAPSING</span>'
      : s.occupied ? '<span style="color:var(--gold)">OCCUPIED</span>' : 'automated';
    $('sel-hp').textContent = `${Math.round(sel.hp)} / ${sel.maxHp}`;
    $('sel-hpbar').style.width = `${frac * 100}%`;
    $('sel-hpbar').style.background = collapsing ? 'var(--red)' : frac < 0.5 ? 'var(--gold)' : 'var(--green)';
    $('sel-prod').innerHTML = `${fmt(s.income, 2)} /s${s.occupied ? ' <span style="color:var(--gold)">▲</span>' : ''}`;
    $('sel-dmg').innerHTML = `${fmt(s.damage, 1)}${s.occupied ? ' <span style="color:var(--gold)">▲</span>' : ''}`;
    $('sel-rate').textContent = `${fmt(s.fireRate, 2)} /s → ${fmt(s.damage * s.fireRate, 1)} dps`;
    $('sel-range').textContent = `${fmt(s.range, 1)} tiles`;
    $('sel-levels').textContent = `W${sel.wLevel} / E${sel.eLevel} (max ${TOWER.upgrade.maxLevel})`;

    setUpgradeButton($('up-weapon'), '[1] Weapon upgrade', upgradeCost(sel, 'weapon'), g.materials, sel.built);
    setUpgradeButton($('up-extract'), '[2] Extraction upgrade', upgradeCost(sel, 'extraction'), g.materials, sel.built);

    const perHp = repairCostPerHp(g);
    const missing = sel.maxHp - sel.hp;
    $('sel-repair').textContent = missing > 0
      ? `${Math.ceil(missing * perHp)} Materials (${fmt(perHp, 2)}/hp)`
      : 'undamaged';
    $('sel-repair-note').innerHTML = s.occupied
      ? '<span class="good">Occupied: repairing fast.</span> Hold <b>R</b>.'
      : 'Hold <b>R</b>. Standing in the tower repairs far faster.';
  }

  // --- build ---
  $('build-cost').textContent = `${towerCost(g)} M`;
  $('build-state').textContent = g.buildMode ? '— ACTIVE' : '';
  $('build-state').className = g.buildMode ? 'good' : 'muted';
  const info = $('build-info');
  if (g.buildMode && g.buildCheck) {
    const c = g.buildCheck;
    info.innerHTML = [
      `<b>${TILE_NAME[c.terrain]}</b>, elevation ${c.elev}`,
      `Income here: <b>${fmt(c.income, 2)} /s</b> ${incomeVerdict(c.income)}`,
      `Visibility: <b>${(c.coverage * 100).toFixed(0)}%</b> of ground in range`,
      c.ok ? '<span class="good">Valid site — click to build.</span>'
           : `<span class="warn">Blocked: ${c.reasons.join(', ')}</span>`,
    ].filter(Boolean).join('<br />');
  } else {
    info.innerHTML = 'Press <b>B</b>, then click a spot. Preview shows income and sight lines.';
  }

  // --- log ---
  if (g.log.length !== lastLogLen) {
    lastLogLen = g.log.length;
    $('log').innerHTML = g.log.map((l) => `<div>${l.text}</div>`).join('');
  }
}

function incomeVerdict(v) {
  if (v > 1.1) return '<span class="good">rich</span>';
  if (v > 0.6) return '<span style="color:var(--gold)">decent</span>';
  if (v > 0.25) return '<span class="muted">thin</span>';
  return '<span class="warn">barren</span>';
}

function setUpgradeButton(btn, label, cost, materials, built) {
  if (cost === null) {
    btn.disabled = true;
    btn.innerHTML = `${label}<span class="cost">MAX</span>`;
    return;
  }
  btn.disabled = !built || materials < cost;
  btn.innerHTML = `${label}<span class="cost">${cost} M</span>`;
}

export function updateMapInfo(g) {
  const r = g.map.report;
  const barriers = r.barriers.map((b) =>
    `${b.type}@x${b.cx}: ${b.routes} route(s), narrowest ${b.narrowest}t`).join('<br />');
  $('d-mapinfo').innerHTML = [
    `seed <b>${g.seed}</b> — accepted on attempt ${g.map.attempts}${g.map.relaxed ? ' <span class="warn">(relaxed)</span>' : ''}`,
    `open ${(r.openFrac * 100).toFixed(0)}% · forest ${(r.forestFrac * 100).toFixed(0)}% · water ${(r.waterFrac * 100).toFixed(0)}%`,
    barriers,
    r.problems.length ? `<span class="warn">${r.problems.join('; ')}</span>` : '',
  ].filter(Boolean).join('<br />');
}

export function showEnd(g) {
  const won = g.status === 'won';
  $('end-title').textContent = won ? 'Line held' : 'Run over';
  $('end-title').style.color = won ? 'var(--green)' : 'var(--red)';
  $('end-sub').textContent = won
    ? `You survived all ${WAVE.totalToSurvive} waves as the ${g.arch.name}.`
    : `Killed on wave ${g.wave} as the ${g.arch.name}. Towers are expendable. You were not.`;
  $('end-stats').innerHTML = [
    ['Waves cleared', g.stats.wavesCleared],
    ['Enemies killed', g.stats.kills],
    ['Towers lost', g.stats.towersLost],
    ['Materials earned', Math.round(g.stats.materialsEarned)],
    ['Seed', g.seed],
  ].map(([k, v]) => `<div class="row"><span>${k}</span><span>${v}</span></div>`).join('');
  $('end-overlay').hidden = false;
}
