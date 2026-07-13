import * as THREE from 'three';

// Locked camera behaviour from the prototype (SPEC section 10):
// ~35deg isometric feel via a perspective cam pulled back and up, aspect-aware
// dynamic zoom so the whole arena + all players fit on any screen (portrait
// phones pull back further), and an accessibility camera-shake slider.

export class IsoCamera {
  readonly cam: THREE.PerspectiveCamera;
  private base = new THREE.Vector3();
  private shakeT = 0;
  private shakeScale = 1; // accessibility multiplier, 0 disables shake
  private halfSize = 30;
  private zoom = 1;

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
    this.cam.position.copy(this.base);
    this.cam.lookAt(0, -2, -halfSize * 0.06);
  }

  onResize() {
    this.cam.aspect = innerWidth / innerHeight;
    this.cam.updateProjectionMatrix();
    if (this.base.lengthSq() > 0) this.frame(this.halfSize, this.zoom);
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
        this.base.z + (Math.random() - 0.5) * s,
      );
      this.shakeT *= 0.9;
      if (this.shakeT < 0.05) {
        this.shakeT = 0;
        this.cam.position.copy(this.base);
      }
    }
  }
}
