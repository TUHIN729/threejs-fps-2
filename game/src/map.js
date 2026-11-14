// Cinder Yard: an original derelict freight depot, built from boxes. Two bomb sites
// (A "Crane Dock" west, B "Tank Farm" east), three lanes between the south spawn and the
// north yard, containers and crates for cover, and a low gantry platform. Every box is a
// collider for the movers and a surface a bullet stops on. The waypoint graph is what the
// bots walk: nodes are open ground, edges are clear paths between them.
import * as THREE from 'three';
import { PALETTE } from './palette.js';

export const MAP = {
  bounds: { minX: -22, minZ: -18, maxX: 22, maxZ: 18 },
  sites: {
    A: { name: 'Crane Dock', center: new THREE.Vector3(-16, 0, -9), half: 4 },
    B: { name: 'Tank Farm', center: new THREE.Vector3(16, 0, -9), half: 4 },
  },
  spawns: {
    player: new THREE.Vector3(0, 0, 15),
    friends: [new THREE.Vector3(-2.5, 0, 15.5), new THREE.Vector3(2.5, 0, 15.5)],
    enemies: [
      new THREE.Vector3(-3, 0, -15),
      new THREE.Vector3(3, 0, -15),
      new THREE.Vector3(-8, 0, -14),
      new THREE.Vector3(8, 0, -14),
    ],
  },
};

// Waypoint graph: [x, z] nodes and their neighbours, for bot pathfinding. Every edge
// was walked on the map: it stays clear of the containers, the lane walls, the tank
// and the gantry platform, so a bot following it never stalls against a box.
const WAYPOINTS = [
  [0, 15], [-18, 12], [18, 12], [0, 8], [-10, 6], [10, 6], [0, 0],
  [-18, 0], [18, 0], [0, -7], [-16, -9], [16, -9], [-10, -14], [10, -14],
  [0, -15], [-6, -4], [6, -4], [-11, -14], [11, -14],
];
const EDGES = [
  [0, 1], [0, 2], [0, 3], [1, 7], [2, 8], [3, 4], [3, 5], [3, 6],
  [4, 1], [5, 2], [4, 15], [5, 16], [6, 15], [6, 16], [7, 10],
  [8, 11], [9, 15], [9, 16], [9, 12], [9, 13], [12, 14], [13, 14],
  [12, 17], [13, 18], [17, 14], [18, 14], [15, 7], [16, 8], [4, 6],
  [5, 6], [1, 4], [2, 5],
];

export function nearestWaypoint(x, z) {
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < WAYPOINTS.length; i += 1) {
    const dx = WAYPOINTS[i][0] - x;
    const dz = WAYPOINTS[i][1] - z;
    const d = dx * dx + dz * dz;
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}

// Breadth-first path over the waypoint graph, as a list of node indices.
export function findPath(from, to) {
  if (from === to) return [to];
  const prev = new Array(WAYPOINTS.length).fill(-1);
  const queue = [from];
  prev[from] = from;
  while (queue.length > 0) {
    const node = queue.shift();
    for (const [a, b] of EDGES) {
      const next = a === node ? b : b === node ? a : -1;
      if (next === -1 || prev[next] !== -1) continue;
      prev[next] = node;
      if (next === to) {
        const path = [to];
        let at = to;
        while (at !== from) {
          at = prev[at];
          path.unshift(at);
        }
        return path;
      }
      queue.push(next);
    }
  }
  return [to];
}

export function waypointPosition(index, out) {
  out.set(WAYPOINTS[index][0], 0, WAYPOINTS[index][1]);
  return out;
}

