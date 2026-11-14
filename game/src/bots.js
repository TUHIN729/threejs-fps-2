// Bots: six of them, two Vanguard friends and four Cinder defenders. Each bot is a
// mover with a body built from boxes, a state machine (advance, hold, engage, defuse),
// and a brain that thinks on a stagger: it follows the waypoint graph toward its site,
// holds and scans, engages the nearest enemy it can see, fires in bursts with an error
// that grows with distance and target speed, and hears gunfire. When the charge is
// planted, the Cinder bots converge on it to defuse.
import * as THREE from 'three';
import { PALETTE } from './palette.js';
import { createMover } from './mover.js';
import { MAP, nearestWaypoint, findPath, waypointPosition } from './map.js';
import { pick } from './rng.js';

const BOT_HEALTH = 100;
const BOT_DAMAGE = 24;
const BOT_HEAD_DAMAGE = 60;
const BOT_WALK = 4.2;
const BOT_ROAM = 3.4;
const THINK_EVERY = 0.12;
const REACTION = 0.35;
const SIGHT_RANGE = 30;

const NAMES = {
  vanguard: ['Ash', 'Briar'],
  cinder: ['Slag', 'Rust', 'Flint', 'Cinder'],
};

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();

// Closest distance between a ray (origin, dir) and a segment (a, b); reused vectors,
// no allocation in the hot path.
function raySegmentDistance(origin, dir, a, b) {
  _v1.subVectors(a, origin);
  _v2.subVectors(b, a);
  const d = _v2.lengthSq();
  const e = _v1.dot(dir);
  const f = _v2.dot(dir);
  const denom = d - f * f;
  let s = 0;
  let t = 0;
  if (denom > 1e-8) {
    s = Math.max(0, Math.min(1, (e * f - _v1.dot(_v2)) / denom));
    t = Math.max(0, e + s * f);
  } else {
    t = Math.max(0, e);
  }
  _v3.copy(origin).addScaledVector(dir, t).sub(a).addScaledVector(_v2, -s);
  return { distance: _v3.length(), along: t };
}

function raySphere(origin, dir, center, radius) {
  _v1.subVectors(center, origin);
  const t = _v1.dot(dir);
  if (t < 0) return null;
  const d2 = _v1.lengthSq() - t * t;
  if (d2 > radius * radius) return null;
  return t - Math.sqrt(radius * radius - d2);
}

// Test a shot ray against a standing body: head sphere first, then the torso capsule.
export function rayHitsBody(origin, dir, feet, eyeY, crouching) {
  const headCenter = _v1.set(feet.x, feet.y + eyeY - 0.12, feet.z);
  const headHit = raySphere(origin, dir, headCenter, 0.24);
  const top = feet.y + (crouching ? 1.0 : 1.5);
  const a = new THREE.Vector3(feet.x, feet.y + 0.25, feet.z);
  const b = new THREE.Vector3(feet.x, top, feet.z);
  const body = raySegmentDistance(origin, dir, a, b);
  if (headHit !== null && headHit < body.along + 0.5) return { part: 'head', distance: headHit };
  if (body.distance < 0.38 && body.along > 0) return { part: 'torso', distance: body.along };
  return null;
}

function buildBody(scene, team) {
  const group = new THREE.Group();
  const teamColor = team === 'vanguard' ? PALETTE.vanguard : PALETTE.cinder;
  const torsoMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(teamColor), roughness: 0.65, metalness: 0.05 });
  const darkMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(PALETTE.hairline), roughness: 0.85 });
  const skinMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(PALETTE.ink), roughness: 0.6 });

  const legL = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.7, 0.2), darkMat);
  legL.position.set(-0.13, 0.35, 0);
  const legR = legL.clone();
  legR.position.x = 0.13;
  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.78, 0.3), torsoMat);
  torso.position.y = 1.0;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.16, 14, 10), skinMat);
  head.position.y = 1.53;
  const helmet = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.1, 0.34), darkMat);
  helmet.position.y = 1.62;
  const gun = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.09, 0.55), darkMat);
  gun.position.set(0.2, 1.15, -0.25);
  group.add(legL, legR, torso, head, helmet, gun);
  group.traverse((mesh) => {
    if (mesh.isMesh) {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
    }
  });
  scene.add(group);
  return { group, torso, head, legL, legR, gun };
}

