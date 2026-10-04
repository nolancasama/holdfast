// DOM HUD for the fortress rework (D77-D80/D83).

import { ARCHETYPES, TOWER, PLAYER, BUILDINGS, WAVE, DROP } from './config.js';
import {
  towerStats, upgradeCost, repairCostPerHp, towerCost, dangerState,
  upgradeState, upgradeRateMult, towerAlarmState, stuckState, playerBuildSite, resourceState,
  assaultIn, wallPlan, towerConnectivity, towerMinRange, garrisonState, garrisonSlots, farmSupport,
} from './game.js';

export const $ = (id) => document.getElementById(id);
const fmt = (n, d = 1) => Number(n || 0).toFixed(d);
const LABEL = { tower: 'Tower', wall: 'Wall', farm: 'Farm', quarry: 'Quarry', mine: 'Gold Mine' };
const RESOURCE = { farm: 'food', quarry: 'stone', mine: 'gold' };

function resourceRates(g) {
  const state = resourceState(g);
  if (state?.rates) return state.rates;
  const out = { stone: 0, gold: 0 };
  for (const b of g.buildings || []) {
    if (!b.built || b.destroyed || b.hp <= 0) continue;
    const resource = b.resource || RESOURCE[b.type];
    if (resource) out[resource] += Number(b.rate || 0);
  }
  return out;
}

function costParts(cost) {
  if (cost == null) return [];
  if (typeof cost === 'number') return [['stone', cost]];
  return ['stone', 'gold'].filter((key) => Number(cost[key]) > 0).map((key) => [key, Number(cost[key])]);
}

function costText(cost) {
  const short = { stone: 'S', gold: 'G' };
  const parts = costParts(cost);
  return parts.length ? parts.map(([key, value]) => `${Math.ceil(value)} ${short[key]}`).join(' · ') : 'free';
}

