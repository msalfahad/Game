import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { clone as skeletonClone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { buildRig, type Rig } from './charanim';

// Real 3D hero models (Higgsfield/Meshy rigged GLBs in public/models/<key>.glb).
// Loaded once per hero and cloned per player (SkeletonUtils handles the rig).
// Heroes without a GLB fall back to the 2D billboard in player.ts.

const MODEL_KEYS = new Set(['zip', 'rax', 'luna', 'ollie', 'rolo', 'pix', 'brutus', 'slam']);
export function hasCharModel(key: string): boolean {
  return MODEL_KEYS.has(key);
}

interface Loaded {
  scene: THREE.Group;
  clips: THREE.AnimationClip[];
}
const cache: Record<string, Loaded | null> = {};
const waiters: Record<string, ((l: Loaded | null) => void)[]> = {};
// Models are compressed with EXT_meshopt_compression (geometry) + KHR webp
// textures; the meshopt decoder is a self-contained inline-WASM module, so no
// external decoder files need serving.
const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);

function base(): string {
  return (import.meta as any).env?.BASE_URL ?? './';
}

function loadGltf(key: string, cb: (l: Loaded | null) => void) {
  // Always resolve asynchronously — even on a cache hit — so callers can finish
  // their synchronous setup first. buildRider() adds the player group to the
  // scene AFTER requesting the model; a synchronous cache callback would run
  // while grp.parent is still null and its !grp.parent guard would drop the
  // model (which happens now that the hero-select screen preloads every model).
  if (key in cache) {
    const l = cache[key];
    queueMicrotask(() => cb(l));
    return;
  }
  if (waiters[key]) {
    waiters[key].push(cb);
    return;
  }
  waiters[key] = [cb];
  const done = (l: Loaded | null) => {
    cache[key] = l;
    for (const w of waiters[key] ?? []) w(l);
    delete waiters[key];
  };
  loader.load(
    base() + 'models/' + key + '.glb',
    (gltf) => {
      try { normalizeMaterials(gltf.scene); } catch (e) { console.warn('[char3d] normalize failed', e); }
      if ((globalThis as any).__CHAR3D_DEBUG) {
        let meshes = 0; const mats = new Set<string>();
        gltf.scene.traverse((o: any) => { if (o.isMesh) { meshes++; mats.add(o.material?.type); } });
        console.log(`[char3d] ${key} loaded: meshes=${meshes} mats=${[...mats].join(',')} clips=${gltf.animations.length}`);
      }
      done({ scene: gltf.scene as unknown as THREE.Group, clips: gltf.animations });
    },
    undefined,
    (e) => { if ((globalThis as any).__CHAR3D_DEBUG) console.log(`[char3d] ${key} FAILED`, (e as any)?.message || e); done(null); },
  );
}

/**
 * Meshy exports characters as metallic MeshPhysicalMaterial. Metals reflect the
 * environment, and our arenas have no environment map — so the model renders
 * pure BLACK (the "black box" bug). Force the material fully non-metallic and
 * moderately rough so the baked albedo texture shows under the arena's ambient
 * + directional lights, and drop the physical extras (transmission/clearcoat)
 * that darken it further. Runs once on the cached master; clones share it.
 */
function normalizeMaterials(root: THREE.Object3D) {
  root.traverse((o: THREE.Object3D) => {
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
      if (s.sheen !== undefined) s.sheen = 0;
      if (s.map) s.map.colorSpace = THREE.SRGBColorSpace;
      // A touch of self-lit fill keeps the darker heroes from muddying out.
      if (s.emissive && s.map) { s.emissive.setRGB(1, 1, 1); s.emissiveMap = s.map; s.emissiveIntensity = 0.12; }
      s.side = THREE.DoubleSide;
      s.needsUpdate = true;
    }
  });
}

export interface CharInstance {
  model: THREE.Group;
  mixer: THREE.AnimationMixer | null;
  clips: THREE.AnimationClip[];
  rig: Rig | null; // procedural skeletal animation (null if the rig is missing)
}

/**
 * Clone a hero's 3D model, scaled to `height` world units with feet at y=0 and
 * centred on x/z. onReady(null) if the model is missing (caller keeps the 2D art).
 */
export function makeCharInstance(key: string, height: number, onReady: (inst: CharInstance | null) => void) {
  loadGltf(key, (l) => {
    if (!l) return onReady(null);
    const model = skeletonClone(l.scene) as THREE.Group;
    model.position.set(0, 0, 0);
    model.rotation.set(0, 0, 0);
    model.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    model.scale.setScalar(height / (size.y || 1));
    model.updateMatrixWorld(true);
    const b2 = new THREE.Box3().setFromObject(model);
    model.position.set(-(b2.min.x + b2.max.x) / 2, -b2.min.y, -(b2.min.z + b2.max.z) / 2);
    model.traverse((o: THREE.Object3D) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.castShadow = true;
        m.frustumCulled = false;
      }
    });
    // Skip the baked clip (Meshy ships only a static rest pose) — we animate
    // the skeleton procedurally instead, so a mixer would just fight the pose.
    const rig = buildRig(model);
    onReady({ model, mixer: null, clips: l.clips, rig });
  });
}
