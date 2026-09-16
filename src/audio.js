// Web Audio observer. Safe to import in Node: context creation happens only on a gesture.
import { AUDIO } from './config.js';

export const AUDIO_PRIORITY = Object.freeze({
  playerDamage: 10, collapsing: 9, collapsingReminder: 9, towerDestroy: 8, exposed: 7, towerEntry: 6,
  waveWarning: 5, heavyTowerHit: 4, towerFire: 3, enemyDeath: 2, enemyHit: 1,
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
  function play(event) {
    if (!enabled || muted || !context || context.state !== 'running') return;
    const n = now(); if (!shouldRateLimit(lastAt, event.type, n)) return; lastAt[event.type] = n;
    const c = context; if (active >= AUDIO.voiceCap) return; active++;
    const playerX = event.playerX ?? 0; const distance = Math.hypot((event.x || 0) - playerX, (event.y || 0) - (event.playerY ?? 0));
    const pan = c.createStereoPanner(); pan.pan.value = Math.max(-1, Math.min(1, ((event.x || 0) - playerX) / AUDIO.farDistance));
    const out = c.createGain(); out.gain.value = Math.max(0.08, 1 - distance / AUDIO.farDistance); out.connect(pan); pan.connect(master);
    const osc = c.createOscillator(); const gain = c.createGain(); const start = c.currentTime;
    const reminder = event.type === 'collapsingReminder'; const kind = reminder ? 'collapsing' : event.type;
    if (reminder) out.gain.value *= AUDIO.collapsingReminderGain;
    const heavy = kind === 'heavyTowerHit'; const low = kind === 'towerHit' || heavy || kind === 'towerDestroy' || kind === 'collapsing';
    const dropFreq = AUDIO.dropFrequencies[event.category] || AUDIO.dropFrequencies.temporary;
    const spec = event.type === 'dropSpawn' ? [dropFreq, .16, 'sine']
      : event.type === 'dropCollect' ? [dropFreq * 1.25, .18, 'triangle']
      : AUDIO.cues[kind] || [520, .12, 'square'];
    const [freq, dur, oscillatorType] = spec;
    osc.type = oscillatorType; osc.frequency.setValueAtTime(freq * (0.96 + Math.random() * 0.08), start); const rising = AUDIO.risingCues.includes(event.type); osc.frequency.exponentialRampToValueAtTime(rising ? freq * AUDIO.risingPitchMult : Math.max(28, freq * 0.42), start + Math.min(rising ? dur * 0.7 : .14, dur));
    const amp = event.occupied ? AUDIO.envelope.occupied : event.type === 'playerDamage' || kind === 'collapsing' ? AUDIO.envelope.urgent : AUDIO.envelope.normal;
    gain.gain.setValueAtTime(0.0001, start); gain.gain.exponentialRampToValueAtTime(amp, start + AUDIO.envelope.attack); gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    osc.connect(gain); gain.connect(out); osc.start(start); osc.stop(start + dur + 0.02);
    if (low || kind === 'towerFire' || kind === 'towerDestroy') { const f = c.createBiquadFilter(); f.type = low ? 'lowpass' : 'highpass'; f.frequency.value = low ? 650 : 1400; const ng = c.createGain(); ng.gain.setValueAtTime(low ? AUDIO.envelope.noiseLow : AUDIO.envelope.noiseHigh, start); ng.gain.exponentialRampToValueAtTime(0.0001, start + dur); ng.connect(out); noise(dur, f, ng, null); }
    if (kind === 'collapsing') { const alarm = c.createOscillator(); const ag = c.createGain(); alarm.type = 'sawtooth'; alarm.frequency.setValueAtTime(390, start); alarm.frequency.linearRampToValueAtTime(520, start + 0.16); ag.gain.setValueAtTime(0.0001, start); ag.gain.linearRampToValueAtTime(0.10, start + .03); ag.gain.setValueAtTime(.035, start + .22); ag.gain.exponentialRampToValueAtTime(.0001, start + dur); alarm.connect(ag); ag.connect(out); alarm.start(start); alarm.stop(start + dur); }
    if (event.type === 'playerDeath') { ducked = true; applyGain(); }
    osc.onended = () => { active = Math.max(0, active - 1); };
  }
  return {
    gesture, playEvents(events, player, paused = false) { if (paused) { stopSustained(); return; } for (const e of selectVoices(events, active)) play({ ...e, playerX: player.x, playerY: player.y }); },
    setEnabled(v) { enabled = !!v; if (!enabled) stopSustained(); persist(); applyGain(); }, setMuted(v) { muted = !!v; persist(); applyGain(); }, setVolume(v) { volume = Math.max(0, Math.min(1, Number(v))); persist(); applyGain(); },
    get state() { return { enabled, muted, volume, active }; }, suspendForPause() { stopSustained(); if (context && context.state === 'running') context.suspend().catch(() => {}); }, resumeAfterPause() { if (enabled) gesture(); },
  };
}
