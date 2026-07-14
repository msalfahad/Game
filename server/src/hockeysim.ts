import { heroByKey, speedMult, strengthMult, accuracyMult, type HeroDef } from './heroes.js';
import { TICK_RATE, type InputMsg, type MatchEndMsg, type MatchMode, type SimEvent, type StateMsg } from './protocol.js';
import type { MatchSeat } from './sim.js';

// Authoritative Ice/Lava Hockey (goal mechanic) at 20Hz. Mirrors the client's
// hockey physics: 4 paddles on the walls of a small rink (half = 14.4), pucks
// with speed caps, strength-scaled deflection, power shots (ult arms the next
// deflection), sealed walls for eliminated players, 20 pts each, 0 = OUT.

const HALF = 14.4; // ASBASE 30 * 0.48, matching the client rink
const HITBOX = 3.0;
const DURATION = 120;
const SIDES = ['bottom', 'top', 'left', 'right'] as const;
type Side = (typeof SIDES)[number];

interface HPlayer {
  slot: number;
  socketId: string | null;
  name: string;
  hero: HeroDef;
  side: Side;
  pos: number; // 0..1 along the wall
  pts: number;
  dead: boolean;
  armed: boolean;
  cd: number;
  input: InputMsg;
  ackSeq: number;
  // bot AI
  retarget: number;
  want: number;
}

interface Ball {
  x: number; z: number; y: number;
  vx: number; vz: number; vy: number;
  power: number;
  grace: number;
}

