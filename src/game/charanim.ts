import * as THREE from 'three';

// Procedural skeletal animation for the rigged 3D heroes. Meshy exports the
// characters rigged (standard humanoid skeleton) but with only a static rest
// pose — no walk/run/etc. clips. Rather than ship baked clips (which we can't
// generate here), we drive the bones directly: leg + arm swings for locomotion,
// a hip bounce, spine lean, a jump tuck, a celebration dance and a wave.
//
// The rig uses Mixamo-style names: Hips, {Left,Right}{UpLeg,Leg,Foot},
// Spine/Spine01/Spine02, {Left,Right}{Shoulder,Arm,ForeArm,Hand}, neck, Head.
// Poses are applied RELATIVE to each bone's captured rest orientation, so any
// hero whose rig matches these names animates; bones that are missing are
// simply skipped.

const WANT = [
  'Hips', 'Spine', 'Spine01', 'Spine02', 'neck', 'Head',
  'LeftUpLeg', 'LeftLeg', 'LeftFoot', 'RightUpLeg', 'RightLeg', 'RightFoot',
  'LeftShoulder', 'LeftArm', 'LeftForeArm', 'LeftHand',
  'RightShoulder', 'RightArm', 'RightForeArm', 'RightHand',
];

export interface Rig {
  bones: Record<string, THREE.Bone>;
  rest: Record<string, THREE.Quaternion>;
  hipsRestY: number;
}

export type AnimState = 'idle' | 'walk' | 'run' | 'sidewalk' | 'jump' | 'dance' | 'wave';

/** Find the animatable bones on a cloned model and snapshot their rest pose. */
export function buildRig(model: THREE.Object3D): Rig | null {
  const bones: Record<string, THREE.Bone> = {};
  const rest: Record<string, THREE.Quaternion> = {};
  model.traverse((o: THREE.Object3D) => {
    const b = o as THREE.Bone;
    if (b.isBone && WANT.includes(b.name) && !bones[b.name]) {
      bones[b.name] = b;
      rest[b.name] = b.quaternion.clone();
    }
  });
  if (!bones['Hips'] || !bones['LeftUpLeg'] || !bones['RightUpLeg']) return null;
  return { bones, rest, hipsRestY: bones['Hips'].position.y };
}

const _e = new THREE.Euler();
const _q = new THREE.Quaternion();

/** bone.quaternion = rest · euler(x,y,z). No-op if the bone is absent. */
function rot(rig: Rig, name: string, x: number, y: number, z: number) {
  const b = rig.bones[name];
  if (!b) return;
  b.quaternion.copy(rig.rest[name]).multiply(_q.setFromEuler(_e.set(x, y, z)));
}

/**
 * Pose the whole skeleton for a state.
 * @param phase locomotion phase in radians (advance with distance travelled)
 * @param t     elapsed seconds (idle breathing / dance timing)
 * @param amt   0..1 blend strength (eases motion in/out)
 */
