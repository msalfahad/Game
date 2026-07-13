import * as THREE from 'three';
import type { FamilyDef, GameDef } from '../data/maps';
import type { SurfaceKind } from '../data/surfaces';
import { auroraSky, gradientSky, styledFloor } from './textures';

// Builds the themed arena for a game: sky, fog, lights, ground, floor (square
// or circle), neon trim, per-family decorative props, and ambient particles.

export interface World {
  floorMesh: THREE.Mesh;
  ringMesh: THREE.Mesh | null; // circle arenas expose their trim ring (pushout shrinks it)
  halfSize: number;
  surfaceAt: (x: number, z: number) => SurfaceKind;
  tick: (dt: number) => void;
}

export function buildWorld(
  scene: THREE.Scene,
  family: FamilyDef,
  game: GameDef,
  halfSize: number,
  rect?: { w: number; l: number }, // rectangular arenas (the climb corridor)
): World {
  const t = family.theme;
  const style = family.style;

  scene.background = style === 'ice' ? auroraSky(t.skyTop, t.skyBot) : gradientSky(t.skyTop, t.skyBot);
  scene.fog = new THREE.Fog(new THREE.Color(t.fog).getHex(), halfSize * 3.0, halfSize * 7.5);

  scene.add(new THREE.AmbientLight(t.light, 0.75));
  const sun = new THREE.DirectionalLight(t.light, 0.9);
  sun.position.set(24, 95, -12);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.left = -halfSize * 1.6;
  sun.shadow.camera.right = halfSize * 1.6;
  sun.shadow.camera.top = halfSize * 1.6;
  sun.shadow.camera.bottom = -halfSize * 1.6;
  scene.add(sun);
  const rim = new THREE.PointLight(t.trim, 0.6, 300);
  rim.position.set(0, 40, -40);
  scene.add(rim);

  // Surrounding ground plane. Lava glows.
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(600, 600),
    new THREE.MeshStandardMaterial({
      color: new THREE.Color(t.ground).getHex(),
      roughness: 1,
      emissive: style === 'lava' ? 0x2a0c04 : 0x000000,
    }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -2;
  ground.receiveShadow = true;
  scene.add(ground);

  // Arena floor.
  const ftex = styledFloor(style);
  const shiny = style === 'ice' || style === 'sky';
  const fmat = new THREE.MeshStandardMaterial({
    map: ftex,
    roughness: shiny ? 0.6 : 0.85,
    metalness: shiny ? 0.1 : 0.05,
    emissive: style === 'lava' ? 0x3a1008 : 0x000000,
    emissiveIntensity: style === 'lava' ? 0.6 : 0,
  });
  let floorMesh: THREE.Mesh;
  let ringMesh: THREE.Mesh | null = null;
  const trimMat = new THREE.MeshBasicMaterial({ color: t.trim });
  if (game.shape === 'circle') {
    floorMesh = new THREE.Mesh(new THREE.CircleGeometry(halfSize, 64), fmat);
    ringMesh = new THREE.Mesh(new THREE.TorusGeometry(halfSize, 0.7, 8, 80), trimMat);
    ringMesh.rotation.x = -Math.PI / 2;
    ringMesh.position.y = 0.4;
    scene.add(ringMesh);
  } else {
    const fw = rect ? rect.w : halfSize;
    const fl = rect ? rect.l : halfSize;
    floorMesh = new THREE.Mesh(new THREE.PlaneGeometry(fw * 2, fl * 2), fmat);
    ([[0, fl], [0, -fl], [fw, 0], [-fw, 0]] as const).forEach((p, i) => {
      const horiz = i < 2;
      const bar = new THREE.Mesh(new THREE.BoxGeometry(horiz ? fw * 2 : 1.4, 1.4, horiz ? 1.4 : fl * 2), trimMat);
      bar.position.set(p[0], 0.5, p[1]);
      scene.add(bar);
    });
  }
  floorMesh.rotation.x = -Math.PI / 2;
  floorMesh.receiveShadow = true;
  scene.add(floorMesh);

  // Goal games skip the tall perimeter props (they blocked the near wall);
  // rectangular corridors skip them too (the ring layout doesn't fit).
  if (game.mechanic !== 'goal' && !rect) buildProps(scene, family, halfSize, trimMat);
  const ambientPts = buildAmbient(scene, family, halfSize);

  const surfaceAt = (x: number, z: number): SurfaceKind => {
    if (game.mechanic === 'lab') {
      if (Math.abs(z) < halfSize * 0.12) return 'conveyor';
      if (x < 0 && z < 0) return 'metal';
      if (x >= 0 && z < 0) return 'ice';
      if (x < 0 && z >= 0) return 'mud';
      return 'sand';
    }
    return family.surface;
  };

  return {
    floorMesh,
    ringMesh,
    halfSize,
    surfaceAt,
    tick(dt: number) {
      tickAmbient(ambientPts, family, dt);
    },
  };
}

// --- props ------------------------------------------------------------------
function buildProps(scene: THREE.Scene, family: FamilyDef, half: number, trimMat: THREE.MeshBasicMaterial) {
  const style = family.style;
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x5a3a22, roughness: 1 });
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    const rad = half * 1.5;
    const h = 14 + Math.sin(i * 3) * 5;
    const px = Math.cos(a) * rad, pz = Math.sin(a) * rad;

    if (style === 'forest') {
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(1.4, 2, h * 0.6, 7), trunkMat);
      trunk.position.set(px, h * 0.3 - 2, pz); trunk.castShadow = true; scene.add(trunk);
      const canopy = new THREE.Mesh(new THREE.ConeGeometry(6, h * 0.8, 8),
        new THREE.MeshStandardMaterial({ color: 0x3e8a44, roughness: 1 }));
      canopy.position.set(px, h * 0.75 - 2, pz); canopy.castShadow = true; scene.add(canopy);
    } else if (style === 'pirate') {
      // masts with sails
      const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 1.2, h, 7), trunkMat);
      mast.position.set(px, h / 2 - 2, pz); mast.castShadow = true; scene.add(mast);
      if (i % 2 === 0) {
        const sail = new THREE.Mesh(new THREE.ConeGeometry(4.5, h * 0.55, 4),
          new THREE.MeshStandardMaterial({ color: 0xf0ead8, roughness: 0.9 }));
        sail.position.set(px, h * 0.62 - 2, pz); scene.add(sail);
      }
    } else if (style === 'sky') {
      // floating cloud puffs
      const cloud = new THREE.Mesh(new THREE.SphereGeometry(4 + (i % 3), 10, 10),
        new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, transparent: true, opacity: 0.85 }));
      cloud.position.set(px, 4 + Math.sin(i * 2) * 6, pz); scene.add(cloud);
    } else if (style === 'desert') {
      if (i % 3 === 0) {
        // palm: trunk + fan of cones
        const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 1.3, h * 0.7, 7), trunkMat);
        trunk.position.set(px, h * 0.35 - 2, pz); trunk.castShadow = true; scene.add(trunk);
        const fronds = new THREE.Mesh(new THREE.ConeGeometry(5, 3, 6),
          new THREE.MeshStandardMaterial({ color: 0x4e9a4a, roughness: 1 }));
        fronds.position.set(px, h * 0.7 - 1, pz); scene.add(fronds);
      } else {
        const pillar = new THREE.Mesh(new THREE.CylinderGeometry(2, 2.6, h, 8),
          new THREE.MeshStandardMaterial({ color: 0xc49a5a, roughness: 0.9 }));
        pillar.position.set(px, h / 2 - 2, pz); pillar.castShadow = true; scene.add(pillar);
        const cap = new THREE.Mesh(new THREE.SphereGeometry(1.4, 10, 10), trimMat);
        cap.position.set(px, h - 2, pz); scene.add(cap);
      }
    } else if (style === 'mech') {
      const pylon = new THREE.Mesh(new THREE.BoxGeometry(3, h, 3),
        new THREE.MeshStandardMaterial({ color: 0x2a323e, roughness: 0.6, metalness: 0.6 }));
      pylon.position.set(px, h / 2 - 2, pz); pylon.castShadow = true; scene.add(pylon);
      const cap = new THREE.Mesh(new THREE.SphereGeometry(1.2, 10, 10), trimMat);
      cap.position.set(px, h - 2, pz); scene.add(cap);
    } else {
      // ice / lava / neon: crystal or rock spires
      const isIce = style === 'ice';
      const mat = new THREE.MeshStandardMaterial({
        color: isIce ? 0x6ab8e8 : style === 'lava' ? 0x2a1512 : 0x2a3050,
        roughness: isIce ? 0.2 : 0.9,
        metalness: isIce ? 0.3 : 0,
        transparent: isIce,
        opacity: isIce ? 0.85 : 1,
        emissive: isIce ? 0x1a4a7a : style === 'lava' ? 0x3a1206 : 0x000000,
      });
      const spire = new THREE.Mesh(
        isIce || style === 'lava' ? new THREE.ConeGeometry(2.4, h, 5) : new THREE.CylinderGeometry(2, 2.6, h, 8),
        mat,
      );
      spire.position.set(px, h / 2 - 2, pz); spire.castShadow = true; scene.add(spire);
      const cap = new THREE.Mesh(new THREE.SphereGeometry(1.4, 10, 10), trimMat);
      cap.position.set(px, h - 2, pz); scene.add(cap);
    }
  }
}

