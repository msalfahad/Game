import { heroByKey, speedMult, type HeroDef } from './heroes.js';
import { TICK_RATE, type InputMsg, type MatchEndMsg, type MatchMode, type PlayerState, type SimEvent, type StateMsg } from './protocol.js';
import { MOVE, SURFACE_PHYS, sprintMul } from './shared/roammove.js';
import type { GameSim, MatchSeat } from './sim.js';

// Authoritative Night Heist (Dune Clash maze) at 20Hz. 1 COP (1.5x faster)
// hunts 3 ROBBERS through a dark maze. Robbers shine torches to fill the cop's
// BLIND meter (6s of net torchlight = robbers win); the cop stuns a robber for
// 2s by touching them FROM BEHIND, then runs on. Cop wins by outlasting the
// clock. Mirrors src/game/games/maze.ts. The darkness/torch beams are rendered
// client-side; the server owns positions, facing, battery, torch on/off,
// exposure and stuns. aux = cop slot; ring = exposure (0..6).
// PlayerState packing: y unused, cd = facing angle, score = battery, flags bit0
// = torch emitting.

const HALF = 30;
const HITBOX = 3.0;
const DUR = 60;
const POLICE_SPEED = 1.5;
const CATCH_R = HITBOX * 2 + 1.5;
const EXPOSE_LIMIT = 6;
const EXPOSE_DECAY = 0.7;
const STUN_TIME = 2;
const BATTERY_MAX = 9;   // 3 bars x 3s
const BAR_SEC = 3;
const RECHARGE_PER_SEC = 1 / 5;
const RANGE_BY_BARS = [0, 11, 16, 22];
const CONE_BY_BARS = [0, 0.42, 0.5, 0.6];

interface Wall { x: number; z: number; hw: number; hd: number; }
interface MPlayer {
  slot: number; socketId: string | null; name: string; hero: HeroDef;
  x: number; z: number; vx: number; vz: number;
  dead: boolean; freezeT: number; face: number;
  battery: number; lightOn: boolean; wantToggle: boolean;
  retarget: number; tx: number; tz: number;
  input: InputMsg;
}

