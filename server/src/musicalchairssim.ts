import { heroByKey, type HeroDef } from './heroes.js';
import { ET, TICK_RATE, type EntityState, type InputMsg, type MatchEndMsg, type MatchMode, type PlayerState, type SimEvent, type StateMsg } from './protocol.js';
import type { GameSim, MatchSeat } from './sim.js';

// Authoritative Musical Chairs (Dune Clash) at 20Hz. Everyone marches CLOCKWISE
// around a ring; press = RUN (a forward dash). At a random moment the music cuts
// out (phase -> sit) and you press to grab the nearest free seat. One seat short
// each round, so the odd one out is eliminated (4->3->2->1). Last one seated
// wins. Mirrors src/game/games/musicalchairs.ts (core loop; HIT/secret weapons
// are offline-only for now). Chairs are sent as TARGET entities; aux = phase.

const CHAIR_R = 8.5;
const WALK_R = 14;
const SIT_WINDOW = 3.0;
const ROUND_CAP = 20;
const WALK_OMEGA = 0.55;
const RUN_IMPULSE = 0.5;
const RUN_DECAY = 3.4;
const RUN_CAP = 1.6;
const SIT_RADIUS = 10;     // you can only grab a chair within this distance (~45deg aligned)
const HIT_WINDOW = 4;      // seconds the PUNCH power stays lit
const HIT_REACH = 12;      // how close a rival must be to punch
const STUN_TIME = 1.5;     // knocked-flat duration
const hitCool = () => 3 + Math.random() * 2; // punch relights roughly every ~4s
const PHASE = { walk: 0, sit: 1, gap: 2 } as const;

interface MPlayer {
  slot: number;
  socketId: string | null;
  name: string;
  hero: HeroDef;
  x: number; z: number;
  dead: boolean;
  sitting: boolean;
  ang: number;
  runBoost: number;
  seat: number | null;
  botReact: number;
  outAt: number;
  hitWinT: number;   // PUNCH power window remaining
  hitCoolT: number;  // time until it relights
  fallen: boolean;   // knocked flat
  fallT: number;     // knocked-flat timer
}
interface Chair { x: number; z: number; occupant: number | null; }

