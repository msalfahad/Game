// Surface physics (SPEC section 4): ice slides, mud slows, sand drifts,
// conveyors push, metal is neutral. Each surface tweaks how input maps to
// velocity and how quickly velocity decays, plus an optional constant push.

export type SurfaceKind = 'metal' | 'ice' | 'mud' | 'sand' | 'conveyor';

export interface Surface {
  kind: SurfaceKind;
  // Per-second velocity retention. Higher = more slippery (keeps momentum).
  // Applied as friction^dt, matching the prototype's decay model.
  grip: number;
  // How strongly the input axis accelerates the player (world accel factor).
  accel: number;
  // Constant world-space push (units/sec), e.g. conveyor belts. Default none.
  push?: { x: number; z: number };
  // Random drift magnitude (sand). Nudges velocity unpredictably.
  drift?: number;
}

// The raw grip/accel/push/drift numbers live once in src/shared/roammove.ts so
// offline + online share them; here we just tag each with its kind.
import { SURFACE_PHYS } from '../shared/roammove';
export const SURFACES: Record<SurfaceKind, Surface> = {
  metal: { kind: 'metal', ...SURFACE_PHYS.metal },
  ice: { kind: 'ice', ...SURFACE_PHYS.ice },
  mud: { kind: 'mud', ...SURFACE_PHYS.mud },
  sand: { kind: 'sand', ...SURFACE_PHYS.sand },
  conveyor: { kind: 'conveyor', ...SURFACE_PHYS.conveyor },
};

export function surface(kind: SurfaceKind): Surface {
  return SURFACES[kind];
}