function canAfford(g, cost) {
  return costParts(cost).every(([key, value]) => Number(g.res?.[key] || 0) >= value);
}

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
  const seconds = Math.max(0, assaultIn(g));
  const shownSeconds = Math.ceil(seconds);
  const countdown = `${String(Math.floor(shownSeconds / 60)).padStart(2, '0')}:${String(shownSeconds % 60).padStart(2, '0')}`;
  const incoming = (g.spawnSides || []).length
    ? g.spawnSides.map((side) => side.toUpperCase()).join(' + ') : 'UNKNOWN';
  const enemiesLeft = (g.enemies || []).filter((enemy) => !enemy.wild).length + (g.pendingSpawns || []).length;
  const rates = resourceRates(g);
  for (const key of ['stone', 'gold']) {
    $(`hud-${key}`).textContent = Math.floor(g.res?.[key] || 0);
    $(`hud-${key}-rate`).textContent = `+${fmt(rates[key], 2)}/s`;
  }
  // D91: Food is support, shown as soldiers garrisoned / soldiers fed.
  const food = garrisonState(g);
  $('hud-food').textContent = `${food.assigned}/${food.support}`;
  $('hud-food-rate').textContent = food.free > 0 ? `${food.free} free` : 'fed by farms';
  const deficit = $('hud-deficit');
  deficit.hidden = !food.deficit;
  if (food.deficit) {
    deficit.textContent = food.standingDown ? 'SUPPLY DEFICIT · SOLDIERS STANDING DOWN'
      : `SUPPLY DEFICIT · ${Math.ceil(food.graceLeft ?? 0)}s`;
    deficit.style.color = 'var(--red)'; deficit.style.borderColor = 'var(--red)';
  }
  $('hud-wave').textContent = `WAVE ${g.wave}`;
  $('hud-incoming').textContent = `Incoming: ${incoming}`;
  $('hud-incoming').hidden = g.phase === 'combat' || g.phase === 'aftermath';
  $('hud-phase').textContent = g.paused ? 'PAUSED' : g.phase === 'prep' ? 'EXPANSION'
    : g.phase === 'warning' ? 'ASSAULT IMMINENT' : g.phase === 'combat' ? 'SIEGE' : 'WAVE COMPLETE';
  $('hud-timer').textContent = g.phase === 'prep' || g.phase === 'warning'
    ? `NEXT ASSAULT ${countdown}` : g.phase === 'combat' ? `${enemiesLeft} ENEMIES LEFT`
      : g.phase === 'aftermath' ? `${Math.max(0, g.phaseLeft).toFixed(0)}s` : '';
  $('hud-phase-chip').className = `phase-block phase-${g.phase}${g.paused ? ' paused' : ''}${
    g.phase === 'warning' && seconds <= 5 ? ' urgent' : ''}`;
  const early = $('start-wave');
  early.hidden = g.paused || g.status !== 'playing' || (g.phase !== 'prep' && g.phase !== 'warning');
  early.disabled = early.hidden;
  $('hud-hp').textContent = Math.max(0, Math.round(g.player.hp));
  $('hud-seed').textContent = `seed ${g.seed}`;
  const pause = $('pause-toggle');
  pause.textContent = g.paused ? '[P] Resume' : '[P] Pause';
  pause.className = g.paused ? 'on' : '';

  const occ = g.towers.find((t) => t.id === g.occupiedTowerId);
  const danger = dangerState(g);
  const shelterPct = Math.round(danger.shelterProgress * 100);
  $('hud-occ').textContent = occ ? `OCCUPIED ${occ.keep ? 'KEEP' : `tower #${occ.id}`}`
    : danger.shelterTowerId ? `SHELTERING ${shelterPct}%` : 'Unoccupied';
  $('hud-occ').style.color = occ ? 'var(--gold)' : danger.shelterTowerId ? 'var(--green)' : 'var(--dim)';

  const dangerChip = $('hud-danger');
  if (g.phase === 'combat' && !danger.sheltered) {
    dangerChip.textContent = `EXPOSED · ${danger.visibleHunters || 0} AGGRO`;
    dangerChip.style.color = 'var(--red)'; dangerChip.style.borderColor = 'var(--red)';
  } else {
    dangerChip.textContent = danger.sheltered ? 'SHELTERED · MELEE SAFE' : 'OPEN GROUND';
    dangerChip.style.color = danger.sheltered ? 'var(--green)' : 'var(--dim)'; dangerChip.style.borderColor = '';
  }

  const activeAlarm = towerAlarmState(g).find((alarm) => alarm.active);
  $('hud-tower-alarm').hidden = !activeAlarm;
  if (activeAlarm) {
    const alarmTarget = activeAlarm.kind === 'building' ? `BUILDING #${activeAlarm.id}`
      : g.towers.find((tower) => tower.id === activeAlarm.id)?.keep ? 'KEEP' : `TOWER #${activeAlarm.id}`;
    $('hud-tower-alarm').textContent = `${alarmTarget} UNDER ATTACK`;
  }

  const fx = Object.entries(g.effects || {});
  $('hud-effects').hidden = fx.length === 0;
  if (fx.length) $('hud-effects').innerHTML = fx.map(([key, time]) => {
    const def = DROP.temporary?.[key];
    return `<span style="color:${def?.color || '#fff'}">${def?.name || key} ${time.toFixed(0)}s</span>`;
  }).join(' · ');

  $('p-arch').textContent = g.arch.name;
  $('p-hp').textContent = `${Math.max(0, Math.round(g.player.hp))} / ${g.player.maxHp}`;
  const hpFrac = Math.max(0, g.player.hp / g.player.maxHp);
  $('p-hpbar').style.width = `${hpFrac * 100}%`;
  $('p-hpbar').style.background = hpFrac < 0.34 ? 'var(--red)' : hpFrac < 0.66 ? 'var(--gold)' : 'var(--green)';
  $('p-income').textContent = `S ${fmt(rates.stone, 2)} · G ${fmt(rates.gold, 2)} /s · feeds ${food.support}`;
  $('p-towers').textContent = `${g.towers.filter((t) => t.built).length} built${
    g.towers.some((t) => !t.built) ? ` (+${g.towers.filter((t) => !t.built).length} building)` : ''}`;
  $('p-buildings').textContent = `${(g.buildings || []).filter((b) => b.built && !b.destroyed).length} producing${
    (g.buildings || []).some((b) => !b.built && !b.destroyed) ? ` (+${g.buildings.filter((b) => !b.built && !b.destroyed).length} building)` : ''}`;
  $('p-danger').innerHTML = danger.sheltered ? '<span class="good">sheltered</span>'
    : g.phase === 'combat' ? `<span class="warn">EXPOSED · ${danger.visibleHunters || 0} aggro</span>`
      : danger.shelterTowerId ? `<span class="good">sheltering ${shelterPct}%</span>` : 'open ground';
  $('p-equipment').textContent = g.equipment.length
    ? g.equipment.map((key) => DROP.equipment[key]?.name || key).join(' · ') : 'None';

  updateSelection(g);
  updateBuild(g);

  $('d-fog').textContent = g.debug.showFog ? 'Hide fog debug [V]' : 'Show fog debug [V]';
  const stuck = stuckState(g);
  $('d-stuck').textContent = `Stuck: ${stuck.detections} detected / ${stuck.recoveries} recovered / ${stuck.despawns} despawned`;
  if (g.log.length !== lastLogLen) {
    lastLogLen = g.log.length;
    $('log').innerHTML = g.log.map((line) => `<div>${line.text}</div>`).join('');
  }
}

