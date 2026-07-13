import { heroByKey, speedMult, strengthMult, defenseMult, type HeroDef } from './heroes.js';
import { TICK_RATE, type InputMsg, type MatchEndMsg, type MatchMode, type PlayerState, type SimEvent, type StateMsg } from './protocol.js';

// Authoritative pushout simulation (Ring Rumble / Tree Top Tumble) at 20Hz.
// Physics constants mirror the client's src/game/physics.ts + pushout.ts so
// client prediction matches: BASE_SPEED 14, accel = top*2.6, metal grip
// 0.02^dt, identical 3.0 hitboxes, ring shrinking to 45% over the match.

const HALF = 30;
const HITBOX = 3.0;
const BASE_SPEED = 14;
const JUMP_V = 22;
const GRAVITY = 60;
const DURATION = 90;
const ULT_CD = 14;

export interface SimPlayer {
  slot: number;
  socketId: string | null; // null = bot
  name: string;
  team: number; // 0|1 in 2v2, slot in FFA (everyone their own team)
  hero: HeroDef;
  x: number; z: number; vx: number; vz: number; y: number; vy: number;
  face: { x: number; z: number };
  lives: number;
  dead: boolean;
  invulnT: number;
  freezeT: number;
  shieldT: number;
  cd: number;
  input: InputMsg;
  ackSeq: number;
  // bot AI
  retarget: number;
  tx: number; tz: number;
}

export interface MatchSeat {
  socketId: string | null;
  name: string;
  heroKey: string;
  team: number;
}

