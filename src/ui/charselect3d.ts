import * as THREE from 'three';
import { makeCharInstance } from '../game/char3d';
import { poseRig, type Rig } from '../game/charanim';

// Live animated 3D heroes on the "Choose your hero" screen. One shared WebGL
// renderer draws every hero into its own tile rectangle (scissor viewports),
// so the whole roster animates from a single context. Each hero idles (breathe,
// weight-shift, look around); the SELECTED one waves/shows off. The canvas is a
// click-through overlay, so the tiles underneath still receive taps.

interface Tile {
  key: string;
  imgEl: HTMLElement;
  scene: THREE.Scene;
  cam: THREE.OrthographicCamera;
  model: THREE.Group | null;
  rig: Rig | null;
  center: THREE.Vector3;
  size: THREE.Vector3;
  seed: number;
  ready: boolean;
}

let renderer: THREE.WebGLRenderer | null = null;
let canvasEl: HTMLCanvasElement | null = null;
let tiles: Tile[] = [];
let raf = 0;
let running = false;
let selectedKey = '';
let lastFrame = 0;

export function setCharSelectSelected(key: string) {
  selectedKey = key;
}

function onResize() {
  if (renderer) renderer.setSize(innerWidth, innerHeight, false);
}

/** Build the shared renderer + one scene/camera/model per hero tile. */
export function initCharSelect3d(entries: { key: string; imgEl: HTMLElement }[]) {
  if (renderer) return; // one-time
  try {
    renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'low-power' });
  } catch {
    renderer = null;
    return; // no WebGL → tiles keep their static portraits
  }
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setScissorTest(true);
  const canvas = renderer.domElement;
  // Above the menu screen (z-index 20) so the 3D shows on the tiles, but the
  // canvas is transparent + click-through + scissored to the tile rects, so the
  // rest of the screen shows through and still receives taps.
  canvas.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:21;display:none;';
  canvasEl = canvas;
  document.body.appendChild(canvas);
  addEventListener('resize', onResize);

  selectedKey = entries[0]?.key ?? '';
  tiles = entries.map((e) => {
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0xffffff, 0x8899aa, 1.05));
    const key = new THREE.DirectionalLight(0xffffff, 1.4);
    key.position.set(2.5, 4, 5);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 0.55);
    fill.position.set(-3, 2, 4);
    scene.add(fill);
    const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 100);
    const tile: Tile = {
      key: e.key, imgEl: e.imgEl, scene, cam, model: null, rig: null,
      center: new THREE.Vector3(), size: new THREE.Vector3(1, 2, 1), seed: e.key.charCodeAt(0) * 0.7, ready: false,
    };
    makeCharInstance(e.key, 2, (inst) => {
      if (!inst) return; // keep the static portrait
      scene.add(inst.model);
      tile.model = inst.model;
      tile.rig = inst.rig;
      inst.model.updateMatrixWorld(true);
      const bb = new THREE.Box3().setFromObject(inst.model);
      bb.getCenter(tile.center);
      bb.getSize(tile.size);
      cam.position.set(tile.center.x, tile.center.y, tile.center.z + 10);
      cam.lookAt(tile.center.x, tile.center.y, tile.center.z);
      tile.ready = true;
      e.imgEl.style.visibility = 'hidden'; // swap the static portrait for the live 3D
    });
    return tile;
  });
}

export function startCharSelect3d() {
  if (running || !renderer) return;
  running = true;
  if (canvasEl) canvasEl.style.display = 'block';
  const loop = (now: number) => {
    if (!running || !renderer) return;
    raf = requestAnimationFrame(loop);
    // ~30fps is plenty for a menu and halves the GPU/battery cost.
    if (now - lastFrame < 32) return;
    lastFrame = now;
    const t = now / 1000;
    let drew = false;
    for (const tile of tiles) {
      if (!tile.ready || !tile.model) continue;
      const r = tile.imgEl.getBoundingClientRect();
      if (r.width < 2 || r.bottom < 0 || r.top > innerHeight) continue;
      if (tile.rig) poseRig(tile.rig, tile.key === selectedKey ? 'wave' : 'idle', 0, t + tile.seed);
      // Frame the model to the tile's current aspect (handles show/resize).
      const aspect = r.width / r.height;
      let hh = (tile.size.y / 2) * 1.14;
      let hw = (tile.size.x / 2) * 1.14;
      if (hw / hh > aspect) hh = hw / aspect;
      else hw = hh * aspect;
      const cam = tile.cam;
      cam.left = -hw; cam.right = hw; cam.top = hh; cam.bottom = -hh;
      cam.updateProjectionMatrix();
      const x = r.left, y = innerHeight - r.bottom, w = r.width, h = r.height;
      renderer.setViewport(x, y, w, h);
      renderer.setScissor(x, y, w, h);
      renderer.render(tile.scene, tile.cam);
      drew = true;
    }
    void drew;
  };
  raf = requestAnimationFrame(loop);
}

export function stopCharSelect3d() {
  running = false;
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
  if (canvasEl) canvasEl.style.display = 'none';
}
