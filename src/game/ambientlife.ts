import * as THREE from 'three';
import type { FamilyDef, GameDef, Mechanic } from '../data/maps';

// Ambient life: small animated touches that make each world feel alive —
// birds, butterflies, rain + lightning, meteors, shooting stars, drones,
// tumbleweeds. Everything lives behind the board or around its edges, never
// over the play area, and uses unlit materials with small counts so phones
// stay smooth. Positions/sizes scale with the arena half-size `hs` because the
// arena camera's distance does: the visible strip between the board's far edge
// and the top HUD is roughly z ≈ -1.3..-2.1·hs at heights 0.1..0.35·hs.

export interface AmbientLife {
  tick(dt: number): void;
}

// Games with their own cameras/scenery (chase cams, stadiums, top-down boards).
const SKIP = new Set<Mechanic>(['raft', 'coaster', 'sprint', 'foosball', 'boat', 'kart', 'maze', 'chase', 'dodgeball']);

const rand = (a: number, b: number) => a + Math.random() * (b - a);

interface Part { tick(dt: number, t: number): void }

// --- Birds -------------------------------------------------------------------

function makeBird(col: number, span: number): { g: THREE.Group; l: THREE.Mesh; r: THREE.Mesh } {
  const mat = new THREE.MeshBasicMaterial({ color: col, side: THREE.DoubleSide, fog: false });
  const wing = new THREE.BufferGeometry();
  // Swept wing triangle from the body out to the tip.
  wing.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, -0.25, span, 0, 0.15, 0, 0, 0.35], 3));
  const l = new THREE.Mesh(wing, mat);
  const r = new THREE.Mesh(wing, mat);
  r.scale.x = -1;
  const body = new THREE.Mesh(new THREE.SphereGeometry(span * 0.16, 6, 4), mat);
  body.scale.set(1, 0.8, 2.4);
  const g = new THREE.Group();
  g.add(l, r, body);
  return { g, l, r };
}

/** V-shaped flocks that periodically cross the sky behind the arena. */
function flocks(scene: THREE.Scene, hs: number, col: number, size: number): Part {
  type Flock = { birds: ReturnType<typeof makeBird>[]; offs: THREE.Vector3[]; x: number; y: number; z: number; dir: number; speed: number; phase: number };
  const active: Flock[] = [];
  let next = rand(1, 4);
  // Enter/leave just past the visible edge for this screen shape (the strip
  // behind the board spans about ±2.15·hs·aspect), so flocks never pop in.
  const edge = () => hs * (2.15 * (innerWidth / Math.max(1, innerHeight)) + 0.4);
  const spawn = () => {
    const n = 3 + Math.floor(Math.random() * 5);
    const dir = Math.random() < 0.5 ? 1 : -1;
    const f: Flock = { birds: [], offs: [], x: -dir * edge(), y: hs * rand(0.12, 0.3), z: -hs * rand(1.5, 2.1), dir, speed: hs * rand(0.18, 0.28), phase: Math.random() * 6 };
    for (let i = 0; i < n; i++) {
      const b = makeBird(col, size * rand(0.85, 1.15));
      const row = Math.ceil(i / 2), side = i % 2 ? 1 : -1;
      f.offs.push(new THREE.Vector3(-dir * row * size * 2.2, rand(-0.3, 0.3) * size, side * row * size * 1.8));
      b.g.rotation.y = dir > 0 ? Math.PI / 2 : -Math.PI / 2;
      scene.add(b.g);
      f.birds.push(b);
    }
    active.push(f);
  };
  return {
    tick(dt, t) {
      next -= dt;
      if (next <= 0 && active.length < 2) { spawn(); next = rand(7, 13); }
      for (let k = active.length - 1; k >= 0; k--) {
        const f = active[k];
        f.x += f.dir * f.speed * dt;
        f.birds.forEach((b, i) => {
          const o = f.offs[i];
          const flap = Math.sin(t * 9 + f.phase + i * 0.7) * 0.7;
          b.l.rotation.z = flap; b.r.rotation.z = -flap;
          b.g.position.set(f.x + o.x, f.y + o.y + Math.sin(t * 1.3 + i) * size * 0.3, f.z + o.z);
        });
        if (f.dir * f.x > edge() + size * 12) {
          f.birds.forEach((b) => scene.remove(b.g));
          active.splice(k, 1);
        }
      }
    },
  };
}

