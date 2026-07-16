import * as THREE from 'three';
import { IsoCamera } from './camera';
import { PostFX } from './postfx';

// Owns the renderer, scene, isometric camera and the animation loop.
// Games register a per-frame update callback; the engine handles fixed camera
// framing, resize, and a clamped delta time.

export class Engine {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: IsoCamera;
  readonly post: PostFX;
  private clock = new THREE.Clock();
  private raf = 0;
  private update: ((dt: number, elapsed: number) => void) | null = null;
  private hitstopT = 0;

  constructor() {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    // Phones have very high device-pixel-ratios; rendering at full 2x is the
    // biggest cause of mobile frame drops. Cap tighter on touch/small screens.
    const isMobile = matchMedia('(pointer: coarse)').matches || innerWidth < 820;
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, isMobile ? 1.4 : 2));
    this.renderer.setSize(innerWidth, innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    document.body.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new IsoCamera();
    this.post = new PostFX(this.renderer, this.scene, this.camera.cam);

    addEventListener('resize', this.onResize);
  }

  private onResize = () => {
    this.renderer.setSize(innerWidth, innerHeight);
    this.post.setSize();
    this.camera.onResize();
  };

  /** Graphics quality: pixel ratio cap + post-fx tier (Low..Ultra). */
  setQuality(tier: 'low' | 'medium' | 'high' | 'ultra') {
    const isMobile = matchMedia('(pointer: coarse)').matches || innerWidth < 820;
    const cap = isMobile
      ? { low: 1, medium: 1.25, high: 1.4, ultra: 1.75 }[tier]
      : { low: 1, medium: 1.5, high: 2, ultra: Math.min(devicePixelRatio, 3) }[tier];
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, cap));
    this.renderer.setSize(innerWidth, innerHeight);
    this.post.setSize();
    this.post.setTier(tier);
  }

  start(update: (dt: number, elapsed: number) => void) {
    this.update = update;
    this.clock.getDelta(); // discard the first (large) delta
    this.loop();
  }

  stop() {
    this.update = null;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.hitstopT = 0;
  }

  /**
   * Freeze game-logic time for `sec` seconds to sell an impact (KO, big hit).
   * Rendering and camera shake keep running in real time, so the pause reads
   * as a punch rather than a stall. Calls stack by taking the longest freeze.
   */
  hitstop(sec: number) {
    this.hitstopT = Math.max(this.hitstopT, sec);
  }

  private loop = () => {
    if (!this.update) return;
    const raw = Math.min(this.clock.getDelta(), 0.05);
    // During hitstop, hand the game a dt of 0 (no movement/integration) while
    // shake + render advance on real time.
    let dt = raw;
    if (this.hitstopT > 0) {
      this.hitstopT = Math.max(0, this.hitstopT - raw);
      dt = 0;
    }
    this.update(dt, this.clock.elapsedTime);
    this.camera.tickShake(raw);
    this.post.render(raw);
    this.raf = requestAnimationFrame(this.loop);
  };

  /** Remove every child from the scene (between matches). */
  clearScene() {
    while (this.scene.children.length) this.scene.remove(this.scene.children[0]);
  }
}
