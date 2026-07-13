// Hero stats for the authoritative sim.
// KEEP IN SYNC with src/data/characters.ts in the client (same keys, same
// 0-15 stats, same <=15% normalization).

export type UltKind = 'blink' | 'spin' | 'clone' | 'burst' | 'root' | 'heal' | 'slam' | 'fortress';

export interface HeroDef {
  key: string;
  name: string;
  spd: number;
  str: number;
  acc: number;
  def: number;
  ult: UltKind;
}

export const HEROES: HeroDef[] = [
  { key: 'zip', name: 'Volt', spd: 10, str: 3, acc: 8, def: 2, ult: 'blink' },
  { key: 'rax', name: 'Ember', spd: 9, str: 4, acc: 7, def: 3, ult: 'spin' },
  { key: 'luna', name: 'Mirage', spd: 8, str: 5, acc: 9, def: 4, ult: 'clone' },
  { key: 'ollie', name: 'Nova', spd: 7, str: 7, acc: 7, def: 7, ult: 'burst' },
  { key: 'slam', name: 'Timber', spd: 6, str: 8, acc: 5, def: 8, ult: 'root' },
  { key: 'rolo', name: 'Moss', spd: 5, str: 7, acc: 6, def: 7, ult: 'heal' },
  { key: 'pix', name: 'Glacier', spd: 4, str: 9, acc: 6, def: 10, ult: 'slam' },
  { key: 'brutus', name: 'Boulder', spd: 3, str: 10, acc: 5, def: 10, ult: 'fortress' },
];

export function heroByKey(key: string): HeroDef {
  return HEROES.find((h) => h.key === key) ?? HEROES[0];
}

const SPREAD = 0.15;
function statMult(stat: number): number {
  const t = Math.max(0, Math.min(15, stat)) / 15;
  return 1 - SPREAD / 2 + t * SPREAD;
}
export const speedMult = (h: HeroDef) => statMult(h.spd);
export const strengthMult = (h: HeroDef) => statMult(h.str);
export const accuracyMult = (h: HeroDef) => statMult(h.acc);
export const defenseMult = (h: HeroDef) => statMult(h.def);
