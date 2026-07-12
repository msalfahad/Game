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

export interface RoomPlayerInfo {
  name: string;
  heroKey: string;
  host: boolean;
  bot: boolean;
  you?: boolean;
}
export interface RoomUpdateMsg {
  code: string;
  players: RoomPlayerInfo[];
}

export interface MatchPlayerInfo {
  slot: number;
  name: string;
  heroKey: string;
  bot: boolean;
}
export interface MatchStartMsg {
  gameId: string;
  players: MatchPlayerInfo[];
  youSlot: number;
  duration: number;
}

export interface InputMsg {
  seq: number;
  ax: number;
  ay: number;
  jump?: boolean;
  ult?: boolean;
}

// [slot, x, z, vx, vz, y, lives, dead, freezeT, shieldT, cd]
export type PlayerState = [number, number, number, number, number, number, number, number, number, number, number];

export interface SimEvent {
  t: 'ult' | 'fall' | 'out';
  slot: number;
}

export interface StateMsg {
  tick: number;
  timeLeft: number;
  ring: number;
  ack: number;
  players: PlayerState[];
  events: SimEvent[];
}

export interface MatchEndMsg {
  ranking: { slot: number; name: string; heroKey: string; lives: number; dead: boolean }[];
}
