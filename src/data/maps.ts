import type { SurfaceKind } from './surfaces';

// The full game catalog: 7 spec families x 4 games (SPEC section 5) + the
// Classic Arena bonus family (the prototype's original modes) + the Surface
// Lab greybox = 34 playable games. Each family shares a theme (floor style,
// sky, trim light, ambient particles, surface) and a hazard ramp across its
// four tiers (Learn -> Adapt -> Master -> Survive).

export type FloorStyle =
  | 'ice' | 'lava' | 'desert' | 'forest' | 'sky' | 'mech' | 'pirate' | 'neon' | 'greybox';

// Generalized hazard kinds; each family flavors them (falling = icicles /
// meteors / debris / cannonballs, rollers = boulders / logs / barrels, ...).
export type HazardKind = 'wind' | 'falling' | 'rollers' | 'geysers' | 'lasers';

export type Mechanic =
  | 'goal' // puck/ball into rival walls (hockey & soccer variants)
  | 'icepush' // slippery brawl: smash rivals through breakable ice walls
  | 'climb' // vertical race up the mountain, dodging falling rocks
  | 'breaktiles' // floor breaks away, don't fall
  | 'pushout' // shrinking platform, shove rivals off
  | 'throwfight' // grab & hurl projectiles, drain HP
  | 'race' // checkpoint laps around the arena
  | 'dodge' // survive sweeping hazards, last standing
  | 'collect' // grab the most pickups
  | 'paint' // claim floor tiles
  | 'mash' // smash pop-up targets
  | 'musicalchairs' // circle the chairs; grab one when the song stops
  | 'chase' // 3 escapers flee 1 faster guard (top-down); hide behind crates
  | 'hotpotato' // pass the exploding watermelon; last one un-splatted wins
  | 'kart' // race karts round a ring track, grab item pickups, most laps wins
  | 'maze' // night maze: 3 robbers with torches vs 1 fast cop who sees in the dark
  | 'lavafloor' // stand on tiles over real lava; they fall 1s after you step on
  | 'boat' // third-person speed-boat race down a winding forest river, grab weapons
  | 'raft' // co-op: one raft, 4 paddlers, flee the river crocodiles to the finish
  | 'lab'; // movement greybox

export type AmbientKind = 'snow' | 'embers' | 'sand' | 'leaves' | 'stars' | 'bubbles' | 'none';

export interface ThemeColors {
  skyTop: string;
  skyBot: string;
  fog: string;
  ground: string;
  trim: number;
  light: number;
  ambient: AmbientKind;
}

export interface FamilyDef {
  id: string;
  name: string;
  icon: string;
  style: FloorStyle;
  surface: SurfaceKind;
  theme: ThemeColors;
  blurb: string;
}

export interface GameDef {
  id: string;
  familyId: string;
  name: string;
  icon: string;
  tier: 1 | 2 | 3 | 4;
  tierName: string;
  mechanic: Mechanic;
  shape: 'square' | 'circle';
  hazards: HazardKind[];
  blurb: string;
  // Mechanic flavor knobs (projectile type, edge hazard, decay pattern, ...).
  mods?: Record<string, string | number | boolean>;
}

const TIER = ['', 'Learn', 'Adapt', 'Master', 'Survive'] as const;

