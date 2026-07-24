// Wire protocol shared with the server.
// KEEP IN SYNC with server/src/protocol.ts — same field names, same meanings.

export const TICK_RATE = 20;
export const INPUT_RATE = 30;
export const MAX_PLAYERS = 4;

export interface WelcomeMsg {
  token: string;
  id: string;
  name: string;
  xp: number;
  games: number;
  wins: number;
}

export interface QueueUpdateMsg {
  count: number;
  needed: number;
  botFillInSec: number;
}

export type MatchMode = 'ffa' | '2v2';

export interface RoomPlayerInfo {
  name: string;
  heroKey: string;
  host: boolean;
  bot: boolean;
  team: number;
  you?: boolean;
}
export interface RoomUpdateMsg {
  code: string;
  mode: MatchMode;
  seriesLen: number;  // how many games the series runs (3 or 5)
  games: string[];    // host-selected catalog ids (empty = random each game)
  players: RoomPlayerInfo[];
}

export interface MatchPlayerInfo {
  slot: number;
  name: string;
  heroKey: string;
  bot: boolean;
  team: number;
}
export interface MatchStartMsg {
  gameId: string;
  mode: MatchMode;
  players: MatchPlayerInfo[];
  youSlot: number;
  duration: number;
}

export interface InputMsg {
  seq: number;
  // Hockey paddles send an absolute target position (0..1) instead of axes.
  pos?: number;
  ax: number;
  ay: number;
  jump?: boolean;
  ult?: boolean;
}

// [slot, x, z, vx, vz, y, lives, dead, freezeT, shieldT, cd, score, flags]
export type PlayerState = [number, number, number, number, number, number, number, number, number, number, number, number, number];

export interface SimEvent {
  t: 'ult' | 'fall' | 'out' | 'goal' | 'power' | 'pick' | 'hit';
  slot: number;
  // Perk kind for 'power' events in Snowball Smash: 4=shoes, 5=zap, 6=shield.
  k?: number;
}

// Synced world entity: [id, type, x, z, y, extra]
export const ET = { LOOT: 0, TARGET: 1, ITEM: 2, MISSILE: 3, LOG: 4 } as const;
export type EntityState = [number, number, number, number, number, number];

export interface StateMsg {
  tick: number;
  timeLeft: number;
  ring: number;
  ack: number;
  players: PlayerState[];
  events: SimEvent[];
  // Hockey-only channel: paddle positions (0..1 per slot), points per slot,
  // and pucks as [x, z, y, powered].
  hockey?: { pos: number[]; pts: number[]; balls: [number, number, number, number][] };
  // Free-roam channels: world entities, tile grid (paint owners / breaktile
  // states), laser beam angles, and a mechanic-specific scalar (wind angle,
  // conveyor direction).
  entities?: EntityState[];
  tiles?: number[];
  beams?: number[];
  aux?: number;
}

export interface MatchEndMsg {
  mode: MatchMode;
  winnerTeam: number; // -1 in FFA
  scoreLabel: string; // 'lives' | 'pts'
  ranking: { slot: number; name: string; heroKey: string; lives: number; dead: boolean; team: number }[];
}

// --- Best-of-5 series (KEEP IN SYNC with server/src/protocol.ts) --------------
export const SERIES_GAMES = 5;
export const SERIES_WIN = 3;

export interface SeriesNextMsg {
  gameNum: number;
  ofN: number;
  nextGameId: string;
  mode: MatchMode;
  score: number[];
  players: MatchPlayerInfo[];
  inSec: number;
  lastRanking?: MatchEndMsg['ranking'];
  lastWinnerTeam?: number;
}

export interface SeriesEndMsg {
  mode: MatchMode;
  score: number[];
  winnerTeam: number;
  standings: { slot: number; name: string; heroKey: string; team: number; wins: number }[];
  players: MatchPlayerInfo[];
}

export interface ReactionShowMsg { slot: number; emoji: string; }
export interface RematchUpdateMsg { votedSlots: number[]; humanSlots: number[]; }
