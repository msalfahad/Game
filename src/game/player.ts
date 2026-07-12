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

// A player is a hero riding a hover disc. `you` marks the local human; bots
// carry AI scratch state (retarget timer, current target).
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
  airJumps = 0; // remaining mid-air jumps (double jump)
  dashCd = 0;
  diveT = 0; // >0 while diving; landing incurs a short recovery

  // AI scratch.
  retarget = 0;
  want = 0.5;
  tx = 0;
  tz = 0;

  // Frostbite hockey: parametric edge position 0..1 along the player's wall.
  pos = 0.5;
  side: 'bottom' | 'top' | 'left' | 'right' = 'bottom';

  // Three.js
  group = new THREE.Group();
  sprite!: THREE.Sprite;
  ring!: THREE.Mesh;
  glow!: THREE.Mesh;

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
    const h = r * 2.15;
    this.sprite.scale.set(h * 0.82, h, 1);
    this.sprite.position.y = h * 0.5 + 0.6;
    grp.add(this.sprite);

    this.group = grp;
    scene.add(grp);
  }

  /** Bob the sprite for a subtle hover feel. */
  bob(elapsed: number, seed: number) {
    if (this.sprite) this.sprite.position.y = HITBOX_RADIUS * 1.05 + 0.6 + Math.sin(elapsed * 3 + seed) * 0.4;
  }

  setArmedGlow(on: boolean) {
    if (this.glow) (this.glow.material as THREE.MeshBasicMaterial).opacity = on ? 0.7 : 0.3;
  }
}
