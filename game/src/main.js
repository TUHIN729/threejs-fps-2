// Boot and the one loop: a fixed 60 Hz simulation feeding a render at the display's
// rate. The player, the bots, the grenades and the match all step from here; this file
// owns the shooting ray, the tracers, the charge mesh and the screenshot modes.
// ?shot=start|play|plant|end with &seed=N sets up a deterministic frame for a capture,
// renders it twice, then freezes it and sets window.__shotReady.
import * as THREE from 'three';
import { PALETTE } from './palette.js';
import { mulberry32 } from './rng.js';
import { createWorld, MAP } from './map.js';
import { createMover } from './mover.js';
import { createInput } from './input.js';
import { createWeaponRig, WEAPONS } from './weapons.js';
import { createGrenades } from './grenades.js';
import { createBots, rayHitsBody } from './bots.js';
import { createHud } from './hud.js';
import { createMatch } from './match.js';
import { createAudio } from './audio.js';

const FIXED_STEP = 1 / 60;
const params = new URLSearchParams(window.location.search);
const shot = params.get('shot');
const seed = Number.parseInt(params.get('seed') ?? '1', 10) || 1;
const random = mulberry32(seed);

window.__errors = [];
window.addEventListener('error', (event) => {
  window.__errors.push(String(event.message || event.error || 'error'));
});

const audio = createAudio();
const silent = new Proxy({}, { get: () => () => {} });
const sfx = shot ? silent : audio;

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.getElementById('game').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(PALETTE.sky);
scene.fog = new THREE.Fog(new THREE.Color(PALETTE.sky), 24, 70);
const camera = new THREE.PerspectiveCamera(74, window.innerWidth / window.innerHeight, 0.05, 160);
scene.add(camera);

const world = createWorld(scene);
const hud = createHud();
const rig = createWeaponRig(camera);
const input = createInput(renderer.domElement, onLockChange);
const playerMover = createMover(world.colliders, MAP.spawns.player);
const player = playerMover.state;
const raycaster = new THREE.Raycaster();
raycaster.far = 120;
const direction = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _tmp2 = new THREE.Vector3();

// Bot-shot tracers: a pool of reusable lines in world space.
const botTracers = [];
for (let i = 0; i < 8; i += 1) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
  const line = new THREE.Line(geometry, new THREE.LineBasicMaterial({ color: new THREE.Color(PALETTE.cinder), transparent: true, opacity: 0 }));
  line.frustumCulled = false;
  line.visible = false;
  scene.add(line);
  botTracers.push({ line, life: 0 });
}
let botTracerIndex = 0;
function botTracer(from, to) {
  const tracer = botTracers[botTracerIndex];
  botTracerIndex = (botTracerIndex + 1) % botTracers.length;
  const positions = tracer.line.geometry.attributes.position.array;
  positions[0] = from.x;
  positions[1] = from.y;
  positions[2] = from.z;
  positions[3] = to.x;
  positions[4] = to.y;
  positions[5] = to.z;
  tracer.line.geometry.attributes.position.needsUpdate = true;
  tracer.line.visible = true;
  tracer.life = 0.09;
}

// The charge: a small box with a blinking LED, placed where the player plants it.
const charge = new THREE.Group();
const chargeBody = new THREE.Mesh(
  new THREE.BoxGeometry(0.36, 0.24, 0.22),
  new THREE.MeshStandardMaterial({ color: new THREE.Color(PALETTE.hairline), roughness: 0.6, metalness: 0.3 }),
);
const chargeLed = new THREE.Mesh(
  new THREE.SphereGeometry(0.05, 10, 8),
  new THREE.MeshBasicMaterial({ color: new THREE.Color(PALETTE.cinder) }),
);
chargeLed.position.set(0, 0.16, 0);
charge.add(chargeBody, chargeLed);
charge.visible = false;
scene.add(charge);

// Bomb-blast visual: one reusable expanding sphere and light.
const blastMesh = new THREE.Mesh(
  new THREE.SphereGeometry(1, 20, 14),
  new THREE.MeshBasicMaterial({ color: new THREE.Color(PALETTE.accent), transparent: true, opacity: 0, depthWrite: false }),
);
blastMesh.visible = false;
scene.add(blastMesh);
const blastLight = new THREE.PointLight(new THREE.Color(PALETTE.accent), 0, 30);
scene.add(blastLight);
let blastLife = 0;

