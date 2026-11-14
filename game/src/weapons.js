// Weapons: the numbers and the view models. Four guns, each with its own damage, rate,
// magazine, spread and price, plus the tracer pool that draws every shot. The numbers
// are the gunplay: stopping to aim pays, because spread grows with movement and with
// sustained fire (bloom), and a headshot multiplies damage.
import * as THREE from 'three';
import { PALETTE } from './palette.js';

export const WEAPONS = {
  pistol: {
    id: 'pistol', name: 'P9 Sidearm', kind: 'pistol', price: 0,
    damage: 26, headMult: 2.5, fireGap: 0.22, mag: 12, reserve: 48,
    reloadTime: 1.4, spreadStill: 0.004, spreadMove: 0.03, bloomPerShot: 0.004,
    kick: 0.008, auto: false,
  },
  smg: {
    id: 'smg', name: 'Rattler SMG', kind: 'smg', price: 900,
    damage: 22, headMult: 2.2, fireGap: 0.085, mag: 28, reserve: 112,
    reloadTime: 1.7, spreadStill: 0.006, spreadMove: 0.034, bloomPerShot: 0.003,
    kick: 0.005, auto: true,
  },
  rifle: {
    id: 'rifle', name: 'Longshot Rifle', kind: 'rifle', price: 2100,
    damage: 34, headMult: 2.5, fireGap: 0.11, mag: 30, reserve: 90,
    reloadTime: 1.9, spreadStill: 0.0022, spreadMove: 0.028, bloomPerShot: 0.0035,
    kick: 0.011, auto: true,
  },
  dmr: {
    id: 'dmr', name: 'Needle DMR', kind: 'dmr', price: 3200,
    damage: 72, headMult: 2.5, fireGap: 0.9, mag: 8, reserve: 32,
    reloadTime: 2.4, spreadStill: 0.0012, spreadMove: 0.02, bloomPerShot: 0.001,
    kick: 0.02, auto: false,
  },
};

const MOVE_REFERENCE = 5.2;
const MAX_BLOOM = 0.03;

function gunModel(def, materials) {
  // A simple built-up gun from boxes: receiver, barrel, stock, grip, sight. The shape
  // differs per weapon so the view model reads as a different gun.
  const group = new THREE.Group();
  const body = materials.body;
  const grip = materials.grip;
  const long = def.id === 'rifle' || def.id === 'dmr';
  const receiver = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.1, long ? 0.5 : 0.34), body);
  const barrel = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.045, long ? 0.5 : 0.26), grip);
  barrel.position.set(0, 0.025, long ? -0.48 : -0.3);
  const stock = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.08, 0.22), grip);
  stock.position.set(0, -0.02, long ? 0.34 : 0.26);
  const gripMesh = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.14, 0.08), grip);
  gripMesh.position.set(0, -0.11, 0.08);
  gripMesh.rotation.x = 0.35;
  group.add(receiver, barrel, stock, gripMesh);
  if (def.id === 'dmr') {
    const scope = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 0.22), grip);
    scope.position.set(0, 0.09, -0.05);
    group.add(scope);
  }
  if (def.id === 'smg') {
    const mag = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.16, 0.09), grip);
    mag.position.set(0, -0.12, -0.1);
    mag.rotation.x = -0.15;
    group.add(mag);
  }
  return group;
}

