// Wire protocol shared with the client.
// KEEP IN SYNC with src/net/protocol.ts in the client — same field names,
// same meanings. Kept as a copied file (not an import) so the server deploys
// standalone.

export const TICK_RATE = 20; // server simulation + broadcast Hz
export const INPUT_RATE = 30; // client input send Hz
export const MAX_PLAYERS = 4;

// Games playable online in v1 (pushout mechanic — simplest state to sync).
export const ONLINE_GAMES = ['classic-1', 'wild-1'];

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
  ax: number; // -1..1
  ay: number;
  jump?: boolean;
  ult?: boolean;
}

// Per-player state in a snapshot: [slot, x, z, vx, vz, y, lives, dead, freezeT, shieldT, cd]
export type PlayerState = [number, number, number, number, number, number, number, number, number, number, number];

export interface SimEvent {
  t: 'ult' | 'fall' | 'out';
  slot: number;
}

export interface StateMsg {
  tick: number;
  timeLeft: number;
  ring: number; // current ring radius
  ack: number; // last input seq the server has applied for YOU
  players: PlayerState[];
  events: SimEvent[];
}

export interface MatchEndMsg {
  ranking: { slot: number; name: string; heroKey: string; lives: number; dead: boolean }[];
}
