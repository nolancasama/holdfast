// D112: occasional weather. Pure simulation state (no DOM), so Tower watch
// distance and the 3D renderer read the same numbers. Weather changes what can
// be seen, never damage or accuracy; it blends over several seconds and long
// clear spells keep each event noticeable.

import { WEATHER } from './config.js';
import { makeRng, hashString } from './rng.js';

const KINDS = Object.keys(WEATHER.kinds);
const smooth = (t) => t * t * (3 - 2 * t);

function pickDuration(rng, [a, b]) {
  return a + rng() * (b - a);
}

export function createWeather(seed) {
  const rng = makeRng(hashString(`${seed}:weather`));
  return {
    rng,
    kind: 'clear',
    from: { ...WEATHER.kinds.clear },
    blend: 1,
    blendTime: WEATHER.blendSeconds,
    timeLeft: pickDuration(rng, WEATHER.firstClear),
    forced: false,
  };
}

/** Begin blending towards `kind` for `duration` seconds. */
export function setWeather(g, kind, { duration = null, blendSeconds = WEATHER.blendSeconds, forced = false } = {}) {
  const w = g.weather;
  if (!WEATHER.kinds[kind]) return false;
  w.from = weatherParams(g);
  w.kind = kind;
  w.blend = blendSeconds > 0 ? 0 : 1;
  w.blendTime = Math.max(0.001, blendSeconds);
  w.timeLeft = duration ?? pickDuration(w.rng, WEATHER.kinds[kind].duration);
  w.forced = forced;
  return true;
}

/** Debug: step to the next weather kind (clear -> rain -> storm -> dust -> clear). */
export function cycleWeather(g, instant = false) {
  const next = KINDS[(KINDS.indexOf(g.weather.kind) + 1) % KINDS.length];
  setWeather(g, next, { duration: next === 'clear' ? null : 240, blendSeconds: instant ? 0 : WEATHER.blendSeconds, forced: true });
  return next;
}

function chooseEvent(rng) {
  let roll = rng() * WEATHER.eventWeights.total;
  for (const [kind, weight] of Object.entries(WEATHER.eventWeights.kinds)) {
    roll -= weight;
    if (roll <= 0) return kind;
  }
  return 'rain';
}

export function updateWeather(g, dt) {
  const w = g.weather;
  if (!w) return;
  if (w.blend < 1) w.blend = Math.min(1, w.blend + dt / w.blendTime);
  w.timeLeft -= dt;
  if (w.timeLeft > 0) return;
  // Every event returns to a long clear spell; clear spells end in an event.
  if (w.kind === 'clear') setWeather(g, chooseEvent(w.rng));
  else setWeather(g, 'clear', { duration: pickDuration(w.rng, WEATHER.kinds.clear.duration) });
}

/** Blended parameters: visibility (0..1 of a clear day), rain, dust, storm, darkness. */
export function weatherParams(g) {
  const w = g.weather;
  if (!w) return { ...WEATHER.kinds.clear };
  const to = WEATHER.kinds[w.kind];
  const k = smooth(Math.max(0, Math.min(1, w.blend)));
  const out = {};
  for (const key of ['visibility', 'rain', 'dust', 'storm', 'dark']) out[key] = w.from[key] + (to[key] - w.from[key]) * k;
  return out;
}

export function weatherState(g) {
  const w = g.weather;
  return { kind: w?.kind ?? 'clear', blend: w?.blend ?? 1, timeLeft: w?.timeLeft ?? Infinity, forced: !!w?.forced, ...weatherParams(g) };
}
