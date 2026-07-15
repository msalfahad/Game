import * as THREE from 'three';

/**
 * Asset loader for Higgsfield-generated resources.
 * Handles skybox textures, PBR materials, 3D models, and voice barks.
 */

const textureCache: Record<string, THREE.Texture> = {};
const modelCache: Record<string, THREE.Group> = {};
const audioCache: Record<string, HTMLAudioElement> = {};

async function loadTexture(url: string): Promise<THREE.Texture> {
  if (textureCache[url]) return textureCache[url];

  const loader = new THREE.TextureLoader();
  const texture = await loader.loadAsync(url);

  texture.colorSpace = THREE.SRGBColorSpace;
  textureCache[url] = texture;
  return texture;
}

async function loadGLTF(url: string): Promise<THREE.Group> {
  if (modelCache[url]) return modelCache[url].clone();

  // Dynamically import GLTFLoader
  const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
  const loader = new GLTFLoader();
  const gltf = await loader.loadAsync(url);
  const scene = gltf.scene;

  // Ensure all materials are PBR-ready
  scene.traverse((node: THREE.Object3D) => {
    if (node instanceof THREE.Mesh) {
      if (node.material instanceof THREE.MeshStandardMaterial) {
        node.castShadow = true;
        node.receiveShadow = true;
      }
    }
  });

  modelCache[url] = scene;
  return scene.clone();
}

async function loadAudio(url: string): Promise<HTMLAudioElement> {
  if (audioCache[url]) return audioCache[url];

  const audio = new Audio(url);
  audioCache[url] = audio;
  return audio;
}

/**
 * Load and apply skybox texture to scene background or dedicated sphere.
 */
export async function applySkybox(
  scene: THREE.Scene,
  skyboxUrl: string,
): Promise<void> {
  try {
    const texture = await loadTexture(skyboxUrl);
    const cubeTexture = new THREE.CubeTexture([
      texture, texture, texture, texture, texture, texture,
    ]);
    scene.background = cubeTexture;
  } catch (err) {
    console.error('Failed to load skybox:', err);
  }
}

/**
 * Load and apply PBR material (albedo, normal, roughness/metallic) to a mesh.
 */
export async function applyPBRMaterial(
  mesh: THREE.Mesh,
  albedoUrl: string,
  normalUrl?: string,
  roughMetalUrl?: string,
): Promise<void> {
  try {
    const albedo = await loadTexture(albedoUrl);

    const material = new THREE.MeshStandardMaterial({
      map: albedo,
      roughness: 0.8,
      metalness: 0.1,
    });

    if (normalUrl) {
      const normal = await loadTexture(normalUrl);
      material.normalMap = normal;
      material.normalScale.set(1, 1);
    }

    if (roughMetalUrl) {
      const rm = await loadTexture(roughMetalUrl);
      material.roughnessMap = rm;
      material.metalnessMap = rm;
    }

    mesh.material = material;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
  } catch (err) {
    console.error('Failed to apply PBR material:', err);
  }
}

/**
 * Load a rigged 3D character model (GLTF) and return the scene.
 */
export async function loadCharacterModel(modelUrl: string): Promise<THREE.Group | null> {
  try {
    const model = await loadGLTF(modelUrl);
    return model;
  } catch (err) {
    console.error('Failed to load character model:', err);
    return null;
  }
}

/**
 * Register and play a voice bark for a character.
 */
export async function playCharacterVoice(
  audioUrl: string,
  volume: number = 1.0,
): Promise<void> {
  try {
    const audio = await loadAudio(audioUrl);
    audio.volume = volume;
    audio.play();
  } catch (err) {
    console.error('Failed to play character voice:', err);
  }
}

/**
 * Pre-cache voice barks for a character (e.g., all Zip-In lines).
 */
export async function precacheCharacterVoices(
  characterKey: string,
  lines: string[],
): Promise<Record<string, HTMLAudioElement>> {
  const cached: Record<string, HTMLAudioElement> = {};

  for (const line of lines) {
    const url = `voices/${characterKey}-${line}.wav`;
    try {
      cached[line] = await loadAudio(url);
    } catch (err) {
      console.warn(`Could not precache voice: ${url}`, err);
    }
  }

  return cached;
}

export const assetLoader = {
  applySkybox,
  applyPBRMaterial,
  loadCharacterModel,
  playCharacterVoice,
  precacheCharacterVoices,
};
