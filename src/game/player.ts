import * as THREE from 'three';
import type { Hero } from '../data/characters';
import { heroImg } from '../data/characters';

// Identical hitboxes for every hero (SPEC section 3) — the disc radius does NOT
// scale with stats. Stats only change feel (speed/knockback), never reach.
export const HITBOX_RADIUS = 3.0;

const texCache: Record<string, THREE.Texture> = {};
function charTex(h: Hero): THREE.Texture {
  if (texCache[h.key]) return texCache[h.key];
  const t = new THREE.TextureLoader().load(heroImg(h));
  t.magFilter = THREE.LinearFilter;
  t.colorSpace = THREE.SRGBColorSpace;
  texCache[h.key] = t;
  return t;
}

// Cropped face texture (top-center of the character art) for the 3D head.
const faceCache: Record<string, THREE.CanvasTexture> = {};
function faceTex(h: Hero, onReady: (t: THREE.CanvasTexture) => void) {
  if (faceCache[h.key]) return onReady(faceCache[h.key]);
  const img = new Image();
  img.src = heroImg(h);
  img.onload = () => {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d')!;
    // Head region of the front-view cutout: center 55% width, top 40% height.
    g.drawImage(img, img.width * 0.225, 0, img.width * 0.55, img.height * 0.4, 0, 0, 128, 128);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    faceCache[h.key] = t;
    onReady(t);
  };
}

export type Team = 0 | 1;

// A hero riding a hover disc — now a small articulated 3D figure (torso,
// face-textured head, swinging arms and legs) instead of a flat billboard.
export class Player {
  hero: Hero;
  you: boolean;
  team: Team;
  index: number;

  // World-plane kinematics (y handled per-game for jumps/falls).
  x = 0;
  z = 0;
  vx = 0;
  vz = 0;
  y = 0;
  vy = 0;
  face = { x: 0, z: -1 };

  dead = false;

  // Match-scoped scoring fields (interpreted per game).
  pts = 0;
  hp = 100;
  lives = 3;
  score = 0;

  // Ability/ultimate cooldown + arm state.
  cd = 0;
  armed = false;

  // Core movement state (SPEC section 4): jumps, dash, dive.
  grounded = true;
  airJumps = 0;
  dashCd = 0;
  diveT = 0;

  // Status effects. Seconds remaining.
  freezeT = 0;
  speedT = 0;
  giantT = 0;
  shieldT = 0;
  invulnT = 0;
  held = false;

  // Race state.
  wp = 0;
  lap = 0;

  // Bot AI scratch.
  retarget = 0;
  want = 0.5;
  tx = 0;
  tz = 0;
  tw: { x: number; z: number } | null = null;

  // Frostbite hockey: parametric edge position 0..1 along the player's wall.
  pos = 0.5;
  side: 'bottom' | 'top' | 'left' | 'right' = 'bottom';

  // Three.js
  group = new THREE.Group();
  ring!: THREE.Mesh;
  glow!: THREE.Mesh;
  private body = new THREE.Group();
  private armL!: THREE.Mesh;
  private armR!: THREE.Mesh;
  private legL!: THREE.Mesh;
  private legR!: THREE.Mesh;
  private headM!: THREE.Mesh;
  private torsoMat!: THREE.MeshStandardMaterial;
  private baseBodyY = 0;
  private px = 0;
  private pz = 0;

  // HUD refs.
  scoreEl: HTMLElement | null = null;
  headEl: HTMLElement | null = null;

  constructor(hero: Hero, you: boolean, index: number, team: Team) {
    this.hero = hero;
    this.you = you;
    this.index = index;
    this.team = team;
  }

  buildRider(scene: THREE.Scene) {
    const r = HITBOX_RADIUS;
    const grp = new THREE.Group();
    const col = new THREE.Color(this.hero.col);
    const colDark = col.clone().multiplyScalar(0.55);

    // Hover disc + ring + glow (unchanged silhouette on the floor).
    const disc = new THREE.Mesh(
      new THREE.CylinderGeometry(r, r * 1.1, 1.1, 20),
      new THREE.MeshStandardMaterial({ color: 0x232a4a, roughness: 0.5, metalness: 0.4 }),
    );
    disc.castShadow = true;
    grp.add(disc);
    this.ring = new THREE.Mesh(
      new THREE.TorusGeometry(r * 0.95, 0.28, 8, 24),
      new THREE.MeshBasicMaterial({ color: col.getHex() }),
    );
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.position.y = 0.6;
    grp.add(this.ring);
    this.glow = new THREE.Mesh(
      new THREE.CircleGeometry(r * 1.2, 20),
      new THREE.MeshBasicMaterial({ color: col.getHex(), transparent: true, opacity: 0.3 }),
    );
    this.glow.rotation.x = -Math.PI / 2;
    this.glow.position.y = 0.05;
    grp.add(this.glow);

    // --- articulated figure (total height ~ r * 2.2) -------------------------
    const S = r * 0.62; // proportional unit
    this.torsoMat = new THREE.MeshStandardMaterial({ color: col.getHex(), roughness: 0.6, metalness: 0.15 });
    const limbMat = new THREE.MeshStandardMaterial({ color: colDark.getHex(), roughness: 0.7 });

    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(S * 0.72, S * 1.0, 6, 12), this.torsoMat);
    torso.position.y = S * 1.9;
    torso.castShadow = true;
    this.body.add(torso);