let playerAlive = true;
let playerHealth = 100;
let owned = new Set(['pistol']);
const ammoStore = {};
for (const def of Object.values(WEAPONS)) ammoStore[def.id] = { mag: def.mag, reserve: def.reserve };

function equipWeapon(id) {
  const current = rig.current.id;
  ammoStore[current] = { mag: rig.state.mag, reserve: rig.state.reserve };
  rig.equip(id);
  rig.state.mag = ammoStore[id].mag;
  rig.state.reserve = ammoStore[id].reserve;
  hud.setAmmo(rig.state.mag, rig.state.reserve, rig.current.name.toUpperCase(), match.state.grenades);
}

function raycastWorld(from, dir, far) {
  raycaster.set(from, dir);
  raycaster.far = far;
  const hit = raycaster.intersectObjects(world.shootables, false)[0];
  return hit ? { distance: hit.distance, point: hit.point } : null;
}

// Actors for bot targeting: created once, fields refreshed every frame.
const playerActor = { kind: 'player', ref: null, team: 'vanguard', pos: player.position, eyeY: 1.6, alive: true, crouching: false, speed: 0 };
const botActors = [];

function damagePlayer(amount, sourceLabel, sourceName) {
  if (!playerAlive) return;
  const absorbed = Math.min(match.state.armor, amount * 0.5);
  match.state.armor -= absorbed;
  playerHealth -= (amount - absorbed);
  hud.setHealth(Math.max(0, playerHealth), match.state.armor);
  hud.damageFlash();
  sfx.hurt();
  if (playerHealth <= 0) {
    playerAlive = false;
    playerActor.alive = false;
    hud.killfeed(`${sourceName} ▸ You [${sourceLabel}]`);
    if (document.pointerLockElement) document.exitPointerLock();
    hud.showOverlay('down');
  }
}

const bots = createBots(scene, world, {
  raycastWorld,
  tracer: botTracer,
  shotSound(bot, distance) {
    if (distance < 14) sfx.shot('rifle');
    else sfx.distantShot();
  },
  damagePlayer(amount, bot, part) {
    damagePlayer(amount, 'Rifle', bot.name);
  },
  damageBot(targetBot, amount, part, attackerBot) {
    bots.damage(targetBot, amount, part, attackerBot.name, 'Rifle');
  },
  onBotKilled(bot, killerLabel, weaponName) {
    hud.killfeed(`${killerLabel} ▸ ${bot.name} [${weaponName}]`);
    if (killerLabel === 'You') {
      match.awardKill();
      sfx.kill();
    }
  },
});
for (const bot of bots.bots) {
  botActors.push({ kind: 'bot', ref: bot, team: bot.team, pos: bot.body.position, eyeY: 1.6, alive: true, crouching: false, speed: 0 });
}

const grenades = createGrenades(scene, world.colliders, (pos) => {
  sfx.explosion();
  explodeDamage(pos, grenades.blastRadius, (d) => grenades.blastDamage(d), 'Frag Grenade', 'You');
});

function explodeDamage(center, radius, damageAt, weaponName, killerLabel) {
  for (const actor of [playerActor, ...botActors]) {
    if (!actor.alive) continue;
    _tmp.set(actor.pos.x, actor.pos.y + actor.eyeY * 0.75, actor.pos.z);
    const dist = _tmp.distanceTo(center);
    if (dist > radius) continue;
    _tmp2.subVectors(_tmp, center).normalize();
    const wall = raycastWorld(center, _tmp2, dist);
    const damage = damageAt(dist) * (wall && wall.distance < dist - 0.4 ? 0.5 : 1);
    if (actor.kind === 'player') damagePlayer(damage, weaponName, killerLabel);
    else bots.damage(actor.ref, damage, 'torso', killerLabel, weaponName);
  }
}

function bombBlastVisual(pos) {
  blastMesh.position.copy(pos);
  blastMesh.visible = true;
  blastLife = 0.6;
  blastLight.position.copy(pos);
}