export function createWeaponRig(camera) {
  const materials = {
    body: new THREE.MeshStandardMaterial({ color: new THREE.Color(PALETTE.ink), roughness: 0.5, metalness: 0.35 }),
    grip: new THREE.MeshStandardMaterial({ color: new THREE.Color(PALETTE.hairline), roughness: 0.7, metalness: 0.2 }),
  };
  const models = {};
  for (const def of Object.values(WEAPONS)) {
    const model = gunModel(def, materials);
    model.position.set(0.28, -0.27, -0.72);
    model.scale.setScalar(0.7);
    model.visible = false;
    camera.add(model);
    models[def.id] = model;
  }

  const flash = new THREE.Mesh(
    new THREE.PlaneGeometry(0.26, 0.26),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(PALETTE.accent), transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide }),
  );
  flash.position.set(0.28, -0.24, -1.15);
  flash.visible = false;
  camera.add(flash);
  const flashLight = new THREE.PointLight(new THREE.Color(PALETTE.accent), 0, 5);
  flashLight.position.set(0.28, -0.22, -0.8);
  camera.add(flashLight);

  // Tracer pool: 8 reusable lines, so firing never allocates.
  const tracers = [];
  for (let i = 0; i < 8; i += 1) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
    const line = new THREE.Line(geometry, new THREE.LineBasicMaterial({ color: new THREE.Color(PALETTE.accent), transparent: true, opacity: 0 }));
    line.frustumCulled = false;
    line.visible = false;
    camera.parent.add(line);
    tracers.push({ line, life: 0 });
  }
  let tracerIndex = 0;
  const muzzleWorld = new THREE.Vector3();
  const muzzleLocal = new THREE.Vector3(0.24, -0.18, -0.95);

  const rig = {
    current: WEAPONS.pistol,
    state: { mag: 12, reserve: 48, cooldown: 0, reloadLeft: 0, flash: 0, kick: 0, bloom: 0 },
    equip(id) {
      const def = WEAPONS[id];
      if (!def) return false;
      for (const [key, model] of Object.entries(models)) model.visible = key === id;
      rig.current = def;
      rig.state.mag = def.mag;
      rig.state.reserve = def.reserve;
      rig.state.cooldown = 0;
      rig.state.reloadLeft = 0;
      rig.state.flash = 0;
      rig.state.kick = 0;
      rig.state.bloom = 0;
      return true;
    },
    step(dt) {
      const s = rig.state;
      s.cooldown = Math.max(0, s.cooldown - dt);
      s.flash = Math.max(0, s.flash - dt);
      s.bloom = Math.max(0, s.bloom - dt * 0.02);
      s.kick += (0 - s.kick) * Math.min(1, dt * 14);
      const model = models[rig.current.id];
      model.position.z = -0.72 + s.kick;
      model.rotation.x = s.kick * 2.2;
      flash.visible = s.flash > 0;
      flash.rotation.z = s.flash * 30;
      flashLight.intensity = s.flash > 0 ? 18 : 0;
      if (s.reloadLeft > 0) {
        s.reloadLeft = Math.max(0, s.reloadLeft - dt);
        model.rotation.x = -0.55 * Math.min(1, (rig.current.reloadTime - s.reloadLeft) * 2);
        if (s.reloadLeft === 0) {
          const need = rig.current.mag - s.mag;
          const take = Math.min(need, s.reserve);
          s.mag += take;
          s.reserve -= take;
        }
      }
      for (const tracer of tracers) {
        if (tracer.life <= 0) continue;
        tracer.life -= dt;
        tracer.line.material.opacity = Math.max(0, tracer.life / 0.09) * 0.85;
        if (tracer.life <= 0) tracer.line.visible = false;
      }
    },
    ready() {
      const s = rig.state;
      return s.mag > 0 && s.cooldown === 0 && s.reloadLeft === 0;
    },
    pullTrigger() {
      const s = rig.state;
      s.cooldown = rig.current.fireGap;
      s.flash = 0.06;
      s.kick = 0.055;
      s.bloom = Math.min(MAX_BLOOM, s.bloom + rig.current.bloomPerShot);
    },
    takeRound() {
      if (rig.state.mag <= 0) return false;
      rig.state.mag -= 1;
      return true;
    },
    reload() {
      const s = rig.state;
      if (s.reloadLeft > 0 || s.mag === rig.current.mag || s.reserve === 0) return false;
      s.reloadLeft = rig.current.reloadTime;
      return true;
    },
    spread(speed) {
      const def = rig.current;
      return def.spreadStill + Math.min(1, speed / MOVE_REFERENCE) * def.spreadMove + rig.state.bloom;
    },
    addReserve(amount) {
      rig.state.reserve += amount;
    },
    fireTracer(endPoint) {
      const tracer = tracers[tracerIndex];
      tracerIndex = (tracerIndex + 1) % tracers.length;
      muzzleLocal.set(0.28, -0.24, -1.15);
      camera.localToWorld(muzzleWorld.copy(muzzleLocal));
      const positions = tracer.line.geometry.attributes.position.array;
      positions[0] = muzzleWorld.x;
      positions[1] = muzzleWorld.y;
      positions[2] = muzzleWorld.z;
      positions[3] = endPoint.x;
      positions[4] = endPoint.y;
      positions[5] = endPoint.z;
      tracer.line.geometry.attributes.position.needsUpdate = true;
      tracer.line.visible = true;
      tracer.life = 0.09;
    },
  };
  rig.equip('pistol');
  return rig;
}
