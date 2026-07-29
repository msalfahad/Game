import { heroByKey, type HeroDef } from './heroes.js';
import { TICK_RATE, type InputMsg, type MatchEndMsg, type MatchMode, type PlayerState, type SimEvent, type StateMsg } from './protocol.js';
import type { GameSim, MatchSeat } from './sim.js';

// Authoritative Watermelon Bomb (hot potato) at 20Hz. Players stand STILL in a
// ring; a melon with a hidden fuse is passed around (press = pass to a random
// rival). Whoever holds it when the fuse blows is splatted OUT. Last one dry
// wins; 60s cap. Mirrors src/game/games/hotpotato.ts.

const GAME_TIME = 60;
const THROW_CD = 0.35;
const RING_R = 8.5;

interface HPlayer {
  slot: number;
  socketId: string | null;
  name: string;
  hero: HeroDef;
  x: number; z: number;
  dead: boolean;
  freezeT: number;
  outAt: number; // elimination order (for ranking)
}

export class HotPotatoSim implements GameSim {
  private players: HPlayer[];
  private tick = 0;
  private elapsed = 0;
  private timeLeft = GAME_TIME;
  private holder = 0;
  private armT = 0;
  private fuse = 10;
  private canThrowAt = 0;
  private botThrowAt = 3;
  private outCount = 0;
  private wantPass = new Map<string, number>(); // holder socketId -> target slot (-1 = nearest/random)
  private events: SimEvent[] = [];
  private ended = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    seats: MatchSeat[],
    private mode: MatchMode,
    private broadcast: (socketId: string, msg: StateMsg) => void,
    private onEnd: (msg: MatchEndMsg) => void,
  ) {
    const n = seats.length;
    this.players = seats.map((s, i) => {
      const a = (i / n) * Math.PI * 2 + Math.PI / 4;
      return {
        slot: i, socketId: s.socketId, name: s.name, hero: heroByKey(s.heroKey),
        x: Math.cos(a) * RING_R, z: Math.sin(a) * RING_R,
        dead: false, freezeT: 0, outAt: 0,
      };
    });
    this.arm(Math.floor(Math.random() * this.players.length));
  }

  start() { this.timer = setInterval(() => this.step(1 / TICK_RATE), 1000 / TICK_RATE); }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }
  dropPlayer(socketId: string) { const p = this.players.find((q) => q.socketId === socketId); if (p) p.socketId = null; }
  get humanCount(): number { return this.players.filter((p) => p.socketId !== null).length; }

  applyInput(socketId: string, msg: InputMsg) {
    // Only the current holder can pass; the ult/jump press throws the melon.
    const p = this.players.find((q) => q.socketId === socketId);
    if (p && !p.dead && p.slot === this.holder && (msg.ult || msg.jump)) {
      this.wantPass.set(socketId, typeof msg.target === 'number' ? msg.target : -1);
    }
  }

  private alive(): HPlayer[] { return this.players.filter((p) => !p.dead); }

  private arm(idx: number) {
    this.holder = idx;
    this.armT = 0;
    this.fuse = 8 + Math.random() * 7;
    this.canThrowAt = this.elapsed + 0.6;
    this.botThrowAt = 2.5 + Math.random() * 4;
  }

  private pass(target = -1) {
    if (this.elapsed < this.canThrowAt) return;
    const others = this.alive().filter((p) => p.slot !== this.holder);
    if (!others.length) return;
    // Pass to the tapped rival if valid, otherwise a random one.
    const to = others.find((p) => p.slot === target) ?? others[Math.floor(Math.random() * others.length)];
    this.holder = to.slot;
    this.canThrowAt = this.elapsed + THROW_CD;
    this.botThrowAt = 2 + Math.random() * 3.5;
    this.events.push({ t: 'hit', slot: to.slot }); // pass cue
  }

  private explode() {
    const victim = this.players[this.holder];
    if (!victim || victim.dead) return;
    victim.dead = true;
    victim.freezeT = 0.6;
    victim.outAt = ++this.outCount;
    this.events.push({ t: 'out', slot: victim.slot });
    const left = this.alive();
    if (left.length >= 2) this.arm(left[Math.floor(Math.random() * left.length)].slot);
  }

  private step(dt: number) {
    if (this.ended) return;
    this.tick++;
    this.elapsed += dt;
    this.timeLeft -= dt;
    this.armT += dt;
    for (const p of this.players) if (p.freezeT > 0) p.freezeT = Math.max(0, p.freezeT - dt);

    const holderP = this.players[this.holder];
    if (!holderP.dead) {
      if (holderP.socketId === null) {
        // Bot holder gets nervous and passes.
        if (this.elapsed >= this.canThrowAt && (this.armT > this.botThrowAt || this.armT > 7)) this.pass();
      } else if (this.wantPass.has(holderP.socketId)) {
        this.pass(this.wantPass.get(holderP.socketId) ?? -1);
      }
    }
    this.wantPass.clear();

    if (this.armT >= this.fuse || this.timeLeft <= 0) this.explode();

    this.sendState();
    this.events = [];

    if (this.alive().length <= 1 || this.timeLeft <= 0) this.finish();
  }

  private sendState() {
    const players: PlayerState[] = this.players.map((p) => [
      p.slot, Math.round(p.x * 100) / 100, Math.round(p.z * 100) / 100, 0, 0, 0,
      p.dead ? 0 : 1, p.dead ? 1 : 0, Math.round(p.freezeT * 100) / 100, 0, 0, 0,
      p.slot === this.holder ? 1 : 0, // flags bit0 = melon holder
    ]);
    for (const p of this.players) {
      if (!p.socketId) continue;
      const msg: StateMsg = {
        tick: this.tick,
        timeLeft: Math.max(0, Math.round(this.timeLeft * 10) / 10),
        ring: 0,
        ack: 0,
        players,
        events: this.events,
        aux: Math.round(this.armT * 100) / 100, // live-melon count-up
      };
      this.broadcast(p.socketId, msg);
    }
  }

  private finish() {
    if (this.ended) return;
    this.ended = true;
    this.stop();
    const ranking = [...this.players]
      .sort((a, b) => (a.dead ? a.outAt : 1e5) - (b.dead ? b.outAt : 1e5))
      .reverse()
      .map((p) => ({
        slot: p.slot, name: p.name, heroKey: p.hero.key,
        lives: p.dead ? 0 : 1, dead: p.dead, team: p.slot,
      }));
    this.onEnd({ mode: this.mode, winnerTeam: -1, scoreLabel: 'dry', ranking });
  }
}
