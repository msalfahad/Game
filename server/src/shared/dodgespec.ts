// ===========================================================================
// GENERATED FILE — DO NOT EDIT. Source of truth: src/shared/<name>.ts
// Regenerate with `npm run sync:shared`. Edits here are overwritten at build.
// ===========================================================================

// ============================================================================
// SINGLE SOURCE OF TRUTH — Dodge (Laser Dodge) tuning. Compiled by the client
// and copied into the server (scripts/sync-shared) so offline + online lasers
// behave identically. Dependency-free.
// ============================================================================

export const LASER = {
  // Beam spin (rad/s): base + progress ramp. Beam 1 counter-rotates. Faster
  // than before so the lasers actually threaten.
  beam0Spin: 0.95,
  beam0Ramp: 1.15,
  beam1Spin: 0.75,
  beam1Ramp: 0.95,
  // Every reverseEverySec the beams SUDDENLY flip direction (CW <-> CCW).
  reverseEverySec: 5,
  // A jump lifts you above the beam: clear it while y is over this height.
  jumpClearY: 2.4,
} as const;