export function poseRig(rig: Rig, state: AnimState, phase: number, t: number, amt = 1) {
  const hips = rig.bones['Hips'];
  const s = Math.sin(phase);
  const s2 = Math.sin(phase * 2);

  switch (state) {
    case 'walk':
    case 'run': {
      const k = state === 'run' ? 1 : 0.62; // run swings harder
      // Legs: thighs swing fore/aft (opposite), knees bend on the back swing.
      rot(rig, 'LeftUpLeg', s * 0.9 * k * amt, 0, 0);
      rot(rig, 'RightUpLeg', -s * 0.9 * k * amt, 0, 0);
      rot(rig, 'LeftLeg', Math.max(0, -s) * 1.1 * k * amt, 0, 0);
      rot(rig, 'RightLeg', Math.max(0, s) * 1.1 * k * amt, 0, 0);
      // Arms: counter-swing to the legs; elbows slightly bent.
      rot(rig, 'LeftArm', -s * 0.7 * k * amt, 0, 0.12);
      rot(rig, 'RightArm', s * 0.7 * k * amt, 0, -0.12);
      rot(rig, 'LeftForeArm', -0.35 * k, 0, 0);
      rot(rig, 'RightForeArm', -0.35 * k, 0, 0);
      // Torso: bob + a forward lean when running, slight counter-twist.
      rot(rig, 'Spine02', (state === 'run' ? 0.28 : 0.08) * amt, -s * 0.12 * amt, 0);
      rot(rig, 'Spine', 0, s * 0.06 * amt, 0);
      if (hips) hips.position.y = rig.hipsRestY + Math.abs(s2) * 0.06 * (state === 'run' ? 1.4 : 1);
      break;
    }
    case 'sidewalk': {
      // Facing forward, stepping sideways: thighs open/close laterally (Z),
      // arms held out a little for balance, gentle bob. No big fore/aft swing.
      rot(rig, 'LeftUpLeg', 0, 0, s * 0.5 * amt);
      rot(rig, 'RightUpLeg', 0, 0, s * 0.5 * amt);
      rot(rig, 'LeftLeg', Math.abs(Math.min(0, s)) * 0.5 * amt, 0, 0);
      rot(rig, 'RightLeg', Math.abs(Math.max(0, s)) * 0.5 * amt, 0, 0);
      rot(rig, 'LeftArm', 0, 0, 0.3 + s * 0.15 * amt);
      rot(rig, 'RightArm', 0, 0, -0.3 - s * 0.15 * amt);
      rot(rig, 'Spine02', 0.05, 0, s * 0.05 * amt);
      if (hips) hips.position.y = rig.hipsRestY + Math.abs(s2) * 0.05;
      break;
    }
    case 'jump': {
      // Airborne tuck: knees up, arms thrown up.
      rot(rig, 'LeftUpLeg', -0.6 * amt, 0, 0.1);
      rot(rig, 'RightUpLeg', -0.6 * amt, 0, -0.1);
      rot(rig, 'LeftLeg', 0.9 * amt, 0, 0);
      rot(rig, 'RightLeg', 0.9 * amt, 0, 0);
      rot(rig, 'LeftArm', -2.1 * amt, 0, 0.2);
      rot(rig, 'RightArm', -2.1 * amt, 0, -0.2);
      rot(rig, 'LeftForeArm', -0.4, 0, 0);
      rot(rig, 'RightForeArm', -0.4, 0, 0);
      rot(rig, 'Spine02', -0.12 * amt, 0, 0);
      break;
    }
    case 'dance': {
      // Celebration: hips sway, arms pump overhead, head bobs to the beat.
      const b = Math.sin(t * 6);
      const b2 = Math.sin(t * 6 + Math.PI / 2);
      rot(rig, 'Spine02', 0.05, b * 0.25, b * 0.12);
      rot(rig, 'Spine', 0, b * 0.12, 0);
      rot(rig, 'LeftArm', -2.2 + b * 0.4, 0, 0.3);
      rot(rig, 'RightArm', -2.2 - b * 0.4, 0, -0.3);
      rot(rig, 'LeftForeArm', -0.5 + b2 * 0.4, 0, 0);
      rot(rig, 'RightForeArm', -0.5 - b2 * 0.4, 0, 0);
      rot(rig, 'LeftUpLeg', Math.max(0, b) * 0.3, 0, 0.15);
      rot(rig, 'RightUpLeg', Math.max(0, -b) * 0.3, 0, -0.15);
      rot(rig, 'Head', b * 0.15, b * 0.2, 0);
      if (hips) hips.position.y = rig.hipsRestY + Math.abs(b) * 0.12;
      break;
    }
    case 'wave': {
      // Right-hand wave (hand movement), left arm relaxed.
      const w = Math.sin(t * 7);
      rot(rig, 'RightArm', -2.3, 0, -0.2 + w * 0.05);
      rot(rig, 'RightForeArm', -0.3, w * 0.5, 0);
      rot(rig, 'RightHand', 0, 0, w * 0.4);
      rot(rig, 'LeftArm', 0.05, 0, 0.1);
      rot(rig, 'Spine02', 0, w * 0.05, 0);
      break;
    }
    case 'idle':
    default: {
      // Breathing: chest rises, arms sway a hair, subtle weight shift.
      const br = Math.sin(t * 2) * 0.5 + 0.5;
      rot(rig, 'Spine02', 0.02 + br * 0.03, 0, 0);
      rot(rig, 'LeftArm', 0, 0, 0.08 + br * 0.03);
      rot(rig, 'RightArm', 0, 0, -0.08 - br * 0.03);
      rot(rig, 'Head', Math.sin(t * 1.3) * 0.04, Math.sin(t * 0.9) * 0.06, 0);
      if (hips) hips.position.y = rig.hipsRestY + br * 0.015;
      break;
    }
  }
}
