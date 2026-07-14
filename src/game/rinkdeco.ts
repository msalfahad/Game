import * as THREE from 'three';

// Hockey rink decoration shared by offline + online: chunky posts in the four
// corners (a CLEAR break between your wall and your neighbours'), a glowing
// goal strip along each wall in that player's color, and serve pads in the
// corners where pucks launch from.

export const CORNER_R = 2.4; // physics radius pucks bounce off (see corner spawn/bounce)
export const SPAWN_INSET = 2.6; // corner serve pads sit this far inside the walls

export interface RinkDeco {
  strips: THREE.Mesh[]; // per player index (bottom, top, left, right)
}

export function decorateRink(scene: THREE.Scene, half: number, cols: string[]): RinkDeco {
  // Corner posts: ice pillar + glowing cap.
  const postMat = new THREE.MeshStandardMaterial({ color: 0xdff2ff, roughness: 0.25, metalness: 0.1 });
  const capMat = new THREE.MeshBasicMaterial({ color: 0x9adfff });
  for (const cx of [-half, half]) {
    for (const cz of [-half, half]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(2.0, 2.3, 5.4, 10), postMat);
      post.position.set(cx, 2.7, cz);
      post.castShadow = true;
      scene.add(post);
      const cap = new THREE.Mesh(new THREE.SphereGeometry(1.1, 12, 12), capMat);
      cap.position.set(cx, 5.7, cz);
      scene.add(cap);

      // Serve pad: where pucks come out.
      const px = Math.sign(cx) * (half - SPAWN_INSET);
      const pz = Math.sign(cz) * (half - SPAWN_INSET);
      const pad = new THREE.Mesh(
        new THREE.CircleGeometry(1.7, 20),
        new THREE.MeshBasicMaterial({ color: 0x0a1230, transparent: true, opacity: 0.85 }),
      );
      pad.rotation.x = -Math.PI / 2;
      pad.position.set(px, 0.12, pz);
      scene.add(pad);
      const rim = new THREE.Mesh(
        new THREE.TorusGeometry(1.7, 0.18, 8, 24),
        new THREE.MeshBasicMaterial({ color: 0xff8a2e }),
      );
      rim.rotation.x = -Math.PI / 2;
      rim.position.set(px, 0.2, pz);
      scene.add(rim);
    }
  }

  // Goal strips: your wall glows in YOUR color, post to post.
  const strips: THREE.Mesh[] = [];
  const len = half * 2 - 5.4;
  const defs: [number, number, boolean][] = [
    [0, half, true], // bottom (player 0)
    [0, -half, true], // top (player 1)
    [-half, 0, false], // left (player 2)
    [half, 0, false], // right (player 3)
  ];
  defs.forEach(([x, z, horizontal], i) => {
    const geo = horizontal ? new THREE.BoxGeometry(len, 0.7, 0.9) : new THREE.BoxGeometry(0.9, 0.7, len);
    const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(cols[i] ?? '#ffffff'), transparent: true, opacity: 0.95 });
    const strip = new THREE.Mesh(geo, mat);
    strip.position.set(x, 1.35, z);
    scene.add(strip);
    strips.push(strip);
  });
  return { strips };
}

/** Dim a goal strip when its player is eliminated (their wall seals). */
export function sealStrip(deco: RinkDeco, i: number) {
  const m = deco.strips[i]?.material as THREE.MeshBasicMaterial | undefined;
  if (m) {
    m.color.setHex(0x9adfff);
    m.opacity = 0.35;
  }
}

/** Pick a random corner serve position + inward velocity (shared launch logic). */
export function cornerServe(half: number, speed: number): { x: number; z: number; vx: number; vz: number } {
  const sx = (Math.random() < 0.5 ? -1 : 1) * (half - SPAWN_INSET);
  const sz = (Math.random() < 0.5 ? -1 : 1) * (half - SPAWN_INSET);
  const a = Math.atan2(-sz, -sx) + (Math.random() - 0.5) * 0.9;
  return { x: sx, z: sz, vx: Math.cos(a) * speed, vz: Math.sin(a) * speed };
}

/** Bounce a puck off the four corner posts. Mutates b. */
export function cornerBounce(b: { x: number; z: number; vx: number; vz: number }, half: number) {
  const R = CORNER_R + 0.9; // post + puck radius
  for (const cx of [-half, half]) {
    for (const cz of [-half, half]) {
      const dx = b.x - cx, dz = b.z - cz;
      const d = Math.hypot(dx, dz);
      if (d > R || d === 0) continue;
      const nx = dx / d, nz = dz / d;
      const dot = b.vx * nx + b.vz * nz;
      if (dot < 0) {
        b.vx -= 2 * dot * nx;
        b.vz -= 2 * dot * nz;
      }
      b.x = cx + nx * R;
      b.z = cz + nz * R;
    }
  }
}
