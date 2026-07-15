import * as THREE from 'three';
import type { FamilyDef } from '../data/maps';

// In-world panoramic backdrop: the family's photoreal arena keyart wrapped
// around the horizon as a big inward-facing cylinder between the arena and
// the shader skydome. Mirrored repeat hides the wrap seams; the ground plane
// hides the bottom edge and the iso camera keeps the top edge out of frame.
// Families without art (or failed loads) simply skip it — the skydome remains.

const RADIUS = 370; // inside the r=400 skydome
const HEIGHT = 150;

export function makeBackdrop(scene: THREE.Scene, family: FamilyDef): THREE.Mesh | null {
  const url = `maps/${family.id}.webp`;
  const geo = new THREE.CylinderGeometry(RADIUS, RADIUS, HEIGHT, 48, 1, true);
  const mat = new THREE.MeshBasicMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    transparent: true,
    opacity: 0, // fades in when the texture arrives
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.y = HEIGHT / 2 - 35; // sink the bottom edge below the ground
  mesh.renderOrder = -0.5; // after the skydome, before the world

  new THREE.TextureLoader().load(
    url,
    (tex) => {
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.wrapS = THREE.MirroredRepeatWrapping;
      tex.repeat.x = 4; // 4 mirrored panels around 360°
      mat.map = tex;
      mat.opacity = 0.95;
      mat.needsUpdate = true;
    },
    undefined,
    () => scene.remove(mesh), // no art for this family — keep shader sky only
  );

  scene.add(mesh);
  return mesh;
}