const match = createMatch(hud, {
  roundStarted(round, planSite) {
    playerAlive = true;
    playerHealth = 100;
    playerActor.alive = true;
    playerMover.reset(MAP.spawns.player, 0);
    bots.reset(round, planSite, random);
    charge.visible = false;
    equipWeapon(match.state.weapon);
    ammoStore[match.state.weapon].mag = WEAPONS[match.state.weapon].mag;
    rig.state.mag = WEAPONS[match.state.weapon].mag;
    hud.setHealth(playerHealth, match.state.armor);
    hud.setAmmo(rig.state.mag, rig.state.reserve, rig.current.name.toUpperCase(), match.state.grenades);
    hud.setAlive(3, 4);
    hud.refreshBuy(match.state.money, match.state.weapon, match.state.armor > 0, match.state.grenades);
    hud.showBuy(true);
    hud.showBanner(`ROUND ${round}`, `Plant the charge at site ${planSite} — ${MAP.sites[planSite].name}`);
    syncCamera();
  },
  liveStarted() {
    hud.showBanner('PLANT THE CHARGE', `Site ${match.state.planSite} — ${MAP.sites[match.state.planSite].name}`);
  },
  roundEnded(winner, reason) {
    const won = winner === 'vanguard';
    hud.showBanner(won ? 'ROUND WON' : 'ROUND LOST', reason, 4200);
    if (won) sfx.roundWin();
    else sfx.roundLose();
    hud.showBuy(false);
  },
  matchEnded(winner) {
    if (document.pointerLockElement) document.exitPointerLock();
    hud.showOverlay(winner === 'vanguard' ? 'matchWin' : 'matchLose', `Final score ${match.state.scoreVanguard} – ${match.state.scoreCinder}.`);
  },
  bombPlanted(site) {
    const center = MAP.sites[site].center;
    charge.position.set(center.x, 0.16, center.z);
    charge.visible = true;
    hud.killfeed(`You planted the charge at ${site}`);
    sfx.beep(true);
  },
  bombTick(fuseLeft) {
    const bucket = Math.ceil(fuseLeft / (fuseLeft <= 10 ? 0.5 : 1));
    if (bucket !== match._lastBeepBucket) {
      match._lastBeepBucket = bucket;
      sfx.beep(fuseLeft <= 10);
    }
  },
  bombDefused() {
    charge.visible = false;
    hud.killfeed('The charge was defused');
  },
  bombExploded(pos) {
    charge.visible = false;
    bombBlastVisual(pos);
    sfx.explosion();
    explodeDamage(pos, 10, (d) => 40 + 180 * Math.max(0, 1 - d / 10), 'Charge', 'Charge');
  },
  bought(id) {
    sfx.buy();
    if (WEAPONS[id]) {
      owned.add(id);
      equipWeapon(id);
    }
    hud.refreshBuy(match.state.money, match.state.weapon, match.state.armor > 0, match.state.grenades);
    hud.setAmmo(rig.state.mag, rig.state.reserve, rig.current.name.toUpperCase(), match.state.grenades);
    hud.setHealth(playerHealth, match.state.armor);
  },
});

hud.onPlay(() => {
  if (match.state.phase === 'matchOver') {
    match.startMatch();
    hud.hideOverlay();
    return;
  }
  if (!playerAlive) {
    // Spectating after being downed: hide the panel, camera stays put.
    hud.hideOverlay();
    return;
  }
  if (shot) return;
  sfx.unlock();
  input.requestLock();
});

hud.onBuy((id) => {
  const result = match.buy(id);
  if (!result.ok) {
    sfx.denied();
    hud.killfeed(result.reason);
  }
});

function onLockChange(locked) {
  if (shot) return;
  if (locked) {
    hud.hideOverlay();
  } else if (playerAlive && match.state.phase !== 'matchOver') {
    hud.showOverlay('paused');
  }
}

function syncCamera() {
  camera.position.set(player.position.x, player.position.y + player.eye, player.position.z);
  camera.rotation.set(player.pitch, player.yaw, 0, 'YXZ');
}

function aimAt(point) {
  const dx = point.x - player.position.x;
  const dy = point.y - (player.position.y + player.eye);
  const dz = point.z - player.position.z;
  const length = Math.hypot(dx, dy, dz) || 1;
  player.yaw = Math.atan2(-dx, -dz);
  player.pitch = Math.asin(Math.max(-1, Math.min(1, dy / length)));
  syncCamera();
}