function updateSelection(g) {
  const building = (g.buildings || []).find((b) => b.id === (g.selectedBuildingId ?? g.selectedBuilding?.id));
  const tower = building ? null : g.towers.find((t) => t.id === (g.selected ?? g.occupiedTowerId));
  const sel = building || tower;
  $('sel-empty').hidden = !!sel;
  $('sel-body').hidden = !sel;
  if (!sel) return;

  const frac = Math.max(0, sel.hp / sel.maxHp);
  const buildingSelected = !!building;
  $('sel-title').textContent = buildingSelected ? `${LABEL[building.type]} #${building.id}` : tower.keep ? 'KEEP' : `Tower #${tower.id}`;
  $('sel-state').innerHTML = !sel.built
    ? `<span class="muted">building ${Math.round((sel.progress || 0) * 100)}%</span>`
    : sel.destroyed || sel.hp <= 0 ? '<span class="warn">DESTROYED</span>'
      : buildingSelected ? '<span class="good">PRODUCING</span>' : towerStats(g, tower).occupied
        ? '<span style="color:var(--gold)">OCCUPIED</span>' : 'automated';
  $('sel-hp').textContent = `${Math.max(0, Math.round(sel.hp))} / ${sel.maxHp}`;
  $('sel-hpbar').style.width = `${frac * 100}%`;
  $('sel-hpbar').style.background = frac < 0.34 ? 'var(--red)' : frac < 0.6 ? 'var(--gold)' : 'var(--green)';

  $('up-weapon').hidden = buildingSelected;
  $('sel-upgrade').hidden = true;
  $('sel-garrison-row').hidden = buildingSelected;
  $('sel-garrison-note').hidden = buildingSelected;
  if (buildingSelected) {
    const resource = RESOURCE[building.type] || building.resource || 'resource';
    $('sel-prod').textContent = !sel.built ? 'starts when construction finishes'
      : building.type === 'farm' ? `feeds ${farmSupport(building)} soldiers` : `${fmt(sel.rate, 2)} ${resource}/s`;
    $('sel-dmg').textContent = '—'; $('sel-rate').textContent = '—'; $('sel-range').textContent = '—'; $('sel-levels').textContent = '—';
  } else {
    const stats = towerStats(g, tower);
    const upgrading = upgradeState(g, tower);
    $('sel-prod').textContent = tower.keep ? 'fortress objective' : 'defensive tower';
    $('sel-dmg').textContent = fmt(stats.damage, 1);
    $('sel-rate').textContent = `${fmt(stats.fireRate, 2)} /s → ${fmt(stats.damage * stats.fireRate, 1)} dps`;
    $('sel-range').textContent = `${fmt(towerMinRange(g, tower), 1)}–${fmt(stats.range, 1)} tiles`;
    $('sel-levels').textContent = `W${tower.wLevel} (max ${TOWER.upgrade.maxLevel})`;
    const food = garrisonState(g);
    const slots = garrisonSlots(tower);
    $('sel-garrison').textContent = `${tower.garrison || 0} / ${slots}`;
    $('garrison-plus').disabled = g.paused || !tower.built || (tower.garrison || 0) >= slots || food.free <= 0;
    $('garrison-minus').disabled = g.paused || !(tower.garrison > 0);
    $('sel-garrison-note').innerHTML = !tower.built ? 'Soldiers can man it once it is finished.'
      : food.free > 0 ? `<span class="good">${food.free} fed soldier${food.free === 1 ? '' : 's'} free.</span> Each adds fire rate and damage, never close defence.`
        : (tower.garrison || 0) < slots ? '<span class="warn">No free Food support — build a Farm.</span>'
          : 'Fully garrisoned.';
    $('sel-upgrade').hidden = !upgrading;
    if (upgrading) {
      $('sel-upgrade-label').textContent = `Weapon W${upgrading.fromLevel} → W${upgrading.toLevel}`;
      $('sel-upgrade-time').textContent = `${upgrading.remaining.toFixed(1)}s`;
      $('sel-upgrade-bar').style.width = `${upgrading.progress * 100}%`;
      const mult = upgradeRateMult(g, tower);
      $('sel-upgrade-rate').textContent = mult > 1 ? `Engineer x${mult.toFixed(1)}` : '';
    }
    const upgradeLocal = Math.hypot(g.player.x - tower.x, g.player.y - tower.y) <= PLAYER.presenceRadius;
    setUpgradeButton($('up-weapon'), '[1] Weapon upgrade', upgradeCost(tower, 'weapon'), g,
      tower.built && !g.paused && !upgrading && upgradeLocal);
    $('up-weapon').title = upgradeLocal ? '' : `Move within ${PLAYER.presenceRadius} tiles to upgrade.`;
  }

  const perHp = repairCostPerHp(g);
  const missing = Math.max(0, sel.maxHp - sel.hp);
  $('sel-repair').textContent = missing > 0 ? `${Math.ceil(missing * perHp)} Stone (${fmt(perHp, 2)}/hp)` : 'undamaged';
  const radius = sel.radius ?? BUILDINGS[sel.type]?.radius ?? 0.55;
  const repairLocal = (!buildingSelected && g.occupiedTowerId === sel.id)
    || Math.hypot(g.player.x - sel.x, g.player.y - sel.y) - radius <= TOWER.repair.reach;
  $('sel-repair-note').innerHTML = g.paused ? '<span class="muted">Disabled while paused.</span>'
    : repairLocal ? '<span class="good">In reach.</span> Hold <b>R</b>.'
      : `<span class="warn">Too far away.</span> Move within ${TOWER.repair.reach} tiles of the structure edge.`;
}