export class HockeySim {
  private players: HPlayer[];
  private balls: Ball[] = [];
  private timeLeft = DURATION;
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
    this.players = seats.map((s, i) => ({
      slot: i,
      socketId: s.socketId,
      name: s.name,
      hero: heroByKey(s.heroKey),
      side: SIDES[i],
      pos: 0.5,
      pts: 10,
      dead: false,
      armed: false,
      cd: 0,
      input: { seq: 0, ax: 0, ay: 0 },
      ackSeq: 0,
      retarget: 0,
      want: 0.5,
    }));
    this.spawnBall();
  }

  start() {
    this.timer = setInterval(() => this.step(1 / TICK_RATE), 1000 / TICK_RATE);
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
  applyInput(socketId: string, msg: InputMsg) {
    const p = this.players.find((q) => q.socketId === socketId);
    if (!p || p.dead) return;
    p.input = {
      seq: msg.seq,
      ax: Math.max(-1, Math.min(1, msg.ax || 0)),
      ay: 0,
      pos: typeof msg.pos === 'number' ? Math.max(0, Math.min(1, msg.pos)) : undefined,
      ult: !!msg.ult,
    };
  }
  dropPlayer(socketId: string) {
    const p = this.players.find((q) => q.socketId === socketId);
    if (p) p.socketId = null;
  }
  get humanCount(): number {
    return this.players.filter((p) => p.socketId !== null).length;
  }

  private edgePos(p: HPlayer): [number, number] {
    const P = (p.pos - 0.5) * 2 * HALF;
    if (p.side === 'bottom') return [P, HALF];
    if (p.side === 'top') return [P, -HALF];
    if (p.side === 'left') return [-HALF, P];
    return [HALF, P];
  }

  // Pucks serve from a random CORNER pad, aimed inward (matches the client
  // rink deco); corner posts (r=2.4) guard the seams between walls.
  private cornerServe(speed: number): { x: number; z: number; vx: number; vz: number } {
    const sx = (Math.random() < 0.5 ? -1 : 1) * (HALF - 2.6);
    const sz = (Math.random() < 0.5 ? -1 : 1) * (HALF - 2.6);
    const a = Math.atan2(-sz, -sx) + (Math.random() - 0.5) * 0.9;
    return { x: sx, z: sz, vx: Math.cos(a) * speed, vz: Math.sin(a) * speed };
  }
  private cornerBounce(b: Ball) {
    const R = 2.4 + 0.9;
    for (const cx of [-HALF, HALF]) {
      for (const cz of [-HALF, HALF]) {
        const dx = b.x - cx, dz = b.z - cz;
        const d = Math.hypot(dx, dz);
        if (d > R || d === 0) continue;
        const nx = dx / d, nz = dz / d;
        const dot = b.vx * nx + b.vz * nz;
        if (dot < 0) { b.vx -= 2 * dot * nx; b.vz -= 2 * dot * nz; }
        b.x = cx + nx * R;
        b.z = cz + nz * R;
      }
    }
  }
  private spawnBall() {
    const s = this.cornerServe(25);
    this.balls.push({ x: s.x, z: s.z, vx: s.vx, vz: s.vz, y: 1.4, vy: 0, power: 0, grace: 0.7 });
  }
  private resetBall(b: Ball) {
    const s = this.cornerServe(23);
    b.x = s.x; b.z = s.z; b.vx = s.vx; b.vz = s.vz;
    b.grace = 0.8; b.power = 0;
  }

  private paddleSpeed(p: HPlayer): number {
    return 0.85 + speedMult(p.hero) * 1.1;
  }

  private step(dt: number) {
    if (this.ended) return;
    this.tick++;
    this.timeLeft -= dt;
    if (this.timeLeft < DURATION * 0.7 && this.balls.length < 2) this.spawnBall();
    if (this.timeLeft < DURATION * 0.33 && this.balls.length < 3) this.spawnBall();

    const R = HITBOX / HALF / 2 + 0.02;
    const prevPos = this.players.map((p) => p.pos);
    for (const p of this.players) {
      if (p.dead) continue;
      p.cd = Math.max(0, p.cd - dt);
      if (p.socketId === null) this.botThink(p, dt);
      else {
        // Humans steer toward their requested absolute position (1:1 drag on
        // the client), rate-limited so nobody teleports across the wall.
        const target = p.input.pos ?? p.pos + p.input.ax * this.paddleSpeed(p) * dt;
        const maxMove = this.paddleSpeed(p) * 3 * dt;
        p.pos += Math.max(-maxMove, Math.min(maxMove, target - p.pos));
      }
      p.pos = Math.max(R, Math.min(1 - R, p.pos));
      if (p.input.ult) {
        p.input.ult = false;
        if (!p.armed && p.cd <= 0) {
          p.armed = true;
          this.events.push({ t: 'power', slot: p.slot });
        }
      }
      p.ackSeq = p.input.seq;
    }
    this.players.forEach((p, i) => ((p as any)._pvel = (p.pos - prevPos[i]) / dt));

    this.tickBalls(dt);
    this.sendState();
    this.events = [];

    const alive = this.players.filter((p) => !p.dead);
    if (this.timeLeft <= 0 || alive.length <= 1) this.finish();
  }

  private botThink(p: HPlayer, dt: number) {
    p.retarget -= dt;
    if (p.retarget <= 0) {
      p.retarget = 0.35 + Math.random() * 0.35;
      let target: Ball | null = null;
      let best = 1e9;
      for (const b of this.balls) {
        let d: number | null = null;
        if (p.side === 'top' && b.vz < 0) d = (b.z + HALF) / -b.vz;
        if (p.side === 'bottom' && b.vz > 0) d = (HALF - b.z) / b.vz;
        if (p.side === 'left' && b.vx < 0) d = (b.x + HALF) / -b.vx;
        if (p.side === 'right' && b.vx > 0) d = (HALF - b.x) / b.vx;
        if (d != null && d < best) { best = d; target = b; }
      }
      let w = 0.5;
      if (target) {
        const tp = p.side === 'top' || p.side === 'bottom' ? target.x : target.z;
        const err = 0.15 / accuracyMult(p.hero);
        w = (tp / HALF + 1) / 2 + (Math.random() - 0.5) * err;
      }
      p.want = w;
    }
    const v = this.paddleSpeed(p) * 0.66 * (1 / TICK_RATE) * TICK_RATE * dt;
    if (Math.abs(p.want - p.pos) > 0.008) p.pos += Math.sign(p.want - p.pos) * Math.min(v, Math.abs(p.want - p.pos));
  }

  private concede(p: HPlayer, b: Ball) {
    p.pts--;
    this.events.push({ t: 'goal', slot: p.slot });
    if (p.pts <= 0) {
      p.dead = true;
      this.events.push({ t: 'out', slot: p.slot });
    }
    this.resetBall(b);
  }

  private tickBalls(dt: number) {
    const edge = HALF - 2;
    for (const b of this.balls) {
      b.grace -= dt;
      b.x += b.vx * dt; b.z += b.vz * dt;
      b.y += b.vy * dt; b.vy -= 34 * dt;
      if (b.y < 1.4) { b.y = 1.4; b.vy = Math.abs(b.vy) * 0.7 + 6; }
      if (b.power > 0) b.power -= dt;
      const cap = b.power > 0 ? 46 : 30;
      const sp = Math.hypot(b.vx, b.vz);
      if (sp > cap) { b.vx *= cap / sp; b.vz *= cap / sp; }
      this.cornerBounce(b);

      for (const p of this.players) {
        const reach = HITBOX + 1.4;
        if (p.dead) {
          if (p.side === 'bottom' && b.vz > 0 && b.z > edge) b.vz = -Math.abs(b.vz);
          if (p.side === 'top' && b.vz < 0 && b.z < -edge) b.vz = Math.abs(b.vz);
          if (p.side === 'left' && b.vx < 0 && b.x < -edge) b.vx = Math.abs(b.vx);
          if (p.side === 'right' && b.vx > 0 && b.x > edge) b.vx = -Math.abs(b.vx);
          continue;
        }
        const [px, pz] = this.edgePos(p);
        const dp = 1.02 + strengthMult(p.hero) * 0.06;
        const deflect = (axis: 'x' | 'z') => {
          const powered = p.armed;
          const mult = dp * (powered ? 1.8 : 1);
          const steer = ((p as any)._pvel ?? 0) * HALF * 2 * 0.85;
          if (axis === 'z') { b.vz = (p.side === 'bottom' ? -1 : 1) * Math.abs(b.vz) * mult; b.vx += (b.x - px) * 0.9 + steer; }
          else { b.vx = (p.side === 'right' ? -1 : 1) * Math.abs(b.vx) * mult; b.vz += (b.z - pz) * 0.9 + steer; }
          b.vy = 8;
          if (powered) {
            p.armed = false;
            p.cd = 6;
            b.power = 2.5;
            this.events.push({ t: 'ult', slot: p.slot });
          }
        };
        if (p.side === 'bottom' && b.vz > 0 && b.z > edge - 2 && Math.abs(b.x - px) < reach) deflect('z');
        if (p.side === 'top' && b.vz < 0 && b.z < -edge + 2 && Math.abs(b.x - px) < reach) deflect('z');
        if (p.side === 'left' && b.vx < 0 && b.x < -edge + 2 && Math.abs(b.z - pz) < reach) deflect('x');
        if (p.side === 'right' && b.vx > 0 && b.x > edge - 2 && Math.abs(b.z - pz) < reach) deflect('x');
      }

      if (b.grace < 0) {
        const m = HALF + 3;
        const ps = this.players;
        if (b.z > m && !ps[0].dead) this.concede(ps[0], b);
        else if (b.z < -m && !ps[1].dead) this.concede(ps[1], b);
        else if (b.x < -m && !ps[2].dead) this.concede(ps[2], b);
        else if (b.x > m && !ps[3].dead) this.concede(ps[3], b);
        else if (Math.abs(b.x) > m + 6 || Math.abs(b.z) > m + 6) this.resetBall(b);
      }
    }
  }

  private sendState() {
    const hockey = {
      pos: this.players.map((p) => Math.round(p.pos * 1000) / 1000),
      pts: this.players.map((p) => p.pts),
      balls: this.balls.map((b) => [
        Math.round(b.x * 100) / 100,
        Math.round(b.z * 100) / 100,
        Math.round(b.y * 100) / 100,
        b.power > 0 ? 1 : 0,
      ] as [number, number, number, number]),
    };
    for (const p of this.players) {
      if (!p.socketId) continue;
      const msg: StateMsg = {
        tick: this.tick,
        timeLeft: Math.max(0, Math.round(this.timeLeft * 10) / 10),
        ring: HALF,
        ack: p.ackSeq,
        players: [],
        events: this.events,
        hockey,
      };
      this.broadcast(p.socketId, msg);
    }
  }

  private finish() {
    if (this.ended) return;
    this.ended = true;
    this.stop();
    const ranking = [...this.players]
      .sort((a, b) => (b.dead ? -1 : b.pts) - (a.dead ? -1 : a.pts))
      .map((p) => ({
        slot: p.slot,
        name: p.name,
        heroKey: p.hero.key,
        lives: Math.max(p.pts, 0),
        dead: p.dead,
        team: p.slot,
      }));
    this.onEnd({ mode: this.mode, winnerTeam: -1, scoreLabel: 'pts', ranking });
  }
}
