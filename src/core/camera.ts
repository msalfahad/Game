import * as THREE from 'three';

// Locked camera behaviour from the prototype (SPEC section 10):
// ~35deg isometric feel via a perspective cam pulled back and up, aspect-aware
// dynamic zoom so the whole arena + all players fit on any screen (portrait
// phones pull back further), and an accessibility camera-shake slider.

export class IsoCamera {
  readonly cam: THREE.PerspectiveCamera;
  private base = new THREE.Vector3();
  private look = new THREE.Vector3(0, -2, 0);
  private shakeT = 0;
  private shakeScale = 0; // default OFF (user request); slider re-enables it
  private halfSize = 30;
  private zoom = 1;
  private followZ = 0;
  private topDown = false;
  private chasing = false;
  private arena = false;
  private arenaHalfW = 20;
  private arenaHalfL = 24;

  constructor() {
    this.cam = new THREE.PerspectiveCamera(52, innerWidth / innerHeight, 0.1, 600);
  }

  /**
   * Frame the arena. `halfSize` is the arena half-extent in world units;
   * `zoom` > 1 pulls in tighter (used for the small hockey rink).
   */
  frame(halfSize: number, zoom = 1) {
    this.halfSize = halfSize;
    this.zoom = zoom;
    const aspect = innerWidth / innerHeight;
    this.cam.fov = 56;
    this.cam.aspect = aspect;
    this.cam.updateProjectionMatrix();

    // Portrait screens need extra pullback to keep all four corners visible;
    // very wide (landscape phone) screens come in closer so the arena fills
    // the view instead of floating in empty sky.
    const portrait = Math.max(1, 0.6 / aspect);
    const wide = aspect > 1.8 ? 1 / 1.14 : 1;
    const dist = halfSize * 2.25 * portrait * zoom * wide;
    const height = halfSize * 1.5 * portrait * zoom * wide;
    this.base.set(0, height, dist);
    this.look.set(0, -2, -halfSize * 0.06);
    this.topDown = false;
    this.chasing = false;
    this.arena = false;
    this.followZ = 0;
    this.applyBase();
  }

  /**
   * Third-person chase view sitting BEHIND a moving target (the boat race),
   * looking a little ahead of it. `heading` is the target's facing (model faces
   * +z at 0, so forward = (sin h, cos h)). The rig eases toward the ideal spot
   * each frame so bends feel smooth, and it composes with `tickShake` because it
   * writes `base`/`look` just like the fixed framings do.
   */
  chaseBehind(tx: number, ty: number, tz: number, heading: number, dist = 13, height = 7.5) {
    const aspect = innerWidth / innerHeight;
    this.cam.fov = 62;
    this.cam.aspect = aspect;
    this.cam.updateProjectionMatrix();
    const fx = Math.sin(heading), fz = Math.cos(heading);
    const dx = tx - fx * dist, dy = ty + height, dz = tz - fz * dist;
    if (!this.chasing) {
      this.chasing = true;
      this.base.set(dx, dy, dz);
    } else {
      this.base.x += (dx - this.base.x) * 0.18;
      this.base.y += (dy - this.base.y) * 0.18;
      this.base.z += (dz - this.base.z) * 0.18;
    }
    this.look.set(tx + fx * 5, ty + 1.6, tz + fz * 5);
    this.topDown = false;
    this.arena = false;
    this.followZ = 0;
    this.applyBase();
  }

  /**
   * Steep near-overhead view (chase games) so the whole map reads at a glance
   * while the 3D heroes stay recognisable — a high angle, not a flat top-down.
   */
  frameTopDown(halfSize: number) {
    this.halfSize = halfSize;
    this.zoom = 1;
    const aspect = innerWidth / innerHeight;
    this.cam.fov = 52;
    this.cam.aspect = aspect;
    this.cam.updateProjectionMatrix();
    const portrait = Math.max(1, 0.66 / aspect);
    this.base.set(0, halfSize * 3.0 * portrait, halfSize * 1.02 * portrait);
    this.look.set(0, 0, 0);
    this.topDown = true;
    this.chasing = false;
    this.arena = false;
    this.followZ = 0;
    this.applyBase();
  }

  /**
   * Fit a rectangle (half-width in x, half-length in z) tightly to the screen
   * from a steep top-down-ish angle — used by Foot Brawl so the whole PITCH
   * fills the view (both goals on-screen in portrait) with no wasted margin.
   * Recomputes the height so both dimensions fit whatever the aspect ratio is.
   */
  frameArena(halfW: number, halfL: number) {
    this.arenaHalfW = halfW;
    this.arenaHalfL = halfL;
    const aspect = innerWidth / innerHeight;
    this.cam.fov = 46;
    this.cam.aspect = aspect;
    this.cam.updateProjectionMatrix();
    const tan = Math.tan((46 * Math.PI) / 180 / 2);
    const margin = 1.05;
    // Height needed for the width to fit (÷aspect for the horizontal FOV) and
    // for the length to fit; take the larger so nothing is cropped. The slight
    // z-tilt eats a little length headroom, so pad the length term.
    const hForWidth = (halfW * margin) / (tan * aspect);
    const hForLen = (halfL * margin * 1.08) / tan;
    const H = Math.max(hForWidth, hForLen);
    this.base.set(0, H, H * 0.24);
    this.look.set(0, 0, 0);
    this.topDown = false;
    this.chasing = false;
    this.arena = true;
    this.followZ = 0;
    this.applyBase();
  }

  private applyBase() {
    this.cam.position.set(this.base.x, this.base.y, this.base.z + this.followZ);
    this.cam.lookAt(this.look.x, this.look.y, this.look.z + this.followZ);
  }

  /** Track a world-z (the climb camera follows the local hero up the slope). */
  follow(z: number, minZ: number, maxZ: number) {
    const target = Math.max(minZ, Math.min(maxZ, z));
    this.followZ += (target - this.followZ) * 0.12;
    this.applyBase();
  }

  onResize() {
    this.cam.aspect = innerWidth / innerHeight;
    this.cam.updateProjectionMatrix();
    // Chase rig re-derives its transform every tick, so a resize only needs the
    // projection refresh above.
    if (this.chasing) return;
    if (this.arena) { this.frameArena(this.arenaHalfW, this.arenaHalfL); return; }
    if (this.base.lengthSq() > 0) {
      if (this.topDown) this.frameTopDown(this.halfSize);
      else this.frame(this.halfSize, this.zoom);
    }
  }

  /** 0 (off) .. 1 (full) accessibility scaling for screen shake. */
  setShakeScale(s: number) {
    this.shakeScale = Math.max(0, Math.min(1, s));
  }

  /** Trigger a shake impulse; larger `amount` = stronger. */
  shake(amount: number) {
    this.shakeT = Math.max(this.shakeT, amount * this.shakeScale);
  }

  tickShake(_dt: number) {
    if (this.shakeT > 0) {
      const s = this.shakeT;
      this.cam.position.set(
        this.base.x + (Math.random() - 0.5) * s,
        this.base.y + (Math.random() - 0.5) * s,
        this.base.z + this.followZ + (Math.random() - 0.5) * s,
      );
      this.shakeT *= 0.9;
      if (this.shakeT < 0.05) {
        this.shakeT = 0;
        this.applyBase();
      }
    }
  }
}