function shoot(spread) {
  if (!rig.takeRound()) {
    sfx.dryClick();
    return false;
  }
  camera.getWorldDirection(direction);
  direction.x += (random() * 2 - 1) * spread;
  direction.y += (random() * 2 - 1) * spread;
  direction.z += (random() * 2 - 1) * spread;
  direction.normalize();
  scene.updateMatrixWorld(true);
  raycaster.set(camera.position, direction);
  raycaster.far = 120;
  const targets = world.shootables.concat(bots.hitMeshes);
  const hit = raycaster.intersectObjects(targets, false)[0];
  const end = hit ? hit.point : camera.position.clone().addScaledVector(direction, 90);
  rig.fireTracer(end);
  if (hit && hit.object.userData.bot) {
    const bot = hit.object.userData.bot;
    if (bot.alive) {
      const def = rig.current;
      const damage = def.damage * (hit.object.userData.part === 'head' ? def.headMult : 1);
      const killed = bots.damage(bot, damage, hit.object.userData.part, 'You', def.name);
      hud.hitMarker(killed, shot ? 4000 : 90);
      if (!killed) sfx.hit();
    }
  } else if (hit) {
    // A wall: a short spark of dust is the tracer's end; nothing more to do.
  }
  rig.pullTrigger();
  player.pitch = Math.min(1.45, player.pitch + rig.current.kick * (0.9 + random() * 0.2));
  player.yaw += (random() * 2 - 1) * rig.current.kick * 0.35;
  hud.setAmmo(rig.state.mag, rig.state.reserve, rig.current.name.toUpperCase(), match.state.grenades);
  sfx.shot(rig.current.kind);
  bots.alert(player.position);
  return true;
}

let elapsed = 0;
let frozen = false;
let started = false;
let botsPaused = false;
let accumulator = 0;
let lastTime = performance.now();

function defuserNearBomb() {
  const bomb = match.state.bomb;
  if (!bomb.planted || !bomb.pos) return null;
  for (const bot of bots.bots) {
    if (bot.team !== 'cinder' || !bot.alive) continue;
    if (Math.hypot(bot.body.position.x - bomb.pos.x, bot.body.position.z - bomb.pos.z) < 2.4) return bot;
  }
  return null;
}

