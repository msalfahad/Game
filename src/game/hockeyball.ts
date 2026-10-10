import * as THREE from 'three';

// The ball for the hockey-style games, shared by the offline and online
// controllers so both look identical. Frostbite plays with a classic
// black-and-white football; every other rink uses a plain white ball. A
// powered-up ball (after an ultimate) glows red in both cases.

const RADIUS = 0.9;
let footballTex: THREE.CanvasTexture | null = null;

/**
 * Equirectangular football texture: the spherical Voronoi cells of the 12
 * icosahedron vertices (black pentagons) and 20 face centres (white hexagons)
 * form a truncated icosahedron — the real football pattern — with dark seams
 * where cells meet. Laid out to match THREE.SphereGeometry's UV mapping.
 */
function footballTexture(): THREE.CanvasTexture {
  if (footballTex) return footballTex;
  const phi = (1 + Math.sqrt(5)) / 2;
  const raw: number[][] = [];
  for (const a of [-1, 1]) for (const b of [-1, 1]) {
    raw.push([0, a, b * phi], [a, b * phi, 0], [b * phi, 0, a]); // 12 icosahedron vertices
  }
  const pent = raw.length;
  for (const a of [-1, 1]) for (const b of [-1, 1]) for (const c of [-1, 1]) raw.push([a, b, c]);
  for (const a of [-1, 1]) for (const b of [-1, 1]) {
    raw.push([0, a / phi, b * phi], [a / phi, b * phi, 0], [b * phi, 0, a / phi]); // 20 dodecahedron vertices
  }
  const centers = raw.map(([x, y, z]) => { const l = Math.hypot(x, y, z); return [x / l, y / l, z / l]; });

  const W = 512, H = 256;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d')!;
  const img = g.createImageData(W, H);
  for (let py = 0; py < H; py++) {
    const v = (py + 0.5) / H;
    const sv = Math.sin(Math.PI * v), cy = Math.cos(Math.PI * v);
    for (let px = 0; px < W; px++) {
      const u = (px + 0.5) / W;
      const dx = -Math.cos(2 * Math.PI * u) * sv, dz = Math.sin(2 * Math.PI * u) * sv;
      let best = -2, second = -2, bi = 0;
      for (let i = 0; i < centers.length; i++) {
        const [x, y, z] = centers[i];
        const d = dx * x + cy * y + dz * z;
        if (d > best) { second = best; best = d; bi = i; } else if (d > second) second = d;
      }
      const seam = Math.acos(Math.min(1, second)) - Math.acos(Math.min(1, best)) < 0.035;
      const shade = seam ? 60 : bi < pent ? 22 : 245;
      const o = (py * W + px) * 4;
      img.data[o] = img.data[o + 1] = img.data[o + 2] = shade;
      img.data[o + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  footballTex = new THREE.CanvasTexture(c);
  footballTex.colorSpace = THREE.SRGBColorSpace;
  footballTex.anisotropy = 4;
  return footballTex;
}

export function makeHockeyBall(familyId: string): THREE.Mesh {
  const football = familyId === 'frost';
  const m = new THREE.Mesh(
    new THREE.SphereGeometry(RADIUS, 24, 16),
    new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: football ? footballTexture() : null,
      roughness: football ? 0.5 : 0.3,
      metalness: 0.05,
      emissive: 0x000000,
    }),
  );
  return m;
}

/** White normally, glowing red while powered up. */
export function styleHockeyBall(m: THREE.Mesh, powered: boolean) {
  const mat = m.material as THREE.MeshStandardMaterial;
  mat.color.setHex(powered ? 0xff6a6a : 0xffffff);
  // The plain ball self-lights a little so warm arena lighting can't tint it beige.
  mat.emissive.setHex(powered ? 0xff2020 : mat.map ? 0x1a1a1a : 0x8c8c8c);
}

const axis = new THREE.Vector3();
/** Roll the ball along its direction of travel so the pattern spins. */
export function rollHockeyBall(m: THREE.Mesh, vx: number, vz: number, dt: number) {
  const speed = Math.hypot(vx, vz);
  if (speed < 0.01) return;
  axis.set(vz / speed, 0, -vx / speed);
  m.rotateOnWorldAxis(axis, (speed * dt) / RADIUS);
}
