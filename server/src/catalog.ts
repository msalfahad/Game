// Server-side game catalog for online play.
// KEEP IN SYNC with src/data/maps.ts in the client (ids, mechanics, mods).
// Only what the simulation needs: mechanic, flavor mods, and duration.

export type Mechanic =
  | 'goal' | 'icepush' | 'climb' | 'breaktiles' | 'pushout' | 'throwfight' | 'race' | 'dodge' | 'collect' | 'paint' | 'mash';

export interface OnlineGameDef {
  id: string;
  mechanic: Mechanic;
  duration: number;
  mods: Record<string, string | number | boolean>;
}

const g = (id: string, mechanic: Mechanic, duration: number, mods: OnlineGameDef['mods'] = {}): OnlineGameDef =>
  ({ id, mechanic, duration, mods });

export const ONLINE_CATALOG: OnlineGameDef[] = [
  // Frostbite
  g('frost-1', 'goal', 120),
  g('frost-2', 'icepush', 120),
  g('frost-3', 'throwfight', 100, { proj: 'snowball' }),
  g('frost-4', 'climb', 60),
  // Inferno
  g('inferno-1', 'goal', 120),
  g('inferno-2', 'breaktiles', 90, { decay: 'ring' }),
  g('inferno-3', 'throwfight', 90, { proj: 'bomb' }),
  g('inferno-4', 'race', 90, { laps: 2 }),
  // Dune
  g('dune-1', 'goal', 120),
  g('dune-2', 'breaktiles', 90, { decay: 'respawn' }),
  g('dune-3', 'pushout', 90, { edge: 'cacti' }),
  g('dune-4', 'race', 90, { laps: 2 }),
  // Wildwood
  g('wild-1', 'pushout', 90),
  g('wild-2', 'dodge', 75, { hz: 'logs' }),
  g('wild-3', 'breaktiles', 90, { decay: 'ring', pond: true }),
  g('wild-4', 'race', 90, { laps: 2 }),
  // Sky
  g('sky-1', 'goal', 120),
  g('sky-2', 'breaktiles', 90, { decay: 'ring' }),
  g('sky-3', 'dodge', 75, { hz: 'wind' }),
  g('sky-4', 'race', 90, { laps: 2 }),
  // Mech
  g('mech-1', 'pushout', 90, { edge: 'gears' }),
  g('mech-2', 'dodge', 75, { hz: 'lasers' }),
  g('mech-3', 'mash', 60, { robots: true }),
  g('mech-4', 'dodge', 75, { hz: 'conveyor' }),
  // Pirate
  g('pirate-1', 'throwfight', 90, { proj: 'cannon' }),
  g('pirate-2', 'breaktiles', 90, { decay: 'side' }),
  g('pirate-3', 'collect', 60, { coin: true }),
  g('pirate-4', 'race', 90, { laps: 2 }),
  // Classic
  g('classic-1', 'pushout', 90),
  g('classic-2', 'collect', 60),
  g('classic-3', 'paint', 60),
  g('classic-4', 'throwfight', 90, { proj: 'crate' }),
  g('classic-5', 'mash', 60),
];

export function onlineGame(id: string): OnlineGameDef | undefined {
  return ONLINE_CATALOG.find((x) => x.id === id);
}

// 2v2 only makes sense for elimination mechanics; scoring games stay FFA.
const TEAM_MECHANICS = new Set<Mechanic>(['pushout', 'throwfight', 'breaktiles', 'dodge', 'icepush']);

export function poolFor(mode: 'ffa' | '2v2'): OnlineGameDef[] {
  return mode === '2v2' ? ONLINE_CATALOG.filter((x) => TEAM_MECHANICS.has(x.mechanic)) : ONLINE_CATALOG;
}
