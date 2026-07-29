import { heroByKey, type HeroDef } from './heroes.js';
import { ET, TICK_RATE, type EntityState, type InputMsg, type MatchEndMsg, type MatchMode, type PlayerState, type SimEvent, type StateMsg } from './protocol.js';
import type { GameSim, MatchSeat } from './sim.js';

// Authoritative Race Kart (Dune Clash) at 20Hz. Karts cruise anticlockwise
// round a desert ring; hold BOOST to floor it, steer with the stick to weave
// for item pickups, tap ITEM to use the held item (⚽ ball / 🍌 banana / 👟 boost
// / ⚡ zap / 🚀 rocket). Most laps when the clock runs out wins. Mirrors
// src/game/games/kart.ts. cd = kart heading, score = laps, flags = held item
// (0 none, 1 ball, 2 banana, 3 boost, 4 zap, 5 rocket). Entities: pickups
// (ET.LOOT extra=itemKind 0..4), bananas (ET.ITEM), shots (ET.MISSILE extra=0
// ball / 1 rocket).

const HALF = 30;
const DUR = 60;
const CRUISE = 15;
const BOOST = 25;
const ACCEL = 2.4;
const TURN = 2.4;
const AUTOCURVE = 2.0;
const OUTER = HALF - 3;
const INNER = HALF * 0.42;
const MID = (INNER + OUTER) / 2;

// Item kinds: 0 ball, 1 banana, 2 boost, 3 zap, 4 rocket.
type Item = 0 | 1 | 2 | 3 | 4;

interface Pickup { id: number; x: number; z: number; kind: Item; }
interface Banana { id: number; x: number; z: number; }
interface Shot { id: number; x: number; z: number; vx: number; vz: number; kind: 0 | 1; owner: number; life: number; }
interface KPlayer {
  slot: number; socketId: string | null; name: string; hero: HeroDef;
  x: number; z: number; vx: number; vz: number;
  head: number; speed: number; spinT: number; freezeT: number; speedT: number;
  progress: number; lastTheta: number; laps: number;
  held: Item | -1; botItemT: number; cruiseMul: number;
  wantItem: boolean; boost: boolean;
  input: InputMsg;
}

