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

// --- 2D puppet slices --------------------------------------------------------
// The character art is cut into body / legs / arms pieces so the ORIGINAL art
// walks: legs scissor, arms swing, torso leans — like a paper puppet. Slices
// are fractions of the source image and cached per hero.

interface PuppetTex {
  torso: THREE.CanvasTexture;
  legL: THREE.CanvasTexture;
  legR: THREE.CanvasTexture;
  armL: THREE.CanvasTexture;
  armR: THREE.CanvasTexture;
}
const puppetCache: Record<string, PuppetTex> = {};
const puppetWaiters: Record<string, ((p: PuppetTex) => void)[]> = {};

function slice(img: HTMLImageElement, x0: number, y0: number, x1: number, y1: number): THREE.CanvasTexture {
  const w = Math.max(2, Math.round(img.width * (x1 - x0)));
  const h = Math.max(2, Math.round(img.height * (y1 - y0)));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  c.getContext('2d')!.drawImage(img, img.width * x0, img.height * y0, w, h, 0, 0, w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.magFilter = THREE.LinearFilter;
  return t;
}

function loadPuppet(hero: Hero, onReady: (p: PuppetTex) => void) {
  const cached = puppetCache[hero.key];
  if (cached) return onReady(cached);
  if (puppetWaiters[hero.key]) return void puppetWaiters[hero.key].push(onReady);
  puppetWaiters[hero.key] = [onReady];
  const img = new Image();
  img.src = heroImg(hero);
  img.onload = () => {
    const p: PuppetTex = {
      torso: slice(img, 0, 0, 1, 0.74), // head + body
      legL: slice(img, 0.14, 0.66, 0.52, 1), // lower left
      legR: slice(img, 0.48, 0.66, 0.86, 1), // lower right
      armL: slice(img, 0, 0.3, 0.24, 0.74), // left side
      armR: slice(img, 0.76, 0.3, 1, 0.74), // right side
    };
    puppetCache[hero.key] = p;
    for (const cb of puppetWaiters[hero.key] ?? []) cb(p);
    delete puppetWaiters[hero.key];
  };
}

export type Team = 0 | 1;

// A hero riding a hover disc. The character is the player's OWN ART, animated
// as a 2D puppet: the image is split into torso, legs and arms; legs scissor
// and arms swing while running, the torso leans into turns, everything tucks
// on jumps. Feet stay anchored to the disc so nothing jitters at the bottom.
export class Player {
  hero: Hero;
  you: boolean;
  team: Team;
  index: number;

  x = 0;
  z = 0;
  vx = 0;
  vz = 0;
  y = 0;
  vy = 0;
  face = { x: 0, z: -1 };

  dead = false;

  pts = 0;
  hp = 100;
  lives = 3;
  score = 0;

  cd = 0;
  armed = false;

  grounded = true;
  airJumps = 0;
  dashCd = 0;
  diveT = 0;

  freezeT = 0;
  speedT = 0;
  giantT = 0;
  shieldT = 0;
  invulnT = 0;
  held = false;
  zapped = false;

  wp = 0;
  lap = 0;

  retarget = 0;
  want = 0.5;
  tx = 0;
  tz = 0;
  tw: { x: number; z: number } | null = null;

  pos = 0.5;
  side: 'bottom' | 'top' | 'left' | 'right' = 'bottom';

  // Three.js
  group = new THREE.Group();
  sprite!: THREE.Sprite; // torso piece (kept as `sprite` for compatibility)
  ring!: THREE.Mesh;
  glow!: THREE.Mesh;
  private pieces: THREE.Sprite[] = [];
  private legLS: THREE.Sprite | null = null;
  private legRS: THREE.Sprite | null = null;
  private armLS: THREE.Sprite | null = null;
  private armRS: THREE.Sprite | null = null;
  private baseH = 0;
  private px = 0;
  private pz = 0;
  private wasAirborne = false;
  private landSquash = 0;

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

    // Start as the plain full-art sprite; swap to the puppet when slices load.
    this.baseH = r * 2.15;
    const W = this.baseH * 0.82;
    this.sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: charTex(this.hero), transparent: true, depthWrite: false }));
    this.sprite.scale.set(W, this.baseH, 1);
    this.sprite.position.y = this.baseH * 0.5 + 0.6;
    grp.add(this.sprite);
    this.pieces = [this.sprite];

    loadPuppet(this.hero, (tex) => {
      if (!grp.parent) return; // rider was torn down before art loaded
      grp.remove(this.sprite);
      const H = this.baseH;
      const bottom = 0.6;
      const legH = H * 0.34;
      const hipY = bottom + legH;
      const mk = (map: THREE.CanvasTexture, w: number, h: number, cx: number, cy: number, x: number, y: number, order: number) => {
        const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map, transparent: true, depthWrite: false }));
        sp.scale.set(w, h, 1);
        sp.center.set(cx, cy);
        sp.position.set(x, y, 0);
        sp.renderOrder = order;
        grp.add(sp);
        return sp;
      };
      // Legs: anchored at the hip (top of the slice), swing like scissors.
      this.legLS = mk(tex.legL, W * 0.38, legH, 0.5, 1, -W * 0.09, hipY, 1);
      this.legRS = mk(tex.legR, W * 0.38, legH, 0.5, 1, W * 0.09, hipY, 1);
      // Torso: anchored at its bottom just below the hip (hides the seam).
      this.sprite = mk(tex.torso, W, H * 0.74, 0.5, 0, 0, hipY - H * 0.08, 2);
      // Arms: anchored at the shoulders, drawn in front.
      const shoulderY = hipY - H * 0.08 + H * 0.74 * 0.72;
      this.armLS = mk(tex.armL, W * 0.24, H * 0.44, 0.5, 1, -W * 0.33, shoulderY, 3);
      this.armRS = mk(tex.armR, W * 0.24, H * 0.44, 0.5, 1, W * 0.33, shoulderY, 3);
      this.pieces = [this.sprite, this.legLS, this.legRS, this.armLS, this.armRS];
    });

    this.group = grp;
    scene.add(grp);
  }

  /**
   * Walk cycle on the original art: legs scissor and arms counter-swing with
   * speed, torso leans into sideways motion, pieces tuck mid-air, soft squash
   * on landing. Feet stay planted — no bottom jitter.
   */
  bob(elapsed: number, seed: number) {
    if (!this.sprite) return;
    const dx = this.x - this.px;
    const dz = this.z - this.pz;
    this.px = this.x;
    this.pz = this.z;
    const speed = Math.min(1, (Math.hypot(dx, dz) * 60) / 16);
    const airborne = this.y > 0.4;
    const t = elapsed * (4.5 + speed * 4.5) + seed;
    const swing = Math.sin(t);

    if (this.wasAirborne && !airborne) this.landSquash = 1;
    this.wasAirborne = airborne;
    this.landSquash = Math.max(0, this.landSquash - 0.1);

    const rot = (sp: THREE.Sprite | null, target: number, snap = 0.3) => {
      if (!sp) return;
      const m = sp.material as THREE.SpriteMaterial;
      m.rotation += (target - m.rotation) * snap;
    };

    const lean = Math.max(-0.14, Math.min(0.14, -dx * 60 * 0.01 * speed));
    if (airborne) {
      // Tucked jump: legs together and back, arms raised outward.
      rot(this.legLS, 0.45);
      rot(this.legRS, -0.45);
      rot(this.armLS, 1.0);
      rot(this.armRS, -1.0);
      rot(this.sprite, lean + Math.sin(elapsed * 6 + seed) * 0.06);
    } else if (speed > 0.05) {
      const amp = 0.32 + speed * 0.3;
      rot(this.legLS, swing * amp, 0.5);
      rot(this.legRS, -swing * amp, 0.5);
      rot(this.armLS, -swing * amp * 1.15, 0.5);
      rot(this.armRS, swing * amp * 1.15, 0.5);
      rot(this.sprite, lean + swing * 0.045 * speed);
    } else {
      // Idle: everything settles; gentle breathing on the torso only.
      rot(this.legLS, 0, 0.12);
      rot(this.legRS, 0, 0.12);
      rot(this.armLS, Math.sin(elapsed * 2 + seed) * 0.06, 0.12);
      rot(this.armRS, -Math.sin(elapsed * 2 + seed) * 0.06, 0.12);
      rot(this.sprite, 0, 0.12);
    }

    // Breathing/landing on the torso scale (bottom-anchored: grows upward,
    // so the feet and the seam stay perfectly still).
    if (this.pieces.length > 1) {
      const breathe = 1 + Math.sin(elapsed * 2.4 + seed) * 0.015 * (1 - speed);
      const squash = 1 - this.landSquash * 0.1;
      this.sprite.scale.y = this.baseH * 0.74 * breathe * squash;
    }
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
    let tint = 0xffffff;
    if (this.zapped && this.freezeT > 0) tint = 0x141414; // blacked out by the zap
    else if (this.freezeT > 0) tint = 0x88ccff;
    else if (this.shieldT > 0) tint = 0xbfe8ff;
    const opacity = this.invulnT > 0 ? 0.55 : 1;
    for (const sp of this.pieces) {
      const m = sp.material as THREE.SpriteMaterial;
      m.color.setHex(tint);
      m.opacity = opacity;
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