/** Big birds gliding in slow circles high above the far side (desert vultures). */
function circlers(scene: THREE.Scene, hs: number, col: number, size: number, n: number): Part {
  const list = Array.from({ length: n }, (_, i) => {
    const b = makeBird(col, size);
    scene.add(b.g);
    return { b, cx: rand(-hs, hs), cz: -hs * rand(1.6, 2.0), y: hs * rand(0.22, 0.34), r: hs * rand(0.3, 0.5), a: (i / n) * Math.PI * 2, w: rand(0.18, 0.3) * (Math.random() < 0.5 ? 1 : -1) };
  });
  return {
    tick(dt, t) {
      for (const c of list) {
        c.a += c.w * dt;
        c.b.g.position.set(c.cx + Math.cos(c.a) * c.r, c.y, c.cz + Math.sin(c.a) * c.r * 0.5);
        c.b.g.rotation.y = -c.a + (c.w > 0 ? 0 : Math.PI);
        const flap = 0.12 + Math.sin(t * 2.2 + c.a) * 0.1; // mostly gliding
        c.b.l.rotation.z = flap; c.b.r.rotation.z = -flap;
      }
    },
  };
}

// --- Butterflies -------------------------------------------------------------

function butterflies(scene: THREE.Scene, hs: number, n: number): Part {
  const cols = [0xffd23f, 0xff6fb5, 0x7fd8ff, 0xffffff, 0xff9c3f];
  const list = Array.from({ length: n }, () => {
    const mat = new THREE.MeshBasicMaterial({ color: cols[Math.floor(Math.random() * cols.length)], side: THREE.DoubleSide });
    const wr = hs * 0.03;
    const wing = new THREE.CircleGeometry(wr, 6);
    const l = new THREE.Mesh(wing, mat); l.position.x = wr * 0.9;
    const r = new THREE.Mesh(wing, mat); r.position.x = -wr * 0.9;
    const pl = new THREE.Group(); pl.add(l);
    const pr = new THREE.Group(); pr.add(r);
    const g = new THREE.Group(); g.add(pl, pr);
    scene.add(g);
    const a = Math.random() * Math.PI * 2;
    return { g, pl, pr, a, rad: hs * rand(1.08, 1.4), y: rand(1.5, 5), w: rand(0.15, 0.35) * (Math.random() < 0.5 ? 1 : -1), ph: Math.random() * 6 };
  });
  return {
    tick(dt, t) {
      for (const b of list) {
        b.a += b.w * dt;
        const wob = Math.sin(t * 0.9 + b.ph) * hs * 0.08;
        b.g.position.set(Math.cos(b.a) * (b.rad + wob), b.y + Math.sin(t * 2 + b.ph) * 0.8, Math.sin(b.a) * (b.rad + wob));
        b.g.rotation.y = -b.a;
        const flap = Math.abs(Math.sin(t * 14 + b.ph)) * 1.2;
        b.pl.rotation.y = flap; b.pr.rotation.y = -flap;
      }
    },
  };
}

// --- Rain + lightning --------------------------------------------------------

function rain(scene: THREE.Scene, hs: number, count: number): Part {
  const pos = new Float32Array(count * 6);
  const span = hs * 1.7, top = hs * 1.6, len = hs * 0.05, slant = 0.25;
  const seed = (i: number, y?: number) => {
    const x = rand(-span, span), z = rand(-span, span), yy = y ?? rand(0, top);
    pos.set([x, yy, z, x - slant * len, yy - len, z], i * 6);
  };
  for (let i = 0; i < count; i++) seed(i);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const lines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0xbcd6ff, transparent: true, opacity: 0.38 }));
  lines.frustumCulled = false;
  scene.add(lines);
  const speed = hs * 1.4;
  return {
    tick(dt) {
      for (let i = 0; i < count; i++) {
        const o = i * 6;
        const dy = speed * dt;
        pos[o + 1] -= dy; pos[o + 4] -= dy;
        pos[o] -= dy * slant; pos[o + 3] -= dy * slant;
        if (pos[o + 4] < 0) seed(i, top);
      }
      geo.attributes.position.needsUpdate = true;
    },
  };
}

