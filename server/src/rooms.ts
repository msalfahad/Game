import type { Socket } from 'socket.io';
import { MatchSim, type GameSim, type MatchSeat } from './sim.js';
import { HockeySim } from './hockeysim.js';
import { FreeSim } from './freesim.js';
import { onlineGame, poolFor } from './catalog.js';
import { recordResult, type Account } from './accounts.js';
import { HEROES } from './heroes.js';
import {
  MAX_PLAYERS, SERIES_GAMES, SERIES_WIN,
  type MatchEndMsg, type MatchMode, type MatchPlayerInfo, type MatchStartMsg,
  type QueueUpdateMsg, type RematchUpdateMsg, type RoomUpdateMsg,
  type SeriesEndMsg, type SeriesNextMsg,
} from './protocol.js';

// Party rooms (4-letter codes) + the quick-play queue. Both feed a best-of-5
// SERIES: 5 random games, first to 3 wins, with a countdown intro before each
// game. Empty seats are bots; if a human drops mid-series their seat becomes a
// bot and play continues.

const QUEUE_BOT_FILL_SEC = 12;
const INTRO_SEC = 5; // countdown shown before each game (and result gap between)

interface SeriesState {
  seats: MatchSeat[];
  mode: MatchMode;
  gameIds: string[];
  index: number;                // which game (0-based)
  score: number[];             // wins per slot (FFA) or per team (2v2)
  sim: GameSim | null;
  phase: 'countdown' | 'playing' | 'ended';
  timer: ReturnType<typeof setTimeout> | null;
  rematch: Set<number>;        // slots that voted to rematch
}

