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

// --- real animation frames ---------------------------------------------------
// Heroes with a sliced animation sheet (public/chars/anim/<key>.png) get REAL
// frame-by-frame walk/run animation from their own art. Strip layout:
// cell 0 = idle (front view), cells 1-8 = walk cycle, cells 9-16 = run cycle,
// all side view facing RIGHT. Square cells, feet on the cell floor.
export const ANIM_CELLS = 17;
const IDLE_F = 0, WALK_F = 1, RUN_F = 9, JUMP_F = 12; // run "UP" pose for air
const animCache: Record<string, THREE.Texture | null> = {};
const animWaiters: Record<string, ((t: THREE.Texture | null) => void)[]> = {};

function animBase(): string {
  // Respect Vite's base path (game is served from a sub-path on Pages).
  return (import.meta as any).env?.BASE_URL ?? './';
}

function loadAnim(hero: Hero, onReady: (t: THREE.Texture | null) => void) {
  if (hero.key in animCache) return onReady(animCache[hero.key]);
  if (animWaiters[hero.key]) return void animWaiters[hero.key].push(onReady);
  animWaiters[hero.key] = [onReady];
  const done = (t: THREE.Texture | null) => {
    animCache[hero.key] = t;
    for (const cb of animWaiters[hero.key] ?? []) cb(t);
    delete animWaiters[hero.key];
  };
  // Single-file build embeds the strips on window.__CHAR_ANIM.
  const inline = (globalThis as any).__CHAR_ANIM as Record<string, string> | undefined;
  const img = new Image();
  img.src = inline?.[hero.key] ?? animBase() + 'chars/anim/' + hero.key + '.png';
  img.onload = () => {
    const t = new THREE.Texture(img);
    t.colorSpace = THREE.SRGBColorSpace;
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearFilter;
    t.generateMipmaps = false;
    t.needsUpdate = true;
    done(t);
  };
  img.onerror = () => done(null); // no sheet for this hero (yet) → puppet
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
  sprite!: THREE.Object3D; // torso piece (kept as `sprite` for compatibility)
  ring!: THREE.Mesh;
  glow!: THREE.Mesh;
  private charGroup = new THREE.Group();
  private pieceMats: THREE.MeshBasicMaterial[] = [];
  private torsoM: THREE.Mesh | null = null;
  private legLM: THREE.Mesh | null = null;
  private legRM: THREE.Mesh | null = null;
  private armLM: THREE.Mesh | null = null;
  private armRM: THREE.Mesh | null = null;
  private legY = 0;
  private armY = 0;
  private torsoY = 0;
  private baseH = 0;
  private px = 0;
  private pz = 0;
  private wasAirborne = false;
  private landSquash = 0;
  // Frame-animation mode (real sliced walk/run frames from the hero's sheet).
  private frameM: THREE.Mesh | null = null;
  private frameTex: THREE.Texture | null = null;
  private frameIdx = -1;
  private strideT = 0;
  private facing = 1; // 1 = right (sheet frames face right)

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
    const startSprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: charTex(this.hero), transparent: true, depthWrite: false }));
    startSprite.scale.set(W, this.baseH, 1);
    startSprite.position.y = this.baseH * 0.5 + 0.6;
    grp.add(startSprite);
    this.sprite = startSprite;
    this.charGroup = new THREE.Group();
    grp.add(this.charGroup);

    // Prefer REAL animation frames when the hero has a sliced sheet; puppet
    // otherwise. The plain sprite stands in while either loads.
    this.frameM = null;
    this.frameTex = null;
    this.frameIdx = -1;
    loadAnim(this.hero, (sheet) => {
      if (!grp.parent) return;
      if (sheet) {
        grp.remove(startSprite);
        const H = this.baseH * 1.06;
        const geo = new THREE.PlaneGeometry(H, H); // square cells
        geo.translate(0, H / 2, 0);
        this.frameTex = sheet.clone();
        this.frameTex.needsUpdate = true;
        this.frameTex.repeat.set(1 / ANIM_CELLS, 1);
        const mat = new THREE.MeshBasicMaterial({ map: this.frameTex, transparent: true, depthWrite: false, side: THREE.DoubleSide });
        this.pieceMats = [mat];
        this.frameM = new THREE.Mesh(geo, mat);
        this.frameM.position.y = 0.6;
        this.frameM.renderOrder = 2;
        this.charGroup.add(this.frameM);
        this.sprite = this.frameM;
        this.setFrame(IDLE_F);
        return;
      }
      loadPuppetOnto();
    });

    const loadPuppetOnto = () => loadPuppet(this.hero, (tex) => {
      if (!grp.parent || this.frameM) return; // rider torn down / frames won
      grp.remove(startSprite);
      const H = this.baseH;
      const bottom = 0.6;
      const legH = H * 0.34;
      const hipY = bottom + legH;
      this.pieceMats = [];
      // Plane pieces, pivoted at their joints (geometry shifted so rotation
      // swings around hip/shoulder). The iso camera is fixed, so planes
      // facing +z read exactly like the old billboard — but they can STEP.
      const mk = (map: THREE.CanvasTexture, w: number, h: number, pivot: 'top' | 'bottom', x: number, y: number, order: number) => {
        const geo = new THREE.PlaneGeometry(w, h);
        geo.translate(0, pivot === 'top' ? -h / 2 : h / 2, 0);
        const mat = new THREE.MeshBasicMaterial({ map, transparent: true, depthWrite: false, side: THREE.DoubleSide });
        this.pieceMats.push(mat);
        const m = new THREE.Mesh(geo, mat);
        m.position.set(x, y, 0);
        m.renderOrder = order;
        this.charGroup.add(m);
        return m;
      };
      this.legLM = mk(tex.legL, W * 0.38, legH, 'top', -W * 0.09, hipY, 1);
      this.legRM = mk(tex.legR, W * 0.38, legH, 'top', W * 0.09, hipY, 1);
      this.torsoM = mk(tex.torso, W, H * 0.74, 'bottom', 0, hipY - H * 0.08, 2);
      const shoulderY = hipY - H * 0.08 + H * 0.74 * 0.72;
      this.armLM = mk(tex.armL, W * 0.24, H * 0.44, 'top', -W * 0.33, shoulderY, 3);
      this.armRM = mk(tex.armR, W * 0.24, H * 0.44, 'top', W * 0.33, shoulderY, 3);
      this.armLM.position.z = 0.05;
      this.armRM.position.z = 0.05;
      this.legY = hipY;
      this.armY = shoulderY;
      this.torsoY = hipY - H * 0.08;
      this.sprite = this.torsoM;
    });

    this.group = grp;
    scene.add(grp);
  }

  /**
   * TRUE step cycle on the original art: legs alternately LIFT like real
   * steps (with a small knee-bend shortening), arms counter-pump up and
   * down, the body bounces on each footfall, pitches slightly forward and
   * sways — pieces tuck mid-air, soft squash on landing. Planted foot never
   * leaves the ground, so the base stays rock steady.
   */
  bob(elapsed: number, seed: number) {
    const dx = this.x - this.px;
    const dz = this.z - this.pz;
    this.px = this.x;
    this.pz = this.z;
    const dist = Math.hypot(dx, dz);
    const speed = Math.min(1, (dist * 60) / 16);
    const airborne = this.y > 0.4;

    // --- REAL frame animation (sliced from the hero's own sheet) ---
    if (this.frameM) {
      if (this.wasAirborne && !airborne) this.landSquash = 1;
      this.wasAirborne = airborne;
      this.landSquash = Math.max(0, this.landSquash - 0.08);
      // Face the way we move (sheet faces right); keep facing when idle.
      if (Math.abs(dx) * 60 > 1.2) this.facing = dx > 0 ? 1 : -1;
      this.frameM.scale.x += (this.facing - this.frameM.scale.x) * 0.5;

      if (airborne) {
        this.setFrame(JUMP_F); // run "UP" pose reads as a jump
        this.frameM.scale.y += (1.04 - this.frameM.scale.y) * 0.2;
      } else if (speed > 0.05) {
        // Distance-driven stride so feet match the ground: ~1 full cycle
        // every ~6 world units, 8 frames per cycle. Walk under ~55% speed,
        // run above it.
        this.strideT += dist * 0.17;
        const f = Math.floor(this.strideT * 8) % 8;
        this.setFrame((speed > 0.55 ? RUN_F : WALK_F) + f);
        this.frameM.scale.y += (1 - this.landSquash * 0.12 - this.frameM.scale.y) * 0.35;
      } else {
        this.setFrame(IDLE_F);
        // Idle breathing on the real front pose.
        const breathe = Math.sin(elapsed * 2.2 + seed);
        this.frameM.scale.y += (1 + breathe * 0.015 - this.landSquash * 0.12 - this.frameM.scale.y) * 0.15;
      }
      return;
    }

    if (!this.torsoM || !this.legLM || !this.legRM || !this.armLM || !this.armRM) return;

    if (this.wasAirborne && !airborne) this.landSquash = 1;
    this.wasAirborne = airborne;
    this.landSquash = Math.max(0, this.landSquash - 0.1);

    const t = elapsed * (5 + speed * 6) + seed;
    const phase = Math.sin(t); // +1 left step apex, -1 right step apex
    const ease = (o: THREE.Object3D, px2: number, py: number, rz: number, k = 0.35) => {
      o.position.y += (py - o.position.y) * k;
      o.position.x += (px2 - o.position.x) * k;
      o.rotation.z += (rz - o.rotation.z) * k;
    };
    const W = this.baseH * 0.82;
    const lean = Math.max(-0.12, Math.min(0.12, -dx * 60 * 0.008 * speed));

    if (airborne) {
      // Tuck: both legs pulled up, arms thrown up.
      ease(this.legLM, -W * 0.09, this.legY + 0.7, 0.25);
      ease(this.legRM, W * 0.09, this.legY + 0.7, -0.25);
      ease(this.armLM, -W * 0.33, this.armY + 0.35, 0.9);
      ease(this.armRM, W * 0.33, this.armY + 0.35, -0.9);
      ease(this.torsoM, 0, this.torsoY + 0.4, lean);
      this.charGroup.rotation.y += (Math.sin(elapsed * 7 + seed) * 0.08 - this.charGroup.rotation.y) * 0.2;
    } else if (speed > 0.05) {
      const lift = 0.55 + speed * 0.5;
      const stepL = Math.max(0, phase); // left foot in the air
      const stepR = Math.max(0, -phase);
      // Legs: lift + slight knee swing; the grounded leg stays planted.
      ease(this.legLM, -W * 0.09, this.legY + stepL * lift, phase * 0.1, 0.5);
      ease(this.legRM, W * 0.09, this.legY + stepR * lift, -phase * 0.1, 0.5);
      // Knee-bend illusion: the lifted leg shortens a touch.
      this.legLM.scale.y = 1 - stepL * 0.22;
      this.legRM.scale.y = 1 - stepR * 0.22;
      // Arms: pump opposite to legs (right arm forward with left foot).
      ease(this.armLM, -W * 0.33, this.armY + stepR * 0.3, -phase * 0.5, 0.5);
      ease(this.armRM, W * 0.33, this.armY + stepL * 0.3, phase * 0.5, 0.5);
      // Body: footfall bounce (two beats per cycle), forward pitch + sway.
      const bounce = Math.abs(Math.cos(t)) * (0.35 + speed * 0.3);
      ease(this.torsoM, phase * W * 0.02, this.torsoY + bounce, lean + phase * 0.05, 0.5);
      this.charGroup.rotation.x += (-0.06 * speed - this.charGroup.rotation.x) * 0.2;
      this.charGroup.rotation.y += (phase * 0.09 * speed - this.charGroup.rotation.y) * 0.3;
    } else {
      // Idle: settle; gentle breathing (torso rises/falls), arms relax.
      const breathe = Math.sin(elapsed * 2.2 + seed);
      ease(this.legLM, -W * 0.09, this.legY, 0, 0.15);
      ease(this.legRM, W * 0.09, this.legY, 0, 0.15);
      this.legLM.scale.y += (1 - this.legLM.scale.y) * 0.15;
      this.legRM.scale.y += (1 - this.legRM.scale.y) * 0.15;
      ease(this.armLM, -W * 0.33, this.armY + breathe * 0.06, breathe * 0.05, 0.15);
      ease(this.armRM, W * 0.33, this.armY + breathe * 0.06, -breathe * 0.05, 0.15);
      ease(this.torsoM, 0, this.torsoY + breathe * 0.08, 0, 0.15);
      this.charGroup.rotation.x += (0 - this.charGroup.rotation.x) * 0.1;
      this.charGroup.rotation.y += (0 - this.charGroup.rotation.y) * 0.1;
    }

    // Landing squash on the torso only (bottom-anchored, feet untouched).
    this.torsoM.scale.y = (1 - this.landSquash * 0.12) * this.torsoM.scale.y + this.landSquash * 0; // keep simple
    if (this.landSquash <= 0) this.torsoM.scale.y += (1 - this.torsoM.scale.y) * 0.2;
  }

  private setFrame(i: number) {
    if (i === this.frameIdx || !this.frameTex) return;
    this.frameIdx = i;
    this.frameTex.offset.x = i / ANIM_CELLS;
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
    for (const m of this.pieceMats) {
      m.color.setHex(tint);
      m.opacity = opacity;
    }
    if (this.sprite instanceof THREE.Sprite) {
      const m = this.sprite.material as THREE.SpriteMaterial;
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