export const FAMILIES: FamilyDef[] = [
  {
    id: 'frost', name: 'Frostbite Arena', icon: '❄️', style: 'ice', surface: 'ice',
    theme: { skyTop: '#5B86C4', skyBot: '#2E4E8A', fog: '#4E74B0', ground: '#3A5E96', trim: 0x9ae8ff, light: 0xeaf4ff, ambient: 'snow' },
    blurb: 'Aurora skies, sliding ice, blizzards & icicles.',
  },
  {
    id: 'inferno', name: 'Inferno Arena', icon: '🌋', style: 'lava', surface: 'metal',
    theme: { skyTop: '#7A2A1A', skyBot: '#1A0808', fog: '#4A160C', ground: '#1A0A08', trim: 0xff5e2e, light: 0xffb080, ambient: 'embers' },
    blurb: 'Lava rivers, geysers and meteor strikes.',
  },
  {
    id: 'dune', name: 'Dune Clash', icon: '🏜️', style: 'desert', surface: 'sand',
    theme: { skyTop: '#F0B060', skyBot: '#B85A2E', fog: '#D08A4A', ground: '#9A6A34', trim: 0xffd23f, light: 0xffe8c0, ambient: 'sand' },
    blurb: 'Drifting sand, sandstorms and sinkholes.',
  },
  {
    id: 'wildwood', name: 'Wildwood Arena', icon: '🌲', style: 'forest', surface: 'metal',
    theme: { skyTop: '#8AC4E8', skyBot: '#3E6438', fog: '#5A8A5A', ground: '#2E5A34', trim: 0xb6ff2e, light: 0xf0ffd0, ambient: 'leaves' },
    blurb: 'Rune groves, rolling logs and poison ponds.',
  },
  {
    id: 'sky', name: 'Sky Island Arena', icon: '☁️', style: 'sky', surface: 'metal',
    theme: { skyTop: '#9ED4FF', skyBot: '#4A78C0', fog: '#7FA8DE', ground: '#4A78C0', trim: 0xcff0ff, light: 0xffffff, ambient: 'stars' },
    blurb: 'Floating islands, wind gusts and falling debris.',
  },
  {
    id: 'mech', name: 'Mech Factory', icon: '⚙️', style: 'mech', surface: 'metal',
    theme: { skyTop: '#3A4256', skyBot: '#12161E', fog: '#2A3038', ground: '#1E2228', trim: 0x2ef2ff, light: 0xc0d0e0, ambient: 'none' },
    blurb: 'Conveyors, gears, lasers and crushers.',
  },
  {
    id: 'pirate', name: 'Pirate Cove', icon: '🏴‍☠️', style: 'pirate', surface: 'metal',
    theme: { skyTop: '#6FB6E8', skyBot: '#1E5E8E', fog: '#3A78A8', ground: '#123A5E', trim: 0xffd23f, light: 0xe8f4ff, ambient: 'bubbles' },
    blurb: 'Ship decks, cannon fire and rolling barrels.',
  },
  {
    id: 'classic', name: 'Classic Arena', icon: '🎪', style: 'neon', surface: 'metal',
    theme: { skyTop: '#2A2E58', skyBot: '#0D1026', fog: '#1A1F3D', ground: '#151A38', trim: 0x2ef2ff, light: 0xbfc8ff, ambient: 'stars' },
    blurb: 'The original neon-night party modes.',
  },
  {
    id: 'lab', name: 'The Lab', icon: '🧪', style: 'greybox', surface: 'metal',
    theme: { skyTop: '#2A2E58', skyBot: '#0D1026', fog: '#1A1F3D', ground: '#151A38', trim: 0x2ef2ff, light: 0xbfc8ff, ambient: 'none' },
    blurb: 'Greybox testing ground for movement & surfaces.',
  },
];

function g(
  id: string, familyId: string, name: string, icon: string, tier: 1 | 2 | 3 | 4,
  mechanic: Mechanic, shape: 'square' | 'circle', hazards: HazardKind[], blurb: string,
  mods?: GameDef['mods'],
): GameDef {
  return { id, familyId, name, icon, tier, tierName: TIER[tier], mechanic, shape, hazards, blurb, mods };
}