export function createWorld(scene) {
  const group = new THREE.Group();
  scene.add(group);

  const materials = {};
  for (const name of Object.keys(PALETTE)) {
    materials[name] = new THREE.MeshStandardMaterial({
      color: new THREE.Color(PALETTE[name]),
      roughness: name === 'accent' || name === 'ink' ? 0.55 : 0.92,
      metalness: name === 'rust' || name === 'rustDark' ? 0.25 : 0.03,
    });
  }

  const colliders = [];
  const shootables = [];

  function box(width, height, depth, x, y, z, material) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), materials[material]);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    colliders.push(new THREE.Box3().setFromObject(mesh));
    shootables.push(mesh);
    return mesh;
  }

  // Ground and the yard's outer walls (5 m, open to the dusk sky).
  box(45, 0.4, 37, 0, -0.2, 0, 'concreteDark');
  box(0.5, 5, 37, -22.25, 2.5, 0, 'concrete');
  box(0.5, 5, 37, 22.25, 2.5, 0, 'concrete');
  box(45, 5, 0.5, 0, 2.5, -18.25, 'concrete');
  box(45, 5, 0.5, 0, 2.5, 18.25, 'concrete');

  // Site pads: a slightly raised plate with hazard edging, so a site reads at a glance.
  for (const site of Object.values(MAP.sites)) {
    const pad = new THREE.Mesh(new THREE.BoxGeometry(8, 0.08, 8), materials.hazard);
    pad.position.set(site.center.x, 0.04, site.center.z);
    pad.receiveShadow = true;
    group.add(pad);
    const inner = new THREE.Mesh(new THREE.BoxGeometry(7.4, 0.1, 7.4), materials.concreteDark);
    inner.position.set(site.center.x, 0.05, site.center.z);
    inner.receiveShadow = true;
    group.add(inner);
  }

  // Mid freight containers: the long sightline blockers on the middle lane.
  box(6, 2.6, 2.4, 0, 1.3, -2, 'rust');
  box(2.4, 2.6, 6, -8, 1.3, -6, 'rustDark');
  box(2.4, 2.6, 6, 8, 1.3, -6, 'rustDark');
  box(6, 2.6, 2.4, -14, 1.3, 3, 'rust');
  box(6, 2.6, 2.4, 14, 1.3, 3, 'rust');

  // Lane walls with a gap in the middle: the fight is about the gaps.
  box(8, 2.2, 0.5, -10, 1.1, 2, 'concrete');
  box(8, 2.2, 0.5, 10, 1.1, 2, 'concrete');
  box(7, 2.2, 0.5, -14.5, 1.1, -12, 'concrete');
  box(7, 2.2, 0.5, 14.5, 1.1, -12, 'concrete');

  // Pillars and the gantry crane legs.
  box(1.2, 4, 1.2, -12, 2, 2, 'hairline');
  box(1.2, 4, 1.2, 12, 2, 2, 'hairline');
  box(1.2, 4.4, 1.2, 0, 2.2, -12, 'hairline');
  box(1.4, 5.4, 1.4, -19, 2.7, -15, 'rustDark');
  box(1.4, 5.4, 1.4, -13, 2.7, -15, 'rustDark');
  box(7.4, 0.8, 1.2, -16, 5.6, -15, 'rust');

  // Crates: low cover to crouch behind, stacked near the sites.
  const crates = [
    [1.2, 1.2, 1.2, -5, 0.6, 8, 'surface'],
    [1.2, 1.2, 1.2, -3.7, 0.6, 8, 'surface'],
    [1.2, 1.2, 1.2, -4.3, 1.8, 8, 'hairline'],
    [1.2, 1.2, 1.2, 5, 0.6, 8, 'surface'],
    [1.8, 1.1, 1.8, -11, 0.55, -9, 'surface'],
    [1.2, 1.2, 1.2, -11, 1.7, -9, 'hairline'],
    [1.8, 1.1, 1.8, 11, 0.55, -9, 'surface'],
    [1.2, 1.2, 1.2, 19.5, 0.6, -4, 'surface'],
    [1.2, 1.2, 1.2, -19.5, 0.6, -4, 'surface'],
    [1.6, 0.9, 1.6, -6, 0.45, -13, 'surface'],
    [1.6, 0.9, 1.6, 6, 0.45, -13, 'surface'],
  ];
  for (const [w, h, d, x, y, z, mat] of crates) box(w, h, d, x, y, z, mat);

  // Gantry platform in the east yard: a half-metre step up, jumpable, with a sightline
  // down the east lane. It sits off the middle lane and off the spawn-to-east path, so
  // the waypoint edges stay clear of it.
  box(6, 0.5, 3, 9, 0.25, 13, 'concrete');
  box(3, 1.1, 0.3, 9, 1.05, 14.5, 'hazard');
  box(3, 1.1, 0.3, 9, 1.05, 11.5, 'hazard');

  // Tank Farm's storage tank at site B: a cylinder whose collider is its bounding box.
  const tank = new THREE.Mesh(new THREE.CylinderGeometry(1.9, 1.9, 3.4, 20), materials.rust);
  tank.position.set(18.5, 1.7, -12.5);
  tank.castShadow = true;
  tank.receiveShadow = true;
  group.add(tank);
  colliders.push(new THREE.Box3().setFromCenterAndSize(new THREE.Vector3(18.5, 1.7, -12.5), new THREE.Vector3(3.8, 3.4, 3.8)));
  shootables.push(tank);

  // Light: dusk sun low from the south-west, cool sky fill, and a warm lamp over each site.
  const sky = new THREE.HemisphereLight(new THREE.Color(PALETTE.sky), new THREE.Color(PALETTE.canvas), 1.3);
  scene.add(sky);

  const sun = new THREE.DirectionalLight(new THREE.Color('#ffd9a0'), 2.6);
  sun.position.set(-14, 18, 16);
  sun.target.position.set(0, 0, -4);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -26;
  sun.shadow.camera.right = 26;
  sun.shadow.camera.top = 26;
  sun.shadow.camera.bottom = -26;
  sun.shadow.camera.far = 60;
  sun.shadow.bias = -0.0006;
  scene.add(sun, sun.target);

  const fill = new THREE.DirectionalLight(new THREE.Color(PALETTE.muted), 0.5);
  fill.position.set(10, 12, -14);
  scene.add(fill);

  for (const site of Object.values(MAP.sites)) {
    const lamp = new THREE.PointLight(new THREE.Color(PALETTE.accent), 14, 16, 1.6);
    lamp.position.set(site.center.x, 4.2, site.center.z);
    scene.add(lamp);
  }

  return { colliders, shootables, group };
}