export class MatchSim {
  players: SimPlayer[];
  tick = 0;
  timeLeft = DURATION;
  ring = HALF;
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
      // 2v2 spawns teammates on the same side of the ring.
      const a = this.mode === '2v2'
        ? (s.team === 0 ? Math.PI * 0.75 : -Math.PI * 0.25) + (i % 2) * (Math.PI / 5)
        : (i * Math.PI) / 2 + Math.PI / 4;
      return {
        slot: i,
        socketId: s.socketId,
        name: s.name,
        team: this.mode === '2v2' ? s.team : i,
        hero: heroByKey(s.heroKey),
        x: Math.cos(a) * HALF * 0.5,
        z: Math.sin(a) * HALF * 0.5,
        vx: 0, vz: 0, y: 0, vy: 0,
        face: { x: 0, z: -1 },
        lives: 3,
        dead: false,
        invulnT: 0, freezeT: 0, shieldT: 0, cd: 0,
        input: { seq: 0, ax: 0, ay: 0 },
        ackSeq: 0,
        retarget: 0, tx: 0, tz: 0,
      };
    });
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
    // Latest-input-wins; clamp axes defensively.
    p.input = {
      seq: msg.seq,
      ax: Math.max(-1, Math.min(1, msg.ax || 0)),
      ay: Math.max(-1, Math.min(1, msg.ay || 0)),
      jump: !!msg.jump,
      ult: !!msg.ult,
    };
  }

  /** Disconnected humans become bots so the match keeps going. */
  dropPlayer(socketId: string) {
    const p = this.players.find((q) => q.socketId === socketId);
    if (p) p.socketId = null;
  }

  get humanCount(): number {
    return this.players.filter((p) => p.socketId !== null).length;
  }

  private step(dt: number) {
    if (this.ended) return;
    this.tick++;
    this.timeLeft -= dt;
    const prog = 1 - Math.max(this.timeLeft, 0) / DURATION;
    this.ring = HALF * (1 - prog * 0.55);

    for (const p of this.players) {
      if (p.dead) continue;
      p.invulnT = Math.max(0, p.invulnT - dt);
      p.freezeT = Math.max(0, p.freezeT - dt);
      p.shieldT = Math.max(0, p.shieldT - dt);
      p.cd = Math.max(0, p.cd - dt);
      if (p.socketId === null) this.botThink(p, dt);
      this.move(p, dt);
      if (p.input.ult) {
        p.input.ult = false;
        this.fireUlt(p);
      }
      if (p.input.jump) {
        p.input.jump = false;
        if (p.y <= 0 && p.freezeT <= 0) p.vy = JUMP_V;
      }
      p.ackSeq = p.input.seq;
    }

    this.collide();
    this.checkFalls();
    this.sendState();
    this.events = [];

    const alive = this.players.filter((p) => !p.dead);
    const aliveTeams = new Set(alive.map((p) => p.team));
    if (this.timeLeft <= 0 || aliveTeams.size <= 1) this.finish();
  }

  private move(p: SimPlayer, dt: number) {
    const top = BASE_SPEED * speedMult(p.hero);
    const accel = top * 2.6;
    if (p.freezeT <= 0) {
      p.vx += p.input.ax * accel * dt;
      p.vz += p.input.ay * accel * dt;
      if (Math.abs(p.input.ax) + Math.abs(p.input.ay) > 0.05) {
        const L = Math.hypot(p.input.ax, p.input.ay) || 1;
        p.face = { x: p.input.ax / L, z: p.input.ay / L };
      }
    }
    const retain = Math.pow(0.02, dt); // metal grip
    p.vx *= retain;
    p.vz *= retain;
    const sp = Math.hypot(p.vx, p.vz);
    if (sp > top) {
      p.vx *= top / sp;
      p.vz *= top / sp;
    }
    p.x += p.vx * dt;
    p.z += p.vz * dt;
    if (p.y > 0 || p.vy !== 0) {
      p.y += p.vy * dt;
      p.vy -= GRAVITY * dt;
      if (p.y <= 0) { p.y = 0; p.vy = 0; }
    }
  }

  private collide() {
    const ps = this.players;
    for (let i = 0; i < ps.length; i++) {
      for (let j = i + 1; j < ps.length; j++) {
        const a = ps[i], b = ps[j];
        if (a.dead || b.dead || a.invulnT > 0 || b.invulnT > 0) continue;
        const dx = b.x - a.x, dz = b.z - a.z;
        const dist = Math.hypot(dx, dz);
        const min = HITBOX * 2;
        if (dist >= min || dist <= 0) continue;
        const nx = dx / dist, nz = dz / dist, ov = min - dist;
        a.x -= (nx * ov) / 2; a.z -= (nz * ov) / 2;
        b.x += (nx * ov) / 2; b.z += (nz * ov) / 2;
        const rel = (b.vx - a.vx) * nx + (b.vz - a.vz) * nz;
        if (rel < 0) {
          const powA = strengthMult(a.hero), powB = strengthMult(b.hero);
          const massA = defenseMult(a.hero), massB = defenseMult(b.hero);
          // Teammates separate but barely shove each other (no friendly knockouts).
          const friendly = a.team === b.team;
          const imp = -rel * (friendly ? 0.2 : 1.5);
          const dampA = a.shieldT > 0 ? 0.5 : 1;
          const dampB = b.shieldT > 0 ? 0.5 : 1;
          a.vx -= (nx * imp * powB * dampA) / massA;
          a.vz -= (nz * imp * powB * dampA) / massA;
          b.vx += (nx * imp * powA * dampB) / massB;
          b.vz += (nz * imp * powA * dampB) / massB;
        }
      }
    }
  }

  private fireUlt(p: SimPlayer) {
    if (p.cd > 0 || p.freezeT > 0) return;
    p.cd = ULT_CD;
    // Offensive ultimates only affect enemies (matters in 2v2).
    const rivals = this.players.filter((q) => q !== p && !q.dead && q.team !== p.team);
    const near = (r: number) => rivals.filter((q) => Math.hypot(q.x - p.x, q.z - p.z) < r);
    const knock = (targets: SimPlayer[], impulse: number) => {
      const str = strengthMult(p.hero);
      for (const q of targets) {
        const d = Math.hypot(q.x - p.x, q.z - p.z) || 1;
        const damp = q.shieldT > 0 ? 0.5 : 1;
        q.vx += ((q.x - p.x) / d) * impulse * str * damp;
        q.vz += ((q.z - p.z) / d) * impulse * str * damp;
      }
    };
    switch (p.hero.ult) {
      case 'blink': {
        p.x += p.face.x * 14;
        p.z += p.face.z * 14;
        const r = Math.hypot(p.x, p.z);
        if (r > this.ring - 1.5) { // never blink into the void
          p.x *= (this.ring - 1.5) / r;
          p.z *= (this.ring - 1.5) / r;
        }
        break;
      }
      case 'spin': knock(near(9), 34); break;
      case 'burst': knock(near(12), 40); break;
      case 'root': for (const q of near(10)) q.freezeT = Math.max(q.freezeT, 1.3); break;
      case 'slam':
        for (const q of near(9)) q.freezeT = Math.max(q.freezeT, 0.8);
        knock(near(9), 24);
        break;
      case 'heal':
      case 'clone':
      case 'fortress':
        p.shieldT = Math.max(p.shieldT, 3);
        if (p.hero.ult === 'fortress') knock(near(8), 26);
        break;
    }
    this.events.push({ t: 'ult', slot: p.slot });
  }

  private checkFalls() {
    for (const p of this.players) {
      if (p.dead || p.invulnT > 0) continue;
      if (Math.hypot(p.x, p.z) <= this.ring) continue;
      p.lives--;
      if (p.lives <= 0) {
        p.dead = true;
        this.events.push({ t: 'out', slot: p.slot });
      } else {
        p.x = (Math.random() - 0.5) * this.ring * 0.4;
        p.z = (Math.random() - 0.5) * this.ring * 0.4;
        p.vx = 0; p.vz = 0;
        p.invulnT = 1;
        this.events.push({ t: 'fall', slot: p.slot });
      }
    }
  }

  private botThink(p: SimPlayer, dt: number) {
    p.retarget -= dt;
    if (p.retarget <= 0) {
      p.retarget = 0.4 + Math.random() * 0.4;
      const edge = Math.hypot(p.x, p.z);
      if (edge > this.ring * 0.72) {
        p.tx = 0; p.tz = 0;
      } else {
        const foes = this.players.filter((q) => q !== p && !q.dead && q.team !== p.team);
        const t = foes[Math.floor(Math.random() * foes.length)];
        p.tx = t ? t.x : 0;
        p.tz = t ? t.z : 0;
      }
      if (p.cd <= 0 && Math.random() < 0.2) p.input.ult = true;
    }
    const dx = p.tx - p.x, dz = p.tz - p.z;
    const L = Math.hypot(dx, dz) || 1;
    p.input.ax = (dx / L) * 0.66;
    p.input.ay = (dz / L) * 0.66;
  }

  private sendState() {
    const players: PlayerState[] = this.players.map((p) => [
      p.slot,
      Math.round(p.x * 100) / 100,
      Math.round(p.z * 100) / 100,
      Math.round(p.vx * 100) / 100,
      Math.round(p.vz * 100) / 100,
      Math.round(p.y * 100) / 100,
      p.lives,
      p.dead ? 1 : 0,
      Math.round(p.freezeT * 100) / 100,
      Math.round(p.shieldT * 100) / 100,
      Math.round(p.cd * 10) / 10,
      0, // score (unused in pushout)
      0, // flags
    ]);
    for (const p of this.players) {
      if (!p.socketId) continue;
      const msg: StateMsg = {
        tick: this.tick,
        timeLeft: Math.max(0, Math.round(this.timeLeft * 10) / 10),
        ring: Math.round(this.ring * 100) / 100,
        ack: p.ackSeq,
        players,
        events: this.events,
      };
      this.broadcast(p.socketId, msg);
    }
  }

  private finish() {
    if (this.ended) return;
    this.ended = true;
    this.stop();

    // 2v2: the winning team is the one with living members, or (at timeout)
    // the one with the most total remaining lives.
    let winnerTeam = -1;
    if (this.mode === '2v2') {
      const score = (team: number) =>
        this.players
          .filter((p) => p.team === team)
          .reduce((n, p) => n + (p.dead ? 0 : 100 + Math.max(p.lives, 0)), 0);
      winnerTeam = score(0) >= score(1) ? 0 : 1;
    }

    const value = (p: SimPlayer) =>
      (this.mode === '2v2' && p.team === winnerTeam ? 1000 : 0) + (p.dead ? -1 : p.lives);
    const ranking = [...this.players]
      .sort((a, b) => value(b) - value(a))
      .map((p) => ({
        slot: p.slot,
        name: p.name,
        heroKey: p.hero.key,
        lives: Math.max(p.lives, 0),
        dead: p.dead,
        team: p.team,
      }));
    this.onEnd({ mode: this.mode, winnerTeam, scoreLabel: 'lives', ranking });
  }
}

/** Common surface every game simulation exposes to the lobby. */
export interface GameSim {
  start(): void;
  stop(): void;
  applyInput(socketId: string, msg: InputMsg): void;
  dropPlayer(socketId: string): void;
  readonly humanCount: number;
}