    // Head: box with the hero's face on the front.
    const faceFallback = new THREE.MeshStandardMaterial({ color: col.clone().multiplyScalar(1.25).getHex(), roughness: 0.5 });
    const headSide = new THREE.MeshStandardMaterial({ color: colDark.getHex(), roughness: 0.6 });
    const headMats: THREE.Material[] = [headSide, headSide, headSide, headSide, faceFallback, headSide];
    this.headM = new THREE.Mesh(new THREE.BoxGeometry(S * 1.5, S * 1.4, S * 1.3), headMats);
    this.headM.position.y = S * 3.35;
    this.headM.castShadow = true;
    this.body.add(this.headM);
    faceTex(this.hero, (t) => {
      headMats[4] = new THREE.MeshBasicMaterial({ map: t });
      this.headM.material = headMats;
    });

    // Limbs pivot at their joints (geometry shifted so rotation swings them).
    const limb = (rad: number, len: number) => {
      const geo = new THREE.CapsuleGeometry(rad, len, 4, 8);
      geo.translate(0, -len / 2, 0);
      const m = new THREE.Mesh(geo, limbMat);
      m.castShadow = true;
      return m;
    };
    this.armL = limb(S * 0.26, S * 1.15);
    this.armR = limb(S * 0.26, S * 1.15);
    this.armL.position.set(-S * 0.95, S * 2.55, 0);
    this.armR.position.set(S * 0.95, S * 2.55, 0);
    this.body.add(this.armL, this.armR);
    this.legL = limb(S * 0.3, S * 1.05);
    this.legR = limb(S * 0.3, S * 1.05);
    this.legL.position.set(-S * 0.42, S * 1.25, 0);
    this.legR.position.set(S * 0.42, S * 1.25, 0);
    this.body.add(this.legL, this.legR);

    this.baseBodyY = 0.6;
    this.body.position.y = this.baseBodyY;
    grp.add(this.body);

    this.group = grp;
    scene.add(grp);
  }

  /**
   * Animate the figure: legs/arms swing with movement speed, arms fly up in
   * the air, gentle idle bob when standing. Velocity is derived from position
   * deltas so it works for predicted, simulated and interpolated players.
   */
  bob(elapsed: number, seed: number) {
    if (!this.body.children.length) return;
    const dx = this.x - this.px;
    const dz = this.z - this.pz;
    this.px = this.x;
    this.pz = this.z;
    const speed = Math.min(1, (Math.hypot(dx, dz) * 60) / 16); // 0..1 run factor
    if (Math.hypot(dx, dz) > 0.02) {
      const L = Math.hypot(dx, dz);
      this.face = { x: dx / L, z: dz / L };
    }
    const airborne = this.y > 0.4;
    const t = elapsed * (5 + speed * 7) + seed;

    if (airborne) {
      // Jump pose: arms up, legs tucked.
      this.armL.rotation.x += (-2.6 - this.armL.rotation.x) * 0.3;
      this.armR.rotation.x += (-2.6 - this.armR.rotation.x) * 0.3;
      this.legL.rotation.x += (0.8 - this.legL.rotation.x) * 0.3;
      this.legR.rotation.x += (0.8 - this.legR.rotation.x) * 0.3;
    } else if (speed > 0.06) {
      const amp = 0.4 + speed * 0.75;
      this.armL.rotation.x = Math.sin(t) * amp;
      this.armR.rotation.x = -Math.sin(t) * amp;
      this.legL.rotation.x = -Math.sin(t) * amp * 0.9;
      this.legR.rotation.x = Math.sin(t) * amp * 0.9;
    } else {
      // Idle: soft breathing sway.
      const sway = Math.sin(elapsed * 2 + seed) * 0.08;
      this.armL.rotation.x += (sway - this.armL.rotation.x) * 0.1;
      this.armR.rotation.x += (-sway - this.armR.rotation.x) * 0.1;
      this.legL.rotation.x += (0 - this.legL.rotation.x) * 0.1;
      this.legR.rotation.x += (0 - this.legR.rotation.x) * 0.1;
    }

    // Face the travel direction; run bounce + idle hover.
    const target = Math.atan2(this.face.x, this.face.z);
    let d = target - this.body.rotation.y;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    this.body.rotation.y += d * 0.25;
    this.body.position.y =
      this.baseBodyY + Math.abs(Math.sin(t)) * 0.3 * speed + Math.sin(elapsed * 3 + seed) * 0.12 * (1 - speed);
    this.headM.rotation.x = Math.sin(t * 0.5) * 0.05;
  }

  setArmedGlow(on: boolean) {
    if (this.glow) (this.glow.material as THREE.MeshBasicMaterial).opacity = on ? 0.7 : 0.3;
  }

  /** Tick down status-effect timers and reflect them on the figure. */
  tickEffects(dt: number) {
    this.freezeT = Math.max(0, this.freezeT - dt);
    this.speedT = Math.max(0, this.speedT - dt);
    this.shieldT = Math.max(0, this.shieldT - dt);
    this.invulnT = Math.max(0, this.invulnT - dt);
    this.cd = Math.max(0, this.cd - dt);
    const wasGiant = this.giantT > 0;
    this.giantT = Math.max(0, this.giantT - dt);
    const isGiant = this.giantT > 0;
    if (wasGiant !== isGiant) this.group.scale.setScalar(isGiant ? 1.35 : 1);
    if (this.torsoMat) {
      const base = new THREE.Color(this.hero.col);
      if (this.freezeT > 0) this.torsoMat.color.set(0x9ad8ff);
      else if (this.shieldT > 0) this.torsoMat.color.set(base).lerp(new THREE.Color(0xbfe8ff), 0.5);
      else this.torsoMat.color.set(base);
    }
  }
}

/** Standalone decoy sprite (Phantom Clone) — still uses the flat art. */
export function makeDecoySprite(hero: Hero): THREE.Sprite {
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: charTex(hero), transparent: true, opacity: 0.7 }));
  const h = HITBOX_RADIUS * 2.15;
  sp.scale.set(h * 0.82, h, 1);
  return sp;
}
