// D112: weather presentation. Reads the simulation's blended weather and
// changes what the eye can see: sky and fog colour, atmospheric distance, light,
// rain streaks, airborne dust and storm flashes. Cheap effects only - no
// volumetrics. Elevation keeps an advantage: the higher the eye stands above
// the plain, the more of the lost distance it gets back.

import * as THREE from 'three';
import { WORLD3D } from '../config.js';
import { weatherParams } from '../weather.js';

const SKY = {
  clear: new THREE.Color('#a8c4dc'),
  rain: new THREE.Color('#87929c'),
  storm: new THREE.Color('#545b63'),
  dust: new THREE.Color('#c9b08a'),
};
const RAIN_DROPS = 1600;
const DUST_MOTES = 900;
const BOX = 34;      // metres around the camera
const TALL = 26;

function softDot() {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const ctx = c.getContext('2d');
  const grad = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 32, 32);
  return new THREE.CanvasTexture(c);
}

export function createWeatherLayer(scene, { hemi, sun }) {
  const base = { hemi: hemi.intensity, sun: sun.intensity, near: WORLD3D.fogNear, far: WORLD3D.drawDistance };

  const rainPos = new Float32Array(RAIN_DROPS * 6);
  const drops = [];
  for (let k = 0; k < RAIN_DROPS; k++) drops.push({ x: (Math.random() - 0.5) * 2 * BOX, y: Math.random() * TALL, z: (Math.random() - 0.5) * 2 * BOX, s: 0.8 + Math.random() * 0.4 });
  const rainGeo = new THREE.BufferGeometry();
  rainGeo.setAttribute('position', new THREE.BufferAttribute(rainPos, 3));
  const rainMat = new THREE.LineBasicMaterial({ color: '#c8d2dc', transparent: true, opacity: 0, depthWrite: false });
  const rain = new THREE.LineSegments(rainGeo, rainMat);
  rain.frustumCulled = false;
  rain.visible = false;
  scene.add(rain);

  const dustPos = new Float32Array(DUST_MOTES * 3);
  const motes = [];
  for (let k = 0; k < DUST_MOTES; k++) motes.push({ x: (Math.random() - 0.5) * 2 * BOX, y: Math.random() * TALL * 0.7, z: (Math.random() - 0.5) * 2 * BOX, v: 0.6 + Math.random() });
  const dustGeo = new THREE.BufferGeometry();
  dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPos, 3));
  const dustMat = new THREE.PointsMaterial({ color: '#d8bf90', size: 0.16, map: softDot(), transparent: true, opacity: 0, depthWrite: false });
  const dust = new THREE.Points(dustGeo, dustMat);
  dust.frustumCulled = false;
  dust.visible = false;
  scene.add(dust);

  const sky = new THREE.Color();
  let flash = 0;
  let nextThunder = 6;
  let thunderAt = null;
  let windPhase = 0;

  return {
    /** Returns audio cues for this frame: { thunder, rain, wind, visibility }. */
    update(g, dt, camera) {
      const w = weatherParams(g);
      sky.copy(SKY.clear).lerp(SKY.rain, Math.min(1, w.rain)).lerp(SKY.storm, w.storm).lerp(SKY.dust, w.dust);

      // Height advantage: metres the eye stands above an ordinary plain.
      const lift = Math.max(0, camera.position.y - WORLD3D.elevStep - WORLD3D.eyeHeight);
      const visibility = Math.min(1, w.visibility + (1 - w.visibility) * Math.min(0.55, lift / 30));
      scene.fog.near = Math.max(10, base.near * visibility * visibility);
      scene.fog.far = Math.max(80, base.far * visibility);

      // Storm flashes light the whole sky for a moment; thunder follows.
      if (w.storm > 0.6) {
        nextThunder -= dt;
        if (nextThunder <= 0) {
          flash = 1;
          thunderAt = g.time + 0.4 + Math.random() * 2.2;
          nextThunder = 9 + Math.random() * 16;
        }
      }
      flash = Math.max(0, flash - dt * 3.5);
      const lit = sky.clone().lerp(new THREE.Color('#e8eef8'), flash * 0.7);
      scene.background.copy(lit);
      scene.fog.color.copy(lit);
      hemi.intensity = base.hemi * (1 - w.dark) + flash * 1.6;
      sun.intensity = base.sun * Math.max(0.12, 1 - w.dark * 1.7);

      // Rain: streaks falling around the camera, slanted by the wind.
      windPhase += dt;
      const wind = 2.5 + w.storm * 6 + Math.sin(windPhase * 0.3) * 1.5;
      rain.visible = w.rain > 0.02;
      if (rain.visible) {
        rainMat.opacity = Math.min(0.6, w.rain * 0.55);
        const n = Math.floor(RAIN_DROPS * Math.min(1, w.rain));
        const cx = camera.position.x;
        const cy = camera.position.y - 6;
        const cz = camera.position.z;
        for (let k = 0; k < RAIN_DROPS; k++) {
          const d = drops[k];
          d.y -= 21 * d.s * dt;
          d.x += wind * dt;
          if (d.y < 0) { d.y += TALL; d.x = (Math.random() - 0.5) * 2 * BOX; d.z = (Math.random() - 0.5) * 2 * BOX; }
          if (d.x > BOX) d.x -= 2 * BOX;
          const len = k < n ? 0.9 : 0;
          rainPos[k * 6] = cx + d.x; rainPos[k * 6 + 1] = cy + d.y; rainPos[k * 6 + 2] = cz + d.z;
          rainPos[k * 6 + 3] = cx + d.x - wind * 0.04; rainPos[k * 6 + 4] = cy + d.y + len; rainPos[k * 6 + 5] = cz + d.z;
        }
        rainGeo.getAttribute('position').needsUpdate = true;
      }

      // Dust: motes drifting across the view.
      dust.visible = w.dust > 0.02;
      if (dust.visible) {
        dustMat.opacity = Math.min(0.7, w.dust * 0.65);
        const cx = camera.position.x;
        const cy = camera.position.y - 4;
        const cz = camera.position.z;
        for (let k = 0; k < DUST_MOTES; k++) {
          const m = motes[k];
          m.x += (5 + wind) * m.v * dt;
          m.y += Math.sin(windPhase * 2 + k) * 0.3 * dt;
          if (m.x > BOX) { m.x -= 2 * BOX; m.z = (Math.random() - 0.5) * 2 * BOX; }
          dustPos[k * 3] = cx + m.x; dustPos[k * 3 + 1] = cy + m.y; dustPos[k * 3 + 2] = cz + m.z;
        }
        dustGeo.getAttribute('position').needsUpdate = true;
      }

      const thunder = thunderAt != null && g.time >= thunderAt;
      if (thunder) thunderAt = null;
      return { thunder, rain: w.rain, wind: Math.min(1, w.dust * 0.9 + w.storm * 0.7 + w.rain * 0.2), visibility, dim: w.dark };
    },
    reset() { flash = 0; thunderAt = null; nextThunder = 6; },
    dispose() { scene.remove(rain); scene.remove(dust); rainGeo.dispose(); dustGeo.dispose(); },
  };
}
