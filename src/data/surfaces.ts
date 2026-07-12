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

export const SURFACES: Record<SurfaceKind, Surface> = {
  // Neutral baseline. Responsive, quick stop.
  metal: { kind: 'metal', grip: 0.02, accel: 1.0 },
  // Very slippery: keeps almost all momentum, weaker direct control.
  ice: { kind: 'ice', grip: 0.55, accel: 0.7 },
  // Sticky: kills momentum fast and slows top speed.
  mud: { kind: 'mud', grip: 0.001, accel: 0.62 },
  // Loose: mostly responsive but adds random lateral drift.
  sand: { kind: 'sand', grip: 0.04, accel: 0.85, drift: 2.2 },
  // Neutral grip but a constant belt push (direction set per-hazard/map).
  conveyor: { kind: 'conveyor', grip: 0.03, accel: 1.0, push: { x: 6, z: 0 } },
};

export function surface(kind: SurfaceKind): Surface {
  return SURFACES[kind];
}