export class KartSim implements GameSim {
  private players: KPlayer[];
  private pickups: Pickup[] = [];
  private bananas: Banana[] = [];
  private shots: Shot[] = [];
  private entId = 1;
  private pickupT = 2;
  private timeLeft = DUR;
  private tick = 0;
  private events: SimEvent[] = [];
  private ended = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    seats: MatchSeat[],
    private mode: MatchMode,
    private broadcast: (socketId: string, msg: StateMsg) => void,
    private onEnd: (msg: MatchEndMsg) => void,
  ) {
    this.players = seats.map((s, i) => {
      const lane = INNER + 4 + (i % 2) * (OUTER - INNER - 8);
      const th = -0.16 - i * 0.34;
      const x = Math.cos(th) * lane, z = Math.sin(th) * lane;
      return {
        slot: i, socketId: s.socketId, name: s.name, hero: heroByKey(s.heroKey),
        x, z, vx: 0, vz: 0,
        head: this.tangentHead(x, z), speed: 0, spinT: 0, freezeT: 0, speedT: 0,
        progress: 0, lastTheta: Math.atan2(z, x), laps: 0,
        held: -1, botItemT: 0, cruiseMul: 0.92 + Math.random() * 0.16,
        wantItem: false, boost: false, input: { seq: 0, ax: 0, ay: 0 },
      };
    });
  }

  start() { this.timer = setInterval(() => this.step(1 / TICK_RATE), 1000 / TICK_RATE); }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }
  dropPlayer(socketId: string) { const p = this.players.find((q) => q.socketId === socketId); if (p) p.socketId = null; }
  get humanCount(): number { return this.players.filter((p) => p.socketId !== null).length; }
  applyInput(socketId: string, msg: InputMsg) {
    const p = this.players.find((q) => q.socketId === socketId);
    if (!p) return;
    p.input = { seq: msg.seq, ax: Math.max(-1, Math.min(1, msg.ax || 0)), ay: 0 };
    p.boost = !!msg.ult;         // held boost
    if (msg.jump) p.wantItem = true; // use item (edge)
  }

  private tangentHead(x: number, z: number): number {
    const r = Math.hypot(x, z) || 0.001;
    return Math.atan2(-z / r, x / r);
  }

  private step(dt: number) {
    if (this.ended) return;
    this.tick++;
    this.timeLeft -= dt;

    for (const p of this.players) {
      p.freezeT = Math.max(0, p.freezeT - dt);
      p.speedT = Math.max(0, p.speedT - dt);
      if (p.socketId === null) this.botThink(p, dt);
      this.driveKart(p, dt);
    }
    this.separateKarts();
    for (const p of this.players) this.clampToTrack(p);

    // Use items (edge-triggered for humans; bots timed in botThink).
    for (const p of this.players) {
      if (p.wantItem) { p.wantItem = false; this.useItem(p); }
    }

    this.tickPickups(dt);
    this.tickBananas();
    this.tickShots(dt);

    this.sendState();
    this.events = [];
    if (this.timeLeft <= 0) this.finish();
  }

  private driveKart(p: KPlayer, dt: number) {
    if (p.spinT > 0) {
      p.spinT -= dt;
      p.head += dt * 12;
      p.speed += (CRUISE * 0.15 - p.speed) * ACCEL * dt;
    } else if (p.freezeT > 0) {
      p.speed += (0 - p.speed) * 6 * dt;
    } else {
      const tHead = this.tangentHead(p.x, p.z);
      const steer = p.socketId === null ? this.botSteer(p) : -p.input.ax;
      p.head += steer * TURN * dt;
      let d = tHead - p.head;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      p.head += d * AUTOCURVE * dt;
      const wantBoost = p.socketId === null ? Math.random() < 0.65 : p.boost;
      let target = (wantBoost ? BOOST : CRUISE) * p.cruiseMul;
      if (p.speedT > 0) target *= 1.5;
      p.speed += (target - p.speed) * ACCEL * dt;
    }
    const fx = Math.sin(p.head), fz = Math.cos(p.head);
    p.x += fx * p.speed * dt; p.z += fz * p.speed * dt;
    p.vx = fx * p.speed; p.vz = fz * p.speed;
    if (this.clampToTrack(p)) p.speed *= 0.92;

    const th = Math.atan2(p.z, p.x);
    let dth = th - p.lastTheta;
    while (dth > Math.PI) dth -= Math.PI * 2;
    while (dth < -Math.PI) dth += Math.PI * 2;
    p.progress += dth;
    p.lastTheta = th;
    const lap = Math.floor(p.progress / (Math.PI * 2));
    if (lap > p.laps) p.laps = lap;
  }

  private botSteer(p: KPlayer): number {
    let best: Pickup | null = null, bd = 16;
    for (const pk of this.pickups) { const d = Math.hypot(pk.x - p.x, pk.z - p.z); if (d < bd) { bd = d; best = pk; } }
    if (!best || p.held >= 0) return (Math.random() - 0.5) * 0.2;
    const want = Math.atan2(best.x - p.x, best.z - p.z);
    let d = want - p.head;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return Math.max(-1, Math.min(1, d * 1.5));
  }

  private botThink(p: KPlayer, dt: number) {
    if (p.held >= 0) { p.botItemT -= dt; if (p.botItemT <= 0) p.wantItem = true; }
  }

  private clampToTrack(p: KPlayer): boolean {
    const r = Math.hypot(p.x, p.z) || 0.001;
    const lo = INNER + 1.6, hi = OUTER - 1.6;
    if (r < lo || r > hi) {
      const clamped = Math.max(lo, Math.min(hi, r));
      p.x = (p.x / r) * clamped; p.z = (p.z / r) * clamped;
      return true;
    }
    return false;
  }

  private separateKarts() {
    const ps = this.players;
    for (let a = 0; a < ps.length; a++) {
      for (let b = a + 1; b < ps.length; b++) {
        const pa = ps[a], pb = ps[b];
        const dx = pb.x - pa.x, dz = pb.z - pa.z, d = Math.hypot(dx, dz);
        if (d > 0.001 && d < 3.4) {
          const push = (3.4 - d) / 2, nx = dx / d, nz = dz / d;
          pa.x -= nx * push; pa.z -= nz * push;
          pb.x += nx * push; pb.z += nz * push;
        }
      }
    }
  }

  // --- pickups ----------------------------------------------------------------
  private tickPickups(dt: number) {
    this.pickupT -= dt;
    if (this.pickupT <= 0 && this.pickups.length < 5) { this.pickupT = 1.5 + Math.random() * 2; this.spawnPickup(); }
    for (let i = this.pickups.length - 1; i >= 0; i--) {
      const pk = this.pickups[i];
      const taker = this.players.find((p) => p.held < 0 && Math.hypot(p.x - pk.x, p.z - pk.z) < 4);
      if (!taker) continue;
      this.pickups.splice(i, 1);
      taker.held = pk.kind;
      if (taker.socketId === null) taker.botItemT = 0.8 + Math.random() * 2.5;
      this.events.push({ t: 'pick', slot: taker.slot, k: pk.kind });
    }
  }

  private spawnPickup() {
    const kind = Math.floor(Math.random() * 5) as Item;
    const a = Math.random() * Math.PI * 2;
    const r = MID + (Math.random() - 0.5) * 7;
    this.pickups.push({ id: this.entId++, x: Math.cos(a) * r, z: Math.sin(a) * r, kind });
  }

  private useItem(p: KPlayer) {
    const kind = p.held;
    if (kind < 0 || this.ended) return;
    p.held = -1;
    if (kind === 2) { // boost
      p.speedT = Math.max(p.speedT, 2.6);
      this.events.push({ t: 'power', slot: p.slot, k: 2 });
    } else if (kind === 1) { // banana
      const bx = p.x - Math.sin(p.head) * 3, bz = p.z - Math.cos(p.head) * 3;
      this.bananas.push({ id: this.entId++, x: bx, z: bz });
    } else if (kind === 3) { // zap
      for (const q of this.players) { if (q === p) continue; q.freezeT = Math.max(q.freezeT, 1.0); }
      this.events.push({ t: 'power', slot: p.slot, k: 3 });
    } else { // ball (0) or rocket (4)
      this.fireShot(p, kind === 4 ? 1 : 0);
    }
  }

  private fireShot(p: KPlayer, kind: 0 | 1) {
    const speed = kind === 1 ? 44 : 26;
    const fx = Math.sin(p.head), fz = Math.cos(p.head);
    this.shots.push({ id: this.entId++, x: p.x + fx * 3, z: p.z + fz * 3, vx: fx * speed, vz: fz * speed, kind, owner: p.slot, life: kind === 1 ? 2.2 : 3.2 });
    this.events.push({ t: 'hit', slot: p.slot });
  }

  private tickBananas() {
    for (let i = this.bananas.length - 1; i >= 0; i--) {
      const b = this.bananas[i];
      const hit = this.players.find((p) => p.spinT <= 0 && p.freezeT <= 0 && Math.hypot(p.x - b.x, p.z - b.z) < 2.4);
      if (!hit) continue;
      this.bananas.splice(i, 1);
      hit.spinT = 1.3;
      this.events.push({ t: 'hit', slot: hit.slot });
    }
  }

  private aheadOf(owner: number): KPlayer | null {
    let best: KPlayer | null = null, bd = Infinity;
    const o = this.players[owner];
    for (const p of this.players) {
      if (p.slot === owner) continue;
      const lead = p.progress - o.progress;
      if (lead > 0 && lead < bd) { bd = lead; best = p; }
    }
    if (!best) {
      let nd = Infinity;
      for (const p of this.players) {
        if (p.slot === owner) continue;
        const d = Math.hypot(p.x - o.x, p.z - o.z);
        if (d < nd) { nd = d; best = p; }
      }
    }
    return best;
  }

  private tickShots(dt: number) {
    for (let i = this.shots.length - 1; i >= 0; i--) {
      const s = this.shots[i];
      s.life -= dt;
      const tgt = this.aheadOf(s.owner);
      if (tgt) {
        const dx = tgt.x - s.x, dz = tgt.z - s.z, L = Math.hypot(dx, dz) || 1;
        const homing = s.kind === 1 ? 120 : 70;
        s.vx += (dx / L) * homing * dt; s.vz += (dz / L) * homing * dt;
        const sp = Math.hypot(s.vx, s.vz), cap = s.kind === 1 ? 50 : 30;
        if (sp > cap) { s.vx = (s.vx / sp) * cap; s.vz = (s.vz / sp) * cap; }
      }
      s.x += s.vx * dt; s.z += s.vz * dt;
      const r = Math.hypot(s.x, s.z);
      let hit: KPlayer | null = null;
      for (const p of this.players) {
        if (p.slot === s.owner) continue;
        if (Math.hypot(p.x - s.x, p.z - s.z) < 2.6) { hit = p; break; }
      }
      if (hit) {
        if (s.kind === 1) { hit.freezeT = Math.max(hit.freezeT, 0.9); hit.spinT = 0.6; }
        else hit.spinT = 1.0;
        this.events.push({ t: 'hit', slot: hit.slot });
        this.shots.splice(i, 1);
      } else if (s.life <= 0 || r < INNER - 2 || r > OUTER + 2) {
        this.shots.splice(i, 1);
      }
    }
  }

  private sendState() {
    const players: PlayerState[] = this.players.map((p) => [
      p.slot, Math.round(p.x * 100) / 100, Math.round(p.z * 100) / 100,
      Math.round(p.vx * 100) / 100, Math.round(p.vz * 100) / 100, 0.55,
      1, 0, Math.round(p.freezeT * 100) / 100, 0,
      Math.round(p.head * 1000) / 1000,      // cd = kart heading
      p.laps,                                 // score = laps
      p.held + 1,                             // flags = held item (0 none, 1..5)
    ]);
    const entities: EntityState[] = [];
    for (const pk of this.pickups) entities.push([pk.id, ET.LOOT, Math.round(pk.x * 100) / 100, Math.round(pk.z * 100) / 100, 0, pk.kind]);
    for (const b of this.bananas) entities.push([b.id, ET.ITEM, Math.round(b.x * 100) / 100, Math.round(b.z * 100) / 100, 0, 0]);
    for (const s of this.shots) entities.push([s.id, ET.MISSILE, Math.round(s.x * 100) / 100, Math.round(s.z * 100) / 100, 0, s.kind]);
    for (const p of this.players) {
      if (!p.socketId) continue;
      const msg: StateMsg = {
        tick: this.tick, timeLeft: Math.max(0, Math.round(this.timeLeft * 10) / 10),
        ring: 0, ack: p.input.seq, players, events: this.events, entities,
      };
      this.broadcast(p.socketId, msg);
    }
  }

  private finish() {
    if (this.ended) return;
    this.ended = true;
    this.stop();
    const ranking = [...this.players]
      .sort((a, b) => b.progress - a.progress)
      .map((p) => ({ slot: p.slot, name: p.name, heroKey: p.hero.key, lives: p.laps, dead: false, team: p.slot }));
    this.onEnd({ mode: this.mode, winnerTeam: -1, scoreLabel: 'laps', ranking });
  }
}