function updateBuild(g) {
  $('build-toggle').disabled = g.paused;
  const wallMode = g.buildMode && g.buildType === 'wall';
  $('build-confirm').disabled = g.paused || !g.buildMode || !g.buildCheck?.ok || (wallMode && g.wallAnchorB == null);
  $('build-confirm').textContent = wallMode ? 'Build wall [Enter]' : 'Build here [Enter]';
  $('build-state').textContent = g.buildMode ? `— ${LABEL[g.buildType || 'tower'].toUpperCase()}` : '';
  $('build-state').className = g.buildMode ? 'good' : 'muted';
  for (const type of ['tower', 'farm', 'quarry', 'mine']) {
    const button = $(`build-${type}`);
    let check = null;
    try { check = playerBuildSite(g, type)?.check; } catch { check = null; }
    const cost = check?.cost ?? (type === 'tower' ? towerCost(g) : null);
    const reasons = check?.reasons || [];
    $(`build-${type}-cost`).textContent = check && !check.ok ? reasons[0] || 'blocked' : costText(cost);
    button.disabled = g.paused || (check && !check.ok);
    button.style.borderColor = g.buildMode && g.buildType === type ? 'var(--gold)' : '';
    button.title = check && !check.ok ? reasons.join(', ') : '';
  }
  $('build-wall').disabled = g.paused;
  $('build-wall').style.borderColor = wallMode ? 'var(--gold)' : '';
  $('build-wall-cost').textContent = 'anchors';

  const info = $('build-info');
  if (wallMode) {
    const a = g.towers.find((tower) => tower.id === g.wallAnchorA);
    const b = g.towers.find((tower) => tower.id === g.wallAnchorB);
    if (!a) {
      info.innerHTML = 'Click a finished <b>Tower</b> or the <b>Keep</b> for anchor A.';
    } else if (!b) {
      info.innerHTML = `Anchor A: <b>${a.keep ? 'KEEP' : `Tower #${a.id}`}</b><br />Click a different finished anchor for B. Escape/right-click goes back.`;
    } else {
      const plan = g.buildCheck || wallPlan(g, a.id, b.id);
      const near = [a, b].some((tower) => Math.hypot(g.player.x - tower.x, g.player.y - tower.y)
        <= PLAYER.presenceRadius + tower.radius);
      const reasons = [...(plan.reasons || [])];
      if (!near) reasons.push('stand at one of the two towers to start the wall');
      const connected = towerConnectivity(g, a) !== 'outpost' || towerConnectivity(g, b) !== 'outpost';
      info.innerHTML = [
        `${a.keep ? 'KEEP' : `Tower #${a.id}`} → ${b.keep ? 'KEEP' : `Tower #${b.id}`}`,
        `${plan.segments?.length || 0} segments · ${plan.skipped || 0} cliff/water skipped · ${Math.ceil(plan.cost?.stone || 0)} Stone`,
        `<span class="${connected ? 'good' : 'warn'}">${connected ? 'CONNECTED' : 'OUTPOST'}</span>`,
        plan.ok && near ? '<span class="good">Valid wall — press Enter or click Build wall.</span>'
          : `<span class="warn">Blocked: ${[...new Set(reasons)].join(', ') || 'invalid wall'}</span>`,
      ].join('<br />');
    }
  } else if (g.buildMode && g.buildCheck) {
    const check = g.buildCheck;
    const reasons = check.reasons || (check.reason ? [check.reason] : []);
    const lines = [];
    if ((g.buildType || 'tower') === 'tower' && g.buildSite) {
      lines.push(`Cost ${costText(check.cost)}`);
      lines.push(check.ok ? '<span class="good">Valid site — press Enter or click Build here.</span>'
        : `<span class="warn">Blocked: ${reasons.join(', ') || 'invalid site'}</span>`);
    } else {
      if (g.buildType === 'farm' && Number.isFinite(check.fertility)) lines.push(`Fertility x${fmt(check.fertility, 2)}`);
      if (g.buildType === 'farm' && Number.isFinite(check.rate)) lines.push(`Feeds ${farmSupport({ rate: check.rate })} soldiers`);
      else if (Number.isFinite(check.rate)) lines.push(`Output ${fmt(check.rate, 2)}/s`);
      if (check.cost) lines.push(`Cost ${costText(check.cost)}`);
      lines.push(check.ok ? '<span class="good">Valid site — press Enter or click Build here.</span>'
        : `<span class="warn">Blocked: ${reasons.join(', ') || 'invalid site'}</span>`);
    }
    info.innerHTML = lines.join('<br />');
  } else {
    info.innerHTML = 'Choose a structure and build nearby, or choose <b>Wall [X]</b> and select two finished anchors. Farms need fertile ground; quarries and mines need an unclaimed site.';
  }
}