export class MazeSim implements GameSim {
  private players: MPlayer[];
  private policeIdx = 0;
  private walls: Wall[] = [];
  private timeLeft = DUR;
  private startGrace = 4;
  private exposure = 0;
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
    this.buildMaze();
    this.policeIdx = Math.floor(Math.random() * seats.length);
    const spots = [[HALF * 0.7, HALF * 0.7], [-HALF * 0.7, HALF * 0.7], [-HALF * 0.7, -HALF * 0.7], [HALF * 0.7, -HALF * 0.7]];
    this.players = seats.map((s, i) => ({
      slot: i, socketId: s.socketId, name: s.name, hero: heroByKey(s.heroKey),
      x: spots[i][0], z: spots[i][1], vx: 0, vz: 0,
      dead: false, freezeT: 0, face: Math.atan2(-spots[i][0], -spots[i][1]),
      battery: BATTERY_MAX, lightOn: false, wantToggle: false,
      retarget: 0, tx: 0, tz: 0, input: { seq: 0, ax: 0, ay: 0 },
    }));
  }

  start() { this.timer = setInterval(() => this.step(1 / TICK_RATE), 1000 / TICK_RATE); }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }
  dropPlayer(socketId: string) { const p = this.players.find((q) => q.socketId === socketId); if (p) p.socketId = null; }
  get humanCount(): number { return this.players.filter((p) => p.socketId !== null).length; }
  applyInput(socketId: string, msg: InputMsg) {
    const p = this.players.find((q) => q.socketId === socketId);
    if (!p || p.dead) return;
    p.input = { seq: msg.seq, ax: Math.max(-1, Math.min(1, msg.ax || 0)), ay: Math.max(-1, Math.min(1, msg.ay || 0)) };
    if (msg.ult) p.wantToggle = true; // torch toggle (robbers only), edge-triggered
  }

  private police() { return this.players[this.policeIdx]; }
  private robbers() { return this.players.filter((p) => p.slot !== this.policeIdx); }
  private aliveRobbers() { return this.robbers().filter((p) => !p.dead); }
  private bars(p: MPlayer): number { return Math.min(3, Math.ceil(p.battery / BAR_SEC - 1e-6)); }
  private emitting(p: MPlayer): boolean { return p.lightOn && p.battery > 0.001; }

  // OPEN arena with scattered thin cover — mirrors offline buildMaze layout.
  private buildMaze() {
    const T = 1.0;
    const layout: [number, number, number, number][] = [
      [0, -13, 3.5, T], [0, 13, 3.5, T], [-13, 0, T, 3.5], [13, 0, T, 3.5],
      [-9, -9, 1.4, 1.4], [9, -9, 1.4, 1.4], [-9, 9, 1.4, 1.4], [9, 9, 1.4, 1.4],
      [0, -21, 3.5, T], [0, 21, 3.5, T], [-21, 0, T, 3.5], [21, 0, T, 3.5],
    ];
    for (const [cx, cz, hw, hd] of layout) this.walls.push({ x: cx, z: cz, hw, hd });
  }

  private segClear(x0: number, z0: number, x1: number, z1: number): boolean {
    const dx = x1 - x0, dz = z1 - z0, dist = Math.hypot(dx, dz);
    const steps = Math.max(2, Math.ceil(dist / 1.4));
    for (let s = 1; s < steps; s++) {
      const t = s / steps, x = x0 + dx * t, z = z0 + dz * t;
      for (const c of this.walls) if (Math.abs(x - c.x) < c.hw && Math.abs(z - c.z) < c.hd) return false;
    }
    return true;
  }

  private step(dt: number) {
    if (this.ended) return;
    this.tick++;
    this.timeLeft -= dt;
    this.startGrace = Math.max(0, this.startGrace - dt);
    const police = this.police();

    // Torch toggles (edge-triggered) — robbers only, needs battery, not stunned.
    for (const p of this.robbers()) {
      if (p.wantToggle) {
        p.wantToggle = false;
        if (p.freezeT <= 0 && p.battery > 0.1) { p.lightOn = !p.lightOn; }
      }
    }

    // Movement.
    for (const p of this.players) {
      if (p.dead) continue;
      if (p.freezeT > 0) { p.freezeT -= dt; p.vx = 0; p.vz = 0; p.lightOn = false; continue; }
      if (p.socketId) this.applyMove(p, p.input.ax, p.input.ay, dt);
      else this.moveBot(p, dt);
      this.resolveWalls(p);
      this.clampWalls(p);
    }

    // Facing: robber shining a torch AIMS at the cop; else follow motion.
    for (const p of this.players) {
      if (p.dead || p.freezeT > 0) continue;
      if (p.slot !== this.policeIdx && this.emitting(p)) {
        p.face = Math.atan2(police.x - p.x, police.z - p.z);
      } else if (Math.hypot(p.vx, p.vz) > 1.5) {
        p.face = Math.atan2(p.vx, p.vz);
      }
    }

    // Torch battery.
    for (const p of this.robbers()) {
      if (this.emitting(p)) { p.battery = Math.max(0, p.battery - dt); if (p.battery <= 0) p.lightOn = false; }
      else p.battery = Math.min(BATTERY_MAX, p.battery + dt * RECHARGE_PER_SEC);
    }

    // Exposure: count robbers lighting the cop (in range + cone + line of sight).
    let beams = 0;
    for (const p of this.robbers()) {
      if (p.freezeT > 0 || !this.emitting(p)) continue;
      const b = this.bars(p);
      const dx = police.x - p.x, dz = police.z - p.z, d = Math.hypot(dx, dz) || 1;
      if (d > RANGE_BY_BARS[b]) continue;
      const fx = Math.sin(p.face), fz = Math.cos(p.face);
      if ((dx / d) * fx + (dz / d) * fz < Math.cos(CONE_BY_BARS[b])) continue;
      if (!this.segClear(p.x, p.z, police.x, police.z)) continue;
      beams++;
    }
    if (this.startGrace <= 0) {
      if (beams > 0) this.exposure = Math.min(EXPOSE_LIMIT, this.exposure + dt * beams);
      else this.exposure = Math.max(0, this.exposure - dt * EXPOSE_DECAY);
    }

    // Cop stuns a robber tagged FROM BEHIND for 2s (not out).
    if (this.startGrace <= 0 && this.exposure < EXPOSE_LIMIT && !police.dead) {
      for (const p of this.robbers()) {
        if (p.freezeT > 0) continue;
        const dx = police.x - p.x, dz = police.z - p.z, d = Math.hypot(dx, dz);
        if (d > CATCH_R || d < 0.001) continue;
        const fx = Math.sin(p.face), fz = Math.cos(p.face);
        if ((dx / d) * fx + (dz / d) * fz < -0.1) this.stunRobber(p);
      }
    }

    this.sendState();
    this.events = [];

    if (this.exposure >= EXPOSE_LIMIT) this.finish(false);
    else if (this.timeLeft <= 0) this.finish(true);
  }

  private speedMul(p: MPlayer): number { return p.slot === this.policeIdx ? POLICE_SPEED : 1; }

  private applyMove(p: MPlayer, ax: number, ay: number, dt: number) {
    const surf = SURFACE_PHYS.metal; // crisp maze movement (matches offline physics)
    const top = MOVE.baseSpeed * speedMult(p.hero) * sprintMul(ax, ay) * this.speedMul(p);
    const accel = top * MOVE.accelMul * surf.accel;
    p.vx += ax * accel * dt; p.vz += ay * accel * dt;
    const retain = Math.pow(surf.grip, dt);
    p.vx *= retain; p.vz *= retain;
    const sp = Math.hypot(p.vx, p.vz);
    if (sp > top) { p.vx *= top / sp; p.vz *= top / sp; }
    p.x += p.vx * dt; p.z += p.vz * dt;
  }

  private moveBot(p: MPlayer, dt: number) {
    const police = this.police();
    if (p.slot === this.policeIdx) {
      p.retarget -= dt;
      const prey = this.aliveRobbers().filter((q) => q.freezeT <= 0);
      if (prey.length && p.retarget <= 0) {
        p.retarget = 0.3;
        let t = prey[0], best = Infinity;
        for (const q of prey) {
          let d = Math.hypot(q.x - p.x, q.z - p.z);
          if (this.emitting(q)) d -= 22;
          if (d < best) { best = d; t = q; }
        }
        const fx = Math.sin(t.face), fz = Math.cos(t.face);
        p.tx = t.x - fx * 4; p.tz = t.z - fz * 4;
      }
    } else {
      const i = p.slot;
      const gd = Math.hypot(police.x - p.x, police.z - p.z);
      const los = this.segClear(p.x, p.z, police.x, police.z);
      p.lightOn = gd < 20 && los && p.battery > 0.6;
      p.retarget -= dt;
      if (p.retarget <= 0) {
        p.retarget = 0.28 + Math.random() * 0.22;
        if (!los || gd > 16) { p.tx = police.x; p.tz = police.z; }
        else if (gd < 10) {
          const ax = p.x - police.x, az = p.z - police.z, L = Math.hypot(ax, az) || 1;
          p.tx = p.x + (ax / L) * 13; p.tz = p.z + (az / L) * 13;
        } else {
          const ax = police.x - p.x, az = police.z - p.z, L = Math.hypot(ax, az) || 1;
          const s = (i % 2 === 0) ? 1 : -1;
          p.tx = p.x - (az / L) * 9 * s + (ax / L) * 2;
          p.tz = p.z + (ax / L) * 9 * s + (az / L) * 2;
        }
      }
    }
    const dx = p.tx - p.x, dz = p.tz - p.z, L = Math.hypot(dx, dz) || 1;
    this.applyMove(p, dx / L, dz / L, dt);
  }

  private stunRobber(p: MPlayer) {
    p.freezeT = Math.max(p.freezeT, STUN_TIME);
    p.lightOn = false;
    this.events.push({ t: 'hit', slot: p.slot });
    this.startGrace = 0.3;
  }

  private resolveWalls(p: MPlayer) {
    for (const c of this.walls) {
      const dx = p.x - c.x, dz = p.z - c.z;
      const nx = c.x + Math.max(-c.hw, Math.min(c.hw, dx)), nz = c.z + Math.max(-c.hd, Math.min(c.hd, dz));
      let ox = p.x - nx, oz = p.z - nz; let d = Math.hypot(ox, oz);
      if (d >= HITBOX) continue;
      if (d < 0.0001) { const px = c.hw - Math.abs(dx), pz = c.hd - Math.abs(dz); if (px < pz) { ox = Math.sign(dx) || 1; oz = 0; } else { ox = 0; oz = Math.sign(dz) || 1; } d = 1; }
      const push = HITBOX - d, ux = ox / d, uz = oz / d;
      p.x += ux * push; p.z += uz * push;
      const into = p.vx * ux + p.vz * uz;
      if (into < 0) { p.vx -= into * ux; p.vz -= into * uz; }
    }
  }
  private clampWalls(p: MPlayer) {
    const m = HALF - HITBOX;
    if (p.x < -m) { p.x = -m; if (p.vx < 0) p.vx = 0; }
    if (p.x > m) { p.x = m; if (p.vx > 0) p.vx = 0; }
    if (p.z < -m) { p.z = -m; if (p.vz < 0) p.vz = 0; }
    if (p.z > m) { p.z = m; if (p.vz > 0) p.vz = 0; }
  }

  private sendState() {
    const players: PlayerState[] = this.players.map((p) => [
      p.slot, Math.round(p.x * 100) / 100, Math.round(p.z * 100) / 100,
      Math.round(p.vx * 100) / 100, Math.round(p.vz * 100) / 100, 0,
      p.dead ? 0 : 1, p.dead ? 1 : 0, Math.round(p.freezeT * 100) / 100, 0,
      Math.round(p.face * 1000) / 1000,                 // cd = facing angle
      Math.round(p.battery * 100) / 100,                // score = battery
      this.emitting(p) ? 1 : 0,                          // flags bit0 = torch on
    ]);
    for (const p of this.players) {
      if (!p.socketId) continue;
      const msg: StateMsg = {
        tick: this.tick, timeLeft: Math.max(0, Math.round(this.timeLeft * 10) / 10),
        ring: Math.round(this.exposure * 100) / 100, ack: p.input.seq,
        players, events: this.events, aux: this.policeIdx,
      };
      this.broadcast(p.socketId, msg);
    }
  }

  private finish(policeWon: boolean) {
    if (this.ended) return;
    this.ended = true;
    this.stop();
    const ranking = [...this.players]
      .map((p) => ({ p, rank: p.slot === this.policeIdx ? (policeWon ? 1e6 : -1) : (policeWon ? 0 : 1e5) }))
      .sort((a, b) => b.rank - a.rank)
      .map(({ p }) => ({ slot: p.slot, name: p.name, heroKey: p.hero.key, lives: p.dead ? 0 : 1, dead: p.dead, team: p.slot }));
    this.onEnd({ mode: this.mode, winnerTeam: -1, scoreLabel: 'heist', ranking });
  }
}
