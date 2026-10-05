// Web Audio observer. Safe to import in Node: context creation happens only on a gesture.
import { AUDIO } from './config.js';

export const AUDIO_PRIORITY = Object.freeze({
  playerDamage: 10, collapsing: 9, collapsingReminder: 9, heavyBreach: 9, wallBreak: 9, breach: 8, heavyWallHit: 6, wallHit: 4, towerUnderAttack: 8, towerDestroy: 8,
  exposed: 7, towerEntry: 6, waveWarning: 5, heavyTowerHit: 4, upgradeStart: 3,
  towerFire: 3, enemyDeath: 2, enemyHit: 1,
  towerBell: 8, distantHorn: 7, distantRoar: 7, thunder: 6, crossbow: 5, swordSwing: 4, reloaded: 3,
});

export function cuePriority(type) { return AUDIO_PRIORITY[type] || 2; }
export function shouldRateLimit(lastAt, type, now, limits = AUDIO.rateLimits) {
  const key = type === 'heavyTowerHit' ? 'heavyTowerHit' : type;
  return now - (lastAt[key] ?? -Infinity) >= (limits[key] ?? limits.default);
}
export function selectVoices(events, activeCount, cap = AUDIO.voiceCap) {
  return events.slice().sort((a, b) => cuePriority(b.type) - cuePriority(a.type))
    .slice(0, Math.max(0, cap - activeCount));
}

