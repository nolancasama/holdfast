// DOM HUD. Functional, not pretty (plan §16).

import { ARCHETYPES, TOWER, WAVE, TILE_NAME, DROP } from './config.js';
import {
  towerStats, upgradeCost, repairCostPerHp, towerCost, dangerState,
  upgradeState, upgradeRateMult, towerAlarmState, stuckState,
} from './game.js';

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
  $('hud-phase').textContent = g.paused ? 'PAUSED' : g.phase === 'warning'
    ? `INCOMING — ${g.spawnSides.map((s) => s.toUpperCase()).join(' + ')}`
    : phaseLabel;
  $('hud-timer').textContent = g.phase === 'combat'
    ? `${g.enemies.length + g.pendingSpawns.length} left`
    : `${Math.max(0, g.phaseLeft).toFixed(0)}s`;
  $('hud-phase-chip').className = `chip ${g.paused ? '' : `phase-${g.phase}`}`;
  $('hud-hp').textContent = Math.max(0, Math.round(g.player.hp));
  $('hud-seed').textContent = `seed ${g.seed}`;
  const pause = $('pause-toggle');
  pause.textContent = g.paused ? '[P] Resume' : '[P] Pause';
  pause.className = g.paused ? 'on' : '';

  const occ = g.towers.find((t) => t.id === g.occupiedTowerId);
  const occChip = $('hud-occ');
  const danger = dangerState(g);
  const shelterPct = Math.round(danger.shelterProgress * 100);
  occChip.textContent = occ ? `OCCUPIED tower #${occ.id}`
    : danger.shelterTowerId ? `SHELTERING ${shelterPct}%` : 'Unoccupied';
  occChip.style.color = occ ? 'var(--gold)' : danger.shelterTowerId ? 'var(--green)' : 'var(--dim)';

  const dangerChip = $('hud-danger');
  if (g.phase === 'combat' && !danger.sheltered) {
    dangerChip.textContent = `EXPOSED · ${danger.visibleHunters} HUNTING`;
    dangerChip.style.color = 'var(--red)';
    dangerChip.style.borderColor = 'var(--red)';
  } else {
    dangerChip.textContent = danger.sheltered ? 'SHELTERED · MELEE SAFE' : 'OPEN GROUND SAFE · PREP';
    dangerChip.style.color = danger.sheltered ? 'var(--green)' : 'var(--dim)';
    dangerChip.style.borderColor = '';
  }

  const activeAlarm = towerAlarmState(g).find((alarm) => alarm.active);
  const alarmChip = $('hud-tower-alarm');
  alarmChip.hidden = !activeAlarm;
  if (activeAlarm) alarmChip.textContent = `TOWER #${activeAlarm.id} UNDER ATTACK`;

  const fx = Object.entries(g.effects);
  const fxChip = $('hud-effects');
  fxChip.hidden = fx.length === 0;
  if (fx.length) {
    fxChip.innerHTML = fx.map(([k, t]) =>
      `<span style="color:${DROP.temporary[k].color}">${DROP.temporary[k].name} ${t.toFixed(0)}s</span>`).join(' · ');
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
      ? `<span class="warn">EXPOSED · ${danger.visibleHunters} hunting</span>`
      : danger.shelterTowerId ? `<span class="good">sheltering ${shelterPct}%</span>` : 'safe during prep';
  $('p-equipment').textContent = g.equipment.length
    ? g.equipment.map((key) => DROP.equipment[key].name).join(' · ')
    : 'None';

  // --- side panel: selected tower ---
  const sel = g.towers.find((t) => t.id === (g.selected ?? g.occupiedTowerId));
  $('sel-empty').hidden = !!sel;
  $('sel-body').hidden = !sel;
  if (sel) {
    const s = towerStats(g, sel);
    const upgrading = upgradeState(g, sel);
    const alarm = towerAlarmState(g).find((state) => state.id === sel.id)?.active;
    const frac = sel.hp / sel.maxHp;
    const collapsing = sel.built && frac < TOWER.collapsingAt;
    $('sel-title').textContent = `Tower #${sel.id}`;
    $('sel-state').innerHTML = !sel.built
      ? `<span class="muted">building ${(sel.progress * 100).toFixed(0)}%</span>`
      : collapsing ? '<span class="warn">COLLAPSING</span>'
      : alarm ? '<span class="warn">UNDER ATTACK</span>'
      : s.occupied ? '<span style="color:var(--gold)">OCCUPIED</span>' : 'automated';
    const upgradeEl = $('sel-upgrade');
    upgradeEl.hidden = !upgrading;
    if (upgrading) {
      const name = upgrading.which === 'weapon' ? 'Weapon' : 'Extraction';
      const kind = upgrading.which === 'weapon' ? 'W' : 'E';
      $('sel-upgrade-label').textContent = `${name} ${kind}${upgrading.fromLevel} -> ${kind}${upgrading.toLevel}`;
      $('sel-upgrade-time').textContent = `${upgrading.remaining.toFixed(1)}s`;
      $('sel-upgrade-bar').style.width = `${upgrading.progress * 100}%`;
      const rate = upgradeRateMult(g, sel);
      $('sel-upgrade-rate').textContent = rate > 1 ? `Engineer x${rate.toFixed(1)}` : '';
    }
    $('sel-hp').textContent = `${Math.round(sel.hp)} / ${sel.maxHp}`;
    $('sel-hpbar').style.width = `${frac * 100}%`;
    $('sel-hpbar').style.background = collapsing ? 'var(--red)' : frac < 0.5 ? 'var(--gold)' : 'var(--green)';
    $('sel-prod').innerHTML = `${fmt(s.income, 2)} /s${s.occupied ? ' <span style="color:var(--gold)">▲</span>' : ''}`;
    $('sel-dmg').innerHTML = `${fmt(s.damage, 1)}${s.occupied ? ' <span style="color:var(--gold)">▲</span>' : ''}`;
    $('sel-rate').textContent = `${fmt(s.fireRate, 2)} /s → ${fmt(s.damage * s.fireRate, 1)} dps`;
    $('sel-range').textContent = `${fmt(s.range, 1)} tiles`;
    $('sel-levels').textContent = `W${sel.wLevel} / E${sel.eLevel} (max ${TOWER.upgrade.maxLevel})`;

    setUpgradeButton($('up-weapon'), '[1] Weapon upgrade', upgradeCost(sel, 'weapon'), g.materials, sel.built && !g.paused && !upgrading);
    setUpgradeButton($('up-extract'), '[2] Extraction upgrade', upgradeCost(sel, 'extraction'), g.materials, sel.built && !g.paused && !upgrading);

    const perHp = repairCostPerHp(g);
    const missing = sel.maxHp - sel.hp;
    $('sel-repair').textContent = missing > 0
      ? `${Math.ceil(missing * perHp)} Materials (${fmt(perHp, 2)}/hp)`
      : 'undamaged';
    $('sel-repair-note').innerHTML = g.paused ? '<span class="muted">Disabled while paused.</span>' : s.occupied
      ? '<span class="good">Occupied: repairing fast.</span> Hold <b>R</b>.'
      : 'Hold <b>R</b>. Standing in the tower repairs far faster.';
  }

  // --- build ---
  $('build-cost').textContent = `${towerCost(g)} M`;
  $('build-toggle').disabled = g.paused;
  $('build-confirm').disabled = g.paused || !g.buildMode || !g.buildCheck?.ok;
  $('build-state').textContent = g.buildMode ? '— ACTIVE' : '';
  $('build-state').className = g.buildMode ? 'good' : 'muted';
  const info = $('build-info');
  if (g.buildMode && g.buildCheck) {
    const c = g.buildCheck;
    info.innerHTML = [
      `<b>${TILE_NAME[c.terrain]}</b>, elevation <b>${c.elevationName}</b> — ${sightMeaning(c)}`,
      `Extraction: <span style="color:var(--gold)">${'▰'.repeat(c.richness.bars)}</span> <b>${c.richness.name}</b> - ${fmt(c.income, 2)} Materials/sec`,
      `Visibility: <b>${(c.coverage * 100).toFixed(0)}%</b> of ground in range`,
      c.ok ? '<span class="good">Valid site — press Enter, click the map, or use Build here.</span>'
           : `<span class="warn">Blocked: ${c.reasons.join(', ')}</span>`,
    ].filter(Boolean).join('<br />');
  } else {
    info.innerHTML = 'Press <b>B</b>, walk to a site, then press <b>Enter</b> to build here. Preview shows income and sight lines.';
  }

  $('d-fog').textContent = g.debug.showFog ? 'Hide fog debug [V]' : 'Show fog debug [V]';
  const stuck = stuckState(g);
  $('d-stuck').textContent = `Stuck: ${stuck.detections} detected / ${stuck.recoveries} recovered / ${stuck.despawns} despawned`;

  // --- log ---
  if (g.log.length !== lastLogLen) {
    lastLogLen = g.log.length;
    $('log').innerHTML = g.log.map((l) => `<div>${l.text}</div>`).join('');
  }
}