function step(dt) {
  elapsed += dt;
  const keys = input.state.keys;
  const phase = match.state.phase;

  if (playerAlive && phase !== 'matchOver') {
    playerMover.look(input.takeLook().x, input.takeLook().y);
    const move = {
      forward: (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0),
      strafe: (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0),
      crouch: keys.has('ControlLeft') || keys.has('ControlRight') || keys.has('KeyC'),
      jump: keys.has('Space'),
      speed: undefined,
    };
    if (phase === 'buy') {
      move.forward *= 0.5;
      move.strafe *= 0.5;
    }
    playerMover.step(dt, move);
    if (phase === 'live' && input.state.firing && rig.ready()) {
      shoot(rig.spread(playerMover.groundSpeed()) * (player.crouching ? 0.6 : 1));
    }
    if (keys.has('KeyR')) {
      if (rig.reload()) sfx.reload();
    }
    if (keys.has('KeyB') && phase === 'buy') {
      hud.showBuy(!hud.buyOpen());
      keys.delete('KeyB');
    }
    if (phase === 'buy') {
      const buyKeys = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6'];
      const buyIds = ['smg', 'rifle', 'dmr', 'armor', 'grenade'];
      for (let i = 0; i < buyKeys.length; i += 1) {
        if (keys.has(buyKeys[i]) && buyIds[i]) {
          const result = match.buy(buyIds[i]);
          if (!result.ok) sfx.denied();
          keys.delete(buyKeys[i]);
        }
      }
    }
    if (phase === 'live') {
      for (const [index, id] of ['pistol', 'smg', 'rifle', 'dmr'].entries()) {
        if (keys.has(`Digit${index + 1}`) && owned.has(id) && rig.current.id !== id) equipWeapon(id);
      }
      if ((keys.has('KeyG')) && match.state.grenades > 0 && grenades.count() < 4) {
        camera.getWorldDirection(direction);
        _tmp.copy(camera.position).addScaledVector(direction, 0.4);
        grenades.throw(_tmp, direction, 13);
        match.state.grenades -= 1;
        hud.setAmmo(rig.state.mag, rig.state.reserve, rig.current.name.toUpperCase(), match.state.grenades);
        keys.delete('KeyG');
      }
    }
  } else {
    input.takeLook();
  }

  rig.step(dt);
  grenades.step(dt, sfx);

  // Charge LED blinks faster as the fuse runs down.
  if (charge.visible) {
    const fuse = match.state.bomb.fuseLeft;
    const rate = fuse <= 10 ? 10 : 3;
    chargeLed.material.color.setHex(Math.sin(elapsed * rate) > 0 ? 0xd05a3c : 0x331111);
  }
  if (blastLife > 0) {
    blastLife -= dt;
    const t = Math.max(0, blastLife / 0.6);
    blastMesh.scale.setScalar(1 + (1 - t) * 10);
    blastMesh.material.opacity = t * 0.5;
    blastLight.intensity = t * 80;
    if (blastLife <= 0) {
      blastMesh.visible = false;
      blastLight.intensity = 0;
    }
  }
  for (const tracer of botTracers) {
    if (tracer.life <= 0) continue;
    tracer.life -= dt;
    tracer.line.material.opacity = Math.max(0, tracer.life / 0.09) * 0.8;
    if (tracer.life <= 0) tracer.line.visible = false;
  }

  // Refresh the shared actor records for the bots.
  playerActor.eyeY = player.eye;
  playerActor.alive = playerAlive;
  playerActor.crouching = player.crouching;
  playerActor.speed = playerMover.groundSpeed();
  for (const actor of botActors) {
    actor.eyeY = actor.ref.body.eye;
    actor.alive = actor.ref.alive;
    actor.speed = actor.ref.mover.groundSpeed();
  }

  const bomb = match.state.bomb;
  const site = bomb.carried ? match.siteAt(player.position) : null;
  const sitePos = site ? MAP.sites[site].center : null;
  match.step(dt, {
    playerAlive,
    planting: keys.has('KeyE'),
    site,
    sitePos,
    carrying: bomb.carried,
    cinderAlive: bots.aliveCount('cinder'),
    vanguardAlive: (playerAlive ? 1 : 0) + bots.aliveCount('vanguard'),
    defuser: defuserNearBomb(),
  });

  if (phase === 'live' || phase === 'buy' || phase === 'roundOver') {
    if (!botsPaused) {
      bots.step(dt, {
        actors: [playerActor, ...botActors],
        random,
        bombPlanted: bomb.planted,
        bombPos: bomb.pos,
      });
    }
  }

  hud.setAlive((playerAlive ? 1 : 0) + bots.aliveCount('vanguard'), bots.aliveCount('cinder'));
  hud.setCrosshairGap(5 + rig.spread(playerMover.groundSpeed()) * 2600 + playerMover.groundSpeed() * 1.2);
  hud.setHealth(Math.max(0, playerHealth), match.state.armor);
}

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min((now - lastTime) / 1000, 0.1);
  lastTime = now;
  if (!frozen) {
    accumulator += dt;
    let steps = 0;
    while (accumulator >= FIXED_STEP && steps < 5) {
      step(FIXED_STEP);
      accumulator -= FIXED_STEP;
      steps += 1;
    }
    if (accumulator > FIXED_STEP * 5) accumulator = 0;
    syncCamera();
  }
  renderer.render(scene, camera);
  if (shot) writeDiag();
}

function writeDiag() {
  const diag = document.getElementById('diag');
  diag.textContent = JSON.stringify({
    phase: match.state.phase,
    round: match.state.round,
    score: [match.state.scoreVanguard, match.state.scoreCinder],
    money: match.state.money,
    playerHp: Math.round(playerHealth),
    playerAlive,
    weapon: rig.current.id,
    ammo: [rig.state.mag, rig.state.reserve],
    grenades: match.state.grenades,
    aliveV: (playerAlive ? 1 : 0) + bots.aliveCount('vanguard'),
    aliveC: bots.aliveCount('cinder'),
    bomb: match.state.bomb.planted ? `planted@${match.state.bomb.site}` : match.state.bomb.carried ? 'carried' : 'none',
    plantProgress: Number(match.state.bomb.plantProgress.toFixed(2)),
    errors: window.__errors,
  });
}

function settle(steps) {
  for (let index = 0; index < steps; index += 1) step(FIXED_STEP);
}

function paintTwiceThenReady() {
  let painted = 0;
  function paint() {
    requestAnimationFrame(paint);
    syncCamera();
    renderer.render(scene, camera);
    painted += 1;
    if (painted === 2) {
      writeDiag();
      window.__shotReady = true;
      frozen = true;
    }
  }
  requestAnimationFrame(paint);
}