export class MusicalChairsSim implements GameSim {
  private players: MPlayer[];
  private chairs: Chair[] = [];
  private phase: number = PHASE.walk;
  private tick = 0;
  private roundT = ROUND_CAP;
  private musicOnT = 0;
  private musicStopAt = 6;
  private sitT = 0;
  private gapT = 0;
  private outCount = 0;
  private wantAct = new Set<string>(); // RUN / SIT presses (ult) this tick
  private wantHit = new Set<string>(); // PUNCH presses (jump) this tick
  private events: SimEvent[] = [];
  private ended = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    seats: MatchSeat[],
    private mode: MatchMode,
    private broadcast: (socketId: string, msg: StateMsg) => void,
    private onEnd: (msg: MatchEndMsg) => void,
  ) {
    this.players = seats.map((s, i) => ({
      slot: i, socketId: s.socketId, name: s.name, hero: heroByKey(s.heroKey),
      x: 0, z: 0, dead: false, sitting: false, ang: 0, runBoost: 0, seat: null,
      botReact: 0, outAt: 0, hitWinT: 0, hitCoolT: 3 + Math.random() * 5, fallen: false, fallT: 0,
    }));
    this.startRound();
  }

  start() { this.timer = setInterval(() => this.step(1 / TICK_RATE), 1000 / TICK_RATE); }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }
  dropPlayer(socketId: string) { const p = this.players.find((q) => q.socketId === socketId); if (p) p.socketId = null; }
  get humanCount(): number { return this.players.filter((p) => p.socketId !== null).length; }
  applyInput(socketId: string, msg: InputMsg) {
    if (msg.ult) this.wantAct.add(socketId);
    if (msg.jump) this.wantHit.add(socketId);
  }

  private alive(): MPlayer[] { return this.players.filter((p) => !p.dead); }

  private startRound() {
    const alive = this.alive();
    if (alive.length <= 1) { this.finish(); return; }
    // One fewer chair than survivors.
    const count = alive.length - 1;
    this.chairs = Array.from({ length: count }, (_, i) => {
      const a = (i / count) * Math.PI * 2 - Math.PI / 2;
      return { x: Math.cos(a) * CHAIR_R, z: Math.sin(a) * CHAIR_R, occupant: null };
    });
    this.phase = PHASE.walk;
    this.roundT = ROUND_CAP;
    this.musicOnT = 0;
    this.musicStopAt = 4 + Math.random() * 5;
    alive.forEach((p, i) => {
      p.sitting = false; p.seat = null; p.runBoost = 0; p.fallen = false; p.fallT = 0;
      p.ang = (i / alive.length) * Math.PI * 2;
      p.x = Math.cos(p.ang) * WALK_R; p.z = Math.sin(p.ang) * WALK_R;
    });
  }

  private stopSong() {
    if (this.phase !== PHASE.walk) return;
    this.phase = PHASE.sit;
    this.sitT = SIT_WINDOW;
    for (const p of this.players) {
      p.botReact = p.socketId ? Infinity : 0.25 + Math.random() * 1.1;
    }
  }

  private claimSeat(p: MPlayer): boolean {
    if (p.seat != null || p.dead || p.fallen) return false;
    let best = -1, bd = Infinity;
    for (let i = 0; i < this.chairs.length; i++) {
      if (this.chairs[i].occupant != null) continue;
      const d = Math.hypot(this.chairs[i].x - p.x, this.chairs[i].z - p.z);
      if (d < bd) { bd = d; best = i; }
    }
    // You can only grab a chair you're actually near (skill / positioning).
    if (best < 0 || bd > SIT_RADIUS) return false;
    this.chairs[best].occupant = p.slot;
    p.seat = best;
    return true;
  }

  /** PUNCH: knock the nearest rival flat while your power is lit. */
  private punch(by: MPlayer) {
    if (by.hitWinT <= 0 || by.fallen) return;
    let victim: MPlayer | null = null, bd = HIT_REACH;
    for (const q of this.alive()) {
      if (q === by || q.fallen || q.sitting) continue;
      const d = Math.hypot(q.x - by.x, q.z - by.z);
      if (d < bd) { bd = d; victim = q; }
    }
    if (!victim) return;
    by.hitWinT = 0; by.hitCoolT = hitCool();
    victim.fallen = true; victim.fallT = STUN_TIME;
    this.events.push({ t: 'hit', slot: victim.slot });
  }

  private resolveRound() {
    const out = this.alive().filter((p) => p.seat == null);
    for (const p of out) {
      p.dead = true; p.sitting = false; p.outAt = ++this.outCount;
      this.events.push({ t: 'fall', slot: p.slot });
    }
    if (this.alive().length <= 1) { this.gapT = 1.1; this.phase = PHASE.gap; return; }
    this.gapT = 1.4;
    this.phase = PHASE.gap;
  }

  private step(dt: number) {
    if (this.ended) return;
    this.tick++;

    if (this.phase === PHASE.walk) {
      this.roundT -= dt;
      this.musicOnT += dt;
      // Punch power windows relight periodically; knocked-flat players recover.
      for (const p of this.alive()) {
        if (p.fallen) { p.fallT -= dt; if (p.fallT <= 0) p.fallen = false; }
        if (p.hitWinT > 0) { p.hitWinT -= dt; if (p.hitWinT <= 0) p.hitCoolT = hitCool(); }
        else { p.hitCoolT -= dt; if (p.hitCoolT <= 0) p.hitWinT = HIT_WINDOW; }
      }
      // Punch presses (humans on jump; bots swing while lit).
      for (const p of this.alive()) {
        if (p.fallen) continue;
        if (p.socketId ? this.wantHit.has(p.socketId) : (p.hitWinT > 0 && Math.random() < dt * 1.5)) this.punch(p);
      }
      // March clockwise (seated/fallen stay put); RUN bursts speed you up.
      for (const p of this.alive()) {
        if (p.sitting || p.fallen) continue;
        if (p.socketId && this.wantAct.has(p.socketId)) p.runBoost = Math.min(RUN_CAP, p.runBoost + RUN_IMPULSE);
        else if (!p.socketId && Math.random() < dt * 0.5) p.runBoost = Math.min(RUN_CAP, p.runBoost + RUN_IMPULSE);
        p.runBoost = Math.max(0, p.runBoost - p.runBoost * RUN_DECAY * dt);
        p.ang -= (WALK_OMEGA + p.runBoost) * dt; // clockwise
        p.x = Math.cos(p.ang) * WALK_R; p.z = Math.sin(p.ang) * WALK_R;
      }
      if (this.musicOnT >= this.musicStopAt || this.roundT <= 0.5) this.stopSong();
    } else if (this.phase === PHASE.sit) {
      this.sitT -= dt;
      for (const p of this.alive()) if (p.fallen) { p.fallT -= dt; if (p.fallT <= 0) p.fallen = false; }
      // Humans claim on press; bots after their reaction delay.
      for (const p of this.alive()) {
        if (p.seat != null || p.sitting) continue;
        if (p.socketId) { if (this.wantAct.has(p.socketId)) this.claimSeat(p); }
        else { p.botReact -= dt; if (p.botReact <= 0) this.claimSeat(p); }
      }
      // Slide claimants onto their seat.
      for (const p of this.alive()) {
        if (p.seat == null || p.sitting) continue;
        const c = this.chairs[p.seat];
        const dx = c.x - p.x, dz = c.z - p.z, d = Math.hypot(dx, dz);
        if (d < 0.6) { p.sitting = true; p.x = c.x; p.z = c.z; }
        else { const s = Math.min(d, dt * 34); p.x += (dx / d) * s; p.z += (dz / d) * s; }
      }
      const seated = this.alive().filter((p) => p.seat != null).length;
      if (this.sitT <= 0 || seated >= this.chairs.length) this.resolveRound();
    } else if (this.phase === PHASE.gap) {
      this.gapT -= dt;
      if (this.gapT <= 0) {
        if (this.alive().length <= 1) { this.sendState(); this.events = []; this.finish(); return; }
        this.startRound();
      }
    }

    this.wantAct.clear();
    this.wantHit.clear();
    this.sendState();
    this.events = [];
  }

  private sendState() {
    const players: PlayerState[] = this.players.map((p) => [
      p.slot, Math.round(p.x * 100) / 100, Math.round(p.z * 100) / 100, 0, 0, p.sitting ? 2.4 : 0,
      p.dead ? 0 : 1, p.dead ? 1 : 0, 0, 0, 0, 0,
      (p.sitting ? 1 : 0) | (p.hitWinT > 0 ? 2 : 0) | (p.fallen ? 4 : 0), // flags: 1=sitting 2=punch-lit 4=fallen
    ]);
    const entities: EntityState[] = this.chairs.map((c, i) =>
      [i, ET.TARGET, Math.round(c.x * 100) / 100, Math.round(c.z * 100) / 100, 0, c.occupant != null ? 1 : 0] as EntityState);
    for (const p of this.players) {
      if (!p.socketId) continue;
      const msg: StateMsg = {
        tick: this.tick,
        timeLeft: Math.max(0, Math.round(this.roundT * 10) / 10),
        ring: 0, ack: 0,
        players, events: this.events, entities,
        aux: this.phase,
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
      .map((p) => ({ slot: p.slot, name: p.name, heroKey: p.hero.key, lives: p.dead ? 0 : 1, dead: p.dead, team: p.slot }));
    this.onEnd({ mode: this.mode, winnerTeam: -1, scoreLabel: 'seat', ranking });
  }
}
