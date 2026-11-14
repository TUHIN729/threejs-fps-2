// Frag grenades: a thrown sphere with gravity, axis-separated bounce off the world's
// boxes, and a timed explosion that hurts through line of sight. One mesh per live
// grenade, at most four, reused from a pool.
import * as THREE from 'three';
import { PALETTE } from './palette.js';

const GRAVITY = 14;
const RADIUS = 0.12;
const FUSE = 1.8;
const BLAST_RADIUS = 6.5;
const BLAST_MAX = 110;
const BLAST_MIN = 15;
const MAX_LIVE = 4;

export function createGrenades(scene, colliders, onExplode) {
  const pool = [];
  for (let i = 0; i < MAX_LIVE; i += 1) {
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(RADIUS, 10, 8),
      new THREE.MeshStandardMaterial({ color: new THREE.Color(PALETTE.hairline), roughness: 0.6, metalness: 0.4 }),
    );
    mesh.visible = false;
    mesh.castShadow = true;
    scene.add(mesh);
    pool.push({ mesh, active: false, velocity: new THREE.Vector3(), fuse: 0, bounced: false });
  }
  const blast = new THREE.Mesh(
    new THREE.SphereGeometry(1, 20, 14),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(PALETTE.accent), transparent: true, opacity: 0, depthWrite: false }),
  );
  blast.visible = false;
  scene.add(blast);
  const blastLight = new THREE.PointLight(new THREE.Color(PALETTE.accent), 0, 18);
  scene.add(blastLight);
  let blastLife = 0;
  const probe = new THREE.Box3();

  function overlapsGrenade(x, y, z) {
    probe.min.set(x - RADIUS, y - RADIUS, z - RADIUS);
    probe.max.set(x + RADIUS, y + RADIUS, z + RADIUS);
    for (const collider of colliders) if (probe.intersectsBox(collider)) return true;
    return false;
  }

  return {
    count() {
      return pool.filter((g) => g.active).length;
    },
    throw(position, direction, speed = 13) {
      const slot = pool.find((g) => !g.active);
      if (!slot) return false;
      slot.active = true;
      slot.mesh.visible = true;
      slot.mesh.position.copy(position);
      slot.velocity.copy(direction).multiplyScalar(speed);
      slot.velocity.y += 3.5;
      slot.fuse = FUSE;
      slot.bounced = false;
      return true;
    },
    step(dt, audio) {
      if (blastLife > 0) {
        blastLife -= dt;
        const t = Math.max(0, blastLife / 0.5);
        blast.scale.setScalar(1 + (1 - t) * BLAST_RADIUS);
        blast.material.opacity = t * 0.55;
        blastLight.intensity = t * 60;
        if (blastLife <= 0) {
          blast.visible = false;
          blastLight.intensity = 0;
        }
      }
      for (const slot of pool) {
        if (!slot.active) continue;
        slot.fuse -= dt;
        slot.velocity.y -= GRAVITY * dt;
        const p = slot.mesh.position;
        const next = p.clone();
        next.x += slot.velocity.x * dt;
        if (overlapsGrenade(next.x, p.y, p.z)) {
          slot.velocity.x *= -0.45;
          if (audio) audio.bounce();
        } else p.x = next.x;
        next.y += slot.velocity.y * dt;
        if (overlapsGrenade(p.x, next.y, p.z)) {
          if (!slot.bounced && audio) audio.bounce();
          slot.bounced = true;
          slot.velocity.y *= -0.45;
          if (Math.abs(slot.velocity.y) < 0.8) slot.velocity.y = 0;
        } else p.y = next.y;
        next.z += slot.velocity.z * dt;
        if (overlapsGrenade(p.x, p.y, next.z)) {
          slot.velocity.z *= -0.45;
          if (audio) audio.bounce();
        } else p.z = next.z;
        if (p.y < RADIUS) {
          p.y = RADIUS;
          slot.velocity.y = Math.abs(slot.velocity.y) * 0.45;
          slot.velocity.y = slot.velocity.y < 0.8 ? 0 : slot.velocity.y;
        }
        if (slot.fuse <= 0) {
          slot.active = false;
          slot.mesh.visible = false;
          blast.position.copy(p);
          blast.visible = true;
          blastLife = 0.5;
          blastLight.position.copy(p);
          onExplode(p.clone());
        }
      }
    },
    reset() {
      for (const slot of pool) {
        slot.active = false;
        slot.mesh.visible = false;
      }
      blast.visible = false;
      blastLife = 0;
      blastLight.intensity = 0;
    },
    blastRadius: BLAST_RADIUS,
    blastDamage(distance) {
      const t = Math.max(0, 1 - distance / BLAST_RADIUS);
      return BLAST_MIN + (BLAST_MAX - BLAST_MIN) * t;
    },
  };
}
