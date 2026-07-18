import * as THREE from 'three';
import type { Hero } from '../data/characters';
import { heroImg } from '../data/characters';
import { hasCharModel, makeCharInstance } from './char3d';
import { poseRig, type Rig, type AnimState } from './charanim';

// Identical hitboxes for every hero (SPEC section 3) — the disc radius does NOT
// scale with stats. Stats only change feel (speed/knockback), never reach.
export const HITBOX_RADIUS = 3.0;

const texCache: Record<string, THREE.Texture> = {};
const texLoaded: Record<string, boolean> = {};
const texWaiters: Record<string, (() => void)[]> = {};
function charTex(h: Hero): THREE.Texture {
  if (texCache[h.key]) return texCache[h.key];
  const t = new THREE.TextureLoader().load(heroImg(h), () => {
    texLoaded[h.key] = true;
    for (const cb of texWaiters[h.key] ?? []) cb();
    texWaiters[h.key] = [];
  });
  t.magFilter = THREE.LinearFilter;
  t.colorSpace = THREE.SRGBColorSpace;
  texCache[h.key] = t;
  return t;
}
/** Run cb once the hero's base texture has actually decoded (never before). */
function onCharTex(h: Hero, cb: () => void) {
  if (texLoaded[h.key]) cb();
  else (texWaiters[h.key] ??= []).push(cb);
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
  // Single-file build embeds the strips on window.__CHAR_ANIM. The ?v= busts
  // stale phone caches whenever the art generation changes.
  const inline = (globalThis as any).__CHAR_ANIM as Record<string, string> | undefined;
  const img = new Image();
  img.src = inline?.[hero.key] ?? animBase() + 'chars/anim/' + hero.key + '.png?v=3';
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
  shoesT = 0; // ⚡ speed-shoes perk: x2 speed while active
  giantT = 0;
  shieldT = 0;
  invulnT = 0;
  flinchT = 0; // snowball-hit reaction: brief stagger lean + red flash
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
  /** Hockey: mounted on a sliding ride — lock facing, no sideways run cycle. */
  riding = false;
  /** Musical Chairs: seated on a chair — play the sit pose, don't walk. */
  sitting = false;
  /** Musical Chairs: knocked flat by a HIT — lie on the floor, can't act. */
  fallen = false;
  /** Hot Potato: stand in place facing this heading (radians) instead of moving. */
  standFacing: number | null = null;

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
  // Real 3D model mode (public/models/<key>.glb). When active the 2D sprite /
  // frame / puppet path is bypassed entirely and the mesh is rotated to face
  // the way the hero moves (or, in hockey, across the rink at the opponent).
  private model3d: THREE.Group | null = null;
  private rig3d: Rig | null = null;
  private use3d = false;
  private faceAngle = 0; // smoothed Y rotation of the 3D model
  private bobPhase = 0;
  private stridePhase = 0; // locomotion phase for the skeletal walk/run cycle
  private animAmt = 0; // eased 0..1 blend so motion starts/stops smoothly
  /** Force a one-shot animation (celebration dance / wave) regardless of movement. */
  celebrate = false;

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

    // Player marker: a plain colored RING on the ground — the map shows
    // through the middle (no dark disc), per design feedback.
    this.ring = new THREE.Mesh(
      new THREE.TorusGeometry(r * 0.95, 0.3, 8, 28),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(this.hero.col).getHex() }),
    );
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.position.y = 0.22;
    grp.add(this.ring);

    // Soft halo just outside the ring; brightens while an ability is armed.
    this.glow = new THREE.Mesh(
      new THREE.RingGeometry(r * 1.05, r * 1.42, 28),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(this.hero.col).getHex(), transparent: true, opacity: 0.28, side: THREE.DoubleSide }),
    );
    this.glow.rotation.x = -Math.PI / 2;
    this.glow.position.y = 0.08;
    grp.add(this.glow);

    // Start as the plain full-art sprite; swap to the puppet when slices load.
    this.baseH = r * 2.15;
    const W = this.baseH * 0.82;
    const startSprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: charTex(this.hero), transparent: true, depthWrite: false }));
    startSprite.scale.set(W, this.baseH, 1);
    startSprite.position.y = this.baseH * 0.5 + 0.15;
    // Hide until the texture has decoded — an unloaded texture renders as an
    // opaque BLACK box, which is the "black square" characters at match start.
    // For heroes with a 3D model we keep it hidden entirely (the base webp has
    // a dark backdrop that reads as a black box); the ring marks the player
    // until the GLB loads a moment later.
    startSprite.visible = false;
    if (!hasCharModel(this.hero.key)) onCharTex(this.hero, () => { startSprite.visible = true; });
    grp.add(startSprite);
    this.sprite = startSprite;
    this.charGroup = new THREE.Group();
    grp.add(this.charGroup);

    // Prefer a REAL 3D model when the hero has one (public/models/<key>.glb):
    // it shows the back, has depth, and can turn to face the opponent. The
    // plain sprite stands in until it loads; on a miss we fall back to the 2D
    // animation frames / puppet.
    this.frameM = null;
    this.frameTex = null;
    this.frameIdx = -1;
    if (hasCharModel(this.hero.key)) {
      makeCharInstance(this.hero.key, this.baseH, (inst) => {
        if (!grp.parent) return;
        if (!inst) { this.load2D(grp, startSprite, W); return; } // model failed → 2D
        grp.remove(startSprite);
        this.model3d = inst.model;
        this.rig3d = inst.rig;
        this.use3d = true;
        this.charGroup.add(this.model3d);
        this.sprite = this.model3d as unknown as THREE.Object3D;
      });
    } else {
      this.load2D(grp, startSprite, W);
    }

    this.group = grp;
    scene.add(grp);
  }

  /** Load the 2D animation frames (or puppet fallback) onto the rider group. */
  private load2D(grp: THREE.Group, startSprite: THREE.Object3D, W: number) {
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
        this.frameM.position.y = 0.15;
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
      const bottom = 0.15;
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

    // --- REAL 3D model (GLB): rotate to face heading / opponent + procedural
    // liveliness (breathe, run-lean, jump). The mesh already stands feet-on-
    // ground, centred, at hero height. ---
    if (this.use3d && this.model3d) {
      // Which way should the hero look? Meshy builds the mesh facing +Z (out of
      // the screen, toward the iso camera) — that's our idle "face the player".
      let target = this.faceAngle;
      if (this.riding) {
        // Hockey: every rider looks straight ACROSS the rink at the opponent on
        // the opposite wall. You (bottom) face -z, so you see your hero's back;
        // the rider in front of you (top) faces you; the left and right riders
        // face each other. Lateral input then reads as sideways strafing.
        // (Meshy models face +z at rotation 0, so angle = atan2(dirX, dirZ).)
        target =
          this.side === 'top' ? 0 // faces +z (toward the bottom player / camera)
          : this.side === 'left' ? Math.PI / 2 // faces +x (toward the right wall)
          : this.side === 'right' ? -Math.PI / 2 // faces -x (toward the left wall)
          : Math.PI; // bottom: faces -z (back to the camera)
      } else if (this.standFacing != null) {
        target = this.standFacing; // fixed stand (hot potato): face the circle
      } else {
        // Face the way we move (velocity is the true heading; fall back to the
        // position delta). +Z is forward, so angle = atan2(x, z).
        const hx = Math.abs(this.vx) > 0.6 ? this.vx : dx * 60;
        const hz = Math.abs(this.vz) > 0.6 ? this.vz : dz * 60;
        if (Math.hypot(hx, hz) > 1.2) target = Math.atan2(hx, hz);
      }
      // Shortest-arc smoothing toward the target angle.
      let d = target - this.faceAngle;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      this.faceAngle += d * 0.25;
      this.model3d.rotation.y = this.faceAngle;

      if (this.wasAirborne && !airborne) this.landSquash = 1;
      this.wasAirborne = airborne;
      this.landSquash = Math.max(0, this.landSquash - 0.08);

      // --- skeletal animation --------------------------------------------------
      if (this.rig3d && this.fallen) {
        // Knocked flat: sprawl pose + tip the whole model onto its back, lowered
        // to the ground so it clearly reads as "fell down".
        poseRig(this.rig3d, 'fall', 0, elapsed + seed, 1);
        this.charGroup.position.y += (0 - this.charGroup.position.y) * 0.2;
        this.model3d.rotation.x += (-Math.PI / 2 - this.model3d.rotation.x) * 0.25;
        this.model3d.rotation.z += (0 - this.model3d.rotation.z) * 0.2;
        return;
      }
      if (this.rig3d && this.sitting) {
        // Seated: hold the sit pose (or a hands-only cheer when celebrating in a
        // kart), no bounce/lean.
        poseRig(this.rig3d, this.celebrate ? 'sitcheer' : 'sit', 0, elapsed + seed, 1);
        this.charGroup.position.y += (0 - this.charGroup.position.y) * 0.2;
        this.model3d.rotation.x += (0 - this.model3d.rotation.x) * 0.2;
        this.model3d.rotation.z += (0 - this.model3d.rotation.z) * 0.2;
        return;
      }
      if (this.rig3d) {
        const moving = !airborne && speed > 0.06 && !this.celebrate;
        this.animAmt += ((moving ? 1 : 0) - this.animAmt) * 0.2;
        let state: AnimState;
        if (this.celebrate) state = 'dance';
        else if (airborne) state = 'jump';
        else if (this.riding) state = moving ? 'sidewalk' : 'idle';
        else state = speed > 0.45 ? 'run' : moving ? 'walk' : 'idle';
        const loco = state === 'walk' || state === 'run' || state === 'sidewalk';
        if (loco) this.stridePhase += dist * (state === 'run' ? 0.55 : 0.95) + 0.015;
        poseRig(this.rig3d, state, this.stridePhase, elapsed + seed, loco ? this.animAmt : 1);
        this.charGroup.position.y += (0 - this.charGroup.position.y) * 0.2;
        this.model3d.rotation.x += (0 - this.model3d.rotation.x) * 0.2;
      } else {
        // No rig (unexpected): fall back to a whole-body bob + lean.
        this.bobPhase += 0.13 + speed * 0.32;
        if (airborne) {
          this.charGroup.position.y += (0.6 - this.charGroup.position.y) * 0.2;
          this.model3d.rotation.x += (-0.12 - this.model3d.rotation.x) * 0.2;
        } else if (speed > 0.05) {
          const bounce = Math.abs(Math.sin(this.bobPhase)) * (0.25 + speed * 0.45);
          this.charGroup.position.y += (bounce - this.charGroup.position.y) * 0.4;
          this.model3d.rotation.x += (-0.08 * speed - this.model3d.rotation.x) * 0.2;
        } else {
          const breathe = Math.sin(elapsed * 2.2 + seed) * 0.06;
          this.charGroup.position.y += (breathe - this.charGroup.position.y) * 0.15;
          this.model3d.rotation.x += (0 - this.model3d.rotation.x) * 0.1;
        }
      }
      // Flinch: quick recoil twist away from the hit (on the whole model).
      if (this.flinchT > 0) this.model3d.rotation.z = -this.facing * this.flinchT * 0.4 * Math.sin(this.flinchT * 18);
      else this.model3d.rotation.z += (0 - this.model3d.rotation.z) * 0.3;
      return;
    }

    // --- REAL frame animation (sliced from the hero's own sheet) ---
    if (this.frameM) {
      if (this.wasAirborne && !airborne) this.landSquash = 1;
      this.wasAirborne = airborne;
      this.landSquash = Math.max(0, this.landSquash - 0.08);
      if (this.riding) {
        // On the hockey ride: face the way you slide and WALK (never the fast
        // run cycle) — idle when still. (A true "face your opponent" back view
        // needs the 3D character art.)
        const headX = Math.abs(this.vx) > 0.6 ? this.vx : dx * 60;
        if (Math.abs(headX) > 1.0) this.facing = headX > 0 ? 1 : -1;
        this.frameM.scale.x += (this.facing - this.frameM.scale.x) * 0.4;
        this.frameM.rotation.z += (0 - this.frameM.rotation.z) * 0.2;
        if (speed > 0.05) {
          this.strideT += dist * 0.14;
          this.setFrame(WALK_F + (Math.floor(this.strideT * 8) % 8));
        } else {
          this.setFrame(IDLE_F);
        }
        this.frameM.scale.y += (1 - this.frameM.scale.y) * 0.2;
        return;
      }
      // Face the way we move (sheet faces right); keep facing when idle.
      // Use VELOCITY, not position deltas: online reconciliation nudges the
      // local player's rendered position backwards while running, which made
      // position-based facing point the wrong way. Velocity comes straight
      // from input prediction (local) / server state (remote), so its sign is
      // always the true heading. Fall back to deltas when velocity is unused
      // (hockey paddles move via pos).
      const headX = Math.abs(this.vx) > 0.6 ? this.vx : dx * 60;
      if (Math.abs(headX) > 1.2) this.facing = headX > 0 ? 1 : -1;
      this.frameM.scale.x += (this.facing - this.frameM.scale.x) * 0.5;
      // Hit reaction: stagger lean away + a quick head-back wobble.
      const flinchLean = this.flinchT > 0 ? -this.facing * this.flinchT * 1.1 * Math.abs(Math.sin(this.flinchT * 18)) * 0.55 - this.facing * this.flinchT * 0.35 : 0;
      this.frameM.rotation.z += (flinchLean - this.frameM.rotation.z) * 0.45;

      if (airborne) {
        this.setFrame(JUMP_F); // run "UP" pose reads as a jump
        this.frameM.scale.y += (1.04 - this.frameM.scale.y) * 0.2;
      } else if (speed > 0.05) {
        // Distance-driven stride so feet match the ground: ~1 full cycle
        // every ~6 world units, 8 frames per cycle. Anything beyond a stroll
        // uses the RUN cycle so slower heroes and easy bots still visibly run.
        this.strideT += dist * 0.17;
        const f = Math.floor(this.strideT * 8) % 8;
        this.setFrame((speed > 0.4 ? RUN_F : WALK_F) + f);
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

  // --- status icon (👟 ⚡ 🛡️ …) floating above the head while a perk is on ---
  private iconSprite: THREE.Sprite | null = null;
  private iconT = 0;

  setStatusIcon(label: string | null, seconds = 0) {
    if (this.iconSprite) {
      this.group.remove(this.iconSprite);
      (this.iconSprite.material as THREE.SpriteMaterial).map?.dispose();
      this.iconSprite = null;
    }
    this.iconT = 0;
    if (!label) return;
    // Emoji or short text ("🥇 5 hits"); font shrinks to fit.
    const c = document.createElement('canvas');
    c.width = 256;
    c.height = 80;
    const x = c.getContext('2d')!;
    let size = 56;
    x.font = `bold ${size}px Nunito, serif`;
    while (size > 22 && x.measureText(label).width > 240) {
      size -= 4;
      x.font = `bold ${size}px Nunito, serif`;
    }
    x.textAlign = 'center';
    x.textBaseline = 'middle';
    x.lineWidth = 6;
    x.strokeStyle = 'rgba(10,18,48,0.9)';
    x.strokeText(label, 128, 44);
    x.fillStyle = '#ffffff';
    x.fillText(label, 128, 44);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, depthWrite: false }));
    sp.scale.set(8, 2.5, 1);
    sp.position.y = this.baseH + 2.2;
    this.group.add(sp);
    this.iconSprite = sp;
    this.iconT = seconds;
  }

  setArmedGlow(on: boolean) {
    if (this.glow) (this.glow.material as THREE.MeshBasicMaterial).opacity = on ? 0.7 : 0.3;
  }

  /** Tick down status-effect timers and reflect them on the art. */
  tickEffects(dt: number) {
    if (this.iconSprite && this.iconT > 0) {
      this.iconT -= dt;
      this.iconSprite.position.y = this.baseH + 2.2 + Math.sin(performance.now() / 250) * 0.25;
      if (this.iconT <= 0) this.setStatusIcon(null);
    }
    this.freezeT = Math.max(0, this.freezeT - dt);
    if (this.freezeT <= 0) this.zapped = false;
    this.speedT = Math.max(0, this.speedT - dt);
    this.shoesT = Math.max(0, this.shoesT - dt);
    this.flinchT = Math.max(0, this.flinchT - dt);
    this.shieldT = Math.max(0, this.shieldT - dt);
    this.invulnT = Math.max(0, this.invulnT - dt);
    this.cd = Math.max(0, this.cd - dt);
    const wasGiant = this.giantT > 0;
    this.giantT = Math.max(0, this.giantT - dt);
    const isGiant = this.giantT > 0;
    if (wasGiant !== isGiant) this.group.scale.setScalar(isGiant ? 1.35 : 1);
    let tint = 0xffffff;
    if (this.zapped && this.freezeT > 0) tint = 0x141414; // blacked out by the zap
    else if (this.flinchT > 0) tint = 0xffb0a6; // hit! brief red flash
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