// --- ambient particles ------------------------------------------------------
function buildAmbient(scene: THREE.Scene, family: FamilyDef, half: number): THREE.Points | null {
  const amb = family.theme.ambient;
  if (amb === 'none') return null;
  const n = amb === 'stars' ? 120 : 70;
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    pos[i * 3] = (Math.random() - 0.5) * half * 3;
    pos[i * 3 + 1] = Math.random() * 60 + (amb === 'stars' ? 20 : 2);
    pos[i * 3 + 2] = (Math.random() - 0.5) * half * 3;
  }
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const conf: Record<string, [number, number]> = {
    snow: [0xffffff, 1.2], embers: [0xff7a2e, 1.0], sand: [0xffd79a, 0.8],
    leaves: [0x9ad85a, 1.4], stars: [0xffffff, 1.2], bubbles: [0xbfefff, 1.0],
  };
  const [col, size] = conf[amb] ?? [0xffffff, 1.2];
  const mat = new THREE.PointsMaterial({ color: col, size, transparent: true, opacity: 0.8, depthWrite: false });
  const pts = new THREE.Points(geo, mat);
  scene.add(pts);
  return pts;
}

function tickAmbient(pts: THREE.Points | null, family: FamilyDef, dt: number) {
  if (!pts) return;
  const amb = family.theme.ambient;
  if (amb === 'stars') return;
  const arr = pts.geometry.attributes.position.array as Float32Array;
  for (let i = 0; i < arr.length; i += 3) {
    if (amb === 'embers' || amb === 'bubbles') {
      arr[i + 1] += dt * (amb === 'embers' ? 5 : 6);
      if (amb === 'embers') arr[i] += Math.sin(arr[i + 1]) * dt;
      if (arr[i + 1] > 60) arr[i + 1] = 2;
    } else {
      arr[i + 1] -= dt * 6;
      arr[i] += Math.sin(arr[i + 1] * 0.1) * dt * 2;
      if (arr[i + 1] < 2) arr[i + 1] = 60;
    }
  }
  pts.geometry.attributes.position.needsUpdate = true;
}
