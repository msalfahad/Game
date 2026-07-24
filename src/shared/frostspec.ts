// ============================================================================
// SINGLE SOURCE OF TRUTH — Frost Arena game rules & tuning.
//
// This file is compiled directly by the CLIENT (offline play) and auto-copied
// into server/src/shared/ by scripts/sync-shared.mjs before the SERVER build.
// Both the offline game modules and the authoritative online sim read these
// numbers, so a change here changes offline AND online together — they are one
// game, not two. Edit ONLY this copy; the server copy is generated.
//
// Keep this file dependency-free (no THREE, no DOM, no Node) so both builds can
// compile it verbatim.
// ============================================================================

export const FROST = {
  // frost-1 · Ice Hockey Brawl (goal). Puck physics, points, deflection.
  hockey: {
    startPts: 10,          // points each; 0 = OUT
    durationSec: 120,      // base clock (offline still scales by the local slider)
    serveSpeed: 36,        // fresh puck launched from a corner pad
    resetSpeed: 34,        // puck re-served after a goal / stall
    puckCap: 42,           // normal top speed
    puckCapPowered: 58,    // capped speed while a power shot is active
    powerShotTime: 2.5,    // seconds a power shot stays "powered"
    powerShotCd: 6,        // ability cooldown after a power shot
    deflectBase: 1.02,     // base puck speed-up on a paddle deflection
    deflectStrength: 0.06, // extra per hero strength point
    poweredMult: 1.8,      // deflection multiplier while armed
    slowReserveSpeed: 8,   // below this for slowReserveTime → re-serve
    slowReserveTime: 0.7,
  },
  // frost-2 · Slip & Slide (icepush). Slippery round rink, breakable wall.
  icePush: {
    lives: 3,
    iceRetainPerSec: 0.55, // momentum kept per second (slippery ice)
    boxEverySec: 10,       // ⚡ thunder box spawn cadence
    zapStunSec: 3,         // stun applied to rivals when someone grabs the box
    wallBounceVel: 22,     // inward velocity when the ice wall saves you once
    wallSegments: 16,      // arc segments around the rim
  },
  // frost-3 · Snowball Smash (throwfight, snow). Most hits in the clock wins.
  snowball: {
    durationSec: 100,
    startScore: 0,         // count hits UP (no HP / no elimination)
  },
  // frost-4 · Avalanche Run (climb). Vertical dash dodging boulders.
  climb: {
    durationSec: 60,
    boxEverySec: 10,       // ❄ freeze box spawn cadence
    boxFreezeSec: 1.4,     // freeze from a big box (small box = half)
    boulderFreezeSec: 0.35,
  },
} as const;