function lightning(scene: THREE.Scene): Part {
  const flash = new THREE.AmbientLight(0xd8e6ff, 0);
  scene.add(flash);
  let next = rand(5, 10);
  let t0 = -99;
  let base = -1; // background brightness to return to after a flash
  const pulses = [0, 0.16, 0.34]; // a quick double-flicker then a strike
  return {
    tick(dt, t) {
      next -= dt;
      if (next <= 0) { t0 = t; next = rand(8, 16); }
      let k = 0;
      for (const s of pulses) { const d = t - t0 - s; if (d >= 0 && d < 0.09) k = Math.max(k, 1 - d / 0.09); }
      flash.intensity = k * 2.4;
      if (k === 0) {
        if (base >= 0) { scene.backgroundIntensity = base; base = -1; }
      } else {
        if (base < 0) base = scene.backgroundIntensity;
        scene.backgroundIntensity = base * (1 + k * 0.8);
      }
    },
  };
}

// --- Meteors / shooting stars -----------------------------------------------

function streaks(scene: THREE.Scene, hs: number, col: number, size: number, every: [number, number], speedK: number): Part {
  type S = { m: THREE.Mesh; vx: number; vy: number; life: number; max: number };
  const live: S[] = [];
  let next = rand(1, every[1]);
  const geo = new THREE.CylinderGeometry(size * 0.05, size, size * 9, 6, 1, true);
  geo.rotateZ(Math.PI / 2); // lie along +x, thick end leading
  return {
    tick(dt) {
      next -= dt;
      if (next <= 0) {
        next = rand(every[0], every[1]);
        const dir = Math.random() < 0.5 ? 1 : -1;
        const mat = new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
        const m = new THREE.Mesh(geo, mat);
        const vx = dir * hs * speedK, vy = -hs * speedK * 0.35;
        m.position.set(rand(-hs * 1.3, hs * 1.3) - dir * hs * 0.6, hs * rand(0.4, 0.55), -hs * rand(1.8, 2.4));
        m.rotation.z = Math.atan2(vy, vx);
        scene.add(m);
        live.push({ m, vx, vy, life: 0, max: rand(1.1, 1.6) });
      }
      for (let i = live.length - 1; i >= 0; i--) {
        const s = live[i];
        s.life += dt;
        s.m.position.x += s.vx * dt; s.m.position.y += s.vy * dt;
        (s.m.material as THREE.MeshBasicMaterial).opacity = 0.95 * Math.max(0, 1 - s.life / s.max);
        if (s.life >= s.max) { scene.remove(s.m); (s.m.material as THREE.Material).dispose(); live.splice(i, 1); }
      }
    },
  };
}

// --- Drones ------------------------------------------------------------------

function drones(scene: THREE.Scene, hs: number, lights: number[], beams: boolean): Part {
  const list = lights.map((col, i) => {
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.5, 1.6), new THREE.MeshBasicMaterial({ color: 0x5c6880 }));
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.6, 10, 8), new THREE.MeshBasicMaterial({ color: col }));
    lamp.position.y = -0.35;
    g.add(body, lamp);
    for (const [x, z] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const rotor = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 0.05, 10), new THREE.MeshBasicMaterial({ color: 0x8a95aa, transparent: true, opacity: 0.55 }));
      rotor.position.set(x * 0.95, 0.3, z * 0.95);
      g.add(rotor);
    }
    let beam: THREE.Mesh | null = null;
    if (beams) {
      const len = 10; // local units (the drone group is scaled up with the arena)
      const bg = new THREE.ConeGeometry(2.4, len, 16, 1, true);
      bg.translate(0, -len / 2, 0);
      beam = new THREE.Mesh(bg, new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.13, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false }));
      g.add(beam);
    }
    g.scale.setScalar(hs / 15);
    scene.add(g);
    return { g, lamp, beam, x0: (i - (lights.length - 1) / 2) * hs * 0.85, z: -hs * rand(1.3, 1.6), y: hs * rand(0.2, 0.3), ph: Math.random() * 6, amp: hs * rand(0.15, 0.3) };
  });
  return {
    tick(_dt, t) {
      for (const d of list) {
        d.g.position.set(d.x0 + Math.sin(t * 0.35 + d.ph) * d.amp, d.y + Math.sin(t * 1.7 + d.ph) * hs * 0.02, d.z);
        d.g.rotation.z = Math.cos(t * 0.35 + d.ph) * 0.12;
        d.lamp.visible = Math.sin(t * 5 + d.ph) > -0.4; // blinking light
        if (d.beam) d.beam.rotation.z = Math.sin(t * 0.8 + d.ph) * 0.5;
      }
    },
  };
}

