import type { Player } from './player';
import type { Surface } from '../data/surfaces';
import { speedMult } from '../data/characters';
import { TUNING } from '../core/tuning';

// Movement + surface physics (SPEC section 4). Shared free-roam kinematics used
// by the Surface Lab and free-roam games. Hockey uses its own 1-axis paddle
// model. Slight momentum, responsive control, surface-dependent grip/drift/push.

const BASE_SPEED = 14; // world units/sec at hero speed midpoint
const SPRINT = 1.15; // ~15% faster when sprinting
const JUMP_V = 22;
const GRAVITY = 60;
const DASH_V = 42;
const DASH_CD = 2; // seconds (SPEC section 4)

export interface MoveOpts {
  halfSize: number;
  sprint?: boolean;
  noClamp?: boolean; // open-edge arenas (pushout / breaktiles / dodge) handle falls themselves
}

/**
 * Apply one movement step to a free-roam player on a given surface.
 * Reads p.vx/vz/x/z/y/vy and the intent axes (ax, ay). Mutates in place.
 */
export function moveFreeRoam(
  p: Player,
  ax: number,
  ay: number,
  surf: Surface,
  dt: number,
  opts: MoveOpts,
) {
  const topSpeed =
    BASE_SPEED * speedMult(p.hero) * (opts.sprint ? SPRINT : 1) *
    (p.speedT > 0 ? 1.35 : 1) * TUNING.speedScale;
  const accel = topSpeed * 2.6 * surf.accel;

  // Direct acceleration from intent (frozen players get no control).
  if (p.freezeT <= 0) {
    p.vx += ax * accel * dt;
    p.vz += ay * accel * dt;
  }

  // Constant surface push (conveyors).
  if (surf.push) {
    p.vx += surf.push.x * dt * 4;
    p.vz += surf.push.z * dt * 4;
  }
  // Random drift (sand).
  if (surf.drift) {
    p.vx += (Math.random() - 0.5) * surf.drift;
    p.vz += (Math.random() - 0.5) * surf.drift;
  }

  // Grip: retention of momentum. grip^dt keeps more velocity when slippery.
  const retain = Math.pow(surf.grip, dt);
  p.vx *= retain;
  p.vz *= retain;

  // Clamp horizontal speed (higher ceiling while diving for a committed lunge).
  const cap = topSpeed * (p.diveT > 0 ? 1.7 : 1);
  const sp = Math.hypot(p.vx, p.vz);
  if (sp > cap) {
    p.vx *= cap / sp;
    p.vz *= cap / sp;
  }

  // Integrate plane.
  p.x += p.vx * dt;
  p.z += p.vz * dt;

  // Face movement direction.
  if (Math.abs(ax) + Math.abs(ay) > 0.05) {
    const L = Math.hypot(ax, ay) || 1;
    p.face = { x: ax / L, z: ay / L };
  }

  // Vertical (jump/gravity).
  if (!p.grounded || p.y > 0) {
    p.y += p.vy * dt;
    p.vy -= GRAVITY * dt;
    if (p.y <= 0) {
      p.y = 0;
      p.vy = 0;
      p.grounded = true;
      p.airJumps = 0;
      if (p.diveT > 0) p.diveT = 0.25; // landing recovery window
    }
  }
  if (p.diveT > 0) p.diveT = Math.max(0, p.diveT - dt);
  if (p.dashCd > 0) p.dashCd = Math.max(0, p.dashCd - dt);

  if (!opts.noClamp) clampToArena(p, opts.halfSize);
}

export function clampToArena(p: Player, halfSize: number) {
  const m = halfSize - 1;
  if (p.x < -m) { p.x = -m; p.vx = Math.abs(p.vx) * 0.3; }
  if (p.x > m) { p.x = m; p.vx = -Math.abs(p.vx) * 0.3; }
  if (p.z < -m) { p.z = -m; p.vz = Math.abs(p.vz) * 0.3; }
  if (p.z > m) { p.z = m; p.vz = -Math.abs(p.vz) * 0.3; }
}

/** Jump / double-jump. Returns true if a jump fired. */
export function tryJump(p: Player): boolean {
  if (p.diveT > 0 && p.grounded) return false; // recovering
  if (p.grounded) {
    p.vy = JUMP_V;
    p.grounded = false;
    p.airJumps = 1; // one extra jump in the air
    return true;
  }
  if (p.airJumps > 0) {
    p.vy = JUMP_V * 0.85;
    p.airJumps--;
    return true;
  }
  return false;
}

/** Dash in facing (or given) direction. Returns true if it fired. */
export function tryDash(p: Player, dx?: number, dz?: number): boolean {
  if (p.dashCd > 0) return false;
  p.dashCd = DASH_CD;
  let fx = dx ?? p.face.x;
  let fz = dz ?? p.face.z;
  const L = Math.hypot(fx, fz) || 1;
  fx /= L; fz /= L;
  p.vx += fx * DASH_V;
  p.vz += fz * DASH_V;
  return true;
}

/** Dive: a committed forward lunge; grounded landing triggers recovery. */
export function tryDive(p: Player): boolean {
  if (!p.grounded || p.diveT > 0) return false;
  p.diveT = 0.6;
  p.vx += p.face.x * DASH_V * 0.7;
  p.vz += p.face.z * DASH_V * 0.7;
  p.vy = JUMP_V * 0.35;
  p.grounded = false;
  return true;
}
