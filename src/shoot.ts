import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';

// Dev-only tool: render each hero's 3D model to a transparent-background PNG so
// the character-select screen shows the REAL character (no studio backdrop).
// Run via the vite dev server + playwright, then the PNGs are saved to
// public/chars/render/. Not part of the game build.

const KEYS = ['zip', 'rax', 'luna', 'ollie', 'rolo', 'pix', 'brutus', 'slam'];
const W = 512, H = 640;

const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);

const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true });
renderer.setSize(W, H);
renderer.setPixelRatio(2);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.setClearColor(0x000000, 0);

function normalize(root: THREE.Object3D) {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    for (const mat of mats) {
      if (!mat) continue;
      const s = mat as THREE.MeshStandardMaterial & Partial<THREE.MeshPhysicalMaterial>;
      if ('metalness' in s) s.metalness = 0;
      if ('roughness' in s) s.roughness = Math.max(0.55, s.roughness ?? 1);
      if ('metalnessMap' in s) s.metalnessMap = null;
      if (s.transmission !== undefined) s.transmission = 0;
      if (s.clearcoat !== undefined) s.clearcoat = 0;
      if (s.map) s.map.colorSpace = THREE.SRGBColorSpace;
      s.side = THREE.DoubleSide;
      s.needsUpdate = true;
    }
  });
}

function shoot(key: string): Promise<string> {
  return new Promise((resolve) => {
    loader.load(
      '/models/' + key + '.glb',
      (gltf) => {
        const model = gltf.scene as unknown as THREE.Group;
        normalize(model);
        // Normalize to height 2, feet at y=0, centred on x/z.
        model.updateMatrixWorld(true);
        const b0 = new THREE.Box3().setFromObject(model);
        const size = b0.getSize(new THREE.Vector3());
        model.scale.setScalar(2 / (size.y || 1));
        model.updateMatrixWorld(true);
        const b1 = new THREE.Box3().setFromObject(model);
        model.position.set(-(b1.min.x + b1.max.x) / 2, -b1.min.y, -(b1.min.z + b1.max.z) / 2);

        const scene = new THREE.Scene();
        scene.add(model);
        // Bright, even portrait lighting so the baked albedo reads clearly.
        scene.add(new THREE.HemisphereLight(0xffffff, 0x8899aa, 1.05));
        const key1 = new THREE.DirectionalLight(0xffffff, 1.5);
        key1.position.set(2.5, 4, 5);
        scene.add(key1);
        const fill = new THREE.DirectionalLight(0xffffff, 0.6);
        fill.position.set(-3, 2, 4);
        scene.add(fill);
        const rim = new THREE.DirectionalLight(0xbfe0ff, 0.5);
        rim.position.set(0, 3, -5);
        scene.add(rim);

        // Orthographic front view that TIGHTLY fits the model's bounds (with a
        // small margin), centred — robust to whatever scale the mesh is.
        model.updateMatrixWorld(true);
        const bb = new THREE.Box3().setFromObject(model);
        const c = bb.getCenter(new THREE.Vector3());
        const sz = bb.getSize(new THREE.Vector3());
        const aspect = W / H;
        const margin = 1.12;
        let halfH = (sz.y / 2) * margin;
        let halfW = (sz.x / 2) * margin;
        if (halfW / halfH > aspect) halfH = halfW / aspect;
        else halfW = halfH * aspect;
        const cam = new THREE.OrthographicCamera(-halfW, halfW, halfH, -halfH, 0.01, 100);
        cam.position.set(c.x, c.y, c.z + 10);
        cam.lookAt(c.x, c.y, c.z);

        renderer.render(scene, cam);
        resolve(renderer.domElement.toDataURL('image/webp', 0.92));
      },
      undefined,
      () => resolve(''),
    );
  });
}

(async () => {
  const out: Record<string, string> = {};
  for (const k of KEYS) out[k] = await shoot(k);
  (window as any).__SHOTS = out;
  document.title = 'shoot-done';
})();