export function createBots(scene, world, hooks) {
  const bots = [];
  const hitMeshes = [];
  let time = 0;
  let alertPos = null;
  let alertTime = -100;

  function makeBot(team, index, spawn) {
    const mover = createMover(world.colliders, spawn);
    const body = buildBody(scene, team);
    const bot = {
      name: NAMES[team][index],
      team,
      mover,
      body: mover.state,
      group: body.group,
      torso: body.torso,
      head: body.head,
      legL: body.legL,
      legR: body.legR,
      gun: body.gun,
      health: BOT_HEALTH,
      alive: true,
      state: 'advance',
      path: [],
      pathIndex: 0,
      targetNode: 0,
      holdNode: 0,
      holdUntil: 0,
      lastSeen: new THREE.Vector3(),
      lastSeenTime: -100,
      firstSeenTime: -100,
      thinkTimer: index * 0.03,
      burstLeft: 0,
      burstTimer: 0,
      pauseTimer: 0,
      strafeDir: 1,
      strafeTimer: 0,
      walkPhase: 0,
      fall: 0,
      defuseSite: null,
      planSite: 'A',
    };
    body.torso.userData.bot = bot;
    body.torso.userData.part = 'torso';
    body.head.userData.bot = bot;
    body.head.userData.part = 'head';
    hitMeshes.push(body.torso, body.head);
    return bot;
  }

  for (let i = 0; i < 2; i += 1) bots.push(makeBot('vanguard', i, MAP.spawns.friends[i]));
  for (let i = 0; i < 4; i += 1) bots.push(makeBot('cinder', i, MAP.spawns.enemies[i]));

  function setPath(bot, targetNode) {
    const from = nearestWaypoint(bot.body.position.x, bot.body.position.z);
    bot.path = findPath(from, targetNode);
    bot.pathIndex = 0;
    bot.targetNode = targetNode;
  }

  function visibleEnemy(bot, actors) {
    const eye = _v1.set(bot.body.position.x, bot.body.position.y + bot.body.eye, bot.body.position.z);
    let best = null;
    let bestDist = Infinity;
    for (const actor of actors) {
      if (!actor.alive || actor.team === bot.team) continue;
      const dx = actor.pos.x - eye.x;
      const dy = actor.pos.y + actor.eyeY * 0.75 - eye.y;
      const dz = actor.pos.z - eye.z;
      const dist = Math.hypot(dx, dy, dz);
      if (dist > SIGHT_RANGE || dist >= bestDist) continue;
      _v2.set(dx / dist, dy / dist, dz / dist);
      const wall = hooks.raycastWorld(eye, _v2, dist);
      if (wall && wall.distance < dist - 0.6) continue;
      best = actor;
      bestDist = dist;
    }
    return best ? { actor: best, distance: bestDist } : null;
  }

  function think(bot, ctx) {
    bot.thinkTimer -= THINK_EVERY;
    if (bot.thinkTimer > 0) return;
    bot.thinkTimer = THINK_EVERY;

    // Seeing an enemy always wins: a bot fights back even while converging on the charge.
    const seen = visibleEnemy(bot, ctx.actors);
    if (seen) {
      // firstSeenTime marks the first sighting, so the reaction delay is measured from
      // when the bot first saw the enemy — lastSeenTime refreshes every think tick
      // while the enemy stays visible, so it can never serve as the reaction clock.
      if (bot.state !== 'engage') bot.firstSeenTime = time;
      bot.state = 'engage';
      bot.lastSeen.copy(seen.actor.pos);
      bot.lastSeenTime = time;
      return;
    }
    if (bot.state === 'engage' && time - bot.lastSeenTime < 2.5) {
      // Lost sight: push to the last seen position.
      if (bot.targetNode !== nearestWaypoint(bot.lastSeen.x, bot.lastSeen.z)) {
        setPath(bot, nearestWaypoint(bot.lastSeen.x, bot.lastSeen.z));
      }
      bot.state = 'advance';
      return;
    }
    if (bot.state === 'engage') bot.state = 'advance';

    if (ctx.bombPlanted && bot.team === 'cinder') {
      const siteNode = nearestWaypoint(ctx.bombPos.x, ctx.bombPos.z);
      const distToBomb = Math.hypot(bot.body.position.x - ctx.bombPos.x, bot.body.position.z - ctx.bombPos.z);
      if (distToBomb < 2.4) {
        bot.state = 'defuse';
      } else if (bot.state !== 'defuse' || bot.targetNode !== siteNode) {
        bot.state = 'advance';
        setPath(bot, siteNode);
      }
      return;
    }

    if (bot.team === 'vanguard') {
      const site = bot.planSite === 'A' ? MAP.sites.A : MAP.sites.B;
      const siteNode = nearestWaypoint(site.center.x, site.center.z);
      if (bot.targetNode !== siteNode && bot.pathIndex >= bot.path.length) {
        setPath(bot, siteNode);
      }
      return;
    }

    // Cinder defenders: hold near their site, drifting between nearby nodes. The pairs
    // are adjacent on the waypoint graph, so the drift never crosses a blocked edge.
    if (time >= bot.holdUntil && bot.pathIndex >= bot.path.length) {
      const options = [bot.holdNode];
      for (const [a, b] of [[10, 7], [11, 8], [6, 15], [6, 16], [9, 15], [9, 16], [9, 12], [9, 13]]) {
        if (a === bot.holdNode) options.push(b);
        if (b === bot.holdNode) options.push(a);
      }
      const next = pick(ctx.random, options);
      bot.holdUntil = time + 6 + ctx.random() * 5;
      if (next !== bot.holdNode) {
        bot.holdNode = next;
        setPath(bot, next);
      }
    }
  }

  function faceToward(bot, x, z, dt, rate = 6) {
    const target = Math.atan2(-(x - bot.body.position.x), -(z - bot.body.position.z));
    let diff = target - bot.body.yaw;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    bot.body.yaw += diff * Math.min(1, dt * rate);
  }

  function fireAt(bot, actor, distance) {
    // Fresh vectors here: rayHitsBody reuses the module scratch vectors, so the eye
    // and direction must not alias them.
    const eye = new THREE.Vector3(bot.body.position.x, bot.body.position.y + bot.body.eye, bot.body.position.z);
    const target = new THREE.Vector3(actor.pos.x, actor.pos.y + actor.eyeY * 0.75, actor.pos.z);
    const error = 0.028 + distance * 0.0009 + actor.speed * 0.003 + bot.mover.groundSpeed() * 0.002 - (actor.crouching ? 0.008 : 0);
    const dir = new THREE.Vector3().subVectors(target, eye).normalize();
    // Perpendicular error so the miss lands somewhere plausible.
    const right = new THREE.Vector3(1, 0, 0).cross(dir).normalize();
    const up = new THREE.Vector3().crossVectors(dir, right).normalize();
    const ex = (Math.random() * 2 - 1) * error;
    const ey = (Math.random() * 2 - 1) * error * 0.7;
    dir.addScaledVector(right, ex).addScaledVector(up, ey).normalize();
    const wall = hooks.raycastWorld(eye, dir, 80);
    const muzzle = new THREE.Vector3(bot.body.position.x, bot.body.position.y + 1.15, bot.body.position.z);
    muzzle.addScaledVector(dir, 0.5);
    const hit = rayHitsBody(eye, dir, actor.pos, actor.eyeY, actor.crouching);
    const wallDist = wall ? wall.distance : Infinity;
    if (hit && hit.distance < wallDist) {
      const end = eye.clone().addScaledVector(dir, hit.distance);
      hooks.tracer(muzzle, end);
      const damage = hit.part === 'head' ? BOT_HEAD_DAMAGE : BOT_DAMAGE;
      if (actor.kind === 'player') hooks.damagePlayer(damage, bot, hit.part);
      else hooks.damageBot(actor.ref, damage, hit.part, bot);
    } else {
      const end = eye.clone().addScaledVector(dir, Math.min(wallDist, 80));
      hooks.tracer(muzzle, end);
    }
    hooks.shotSound(bot, distance);
  }

  function stepBot(bot, dt, ctx) {
    if (!bot.alive) {
      if (bot.fall < 1) {
        bot.fall = Math.min(1, bot.fall + dt / 0.4);
        bot.group.rotation.x = -bot.fall * 1.45;
        bot.group.position.y = -bot.fall * 0.08;
      }
      return;
    }

    think(bot, ctx);

    const move = { forward: 0, strafe: 0, crouch: false, jump: false, speed: BOT_WALK };
    let target = null;

    if (bot.state === 'engage') {
      target = ctx.actors.find((a) => a.alive && a.team !== bot.team && a.pos.distanceToSquared(bot.lastSeen) < 4)
        ?? ctx.actors.find((a) => a.alive && a.team !== bot.team);
      if (target) faceToward(bot, target.pos.x, target.pos.z, dt, 8);
      bot.strafeTimer -= dt;
      if (bot.strafeTimer <= 0) {
        bot.strafeDir *= -1;
        bot.strafeTimer = 0.7 + Math.random() * 0.6;
      }
      // Far off, close the distance instead of strafing in place: a bot that can see
      // an enemy across the map must push, or the round never moves.
      const targetDist = target ? Math.hypot(target.pos.x - bot.body.position.x, target.pos.z - bot.body.position.z) : 0;
      if (targetDist > 16) {
        move.forward = 1;
        move.speed = BOT_WALK;
      } else {
        move.strafe = bot.strafeDir * 0.6;
        move.speed = 2.2;
      }
      // Fire in bursts once the reaction delay has passed since first sighting.
      if (target && time - bot.firstSeenTime > REACTION) {
        bot.pauseTimer -= dt;
        if (bot.burstLeft > 0) {
          bot.burstTimer -= dt;
          if (bot.burstTimer <= 0) {
            bot.burstTimer = 0.13;
            bot.burstLeft -= 1;
            const dist = Math.hypot(target.pos.x - bot.body.position.x, target.pos.z - bot.body.position.z);
            fireAt(bot, target, dist);
          }
        } else if (bot.pauseTimer <= 0) {
          bot.burstLeft = 3 + Math.floor(Math.random() * 3);
          bot.pauseTimer = 0.8 + Math.random() * 0.7;
        }
      }
    } else if (bot.state === 'defuse') {
      faceToward(bot, ctx.bombPos.x, ctx.bombPos.z, dt, 8);
    } else if (bot.path.length > 0 && bot.pathIndex < bot.path.length) {
      const node = bot.path[bot.pathIndex];
      const wp = waypointPosition(node, _v1);
      const dx = wp.x - bot.body.position.x;
      const dz = wp.z - bot.body.position.z;
      if (Math.hypot(dx, dz) < 0.9) {
        bot.pathIndex += 1;
      } else {
        faceToward(bot, wp.x, wp.z, dt, 6);
        move.forward = 1;
        move.speed = bot.team === 'vanguard' ? BOT_WALK : BOT_ROAM;
      }
    } else {
      // Holding: slow scan across the lane.
      bot.body.yaw += Math.sin(time * 0.5 + bot.holdNode) * dt * 0.4;
    }

    bot.mover.step(dt, move);

    // Keep yaw in [-PI, PI]: faceToward can walk it past the boundary when the target
    // angle flips, and an unbounded yaw loses precision in the movement maths.
    bot.body.yaw = Math.atan2(Math.sin(bot.body.yaw), Math.cos(bot.body.yaw));

    // Walk cycle and group sync.
    bot.walkPhase += dt * (bot.mover.groundSpeed() * 2.2);
    const swing = Math.sin(bot.walkPhase) * 0.35 * Math.min(1, bot.mover.groundSpeed() / BOT_WALK);
    bot.legL.rotation.x = swing;
    bot.legR.rotation.x = -swing;
    bot.group.position.copy(bot.body.position);
    bot.group.rotation.y = bot.body.yaw;

    // Hearing: a recent gunshot pulls the bot toward it.
    if (alertPos && time - alertTime < 4 && bot.state !== 'engage' && bot.state !== 'defuse') {
      const dist = Math.hypot(alertPos.x - bot.body.position.x, alertPos.z - bot.body.position.z);
      if (dist < 26 && (bot.pathIndex >= bot.path.length || bot.team === 'cinder')) {
        const node = nearestWaypoint(alertPos.x, alertPos.z);
        if (bot.targetNode !== node) setPath(bot, node);
      }
    }
  }

  return {
    bots,
    hitMeshes,
    alert(position) {
      alertPos = position.clone();
      alertTime = time;
    },
    damage(bot, amount, part, killerLabel, weaponName) {
      if (!bot.alive) return false;
      bot.health -= amount;
      if (bot.health > 0) return false;
      bot.alive = false;
      bot.fall = 0;
      bot.state = 'dead';
      hooks.onBotKilled(bot, killerLabel, weaponName);
      return true;
    },
    aliveCount(team) {
      return bots.filter((b) => b.team === team && b.alive).length;
    },
    step(dt, ctx) {
      time += dt;
      for (const bot of bots) stepBot(bot, dt, ctx);
    },
    reset(round, planSite, random) {
      time = 0;
      alertPos = null;
      alertTime = -100;
      const holdNodes = [10, 11, 6, 9];
      const shuffled = holdNodes.slice();
      for (let i = shuffled.length - 1; i > 0; i -= 1) {
        const j = Math.floor(random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      bots.forEach((bot, index) => {
        const spawn = bot.team === 'vanguard' ? MAP.spawns.friends[index] : MAP.spawns.enemies[index - 2];
        const yaw = bot.team === 'vanguard' ? Math.PI : 0;
        bot.mover.reset(spawn, yaw);
        bot.health = BOT_HEALTH;
        bot.alive = true;
        bot.state = bot.team === 'vanguard' ? 'advance' : 'hold';
        bot.fall = 0;
        bot.group.rotation.set(0, yaw, 0);
        bot.group.position.copy(spawn);
        bot.lastSeenTime = -100;
        bot.burstLeft = 0;
        bot.pauseTimer = 0;
        bot.thinkTimer = index * 0.03;
        bot.planSite = planSite;
        if (bot.team === 'vanguard') {
          const site = index === 0 ? planSite : planSite === 'A' ? 'B' : 'A';
          const center = site === 'A' ? MAP.sites.A.center : MAP.sites.B.center;
          setPath(bot, nearestWaypoint(center.x, center.z));
        } else {
          bot.holdNode = shuffled[index - 2];
          bot.holdUntil = 0;
          setPath(bot, bot.holdNode);
        }
      });
    },
  };
}