export const GAMES: GameDef[] = [
  // 1. Frostbite Arena
  g('frost-1', 'frost', 'Ice Hockey Brawl', '🏒', 1, 'goal', 'square', [], 'Guard your wall. Deflect the puck. 0 pts = OUT.'),
  g('frost-2', 'frost', 'Slip & Slide', '🧊', 2, 'icepush', 'circle', [], 'Slippery brawl! Smash rivals through the ice walls. Grab the ⚡ box to zap everyone else.'),
  g('frost-3', 'frost', 'Snowball Smash', '☃️', 3, 'throwfight', 'square', ['wind', 'falling'], 'Most hits in 100s wins — big snowballs count double. Grab 👟⚡🛡️ perks!', { proj: 'snowball' }),
  g('frost-4', 'frost', 'Avalanche Run', '🏔️', 4, 'climb', 'square', [], 'Climb the mountain! Boulders knock you back down. First to the summit — grab ❄ to freeze rivals.'),

  // 2. Inferno Arena
  g('inferno-1', 'inferno', 'Lava Hockey', '🔥', 1, 'goal', 'square', [], 'Hockey on obsidian. The ember puck burns.'),
  g('inferno-2', 'inferno', 'Floor Is Lava', '🌋', 2, 'lavafloor', 'square', [], 'The floor is real lava! Tiles drop 1s after you step on them. Jump and double-jump across the gaps — last one out of the lava wins.'),
  g('inferno-3', 'inferno', 'Blast Zone', '💣', 3, 'throwfight', 'square', ['geysers', 'falling'], 'Grab bombs. Big blasts, big knockback.', { proj: 'bomb' }),
  g('inferno-4', 'inferno', 'Volcano Rush', '🌋', 4, 'climb', 'square', [], 'Climb the erupting volcano! Dodge rolling lava rocks and the crater guardian\'s fireballs.', { volcano: 1 }),

  // 3. Dune Clash
  g('dune-1', 'dune', 'Race Kart', '🏎️', 1, 'kart', 'circle', [], 'Race karts around the desert ring! Grab items — balls, bananas, boosts, zaps and rockets — and rack up the most laps before time.'),
  g('dune-2', 'dune', 'Musical Chairs', '🎵', 2, 'musicalchairs', 'circle', [], 'Circle the chairs while the song plays. When it stops — grab a seat! No seat = out.'),
  g('dune-3', 'dune', 'The Great Escape', '🏃', 3, 'chase', 'square', [], 'You broke into a forbidden yard! 3 escape, 1 guard chases with a stick. Hide behind crates, grab shoes/freeze/slingshots. Survive the guard.'),
  g('dune-4', 'dune', 'Night Heist', '🔦', 4, 'maze', 'square', [], 'Lights out! 3 robbers with fading torches must blind the cop — hold 5s of torchlight on them to win. The cop sees in the dark, runs faster, and tags robbers from behind.'),

  // 4. Wildwood Arena
  g('wild-1', 'wildwood', 'Boat Bash Race', '🚤', 1, 'boat', 'square', [], 'Blast down a winding forest river in a speed boat! Ram rivals, grab weapons, and race to the checkered flag. First across or the furthest in 1 minute wins.'),
  g('wild-2', 'wildwood', 'Rolling Logs', '🪵', 2, 'dodge', 'square', [], 'Logs sweep the grove. Jump or be flattened.', { hz: 'logs' }),
  g('wild-3', 'wildwood', 'Watermelon Bomb', '🍉', 3, 'hotpotato', 'square', [], 'The watermelon has a firecracker! Tap a rival to pass it. Whoever is holding it when it blows gets splatted. Last one dry wins.'),
  g('wild-4', 'wildwood', 'Jungle Race', '🦜', 4, 'race', 'square', ['falling', 'rollers'], 'Race the ruins as branches crash down.', { laps: 2 }),

  // 5. Sky Island Arena
  g('sky-1', 'sky', 'Croc River Raft', '🚣', 1, 'raft', 'square', [], 'One raft, four paddlers — two on each side! Steer down the winding forest river, whack the hungry crocodiles, and paddle hard to the finish before they sink you.'),
  g('sky-2', 'sky', 'Falling Platform', '🪂', 2, 'breaktiles', 'square', ['wind'], 'Sky tiles drop into the void one by one.', { decay: 'ring' }),
  g('sky-3', 'sky', 'Wind Gauntlet', '💨', 3, 'dodge', 'square', ['falling'], 'Gale-force wind drags you toward the edge.', { hz: 'wind' }),
  g('sky-4', 'sky', 'Sky Race', '🕊️', 4, 'race', 'square', ['wind', 'falling'], 'Gate to gate across the floating island.', { laps: 2 }),

  // 6. Mech Factory
  g('mech-1', 'mech', 'Gear Bash', '🔩', 1, 'pushout', 'circle', [], 'Rotating gear arms sweep the platform.', { edge: 'gears' }),
  g('mech-2', 'mech', 'Laser Dodge', '🔴', 2, 'dodge', 'square', [], 'Sweeping factory lasers. Don’t get tagged.', { hz: 'lasers' }),
  g('mech-3', 'mech', 'Robot Rumble', '🤖', 3, 'mash', 'square', ['lasers'], 'Smash the scurrying repair-bots for points.', { robots: true }),
  g('mech-4', 'mech', 'Conveyor Chaos', '🏭', 4, 'dodge', 'square', ['lasers'], 'Belts drag you into the crushers. Fight the flow.', { hz: 'conveyor' }),

  // 7. Pirate Cove
  g('pirate-1', 'pirate', 'Cannon Blast', '💥', 1, 'throwfight', 'square', [], 'Grab cannonballs, sink your rivals.', { proj: 'cannon' }),
  g('pirate-2', 'pirate', 'Sinking Ship', '🚢', 2, 'breaktiles', 'square', ['falling'], 'The deck breaks from the bow. Find safe planks.', { decay: 'side' }),
  g('pirate-3', 'pirate', 'Treasure Scramble', '🪙', 3, 'collect', 'square', ['falling'], 'Doubloons rain down. Grab the most.', { coin: true }),
  g('pirate-4', 'pirate', 'Pirate Race', '⛵', 4, 'race', 'square', ['falling', 'rollers'], 'Race the cove through cannon fire and barrels.', { laps: 2 }),

  // Classic Arena (the original prototype modes, kept as a bonus family)
  g('classic-1', 'classic', 'Ring Rumble', '💥', 1, 'pushout', 'circle', [], 'Bump rivals off a shrinking neon ring.'),
  g('classic-2', 'classic', 'Gem Grab', '💎', 1, 'collect', 'square', [], 'Gems rain in. Grab the most in 60 seconds.'),
  g('classic-3', 'classic', 'Paint Panic', '🎨', 1, 'paint', 'square', [], 'Claim floor tiles in your color.'),
  g('classic-4', 'classic', 'Crate Brawl', '📦', 2, 'throwfight', 'square', [], 'Grab & hurl crates. Last basher standing.', { proj: 'crate' }),
  g('classic-5', 'classic', 'Mallet Mash', '🔨', 1, 'mash', 'square', [], 'Smash pop-up targets. Golden ones score big.'),

  // Lab
  g('lab-1', 'lab', 'Surface Lab', '🧪', 1, 'lab', 'square', [], 'Metal · ice · mud · sand quadrants + a conveyor strip.'),
];

export function gameById(id: string): GameDef {
  return GAMES.find((x) => x.id === id) ?? GAMES[0];
}
export function familyById(id: string): FamilyDef {
  return FAMILIES.find((f) => f.id === id) ?? FAMILIES[0];
}
export function familyGames(familyId: string): GameDef[] {
  return GAMES.filter((x) => x.familyId === familyId);
}
