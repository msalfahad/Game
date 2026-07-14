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

  constructor() {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
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
    const cap = { low: 1, medium: 1.5, high: 2, ultra: Math.min(devicePixelRatio, 3) }[tier];
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
  }

  private loop = () => {
    if (!this.update) return;
    const dt = Math.min(this.clock.getDelta(), 0.05);
    this.update(dt, this.clock.elapsedTime);
    this.camera.tickShake(dt);
    this.post.render(dt);
    this.raf = requestAnimationFrame(this.loop);
  };

  /** Remove every child from the scene (between matches). */
  clearScene() {
    while (this.scene.children.length) this.scene.remove(this.scene.children[0]);
  }
}
