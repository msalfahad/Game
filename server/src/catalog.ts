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

// Only games whose CURRENT client mechanic (src/data/maps.ts) is one the server
// can simulate appear online — and each entry's mechanic + mods MUST match the
// client id exactly, or the client renders one game while the server simulates
// another. Games with bespoke offline-only mechanics (kart, maze, boat, raft,
// foosball, sprint, lavafloor, hotpotato, musicalchairs, chase, dodgeball,
// coaster) are NOT online until they get a server simulation.
export const ONLINE_CATALOG: OnlineGameDef[] = [
  // Frostbite
  g('frost-1', 'goal', 120),                              // Ice Hockey Brawl
  g('frost-2', 'icepush', 120),                           // Slip & Slide
  g('frost-3', 'throwfight', 100, { proj: 'snowball' }),  // Snowball Smash
  g('frost-4', 'climb', 60),                              // Avalanche Run
  // Inferno
  g('inferno-1', 'goal', 120),                            // Lava Hockey
  g('inferno-3', 'throwfight', 90, { proj: 'bomb' }),     // Blast Zone
  g('inferno-4', 'climb', 60, { volcano: 1 }),            // Volcano Rush
  // Wildwood
  g('wild-2', 'dodge', 75, { hz: 'logs' }),               // Rolling Logs
  // Sky
  g('sky-3', 'dodge', 75, { hz: 'wind' }),                // Wind Gauntlet
  // Mech
  g('mech-1', 'pushout', 90, { edge: 'gears' }),          // Gear Bash
  g('mech-2', 'dodge', 75, { hz: 'lasers' }),             // Laser Dodge
  g('mech-3', 'mash', 60, { robots: true }),              // Robot Rumble
  g('mech-4', 'dodge', 75, { hz: 'conveyor' }),           // Conveyor Chaos
  // Pirate
  g('pirate-1', 'throwfight', 90, { proj: 'cannon' }),    // Cannon Blast
  g('pirate-2', 'breaktiles', 90, { decay: 'side' }),     // Sinking Ship
  g('pirate-3', 'collect', 60, { coin: true }),           // Treasure Scramble
  // Classic
  g('classic-1', 'pushout', 90),                          // Ring Rumble
  g('classic-2', 'collect', 60),                          // Gem Grab
  g('classic-3', 'paint', 60),                            // Paint Panic
  g('classic-4', 'throwfight', 90, { proj: 'crate' }),    // Crate Brawl
  g('classic-5', 'mash', 60),                             // Mallet Mash
];

export function onlineGame(id: string): OnlineGameDef | undefined {
  return ONLINE_CATALOG.find((x) => x.id === id);
}

// 2v2 only makes sense for elimination mechanics; scoring games stay FFA.
const TEAM_MECHANICS = new Set<Mechanic>(['pushout', 'throwfight', 'breaktiles', 'dodge', 'icepush']);

export function poolFor(mode: 'ffa' | '2v2'): OnlineGameDef[] {
  return mode === '2v2' ? ONLINE_CATALOG.filter((x) => TEAM_MECHANICS.has(x.mechanic)) : ONLINE_CATALOG;
}
