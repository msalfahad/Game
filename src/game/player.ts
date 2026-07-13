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

export type Team = 0 | 1;

// A hero riding a hover disc. The character is the player's own art (billboard
// sprite) brought to life procedurally: it hops when running, leans into
// turns, stretches on jumps, squashes on landing, and tints when zapped,
// frozen or shielded. (True rigged 3D versions of the art come later via
// image-to-3D per the spec; this keeps the characters exactly as drawn.)
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
  zapped = false; // thunder-box stun: character shows blacked-out while frozen

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
  sprite!: THREE.Sprite;
  ring!: THREE.Mesh;
  glow!: THREE.Mesh;
  private baseH = 0;
  private px = 0;
  private pz = 0;
  private wasAirborne = false;
  private landSquash = 0;

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

    const disc = new THREE.Mesh(
      new THREE.CylinderGeometry(r, r * 1.1, 1.1, 20),
      new THREE.MeshStandardMaterial({ color: 0x232a4a, roughness: 0.5, metalness: 0.4 }),
    );
    disc.castShadow = true;
    grp.add(disc);

    this.ring = new THREE.Mesh(
      new THREE.TorusGeometry(r * 0.95, 0.28, 8, 24),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(this.hero.col).getHex() }),
    );
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.position.y = 0.6;
    grp.add(this.ring);

    this.glow = new THREE.Mesh(
      new THREE.CircleGeometry(r * 1.2, 20),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(this.hero.col).getHex(), transparent: true, opacity: 0.3 }),
    );
    this.glow.rotation.x = -Math.PI / 2;
    this.glow.position.y = 0.05;
    grp.add(this.glow);

    this.sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: charTex(this.hero), transparent: true }));
    this.baseH = r * 2.15;
    this.sprite.scale.set(this.baseH * 0.82, this.baseH, 1);
    this.sprite.position.y = this.baseH * 0.5 + 0.6;
    grp.add(this.sprite);

    this.group = grp;
    scene.add(grp);
  }

  /**
   * Bring the art to life: hop cycle while running, lean into sideways
   * motion, stretch going up / squash on landing, spin-wobble in the air.
   * Velocity is derived from position deltas so it works for predicted,
   * simulated and interpolated players alike.
   */
  bob(elapsed: number, seed: number) {
    if (!this.sprite) return;
    const dx = this.x - this.px;
    const dz = this.z - this.pz;
    this.px = this.x;
    this.pz = this.z;
    const speed = Math.min(1, (Math.hypot(dx, dz) * 60) / 16); // 0..1 run factor
    const airborne = this.y > 0.4;
    const mat = this.sprite.material as THREE.SpriteMaterial;
    const t = elapsed * (6 + speed * 8) + seed;

    // Landing squash trigger.
    if (this.wasAirborne && !airborne) this.landSquash = 1;
    this.wasAirborne = airborne;
    this.landSquash = Math.max(0, this.landSquash - 0.12);

    // Scale: stretch while rising, squash on landing, bouncy breathing idle.
    let sy = 1;
    let sx = 1;
    if (airborne) {
      sy = this.vy > 0 ? 1.1 : 1.04;
      sx = 0.94;
    } else if (this.landSquash > 0) {
      sy = 1 - this.landSquash * 0.18;
      sx = 1 + this.landSquash * 0.14;
    } else {
      const breathe = Math.sin(elapsed * 2.4 + seed) * 0.02;
      sy = 1 + breathe + Math.abs(Math.sin(t)) * 0.06 * speed;
      sx = 1 - breathe * 0.6;
    }
    this.sprite.scale.set(this.baseH * 0.82 * sx, this.baseH * sy, 1);

    // Lean into sideways travel; wobble mid-air.
    const targetTilt = airborne ? Math.sin(elapsed * 9 + seed) * 0.12 : -dx * 60 * 0.012 * speed;
    mat.rotation += (Math.max(-0.22, Math.min(0.22, targetTilt)) - mat.rotation) * 0.25;

    // Hop while running + hover idle.
    this.sprite.position.y =
      this.baseH * 0.5 + 0.6 + Math.abs(Math.sin(t)) * 0.9 * speed + Math.sin(elapsed * 3 + seed) * 0.25 * (1 - speed);
  }

  setArmedGlow(on: boolean) {
    if (this.glow) (this.glow.material as THREE.MeshBasicMaterial).opacity = on ? 0.7 : 0.3;
  }

  /** Tick down status-effect timers and reflect them on the art. */
  tickEffects(dt: number) {
    this.freezeT = Math.max(0, this.freezeT - dt);
    if (this.freezeT <= 0) this.zapped = false;
    this.speedT = Math.max(0, this.speedT - dt);
    this.shieldT = Math.max(0, this.shieldT - dt);
    this.invulnT = Math.max(0, this.invulnT - dt);
    this.cd = Math.max(0, this.cd - dt);
    const wasGiant = this.giantT > 0;
    this.giantT = Math.max(0, this.giantT - dt);
    const isGiant = this.giantT > 0;
    if (wasGiant !== isGiant) this.group.scale.setScalar(isGiant ? 1.35 : 1);
    if (this.sprite) {
      const mat = this.sprite.material as THREE.SpriteMaterial;
      if (this.zapped && this.freezeT > 0) mat.color.setHex(0x141414); // blacked out by the zap
      else if (this.freezeT > 0) mat.color.setHex(0x88ccff);
      else if (this.shieldT > 0) mat.color.setHex(0xbfe8ff);
      else mat.color.setHex(0xffffff);
      mat.opacity = this.invulnT > 0 ? 0.55 : 1;
    }
  }
}

/** Standalone decoy sprite (Phantom Clone). */
export function makeDecoySprite(hero: Hero): THREE.Sprite {
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: charTex(hero), transparent: true, opacity: 0.7 }));
  const h = HITBOX_RADIUS * 2.15;
  sp.scale.set(h * 0.82, h, 1);
  return sp;
}