function setUpgradeButton(button, label, cost, g, enabled) {
  if (cost === null) {
    button.disabled = true; button.innerHTML = `${label}<span class="cost">MAX</span>`; return;
  }
  button.disabled = !enabled || !canAfford(g, cost);
  button.innerHTML = `${label}<span class="cost">${costText(cost)}</span>`;
}

export function updateMapInfo(g) {
  const report = g.map.report || {};
  const barriers = (report.barriers || []).map((b) => `${b.type}@x${b.cx}: ${b.routes} routes, narrowest ${b.narrowest}t`).join('<br />');
  $('d-mapinfo').innerHTML = [
    `seed <b>${g.seed}</b> — accepted on attempt ${g.map.attempts}${g.map.relaxed ? ' <span class="warn">(relaxed)</span>' : ''}`,
    Number.isFinite(report.openFrac) ? `open ${(report.openFrac * 100).toFixed(0)}% · forest ${(report.forestFrac * 100).toFixed(0)}% · water ${(report.waterFrac * 100).toFixed(0)}%` : '',
    barriers,
    report.roads ? `roads ${report.roads.roads} · junctions ${report.roads.junctions} · turns avg ${report.roads.avgTurns.toFixed(1)} max ${report.roads.maxTurns}`
      + ` · min spacing ${Number.isFinite(report.roads.minSpacing) ? report.roads.minSpacing : '—'} · loops ${report.roads.loops}`
      + ` · self-crossings ${report.roads.selfIntersections} · knots ${g.map.roadDefects?.knots ?? '?'} · rejected ${report.roads.rejected}` : '',
    (report.problems || []).length ? `<span class="warn">${report.problems.join('; ')}</span>` : '',
  ].filter(Boolean).join('<br />');
}

export function showEnd(g) {
  const won = g.status === 'won';
  const keepLost = g.lossCause === 'keep';
  $('end-title').textContent = won ? 'Line held' : keepLost ? 'Keep fallen' : 'You died';
  $('end-title').style.color = won ? 'var(--green)' : 'var(--red)';
  $('end-sub').textContent = won ? `You survived all ${WAVE.totalToSurvive} waves as the ${g.arch.name}.`
    : keepLost ? `The Keep fell on wave ${g.wave}.` : `Killed on wave ${g.wave} as the ${g.arch.name}.`;
  $('end-stats').innerHTML = [
    ['Waves cleared', g.stats.wavesCleared], ['Enemies killed', g.stats.kills],
    ['Towers lost', g.stats.towersLost], ['Nests destroyed', g.stats.nestsDestroyed || 0],
    ['Stone', Math.floor(g.res?.stone || 0)], ['Gold', Math.floor(g.res?.gold || 0)], ['Seed', g.seed],
  ].map(([key, value]) => `<div class="row"><span>${key}</span><span>${value}</span></div>`).join('');
  $('end-overlay').hidden = false;
}