function placeBot(bot, x, z, yaw, hold = true) {
  bot.body.position.set(x, 0, z);
  bot.body.yaw = yaw;
  bot.group.position.set(x, 0, z);
  bot.group.rotation.y = yaw;
  bot.path = [];
  bot.pathIndex = 0;
  if (hold) {
    bot.state = 'hold';
    bot.holdUntil = 1e9;
  }
}

function killBot(bot) {
  bot.alive = false;
  bot.health = 0;
  bot.fall = 1;
  bot.group.rotation.x = -1.45;
  bot.group.position.y = -0.08;
}

function runShot(name) {
  hud.hideOverlay();
  hud.hideBanner();
  botsPaused = true;
  const enemies = bots.bots.filter((b) => b.team === 'cinder');
  const friends = bots.bots.filter((b) => b.team === 'vanguard');
  if (name === 'start') {
    player.position.set(0, 0, 14);
    player.yaw = 0;
    player.pitch = 0.02;
    placeBot(enemies[0], -4, 0, Math.PI);
    placeBot(enemies[1], 5, -5, Math.PI);
    placeBot(friends[0], -2.5, 15.5, 0);
    placeBot(friends[1], 2.5, 15.5, 0);
    settle(30);
    hud.showBuy(true);
  } else if (name === 'play') {
    match.state.phase = 'live';
    match.state.roundTime = 95;
    hud.showBuy(false);
    equipWeapon('rifle');
    owned.add('rifle');
    match.state.weapon = 'rifle';
    player.position.set(0, 0, 4);
    placeBot(enemies[0], 2, 0, 2.68);
    placeBot(enemies[1], 4, -2, 2.5);
    placeBot(enemies[2], -6, 2, -0.9);
    placeBot(friends[0], -2, 6, 0);
    placeBot(friends[1], 3, 7, 0);
    settle(10);
    const target = _tmp.set(2, 1.0, 0);
    aimAt(target);
    for (let i = 0; i < 3; i += 1) {
      shoot(0);
      if (i < 2) settle(8);
    }
    if (!enemies[0].alive) {
      enemies[0].fall = 1;
      enemies[0].group.rotation.x = -1.45;
      enemies[0].group.position.y = -0.08;
    }
    settle(12);
    aimAt(_tmp2.set(4, 1.0, -2));
    shoot(0);
    settle(4);
  } else if (name === 'plant') {
    match.state.phase = 'live';
    match.state.roundTime = 80;
    match.state.planSite = 'A';
    hud.showBuy(false);
    player.position.set(-14.5, 0, -7);
    player.yaw = Math.atan2(-(-16 + 14.5), -(-9 + 7));
    player.pitch = -0.05;
    match.state.bomb.plantProgress = 0.65;
    hud.setPlant(0.65, 'PLANTING AT A…');
    placeBot(enemies[0], -15.5, -11, -2.68);
    placeBot(enemies[1], -17.5, -10, -2.45);
    placeBot(friends[0], -16, -12, 0);
    settle(20);
  } else {
    // end: round won, one Cinder bot down in mid, score 1-0.
    match.state.phase = 'roundOver';
    match.state.scoreVanguard = 1;
    match.state.roundOverTime = 60;
    hud.setScore(1, 0, 1);
    hud.setTimer('0:00', false);
    hud.showBuy(false);
    player.position.set(0, 0, 8);
    player.yaw = 0;
    player.pitch = 0;
    killBot(enemies[0]);
    enemies[0].body.position.set(0, 0, 2);
    enemies[0].group.position.set(0, -0.08, 2);
    placeBot(enemies[1], 8, -1, Math.PI);
    placeBot(friends[0], -2, 12, 0);
    settle(20);
    hud.showBanner('ROUND WON', 'Vanguard takes round 1 — Cinder squad wiped', 60000);
  }
  syncCamera();
  paintTwiceThenReady();
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// Boot: round 1 starts in buy phase; the overlay covers it until the player clicks.
match.startMatch();
hud.setHealth(100, 0);
hud.setAmmo(rig.state.mag, rig.state.reserve, 'P9 SIDEARM', 0);
if (!shot) hud.showOverlay('start');
syncCamera();
if (shot) runShot(shot);
else requestAnimationFrame(frame);
