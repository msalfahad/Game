// ============================================================================
// SINGLE SOURCE OF TRUTH — free-roam movement tuning + surface physics.
//
// Compiled by the CLIENT and auto-copied into the server (scripts/sync-shared)
// so offline play, the authoritative server sim, and client prediction all use
// the SAME movement numbers — characters move identically online and offline.
// Keep dependency-free (no THREE / DOM / Node).
// ============================================================================

export const MOVE = {
  baseSpeed: 14,      // world units/sec at hero speed midpoint
  sprint: 1.15,       // ~15% faster at full-stick input
  sprintThresh: 0.9,  // |input| above this counts as sprinting
  jumpV: 22,          // jump take-off velocity
  gravity: 60,
  accelMul: 2.6,      // acceleration = topSpeed * accelMul * surface.accel
  speedBoost: 1.35,   // ⚡ speed powerup multiplier
  shoesBoost: 2,      // 👟 shoes powerup multiplier
} as const;

export interface SurfacePhys {
  grip: number;   // per-second velocity retention (higher = slipperier)
  accel: number;  // input acceleration factor
  push?: { x: number; z: number };
  drift?: number;
}

// Raw surface numbers — the single source for src/data/surfaces.ts too.
export const SURFACE_PHYS: Record<string, SurfacePhys> = {
  metal: { grip: 0.02, accel: 1.0 },
  ice: { grip: 0.55, accel: 0.7 },
  mud: { grip: 0.001, accel: 0.62 },
  sand: { grip: 0.04, accel: 0.85, drift: 2.2 },
  conveyor: { grip: 0.03, accel: 1.0, push: { x: 6, z: 0 } },
};

// Family → surface (mirrors src/data/maps.ts family.surface). Snowball Smash
// plays on packed snow (no slip) even though Frostbite's floor is ice.
export function roamSurface(familyId: string, snow: boolean): SurfacePhys {
  if (snow) return SURFACE_PHYS.metal;
  if (familyId === 'frost') return SURFACE_PHYS.ice;
  if (familyId === 'dune') return SURFACE_PHYS.sand;
  return SURFACE_PHYS.metal;
}

/** Sprint multiplier for an input vector (full stick = faster, like offline). */
export function sprintMul(ax: number, ay: number): number {
  return Math.hypot(ax, ay) > MOVE.sprintThresh ? MOVE.sprint : 1;
}