function sightMeaning(c) {
  if (c.elevationName === 'Cliff') return 'impassable and blocks sight';
  if (c.elev === 0) return 'forest blocks sight';
  if (c.elev === 1) return 'sees over Low forest';
  return 'sees over Low and Normal forest';
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
  const parallel = ['west', 'east'].map((side) => {
    const p = r.parallelRoutes[side];
    return `${side}: median ${p.median}, max ${p.max}, 3+ cols ${p.columnsWithThree}`;
  }).join(' · ');
  $('d-mapinfo').innerHTML = [
    `seed <b>${g.seed}</b> — accepted on attempt ${g.map.attempts}${g.map.relaxed ? ' <span class="warn">(relaxed)</span>' : ''}`,
    `open ${(r.openFrac * 100).toFixed(0)}% · forest ${(r.forestFrac * 100).toFixed(0)}% · water ${(r.waterFrac * 100).toFixed(0)}%`,
    `parallel roads — ${parallel}`,
    barriers,
    r.problems.length ? `<span class="warn">${r.problems.join('; ')}</span>` : '',
  ].filter(Boolean).join('<br />');
}

export function showEnd(g) {
  const won = g.status === 'won';
  $('end-title').textContent = won ? 'Line held' : g.lossCause === 'towers' ? 'Position lost' : 'You died';
  $('end-title').style.color = won ? 'var(--green)' : 'var(--red)';
  $('end-sub').textContent = won
    ? `You survived all ${WAVE.totalToSurvive} waves as the ${g.arch.name}.`
    : g.lossCause === 'towers'
      ? `Every tower was destroyed on wave ${g.wave} as the ${g.arch.name}.`
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
