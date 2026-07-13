// Wire protocol shared with the client.
// KEEP IN SYNC with src/net/protocol.ts in the client — same field names,
// same meanings. Kept as a copied file (not an import) so the server deploys
// standalone.

export const TICK_RATE = 20; // server simulation + broadcast Hz
export const INPUT_RATE = 30; // client input send Hz
export const MAX_PLAYERS = 4;

// Online game pools. 2v2 sticks to team-friendly pushout arenas; free-for-all
// mixes in the hockey rinks.
export const ONLINE_GAMES_2V2 = ['classic-1', 'wild-1'];
export const ONLINE_GAMES_FFA = ['classic-1', 'wild-1', 'frost-1', 'inferno-1'];

export interface HelloMsg {
  token?: string;
  name?: string;
}
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
  botFillInSec: number; // -1 = no timer running
}

export type MatchMode = 'ffa' | '2v2';

export interface RoomPlayerInfo {
  name: string;
  heroKey: string;
  host: boolean;
  bot: boolean;
  team: number; // 0 | 1 (used in 2v2)
  you?: boolean;
}
export interface RoomUpdateMsg {
  code: string;
  mode: MatchMode;
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
  ax: number; // -1..1
  ay: number;
  jump?: boolean;
  ult?: boolean;
}

// Per-player state in a snapshot: [slot, x, z, vx, vz, y, lives, dead, freezeT, shieldT, cd]
export type PlayerState = [number, number, number, number, number, number, number, number, number, number, number];

export interface SimEvent {
  t: 'ult' | 'fall' | 'out' | 'goal' | 'power';
  slot: number;
}

export interface StateMsg {
  tick: number;
  timeLeft: number;
  ring: number; // current ring radius
  ack: number; // last input seq the server has applied for YOU
  players: PlayerState[];
  events: SimEvent[];
  // Hockey-only channel: paddle positions (0..1 per slot), points per slot,
  // and pucks as [x, z, y, powered].
  hockey?: { pos: number[]; pts: number[]; balls: [number, number, number, number][] };
}

export interface MatchEndMsg {
  mode: MatchMode;
  winnerTeam: number; // -1 in FFA
  scoreLabel: string; // 'lives' | 'pts'
  ranking: { slot: number; name: string; heroKey: string; lives: number; dead: boolean; team: number }[];
}
