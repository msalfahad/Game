import * as THREE from 'three';

// A stylized lightning bolt striking down on a target — used by the Slip &
// Slide thunder box. Caller owns the lifetime (fade + remove).

export interface Bolt {
  group: THREE.Group;
  t: number;
}

export function spawnBolt(scene: THREE.Scene, x: number, z: number): Bolt {
  const group = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({ color: 0xfff7aa, transparent: true, opacity: 1 });
  let px = 0;
  let py = 16;
  for (let i = 0; i < 5; i++) {
    const ny = py - 3.2;
    const nx = px + (Math.random() - 0.5) * 3.4;
    const len = Math.hypot(nx - px, py - ny);
    const seg = new THREE.Mesh(new THREE.BoxGeometry(0.55, len + 0.4, 0.55), mat);
    seg.position.set((px + nx) / 2, (py + ny) / 2, 0);
    seg.rotation.z = Math.atan2(nx - px, py - ny);
    group.add(seg);
    px = nx;
    py = ny;
  }
  // Impact flash on the ground.
  const flash = new THREE.Mesh(
    new THREE.CircleGeometry(3, 16),
    new THREE.MeshBasicMaterial({ color: 0xfff7aa, transparent: true, opacity: 0.8 }),
  );
  flash.rotation.x = -Math.PI / 2;
  flash.position.y = -py + 0.3 - 16; // relative: place at group-local ground
  flash.position.y = 0.3 - 16;
  group.add(flash);
  group.position.set(x, 16, z);
  scene.add(group);
  return { group, t: 0.4 };
}

/** Fade + cull bolts; returns the surviving list. */
export function tickBolts(scene: THREE.Scene, bolts: Bolt[], dt: number): Bolt[] {
  return bolts.filter((b) => {
    b.t -= dt;
    if (b.t <= 0) {
      scene.remove(b.group);
      return false;
    }
    b.group.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.MeshBasicMaterial | undefined;
      if (m && 'opacity' in m) m.opacity = Math.min(1, b.t / 0.25);
    });
    return true;
  });
}
