import * as THREE from 'three';
import type { MapDef } from '../data/maps';
import type { SurfaceKind } from '../data/surfaces';
import { auroraSky, gradientSky, iceFloor, quadrantFloor } from './textures';

// Builds the themed arena for a MapDef: skybox, fog, lights, ground, floor,
// neon trim border, decorative props, and ambient particles. Returns a handle
// with per-frame ambient ticking and a surface lookup used by free-roam games.

export interface World {
  floor: THREE.Mesh;
  halfSize: number;
  surfaceAt: (x: number, z: number) => SurfaceKind;
  tick: (dt: number) => void;
}

export function buildWorld(scene: THREE.Scene, map: MapDef, halfSize: number): World {
  const t = map.theme;
  const isIce = map.surface === 'ice';

  scene.background = isIce ? auroraSky(t.skyTop, t.skyBot) : gradientSky(t.skyTop, t.skyBot);
  scene.fog = new THREE.Fog(new THREE.Color(t.fog).getHex(), halfSize * 3.0, halfSize * 7.5);

  // Lights.
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

  // Surrounding ground plane for depth.
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(600, 600),
    new THREE.MeshStandardMaterial({ color: new THREE.Color(t.ground).getHex(), roughness: 1 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -2;
  ground.receiveShadow = true;
  scene.add(ground);

  // Arena floor.
  let ftex: THREE.Texture;
  if (map.id === 'greybox') ftex = quadrantFloor();
  else if (isIce) ftex = iceFloor();
  else ftex = iceFloor();
  const fmat = new THREE.MeshStandardMaterial({ map: ftex, roughness: 0.6, metalness: 0.1 });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(halfSize * 2, halfSize * 2), fmat);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  // Neon trim border.
  const trimMat = new THREE.MeshBasicMaterial({ color: t.trim });
  ([[0, halfSize], [0, -halfSize], [halfSize, 0], [-halfSize, 0]] as const).forEach((p, i) => {
    const horiz = i < 2;
    const bar = new THREE.Mesh(new THREE.BoxGeometry(horiz ? halfSize * 2 : 1.4, 1.4, horiz ? 1.4 : halfSize * 2), trimMat);
    bar.position.set(p[0], 0.5, p[1]);
    scene.add(bar);
  });

  // Decorative crystal shards / pillars around the rink.
  const pcol = new THREE.MeshStandardMaterial({
    color: isIce ? 0x6ab8e8 : 0x2a3050,
    roughness: isIce ? 0.2 : 0.9,
    metalness: isIce ? 0.3 : 0,
    transparent: isIce,
    opacity: isIce ? 0.85 : 1,
    emissive: isIce ? 0x1a4a7a : 0x000000,
  });
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    const rad = halfSize * 1.5;
    const h = 14 + Math.sin(i * 3) * 5;
    const pil = new THREE.Mesh(new THREE.ConeGeometry(2.4, h, 5), pcol);
    pil.position.set(Math.cos(a) * rad, h / 2 - 2, Math.sin(a) * rad);
    pil.castShadow = true;
    scene.add(pil);
    const cap = new THREE.Mesh(new THREE.SphereGeometry(1.4, 10, 10), new THREE.MeshBasicMaterial({ color: t.trim }));
    cap.position.set(Math.cos(a) * rad, h - 2, Math.sin(a) * rad);
    scene.add(cap);
  }

  // Ambient particles (snow).
  let ambientPts: THREE.Points | null = null;
  if (t.ambient === 'snow') {
    const n = 70;
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      pos[i * 3] = (Math.random() - 0.5) * halfSize * 3;
      pos[i * 3 + 1] = Math.random() * 60 + 2;
      pos[i * 3 + 2] = (Math.random() - 0.5) * halfSize * 3;
    }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({ color: 0xffffff, size: 1.2, transparent: true, opacity: 0.8, depthWrite: false });
    ambientPts = new THREE.Points(geo, mat);
    scene.add(ambientPts);
  }

  // Surface lookup: greybox uses quadrants + a central conveyor strip; every
  // other map is uniform (its declared surface).
  const surfaceAt = (x: number, z: number): SurfaceKind => {
    if (map.id !== 'greybox') return map.surface;
    if (Math.abs(z) < halfSize * 0.12) return 'conveyor';
    if (x < 0 && z < 0) return 'metal';
    if (x >= 0 && z < 0) return 'ice';
    if (x < 0 && z >= 0) return 'mud';
    return 'sand';
  };

  return {
    floor,
    halfSize,
    surfaceAt,
    tick(dt: number) {
      if (!ambientPts) return;
      const arr = ambientPts.geometry.attributes.position.array as Float32Array;
      for (let i = 0; i < arr.length; i += 3) {
        arr[i + 1] -= dt * 6;
        arr[i] += Math.sin(arr[i + 1] * 0.1) * dt * 2;
        if (arr[i + 1] < 2) arr[i + 1] = 60;
      }
      ambientPts.geometry.attributes.position.needsUpdate = true;
    },
  };
}