interface Session {
  socket: Socket;
  account: Account;
  heroKey: string;
  team: number; // 0 | 1, used when the room is in 2v2 mode
  roomCode: string | null;
  inQueue: boolean;
  match: GameSim | null;
  series: SeriesState | null;
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
      series: null,
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
    if (s.series) this.detachFromSeries(socketId, s.series);
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
      this.startSeries(four);
      this.updateQueueTimer();
    } else if (!this.queueTimer) {
      this.queueDeadline = Date.now() + QUEUE_BOT_FILL_SEC * 1000;
      this.queueTimer = setTimeout(() => {
        this.queueTimer = null;
        if (this.queue.length > 0) this.startSeries(this.queue.splice(0, MAX_PLAYERS));
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
    this.startSeries(members, mode, gameChoice);
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

  // --- series lifecycle -------------------------------------------------------
  private startSeries(socketIds: string[], mode: MatchMode = 'ffa', gameChoice = 'random') {
    const humans = socketIds
      .map((id) => this.sessions.get(id))
      .filter((s): s is Session => !!s);
    if (humans.length === 0) return;
    for (const s of humans) { s.inQueue = false; s.roomCode = null; }

    const seats = this.buildSeats(humans, mode);
    const state: SeriesState = {
      seats, mode, gameIds: this.pickSeriesGames(mode, gameChoice), index: 0,
      score: mode === '2v2' ? [0, 0] : [0, 0, 0, 0],
      sim: null, phase: 'countdown', timer: null, rematch: new Set(),
    };
    for (const seat of seats) {
      if (!seat.socketId) continue;
      const sess = this.sessions.get(seat.socketId);
      if (sess) { sess.series = state; sess.match = null; }
    }
    this.beginIntermission(state, INTRO_SEC, null);
  }

  /** Humans first (keeping teams), bots fill the rest; 2v2 balanced to 2 each. */
  private buildSeats(humans: Session[], mode: MatchMode): MatchSeat[] {
    const seats: MatchSeat[] = humans.map((s) => ({
      socketId: s.socket.id, name: s.account.name, heroKey: s.heroKey,
      team: mode === '2v2' ? s.team : 0,
    }));
    const usedHeroes = new Set(seats.map((s) => s.heroKey));
    const botPool = HEROES.filter((h) => !usedHeroes.has(h.key));
    for (let i = botPool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [botPool[i], botPool[j]] = [botPool[j], botPool[i]]; }
    while (seats.length < MAX_PLAYERS) {
      const h = botPool.pop() ?? HEROES[Math.floor(Math.random() * HEROES.length)];
      const team0 = seats.filter((s) => s.team === 0).length;
      seats.push({ socketId: null, name: h.name + ' (bot)', heroKey: h.key, team: mode === '2v2' ? (team0 <= seats.length - team0 ? 0 : 1) : 0 });
    }
    if (mode === '2v2') {
      let t0 = seats.filter((s) => s.team === 0).length;
      for (const seat of [...seats].reverse()) { if (t0 <= 2) break; if (seat.team === 0 && seat.socketId === null) { seat.team = 1; t0--; } }
      let t1 = seats.filter((s) => s.team === 1).length;
      for (const seat of [...seats].reverse()) { if (t1 <= 2) break; if (seat.team === 1 && seat.socketId === null) { seat.team = 0; t1--; } }
    }
    return seats;
  }

  /** 5 games for the series — random from the mode pool (host's pick leads). */
  private pickSeriesGames(mode: MatchMode, first = 'random'): string[] {
    const poolIds = poolFor(mode).map((g) => g.id);
    const bag: string[] = [];
    const draw = () => { if (bag.length === 0) bag.push(...poolIds); const j = Math.floor(Math.random() * bag.length); return bag.splice(j, 1)[0]; };
    const picks: string[] = [];
    if (first !== 'random' && poolIds.includes(first)) picks.push(first);
    while (picks.length < SERIES_GAMES) picks.push(draw());
    return picks.slice(0, SERIES_GAMES);
  }

  private playersInfo(state: SeriesState): MatchPlayerInfo[] {
    return state.seats.map((s, i) => ({ slot: i, name: s.name, heroKey: s.heroKey, bot: s.socketId === null, team: state.mode === '2v2' ? s.team : i }));
  }
  private seriesEmit(state: SeriesState, event: string, msg: unknown) {
    for (const seat of state.seats) if (seat.socketId) this.sessions.get(seat.socketId)?.socket.emit(event, msg);
  }
  private humanSlots(state: SeriesState): number[] {
    return state.seats.map((s, i) => (s.socketId ? i : -1)).filter((i) => i >= 0);
  }
  private slotOf(state: SeriesState, socketId: string): number {
    return state.seats.findIndex((s) => s.socketId === socketId);
  }

  /** Show the next game + a countdown; kick it off when the timer fires. */
  private beginIntermission(state: SeriesState, inSec: number, last: MatchEndMsg | null) {
    state.phase = 'countdown';
    state.sim = null;
    for (const seat of state.seats) if (seat.socketId) { const sess = this.sessions.get(seat.socketId); if (sess) sess.match = null; }
    const msg: SeriesNextMsg = {
      gameNum: state.index + 1, ofN: SERIES_GAMES, nextGameId: state.gameIds[state.index],
      mode: state.mode, score: [...state.score], players: this.playersInfo(state), inSec,
      lastRanking: last?.ranking, lastWinnerTeam: last?.winnerTeam,
    };
    this.seriesEmit(state, 'series:next', msg);
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => { state.timer = null; this.runGame(state); }, inSec * 1000);
  }

  private runGame(state: SeriesState) {
    if (state.phase === 'ended') return;
    const pool = poolFor(state.mode);
    const gameId = process.env.FORCE_GAME ?? state.gameIds[state.index];
    const def = onlineGame(gameId) ?? pool[0];
    const seats = state.seats, mode = state.mode;
    const sendState = (socketId: string, m: any) => this.sessions.get(socketId)?.socket.emit('state', m);
    const endMatch = (endMsg: MatchEndMsg) => this.onGameEnd(state, endMsg);
    const sim: GameSim = def.mechanic === 'goal' ? new HockeySim(seats, mode, sendState, endMatch)
      : def.mechanic === 'pushout' ? new MatchSim(seats, mode, sendState, endMatch)
      : new FreeSim(seats, def, mode, sendState, endMatch);
    state.sim = sim; state.phase = 'playing';
    for (const seat of seats) if (seat.socketId) { const sess = this.sessions.get(seat.socketId); if (sess) sess.match = sim; }
    seats.forEach((seat, slot) => {
      if (!seat.socketId) return;
      const msg: MatchStartMsg = { gameId, mode, youSlot: slot, duration: def.duration, players: this.playersInfo(state) };
      this.sessions.get(seat.socketId)?.socket.emit('match:start', msg);
    });
    sim.start();
  }

  private onGameEnd(state: SeriesState, endMsg: MatchEndMsg) {
    if (state.phase !== 'playing') return;
    state.phase = 'countdown';
    const winnerSlot = endMsg.ranking[0]?.slot ?? 0;
    if (state.mode === '2v2') { if (endMsg.winnerTeam === 0 || endMsg.winnerTeam === 1) state.score[endMsg.winnerTeam]++; }
    else state.score[winnerSlot] = (state.score[winnerSlot] ?? 0) + 1;
    for (const seat of state.seats) {
      if (!seat.socketId) continue;
      const sess = this.sessions.get(seat.socketId);
      if (!sess) continue;
      sess.match = null;
      sess.socket.emit('match:end', endMsg);
      const won = state.mode === '2v2' ? seat.team === endMsg.winnerTeam : state.seats.indexOf(seat) === winnerSlot;
      recordResult(sess.account.token, won);
    }
    state.sim = null;
    const over = Math.max(...state.score) >= SERIES_WIN || state.index + 1 >= SERIES_GAMES;
    if (over) {
      if (state.timer) clearTimeout(state.timer);
      state.timer = setTimeout(() => { state.timer = null; this.endSeries(state); }, INTRO_SEC * 1000);
    } else {
      state.index++;
      this.beginIntermission(state, INTRO_SEC, endMsg);
    }
  }

  private endSeries(state: SeriesState) {
    state.phase = 'ended';
    state.rematch.clear();
    const winnerTeam = state.mode === '2v2' ? (state.score[0] >= state.score[1] ? 0 : 1) : -1;
    const standings = state.seats.map((s, i) => ({
      slot: i, name: s.name, heroKey: s.heroKey, team: state.mode === '2v2' ? s.team : i,
      wins: state.mode === '2v2' ? state.score[s.team] : (state.score[i] ?? 0),
    }));
    const msg: SeriesEndMsg = { mode: state.mode, score: [...state.score], winnerTeam, standings, players: this.playersInfo(state) };
    this.seriesEmit(state, 'series:end', msg);
  }

  // --- reactions + rematch ----------------------------------------------------
  sendReaction(socketId: string, emojiRaw: unknown) {
    const s = this.sessions.get(socketId);
    if (!s?.series) return;
    const emoji = String(emojiRaw ?? '').slice(0, 12);
    const slot = this.slotOf(s.series, socketId);
    if (!emoji || slot < 0) return;
    this.seriesEmit(s.series, 'reaction:show', { slot, emoji });
  }

  voteRematch(socketId: string) {
    const s = this.sessions.get(socketId);
    const state = s?.series;
    if (!state || state.phase !== 'ended') return;
    const slot = this.slotOf(state, socketId);
    if (slot < 0) return;
    state.rematch.add(slot);
    const humans = this.humanSlots(state);
    this.seriesEmit(state, 'rematch:update', { votedSlots: [...state.rematch], humanSlots: humans } as RematchUpdateMsg);
    // Everyone still here voted → run a fresh 5-game series with the same crew.
    if (humans.length > 0 && humans.every((sl) => state.rematch.has(sl))) {
      const humanIds = state.seats.filter((seat) => seat.socketId).map((seat) => seat.socketId!);
      const mode = state.mode;
      this.disposeSeries(state);
      this.startSeries(humanIds, mode);
    }
  }

  /** "Find New Game": leave the series (seat becomes a bot); back to the lobby. */
  leaveSeries(socketId: string) {
    const s = this.sessions.get(socketId);
    if (s?.series) this.detachFromSeries(socketId, s.series);
  }

  private detachFromSeries(socketId: string, state: SeriesState) {
    const seat = state.seats.find((x) => x.socketId === socketId);
    const slot = this.slotOf(state, socketId);
    if (seat) seat.socketId = null; // seat keeps playing as a bot
    const sess = this.sessions.get(socketId);
    if (sess) { sess.series = null; sess.match = null; }
    if (slot >= 0) state.rematch.delete(slot);
    if (!state.seats.some((x) => x.socketId)) { this.disposeSeries(state); return; }
    if (state.phase === 'ended') {
      const humans = this.humanSlots(state);
      this.seriesEmit(state, 'rematch:update', { votedSlots: [...state.rematch], humanSlots: humans } as RematchUpdateMsg);
      if (humans.length > 0 && humans.every((sl) => state.rematch.has(sl))) {
        const humanIds = state.seats.filter((x) => x.socketId).map((x) => x.socketId!);
        const mode = state.mode;
        this.disposeSeries(state);
        this.startSeries(humanIds, mode);
      }
    }
  }

  private disposeSeries(state: SeriesState) {
    if (state.timer) { clearTimeout(state.timer); state.timer = null; }
    if (state.sim) { state.sim.stop(); state.sim = null; }
    state.phase = 'ended';
    for (const seat of state.seats) if (seat.socketId) { const sess = this.sessions.get(seat.socketId); if (sess && sess.series === state) { sess.series = null; sess.match = null; } }
  }

  handleInput(socketId: string, msg: unknown) {
    const s = this.sessions.get(socketId);
    if (s?.match) s.match.applyInput(socketId, msg as any);
  }
}