export function createAudioSystem() {
  let context = null, enabled = true, muted = false, volume = AUDIO.masterVolume;
  let master = null, active = 0, ducked = false;
  const lastAt = {}, sustained = new Set();
  const now = () => (typeof performance !== 'undefined' ? performance.now() / 1000 : Date.now() / 1000);
  const storage = (key, fallback) => { try { const v = localStorage.getItem(key); return v === null ? fallback : v; } catch { return fallback; } };
  enabled = storage('holdfast.audioEnabled', 'true') !== 'false'; muted = storage('holdfast.audioMuted', 'false') === 'true';
  volume = Number(storage('holdfast.audioVolume', String(volume))) || volume;
  const persist = () => { try { localStorage.setItem('holdfast.audioEnabled', enabled); localStorage.setItem('holdfast.audioMuted', muted); localStorage.setItem('holdfast.audioVolume', volume); } catch {} };
  function ensure() {
    if (context) return context;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      context = new Ctx(); master = context.createGain(); master.gain.value = 0;
      const limiter = context.createDynamicsCompressor(); limiter.threshold.value = AUDIO.limiter.threshold; limiter.ratio.value = AUDIO.limiter.ratio;
      master.connect(limiter); limiter.connect(context.destination); applyGain();
    } catch { context = null; }
    return context;
  }
  function applyGain() { if (master && context) master.gain.setTargetAtTime(enabled && !muted ? volume * (ducked ? 0.2 : 1) : 0, context.currentTime, 0.025); }
  function gesture() { const c = ensure(); if (c && c.state === 'suspended') c.resume().catch(() => {}); }
  function stopSustained() { for (const n of sustained) { try { n.stop(); } catch {} } sustained.clear(); }
  function noise(seconds, filter, gain, pan) {
    const c = context; const b = c.createBuffer(1, Math.ceil(c.sampleRate * seconds), c.sampleRate); const d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const s = c.createBufferSource(); s.buffer = b; s.connect(filter); filter.connect(gain); if (pan) gain.connect(pan); else gain.connect(master); s.start(); s.stop(c.currentTime + seconds); return s;
  }
  // D111-D113: world cues with their own voices and distance curves - a horn and
  // a roar carry far but faintly, a Tower bell carries a fair way, thunder is
  // everywhere, and weapon sounds are close.
  function special(kind, c, out, distance) {
    const t0 = c.currentTime;
    const curve = AUDIO.reach[kind];
    if (curve) out.gain.value = Math.max(curve[1], Math.min(curve[2], 1 - distance / curve[0]));
    const env = (node, peak, attack, hold, release) => {
      const gn = c.createGain(); gn.gain.setValueAtTime(0.0001, t0);
      gn.gain.exponentialRampToValueAtTime(peak, t0 + attack); gn.gain.setValueAtTime(peak, t0 + attack + hold);
      gn.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + hold + release); node.connect(gn); gn.connect(out); return attack + hold + release;
    };
    const tone = (type, freq, end = freq) => { const o = c.createOscillator(); o.type = type; o.frequency.setValueAtTime(freq, t0); if (end !== freq) o.frequency.exponentialRampToValueAtTime(end, t0 + 0.6); return o; };
    const filtered = (src, type, freq) => { const f = c.createBiquadFilter(); f.type = type; f.frequency.value = freq; src.connect(f); return f; };
    const noiseSrc = (seconds) => { const b = c.createBuffer(1, Math.ceil(c.sampleRate * seconds), c.sampleRate); const d = b.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; const s = c.createBufferSource(); s.buffer = b; return s; };
    const sources = [];
    let dur = 0.3;
    if (kind === 'distantHorn') {
      for (const f of [98, 98.6, 147]) { const o = tone('sawtooth', f); dur = env(filtered(o, 'lowpass', 520), f > 140 ? 0.03 : 0.07, 0.35, 1.2, 0.8); sources.push(o); }
    } else if (kind === 'distantRoar') {
      const s = noiseSrc(2.6); dur = env(filtered(s, 'lowpass', 320), 0.22, 0.7, 0.9, 1.0); sources.push(s);
      const o = tone('sawtooth', 72, 46); env(filtered(o, 'lowpass', 240), 0.06, 0.5, 0.8, 0.9); sources.push(o);
    } else if (kind === 'towerBell') {
      for (const [f, a] of [[740, 0.09], [1776, 0.035], [370, 0.05]]) { const o = tone('sine', f); dur = Math.max(dur, env(o, a, 0.005, 0.02, 1.7)); sources.push(o); }
    } else if (kind === 'thunder') {
      const s = noiseSrc(3.2); dur = env(filtered(s, 'lowpass', 170), 0.5, 0.08 + Math.random() * 0.2, 0.4, 2.4); sources.push(s);
    } else if (kind === 'crossbow') {
      const s = noiseSrc(0.12); env(filtered(s, 'highpass', 1800), 0.12, 0.003, 0.01, 0.08); sources.push(s);
      const o = tone('square', 150, 55); dur = env(filtered(o, 'lowpass', 900), 0.08, 0.003, 0.02, 0.14); sources.push(o);
    } else if (kind === 'reloaded') {
      const o = tone('square', 1500); dur = env(filtered(o, 'bandpass', 1500), 0.04, 0.002, 0.01, 0.04); sources.push(o);
    } else if (kind === 'swordSwing') {
      const s = noiseSrc(0.25); const f = filtered(s, 'bandpass', 900); f.frequency.exponentialRampToValueAtTime(2600, t0 + 0.18);
      dur = env(f, 0.07, 0.04, 0.03, 0.12); sources.push(s);
    }
    for (const src of sources) { src.start(t0); src.stop(t0 + dur + 0.05); }
    sources[0].onended = () => { active = Math.max(0, active - 1); };
  }

  function play(event) {
    if (!enabled || muted || !context || context.state !== 'running') return;
    const n = now(); if (!shouldRateLimit(lastAt, event.type, n)) return; lastAt[event.type] = n;
    const c = context; if (active >= AUDIO.voiceCap) return; active++;
    const playerX = event.playerX ?? 0; const distance = Math.hypot((event.x || 0) - playerX, (event.y || 0) - (event.playerY ?? 0));
    // D101: with a listener right vector (first person), pan by facing, not by map x.
    const lateral = event.rightX != null ? ((event.x || 0) - playerX) * event.rightX + ((event.y || 0) - (event.playerY ?? 0)) * event.rightY : (event.x || 0) - playerX;
    const pan = c.createStereoPanner(); pan.pan.value = Math.max(-1, Math.min(1, lateral / Math.max(6, Math.min(AUDIO.farDistance, distance || 1))));
    const out = c.createGain(); out.gain.value = Math.max(0.08, 1 - distance / AUDIO.farDistance); out.connect(pan); pan.connect(master);
    if (AUDIO.special.includes(event.type)) { special(event.type, c, out, distance); return; }
    const osc = c.createOscillator(); const gain = c.createGain(); const start = c.currentTime;
    const reminder = event.type === 'collapsingReminder'; const kind = reminder ? 'collapsing' : event.type;
    if (reminder) out.gain.value *= AUDIO.collapsingReminderGain;
    const heavy = kind === 'heavyTowerHit' || kind === 'heavyWallHit'; const breach = kind === 'breach' || kind === 'heavyBreach' || kind === 'wallBreak';
    const low = kind === 'towerHit' || kind === 'wallHit' || heavy || breach || kind === 'towerDestroy' || kind === 'collapsing';
    if (breach) out.gain.value = 1; // D78: structure impacts remain prominent at distance
    const dropFreq = AUDIO.dropFrequencies[event.category] || AUDIO.dropFrequencies.temporary;
    const spec = event.type === 'dropSpawn' ? [dropFreq, .16, 'sine']
      : event.type === 'dropCollect' ? [dropFreq * 1.25, .18, 'triangle']
      : AUDIO.cues[kind] || [520, .12, 'square'];
    const [freq, dur, oscillatorType] = spec;
    osc.type = oscillatorType; osc.frequency.setValueAtTime(freq * (0.96 + Math.random() * 0.08), start); const rising = AUDIO.risingCues.includes(event.type); osc.frequency.exponentialRampToValueAtTime(rising ? freq * AUDIO.risingPitchMult : Math.max(28, freq * 0.42), start + Math.min(rising ? dur * 0.7 : .14, dur));
    const amp = event.occupied ? AUDIO.envelope.occupied : event.type === 'playerDamage' || kind === 'collapsing' ? AUDIO.envelope.urgent
      : AUDIO.envelope[kind] ?? AUDIO.envelope.normal;
    gain.gain.setValueAtTime(0.0001, start); gain.gain.exponentialRampToValueAtTime(amp, start + AUDIO.envelope.attack); gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    osc.connect(gain); gain.connect(out); osc.start(start); osc.stop(start + dur + 0.02);
    if (low || kind === 'towerFire' || kind === 'towerDestroy') { const f = c.createBiquadFilter(); f.type = low ? 'lowpass' : 'highpass'; f.frequency.value = low ? 650 : 1400; const ng = c.createGain(); ng.gain.setValueAtTime(low ? AUDIO.envelope.noiseLow : kind === 'towerFire' ? AUDIO.envelope.towerFireNoise : AUDIO.envelope.noiseHigh, start); ng.gain.exponentialRampToValueAtTime(0.0001, start + dur); ng.connect(out); noise(dur, f, ng, null); }
    if (kind === 'collapsing') { const alarm = c.createOscillator(); const ag = c.createGain(); alarm.type = 'sawtooth'; alarm.frequency.setValueAtTime(390, start); alarm.frequency.linearRampToValueAtTime(520, start + 0.16); ag.gain.setValueAtTime(0.0001, start); ag.gain.linearRampToValueAtTime(0.10, start + .03); ag.gain.setValueAtTime(.035, start + .22); ag.gain.exponentialRampToValueAtTime(.0001, start + dur); alarm.connect(ag); ag.connect(out); alarm.start(start); alarm.stop(start + dur); }
    if (event.type === 'playerDeath') { ducked = true; applyGain(); }
    osc.onended = () => { active = Math.max(0, active - 1); };
  }
  // D112: looped rain and wind beds whose levels follow the weather.
  const beds = {};
  function bed(name, type, freq) {
    if (beds[name]) return beds[name];
    const c = context; const b = c.createBuffer(1, c.sampleRate * 2, c.sampleRate); const d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const s = c.createBufferSource(); s.buffer = b; s.loop = true;
    const f = c.createBiquadFilter(); f.type = type; f.frequency.value = freq;
    const gn = c.createGain(); gn.gain.value = 0;
    s.connect(f); f.connect(gn); gn.connect(master); s.start();
    beds[name] = gn;
    return gn;
  }
  function setAmbience({ rain = 0, wind = 0 } = {}) {
    if (!context || context.state !== 'running') return;
    const t = context.currentTime;
    if (rain > 0.01 || beds.rain) bed('rain', 'highpass', 1100).gain.setTargetAtTime(rain * AUDIO.ambience.rain, t, 0.6);
    if (wind > 0.01 || beds.wind) bed('wind', 'lowpass', 420).gain.setTargetAtTime(wind * AUDIO.ambience.wind, t, 0.8);
  }

  return {
    setAmbience,
    gesture, playEvents(events, player, paused = false, right = null) { if (paused) { stopSustained(); return; } for (const e of selectVoices(events, active)) play({ ...e, playerX: player.x, playerY: player.y, ...(right ? { rightX: right.x, rightY: right.y } : {}) }); },
    setEnabled(v) { enabled = !!v; if (!enabled) stopSustained(); persist(); applyGain(); }, setMuted(v) { muted = !!v; persist(); applyGain(); }, setVolume(v) { volume = Math.max(0, Math.min(1, Number(v))); persist(); applyGain(); },
    get state() { return { enabled, muted, volume, active }; }, suspendForPause() { stopSustained(); if (context && context.state === 'running') context.suspend().catch(() => {}); }, resumeAfterPause() { if (enabled) gesture(); },
  };
}
