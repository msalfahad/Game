import type { Socket } from 'socket.io';
import { MatchSim, type GameSim, type MatchSeat } from './sim.js';
import { HockeySim } from './hockeysim.js';
import { FreeSim } from './freesim.js';
import { onlineGame, poolFor } from './catalog.js';
import { recordResult, type Account } from './accounts.js';
import { HEROES } from './heroes.js';
import { MAX_PLAYERS, type MatchMode, type MatchStartMsg, type QueueUpdateMsg, type RoomUpdateMsg } from './protocol.js';

// Party rooms (4-letter codes) + the quick-play queue. Both feed the same
// match starter; empty seats are filled with bots (SPEC section 2). A match
// keeps running if a human drops — their seat turns into a bot.

const QUEUE_BOT_FILL_SEC = 12;

interface Session {
  socket: Socket;
  account: Account;
  heroKey: string;
  team: number; // 0 | 1, used when the room is in 2v2 mode
  roomCode: string | null;
  inQueue: boolean;
  match: GameSim | null;
}

interface Room {
  code: string;
  hostId: string; // socket id
  members: string[]; // socket ids, insertion order
  mode: MatchMode;
  gameId: string; // 'random' or a catalog id
  started: boolean;
}

export class Lobby {
  private sessions = new Map<string, Session>();
  private rooms = new Map<string, Room>();
  private queue: string[] = [];
  private queueTimer: ReturnType<typeof setTimeout> | null = null;
  private queueDeadline = 0;

  constructor() {}

  addSession(socket: Socket, account: Account) {
    this.sessions.set(socket.id, {
      socket,
      account,
      heroKey: HEROES[0].key,
      team: 0,
      roomCode: null,
      inQueue: false,
      match: null,
    });
  }

  setHero(socketId: string, heroKey: string) {
    const s = this.sessions.get(socketId);
    if (!s) return;
    if (HEROES.some((h) => h.key === heroKey)) s.heroKey = heroKey;
    if (s.roomCode) this.broadcastRoom(s.roomCode);
  }

  disconnect(socketId: string) {
    const s = this.sessions.get(socketId);
    if (!s) return;
    this.leaveQueue(socketId);
    this.leaveRoom(socketId);
    if (s.match) s.match.dropPlayer(socketId);
    this.sessions.delete(socketId);
  }

  // --- quick play -----------------------------------------------------------
  joinQueue(socketId: string) {
    const s = this.sessions.get(socketId);
    if (!s || s.inQueue || s.match) return;
    this.leaveRoom(socketId);
    s.inQueue = true;
    this.queue.push(socketId);
    if (this.queue.length >= MAX_PLAYERS) {
      const four = this.queue.splice(0, MAX_PLAYERS);
      this.startMatch(four);
      this.updateQueueTimer();
    } else if (!this.queueTimer) {
      this.queueDeadline = Date.now() + QUEUE_BOT_FILL_SEC * 1000;
      this.queueTimer = setTimeout(() => {
        this.queueTimer = null;
        if (this.queue.length > 0) this.startMatch(this.queue.splice(0, MAX_PLAYERS));
      }, QUEUE_BOT_FILL_SEC * 1000);
    }
    this.broadcastQueue();
  }

  leaveQueue(socketId: string) {
    const s = this.sessions.get(socketId);
    if (!s || !s.inQueue) return;
    s.inQueue = false;
    this.queue = this.queue.filter((id) => id !== socketId);
    this.updateQueueTimer();
    this.broadcastQueue();
  }

  private updateQueueTimer() {
    if (this.queue.length === 0 && this.queueTimer) {
      clearTimeout(this.queueTimer);
      this.queueTimer = null;
    }
  }

  private broadcastQueue() {
    const secLeft = this.queueTimer ? Math.max(0, Math.round((this.queueDeadline - Date.now()) / 1000)) : -1;
    const msg: QueueUpdateMsg = { count: this.queue.length, needed: MAX_PLAYERS, botFillInSec: secLeft };
    for (const id of this.queue) this.sessions.get(id)?.socket.emit('queue:update', msg);
  }

