// D113: first-person weapon view models. Rendered as a second pass over the
// world (own scene + camera, depth cleared) so the weapon never clips into
// walls. Placeholder geometry only: no arms, no character animation. The
// simulation owns cooldowns; this file only reads them to animate.

import * as THREE from 'three';
import { PLAYER } from '../config.js';

const wood = new THREE.MeshLambertMaterial({ color: '#7a5434' });
const woodDark = new THREE.MeshLambertMaterial({ color: '#4a3220' });
const iron = new THREE.MeshLambertMaterial({ color: '#5a6068' });
const steel = new THREE.MeshPhongMaterial({ color: '#c9d0d8', shininess: 80, specular: '#ffffff' });
const leather = new THREE.MeshLambertMaterial({ color: '#3b2a1e' });

function box(w, h, d, mat, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  return m;
}

function makeCrossbow() {
  const g = new THREE.Group();
  const body = new THREE.Group();
  body.add(box(0.06, 0.07, 0.62, wood, 0, 0, 0));            // stock
  body.add(box(0.05, 0.1, 0.16, woodDark, 0, -0.07, 0.2));   // grip
  body.add(box(0.02, 0.05, 0.03, iron, 0, -0.06, 0.08));     // trigger
  // Prod: two limbs swept slightly back from the nose.
  for (const s of [-1, 1]) {
    const limb = box(0.34, 0.03, 0.045, woodDark, s * 0.17, 0.02, -0.29);
    limb.rotation.y = s * 0.18;
    body.add(limb);
  }
  body.add(box(0.07, 0.06, 0.06, iron, 0, 0.02, -0.3));      // nose
  g.add(body);
  // String: two segments from the limb tips to the nut, redrawn as it spans.
  const stringMat = new THREE.LineBasicMaterial({ color: '#e8dcc0' });
  const stringGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()]);
  const string = new THREE.Line(stringGeo, stringMat);
  g.add(string);
  const bolt = new THREE.Group();
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.34, 5), wood);
  shaft.rotation.x = Math.PI / 2;
  bolt.add(shaft);
  const head = new THREE.Mesh(new THREE.ConeGeometry(0.016, 0.05, 5), iron);
  head.rotation.x = -Math.PI / 2;
  head.position.z = -0.19;
  bolt.add(head);
  bolt.position.set(0, 0.05, -0.1);
  g.add(bolt);
  g.userData = { string, stringGeo, bolt };
  return g;
}

function makeSword() {
  const g = new THREE.Group();
  const blade = box(0.045, 0.72, 0.012, steel, 0, 0.47, 0);
  g.add(blade);
  const tip = new THREE.Mesh(new THREE.ConeGeometry(0.032, 0.08, 4), steel);
  tip.position.y = 0.87;
  tip.rotation.y = Math.PI / 4;
  tip.scale.z = 0.3;
  g.add(tip);
  g.add(box(0.2, 0.028, 0.035, iron, 0, 0.1, 0));             // crossguard
  g.add(new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.02, 0.15, 6), leather));
  g.children.at(-1).position.y = 0.02;
  g.add(new THREE.Mesh(new THREE.SphereGeometry(0.028, 6, 5), iron));
  g.children.at(-1).position.y = -0.06;
  return g;
}

export function createViewModel() {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(58, 1, 0.01, 10);
  scene.add(new THREE.HemisphereLight('#f2f4ff', '#4a4038', 2.2));
  const key = new THREE.DirectionalLight('#fff1d6', 1.6);
  key.position.set(1, 2, 1);
  scene.add(key);

  const crossbow = makeCrossbow();
  const sword = makeSword();
  sword.scale.setScalar(0.62);
  crossbow.scale.setScalar(0.5);
  const rig = new THREE.Group();
  scene.add(rig);
  rig.add(crossbow, sword);

  let shown = 'melee';
  let lower = 0;           // 0 = raised, 1 = lowered (switching)
  let walk = 0;
  let lastShot = -99;
  let kick = 0;
  let lastSwing = -99;
  let swingT = 1;
  const light = { base: 1 };

  return {
    camera,
    resize(aspect) { camera.aspect = aspect; camera.updateProjectionMatrix(); },
    /** dim: 0..1 weather darkening so the weapon sits in the scene's light. */
    update(g, dt, { moving = 0, sprint = false, hidden = false, dim = 0 } = {}) {
      const p = g.player;
      const want = p.weapon === 'crossbow' ? 'crossbow' : 'melee';
      // Lower, swap, raise.
      if (want !== shown) { lower = Math.min(1, lower + dt * 7); if (lower >= 1) shown = want; }
      else lower = Math.max(0, lower - dt * 6);
      crossbow.visible = shown === 'crossbow';
      sword.visible = shown === 'melee';
      rig.visible = !hidden;

      walk += dt * (moving ? (sprint ? 13 : 9) : 0);
      const bobX = Math.sin(walk) * 0.012 * moving;
      const bobY = Math.abs(Math.cos(walk)) * 0.014 * moving;

      if (p.lastShotAt !== lastShot) { lastShot = p.lastShotAt; kick = 1; }
      kick = Math.max(0, kick - dt * 5);
      if (p.lastSwingAt !== lastSwing) { lastSwing = p.lastSwingAt; swingT = 0; }
      swingT = Math.min(1, swingT + dt / 0.32);

      // Crossbow: kick on release, string slack and bolt missing while reloading.
      const reload = PLAYER.crossbow.reload;
      const r = p.boltCd > 0 ? 1 - p.boltCd / reload : 1;   // 0 just fired -> 1 ready
      crossbow.position.set(0.2 + bobX, -0.2 - bobY - lower * 0.35 + (r < 1 ? -0.03 * Math.sin(r * Math.PI) : 0), -0.62 + kick * 0.06);
      crossbow.rotation.set(kick * 0.22 + (r < 1 ? 0.25 * Math.sin(r * Math.PI) : 0), 0.04, (r < 1 ? -0.3 * Math.sin(r * Math.PI) : 0));
      const drawn = r >= 0.55 ? 1 : 0;
      const nutZ = drawn ? 0.02 : -0.27;
      const sp = crossbow.userData.stringGeo.getAttribute('position');
      sp.setXYZ(0, -0.33, 0.02, -0.24);
      sp.setXYZ(1, 0, 0.04, nutZ);
      sp.setXYZ(2, 0.33, 0.02, -0.24);
      sp.needsUpdate = true;
      const bolt = crossbow.userData.bolt;
      bolt.visible = r >= 0.75;
      bolt.position.y = 0.05 - Math.max(0, 1 - (r - 0.75) / 0.2) * 0.12;

      // Sword: rests angled up-right; a swing sweeps it across and down.
      const s = swingT < 1 ? Math.sin(swingT * Math.PI) : 0;
      const sweep = swingT < 1 ? swingT : 0;
      // Rest: low on the right, tip leaning forward and away from the centre.
      sword.position.set(0.34 + bobX - sweep * 0.42, -0.36 - bobY - lower * 0.4 + s * 0.1, -0.62 - s * 0.1);
      sword.rotation.set(-1.05 - s * 0.5, 0.15, -0.35 + sweep * 1.8 * (swingT < 1 ? 1 : 0));

      light.base = 1 - dim * 0.55;
      key.intensity = 1.6 * light.base;
    },
    render(renderer) {
      renderer.autoClear = false;
      renderer.clearDepth();
      renderer.render(scene, camera);
      renderer.autoClear = true;
    },
  };
}