// --- Tumbleweeds -------------------------------------------------------------

function tumbleweeds(scene: THREE.Scene, hs: number): Part {
  const mat = new THREE.MeshBasicMaterial({ color: 0x9a7444, wireframe: true });
  const list: { m: THREE.Mesh; r: number; x: number; z: number; dir: number; sp: number; ph: number }[] = [];
  let next = rand(2, 6);
  return {
    tick(dt, t) {
      next -= dt;
      if (next <= 0 && list.length < 2) {
        next = rand(6, 12);
        const dir = Math.random() < 0.5 ? 1 : -1;
        const r = hs * rand(0.06, 0.09);
        const m = new THREE.Mesh(new THREE.IcosahedronGeometry(r, 1), mat);
        scene.add(m);
        list.push({ m, r, x: -dir * hs * 2, z: -hs * rand(1.12, 1.4), dir, sp: hs * rand(0.25, 0.4), ph: Math.random() * 6 });
      }
      for (let i = list.length - 1; i >= 0; i--) {
        const w = list[i];
        w.x += w.dir * w.sp * dt;
        w.m.position.set(w.x, w.r + Math.abs(Math.sin(t * 3 + w.ph)) * w.r * 1.2, w.z);
        w.m.rotation.z -= w.dir * w.sp * dt / w.r;
        if (Math.abs(w.x) > hs * 2.1) { scene.remove(w.m); list.splice(i, 1); }
      }
    },
  };
}

// --- Per-family setup ----------------------------------------------------------

export function makeAmbientLife(scene: THREE.Scene, family: FamilyDef, game: GameDef, hs: number): AmbientLife | null {
  if (SKIP.has(game.mechanic)) return null;
  const parts: Part[] = [];
  switch (family.id) {
    case 'wildwood':
      parts.push(flocks(scene, hs, 0x2a2018, hs * 0.09), butterflies(scene, hs, 7));
      break;
    case 'pirate':
      parts.push(flocks(scene, hs, 0xf2f4f7, hs * 0.09), rain(scene, hs, 320), lightning(scene));
      break;
    case 'dune':
      parts.push(circlers(scene, hs, 0x2b1d14, hs * 0.12, 3), tumbleweeds(scene, hs));
      break;
    case 'sky':
      parts.push(flocks(scene, hs, 0xffffff, hs * 0.09));
      break;
    case 'inferno':
      parts.push(streaks(scene, hs, 0xff7a2e, hs * 0.035, [2.5, 5.5], 0.9));
      break;
    case 'frost':
      parts.push(flocks(scene, hs, 0xf4fbff, hs * 0.08), streaks(scene, hs, 0xeaf6ff, hs * 0.012, [4, 9], 1.6));
      break;
    case 'mech':
      parts.push(drones(scene, hs, [0xff3b3b, 0x2bd9c8, 0xffb020], false));
      break;
    case 'classic':
      parts.push(drones(scene, hs, [0xff3bd0, 0x3bd8ff, 0xb06bff], true));
      break;
    default:
      return null;
  }
  let t = 0;
  return {
    tick(dt) {
      t += dt;
      for (const p of parts) p.tick(dt, t);
    },
  };
}