  // --- party rooms ----------------------------------------------------------
  createRoom(socketId: string): string | null {
    const s = this.sessions.get(socketId);
    if (!s || s.match) return null;
    this.leaveQueue(socketId);
    this.leaveRoom(socketId);
    let code = '';
    do {
      code = Array.from({ length: 4 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ'[Math.floor(Math.random() * 24)]).join('');
    } while (this.rooms.has(code));
    this.rooms.set(code, { code, hostId: socketId, members: [socketId], mode: 'ffa', gameId: 'random', started: false });
    s.roomCode = code;
    s.team = 0;
    this.broadcastRoom(code);
    return code;
  }

  joinRoom(socketId: string, codeRaw: string): string | null {
    const s = this.sessions.get(socketId);
    const code = (codeRaw || '').toUpperCase().trim();
    const room = this.rooms.get(code);
    if (!s || !room || room.started || room.members.length >= MAX_PLAYERS || s.match) return null;
    this.leaveQueue(socketId);
    this.leaveRoom(socketId);
    room.members.push(socketId);
    s.roomCode = code;
    // Alternate default teams so a fresh 2v2 lobby is already balanced.
    s.team = (room.members.length - 1) % 2;
    this.broadcastRoom(code);
    return code;
  }

  /** Host switches the room between free-for-all and 2v2. */
  setRoomMode(socketId: string, mode: MatchMode) {
    const s = this.sessions.get(socketId);
    if (!s || !s.roomCode) return;
    const room = this.rooms.get(s.roomCode);
    if (!room || room.hostId !== socketId || room.started) return;
    if (mode !== 'ffa' && mode !== '2v2') return;
    room.mode = mode;
    // A game picked for the other mode may be invalid now.
    if (room.gameId !== 'random' && !poolFor(mode).some((g) => g.id === room.gameId)) room.gameId = 'random';
    this.broadcastRoom(room.code);
  }

  /** Host picks a specific map (or 'random') for the room. */
  setRoomGame(socketId: string, gameId: string) {
    const s = this.sessions.get(socketId);
    if (!s || !s.roomCode) return;
    const room = this.rooms.get(s.roomCode);
    if (!room || room.hostId !== socketId || room.started) return;
    if (gameId !== 'random' && !poolFor(room.mode).some((g) => g.id === gameId)) return;
    room.gameId = gameId;
    this.broadcastRoom(room.code);
  }

  /** A member hops to the other team (if it has space). */
  toggleTeam(socketId: string) {
    const s = this.sessions.get(socketId);
    if (!s || !s.roomCode) return;
    const room = this.rooms.get(s.roomCode);
    if (!room || room.started) return;
    const target = s.team === 0 ? 1 : 0;
    const onTarget = room.members.filter((id) => this.sessions.get(id)?.team === target).length;
    if (onTarget >= 2) return; // team is full
    s.team = target;
    this.broadcastRoom(room.code);
  }

  leaveRoom(socketId: string) {
    const s = this.sessions.get(socketId);
    if (!s || !s.roomCode) return;
    const room = this.rooms.get(s.roomCode);
    s.roomCode = null;
    if (!room) return;
    room.members = room.members.filter((id) => id !== socketId);
    if (room.members.length === 0) {
      this.rooms.delete(room.code);
      return;
    }
    if (room.hostId === socketId) room.hostId = room.members[0];
    this.broadcastRoom(room.code);
  }

  startRoom(socketId: string) {
    const s = this.sessions.get(socketId);
    if (!s || !s.roomCode) return;
    const room = this.rooms.get(s.roomCode);
    if (!room || room.hostId !== socketId || room.started) return;
    room.started = true;
    const members = [...room.members];
    const mode = room.mode;
    const gameChoice = room.gameId;
    // The room is consumed; players return to a fresh lobby after the match.
    for (const id of members) {
      const m = this.sessions.get(id);
      if (m) m.roomCode = null;
    }
    this.rooms.delete(room.code);
    this.startMatch(members, mode, gameChoice);
  }

  private broadcastRoom(code: string) {
    const room = this.rooms.get(code);
    if (!room) return;
    for (const viewerId of room.members) {
      const msg: RoomUpdateMsg = {
        code,
        mode: room.mode,
        gameId: room.gameId,
        players: room.members.map((id) => {
          const m = this.sessions.get(id)!;
          return {
            name: m.account.name,
            heroKey: m.heroKey,
            host: id === room.hostId,
            bot: false,
            team: m.team,
            you: id === viewerId,
          };
        }),
      };
      this.sessions.get(viewerId)?.socket.emit('room:update', msg);
    }
  }

  // --- match lifecycle --------------------------------------------------------
  private startMatch(socketIds: string[], mode: MatchMode = 'ffa', gameChoice = 'random') {
    const humans = socketIds
      .map((id) => this.sessions.get(id))
      .filter((s): s is Session => !!s);
    if (humans.length === 0) return;

    for (const s of humans) {
      s.inQueue = false;
      s.roomCode = null;
    }

    // Seats: humans first (keeping their chosen teams), bots fill the rest.
    const seats: MatchSeat[] = humans.map((s) => ({
      socketId: s.socket.id,
      name: s.account.name,
      heroKey: s.heroKey,
      team: mode === '2v2' ? s.team : 0,
    }));
    const usedHeroes = new Set(seats.map((s) => s.heroKey));
    const botPool = HEROES.filter((h) => !usedHeroes.has(h.key));
    for (let i = botPool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [botPool[i], botPool[j]] = [botPool[j], botPool[i]];
    }
    while (seats.length < MAX_PLAYERS) {
      const h = botPool.pop() ?? HEROES[Math.floor(Math.random() * HEROES.length)];
      // 2v2: each bot joins whichever team is currently smaller.
      const team0 = seats.filter((s) => s.team === 0).length;
      seats.push({
        socketId: null,
        name: h.name + ' (bot)',
        heroKey: h.key,
        team: mode === '2v2' ? (team0 <= seats.length - team0 ? 0 : 1) : 0,
      });
    }
    if (mode === '2v2') {
      // Safety: exactly two per team, even if humans stacked one side.
      let t0 = seats.filter((s) => s.team === 0).length;
      for (const seat of [...seats].reverse()) {
        if (t0 <= 2) break;
        if (seat.team === 0 && seat.socketId === null) { seat.team = 1; t0--; }
      }
      let t1 = seats.filter((s) => s.team === 1).length;
      for (const seat of [...seats].reverse()) {
        if (t1 <= 2) break;
        if (seat.team === 1 && seat.socketId === null) { seat.team = 0; t1--; }
      }
    }

    const pool = poolFor(mode);
    // FORCE_GAME pins the map for testing (e.g. FORCE_GAME=frost-1 npm start).
    const gameId =
      process.env.FORCE_GAME ??
      (gameChoice !== 'random' && pool.some((g) => g.id === gameChoice)
        ? gameChoice
        : pool[Math.floor(Math.random() * pool.length)].id);
    const def = onlineGame(gameId) ?? pool[0];

    const makeSim = (): GameSim => {
      if (def.mechanic === 'goal') return new HockeySim(seats, mode, sendState, endMatch);
      if (def.mechanic === 'pushout') return new MatchSim(seats, mode, sendState, endMatch);
      return new FreeSim(seats, def, mode, sendState, endMatch);
    };
    const sendState = (socketId: string, msg: any) => this.sessions.get(socketId)?.socket.emit('state', msg);
    const endMatch = (endMsg: any) => {
      const winnerSlot = endMsg.ranking[0]?.slot;
      for (const seat of seats) {
        if (!seat.socketId) continue;
        const sess = this.sessions.get(seat.socketId);
        if (!sess) continue;
        sess.match = null;
        sess.socket.emit('match:end', endMsg);
        const mySlot = seats.indexOf(seat);
        const won = mode === '2v2' ? seat.team === endMsg.winnerTeam : mySlot === winnerSlot;
        recordResult(sess.account.token, won);
      }
    };
    const sim: GameSim = makeSim();

    for (const s of humans) s.match = sim;

    seats.forEach((seat, slot) => {
      if (!seat.socketId) return;
      const msg: MatchStartMsg = {
        gameId,
        mode,
        youSlot: slot,
        duration: def.duration,
        players: seats.map((s2, i) => ({
          slot: i,
          name: s2.name,
          heroKey: s2.heroKey,
          bot: s2.socketId === null,
          team: mode === '2v2' ? s2.team : i,
        })),
      };
      this.sessions.get(seat.socketId)?.socket.emit('match:start', msg);
    });

    sim.start();
  }

  handleInput(socketId: string, msg: unknown) {
    const s = this.sessions.get(socketId);
    if (s?.match) s.match.applyInput(socketId, msg as any);
  }
}
