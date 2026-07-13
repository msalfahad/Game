// The 8 heroes. Stats come from the design bible (SPEC section 3).
// Identical hitboxes across all heroes; stats only change feel, and no single
// stat is allowed to translate into more than a ~15% mechanical advantage.
// `img` maps each bible hero onto its original art asset in public/chars/.

export type UltimateKind =
  | 'blink' // short teleport dash in facing direction
  | 'spin' // spinning burst that knocks nearby rivals back
  | 'clone' // decoy that draws bot aggro
  | 'burst' // radial shockwave
  | 'root' // freezes nearby rivals briefly
  | 'heal' // restores own state / grants brief shield
  | 'slam' // ground slam: freeze + knockback
  | 'fortress'; // heavy rolling charge

export interface Hero {
  key: string; // asset filename stem, also loads public/chars/<key>.webp
  name: string; // display name (bible hero name)
  role: string;
  col: string; // player color
  // Bible stats on a 0-15 scale.
  spd: number;
  str: number;
  acc: number;
  def: number;
  ultimate: UltimateKind;
  ultName: string;
}

// Names/roles match the character sheets: Zip the Speedster, Vex the Wildcard
// (art key 'rax'), Luna the Elemental, Ollie the Gadgeteer, Slam the
// Juggernaut, Rolo the Tech Genius, Pix the Trickster, Brutus the Tank.
export const HEROES: Hero[] = [
  { key: 'zip', name: 'Zip', role: 'Speedster', col: '#7ED321', spd: 10, str: 3, acc: 8, def: 2, ultimate: 'blink', ultName: 'Lightning Blink' },
  { key: 'rax', name: 'Vex', role: 'Wildcard', col: '#B06BFF', spd: 9, str: 4, acc: 7, def: 3, ultimate: 'spin', ultName: 'Shadow Spin' },
  { key: 'luna', name: 'Luna', role: 'Elemental', col: '#4DA6FF', spd: 8, str: 5, acc: 9, def: 4, ultimate: 'clone', ultName: 'Phantom Clone' },
  { key: 'ollie', name: 'Ollie', role: 'Gadgeteer', col: '#FF9C3F', spd: 7, str: 7, acc: 7, def: 7, ultimate: 'burst', ultName: 'Gadget Burst' },
  { key: 'slam', name: 'Slam', role: 'Juggernaut', col: '#3D5AFE', spd: 6, str: 8, acc: 5, def: 8, ultimate: 'root', ultName: 'Ground Shaker' },
  { key: 'rolo', name: 'Rolo', role: 'Tech Genius', col: '#2BD9C8', spd: 5, str: 7, acc: 6, def: 7, ultimate: 'heal', ultName: 'Repair Field' },
  { key: 'pix', name: 'Pix', role: 'Trickster', col: '#FF3D9E', spd: 4, str: 9, acc: 6, def: 10, ultimate: 'slam', ultName: 'Boom Drop' },
  { key: 'brutus', name: 'Brutus', role: 'Tank', col: '#E05038', spd: 3, str: 10, acc: 5, def: 10, ultimate: 'fortress', ultName: 'Rolling Fortress' },
];

export function heroByKey(key: string): Hero {
  return HEROES.find((h) => h.key === key) ?? HEROES[0];
}

export function heroImg(h: Hero): string {
  // The single-file preview build injects sprites as data URIs on
  // window.__CHAR_IMG so nothing can get separated from the HTML.
  const inline = (globalThis as any).__CHAR_IMG as Record<string, string> | undefined;
  return inline?.[h.key] ?? `chars/${h.key}.webp`;
}

// --- Stat normalization -----------------------------------------------------
// The bible caps mechanical advantage at 15%. We convert a 0-15 stat into a
// multiplier in [1-SPREAD/2, 1+SPREAD/2] so the fastest hero is only ~15%
// faster than the slowest, never more. Identical hitboxes are enforced
// separately (see game/player.ts HITBOX_RADIUS).
const SPREAD = 0.15;

function statMult(stat: number): number {
  const t = Math.max(0, Math.min(15, stat)) / 15; // 0..1
  return 1 - SPREAD / 2 + t * SPREAD;
}

export function speedMult(h: Hero): number {
  return statMult(h.spd);
}
export function strengthMult(h: Hero): number {
  return statMult(h.str);
}
export function accuracyMult(h: Hero): number {
  return statMult(h.acc);
}
export function defenseMult(h: Hero): number {
  return statMult(h.def);
}
