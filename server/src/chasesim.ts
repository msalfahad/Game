import { heroByKey, speedMult, type HeroDef } from './heroes.js';
import { ET, TICK_RATE, type EntityState, type InputMsg, type MatchEndMsg, type MatchMode, type PlayerState, type SimEvent, type StateMsg } from './protocol.js';
import { MOVE, SURFACE_PHYS, sprintMul } from './shared/roammove.js';
import type { GameSim, MatchSeat } from './sim.js';

// Authoritative The Great Escape (Dune Clash chase) at 20Hz. 1 GUARD (faster,
// has a stick) hunts 3 ESCAPERS through a walled yard. Touch = caught/out.
// Guard wins by catching all 3 before the clock; any survivor wins otherwise.
// Escapers grab 👟 SHOES to briefly outrun the guard. Guard AI routes through
// the wall gaps via a small nav graph. Mirrors src/game/games/chase.ts (core;
// freeze/sling pickups are offline-only for now). aux = guard slot.

const HALF = 30;
const DUR = 55;
const GUARD_SPEED = 1.18; // reeled-in feel, not a sprint (was 1.4)
const SHOES_SPEED = 1.45;  // shoes still clearly beat the guard
const HITBOX = 3.0;
// Guard must be right on top of a runner to catch — a tight overlap so with
// network lag it reads as a real touch, never a catch from a body-width away.
const CATCH_R = HITBOX * 2 - 1.6;

interface Crate { x: number; z: number; hw: number; hd: number; }
interface CPlayer {
  slot: number; socketId: string | null; name: string; hero: HeroDef;
  x: number; z: number; vx: number; vz: number;
  dead: boolean; shoesT: number; freezeT: number; outAt: number;
  retarget: number; tx: number; tz: number; fleeGoal: number;
  input: InputMsg;
}

export class ChaseSim implements GameSim {
  private players: CPlayer[];
  private guardIdx = 0;
  private crates: Crate[] = [];
  private nav: { x: number; z: number }[] = [];
  private navEdges: number[][] = [];
  private ents = new Map<number, { id: number; x: number; z: number; kind: number }>();
  private entId = 1;
  private boxT = 3;
  private caught = 0;
  private startGrace = 1.6;
  private timeLeft = DUR;
  private tick = 0;
  private guardTarget: CPlayer | null = null;
  private guardTargetT = 0;
  private events: SimEvent[] = [];
  private ended = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inner = HALF * 0.5;

  constructor(
    seats: MatchSeat[],
    private mode: MatchMode,
    private broadcast: (socketId: string, msg: StateMsg) => void,
    private onEnd: (msg: MatchEndMsg) => void,
  ) {
    this.buildWalls();
    this.buildNav();
    this.guardIdx = Math.floor(Math.random() * seats.length);
    const corners = [[HALF * 0.68, HALF * 0.68], [-HALF * 0.68, HALF * 0.68], [-HALF * 0.68, -HALF * 0.68], [HALF * 0.68, -HALF * 0.68]];
    let ci = 0;
    this.players = seats.map((s, i) => {
      const guard = i === this.guardIdx;
      const c = corners[ci++ % 4];
      return {
        slot: i, socketId: s.socketId, name: s.name, hero: heroByKey(s.heroKey),
        x: guard ? 0 : c[0], z: guard ? 0 : c[1], vx: 0, vz: 0,
        dead: false, shoesT: 0, freezeT: 0, outAt: 0,
        retarget: 0, tx: 0, tz: 0, fleeGoal: -1, input: { seq: 0, ax: 0, ay: 0 },
      };
    });
    this.boxT = 2 + Math.random() * 3;
  }

  start() { this.timer = setInterval(() => this.step(1 / TICK_RATE), 1000 / TICK_RATE); }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }
  dropPlayer(socketId: string) { const p = this.players.find((q) => q.socketId === socketId); if (p) p.socketId = null; }
  get humanCount(): number { return this.players.filter((p) => p.socketId !== null).length; }
  applyInput(socketId: string, msg: InputMsg) {
    const p = this.players.find((q) => q.socketId === socketId);
    if (p && !p.dead) p.input = { seq: msg.seq, ax: Math.max(-1, Math.min(1, msg.ax || 0)), ay: Math.max(-1, Math.min(1, msg.ay || 0)) };
  }

  private guard() { return this.players[this.guardIdx]; }
  private escapers() { return this.players.filter((p) => p.slot !== this.guardIdx); }
  private aliveEscapers() { return this.escapers().filter((p) => !p.dead); }

  // Inner square with a centred gap on each side, plus 4 boulders.
  private buildWalls() {
    const inner = this.inner; const gap = 5.5; const thick = 1.5;
    const seg = (inner - gap) / 2;
    const wall = (cx: number, cz: number, hw: number, hd: number) => this.crates.push({ x: cx, z: cz, hw, hd });
    for (const sz of [-inner, inner]) { wall(-(gap + seg), sz, seg, thick); wall(gap + seg, sz, seg, thick); }
    for (const sx of [-inner, inner]) { wall(sx, -(gap + seg), thick, seg); wall(sx, gap + seg, thick, seg); }
    for (const [x, z, s] of [[8, 8, 1.9], [-8, -8, 1.9], [9, -7, 1.8], [-7, 9, 1.8]] as const) this.crates.push({ x, z, hw: s, hd: s });
  }

  private buildNav() {
    const inner = this.inner; const cr = (inner + HALF) / 2;
    this.nav = [
      { x: 0, z: 0 }, { x: 0, z: -inner }, { x: 0, z: inner }, { x: inner, z: 0 }, { x: -inner, z: 0 },
      { x: 0, z: -cr }, { x: 0, z: cr }, { x: cr, z: 0 }, { x: -cr, z: 0 },
      { x: cr, z: -cr }, { x: -cr, z: -cr }, { x: cr, z: cr }, { x: -cr, z: cr },
    ];
    this.navEdges = [[1, 2, 3, 4], [0, 5], [0, 6], [0, 7], [0, 8], [1, 9, 10], [2, 11, 12], [3, 9, 11], [4, 10, 12], [5, 7], [5, 8], [6, 7], [6, 8]];
  }

  private step(dt: number) {
    if (this.ended) return;
    this.tick++;
    this.timeLeft -= dt;
    this.startGrace = Math.max(0, this.startGrace - dt);

    for (const p of this.players) {
      if (p.dead) continue;
      if (p.freezeT > 0) { p.freezeT -= dt; p.vx = 0; p.vz = 0; continue; }
      if (p.shoesT > 0) p.shoesT -= dt;
      if (p.socketId) this.moveHuman(p, dt);
      else this.moveBot(p, dt);
      this.resolveCrates(p);
      this.clampWalls(p);
    }

    // Catches.
    const g = this.guard();
    if (this.startGrace <= 0 && !g.dead && g.freezeT <= 0) {
      for (const p of this.aliveEscapers()) {
        if (Math.hypot(p.x - g.x, p.z - g.z) < CATCH_R) this.catchEscaper(p);
      }
    }

    // Shoe pickups.
    this.boxT -= dt;
    if (this.boxT <= 0 && this.ents.size < 3) { this.boxT = 3 + Math.random() * 5; this.spawnBox(); }
    for (const [id, e] of this.ents) {
      const taker = this.aliveEscapers().find((p) => Math.hypot(p.x - e.x, p.z - e.z) < HITBOX + 1.5);
      if (taker) { taker.shoesT = Math.max(taker.shoesT, 5); this.ents.delete(id); this.events.push({ t: 'power', slot: taker.slot, k: 4 }); }
    }

    this.sendState();
    this.events = [];

    if (this.aliveEscapers().length === 0) this.finish(true);
    else if (this.timeLeft <= 0) this.finish(false);
  }

  private speedMul(p: CPlayer): number {
    if (p.slot === this.guardIdx) {
      let boost = 1;
      const prey = this.aliveEscapers();
      if (prey.length) {
        let d = Infinity;
        for (const q of prey) d = Math.min(d, Math.hypot(q.x - p.x, q.z - p.z));
        boost = d > 22 ? 1.16 : d > 13 ? 1.08 : 1;
      }
      return GUARD_SPEED * boost;
    }
    return p.shoesT > 0 ? SHOES_SPEED : 1;
  }

  private applyMove(p: CPlayer, ax: number, ay: number, dt: number) {
    // Crisp metal grip (NO sand drift): the client predicts this exactly, so the
    // local runner never rubber-bands against unpredictable server noise.
    const surf = SURFACE_PHYS.metal;
    const top = MOVE.baseSpeed * speedMult(p.hero) * sprintMul(ax, ay) * this.speedMul(p);
    const accel = top * MOVE.accelMul * surf.accel;
    p.vx += ax * accel * dt; p.vz += ay * accel * dt;
    const retain = Math.pow(surf.grip, dt);
    p.vx *= retain; p.vz *= retain;
    const sp = Math.hypot(p.vx, p.vz);
    if (sp > top) { p.vx *= top / sp; p.vz *= top / sp; }
    p.x += p.vx * dt; p.z += p.vz * dt;
  }

  private moveHuman(p: CPlayer, dt: number) {
    this.applyMove(p, p.input.ax, p.input.ay, dt);
  }

  private moveBot(p: CPlayer, dt: number) {
    p.retarget -= dt;
    if (p.slot === this.guardIdx) {
      this.guardTargetT -= dt;
      const prey = this.aliveEscapers();
      if (!prey.length) return;
      let t = this.guardTarget && !this.guardTarget.dead ? this.guardTarget : null;
      if (!t || this.guardTargetT <= 0) {
        let best = Infinity, pick = prey[0];
        for (const q of prey) { const d = Math.hypot(q.x - p.x, q.z - p.z); if (d < best) { best = d; pick = q; } }
        t = pick; this.guardTargetT = 1.6;
      }
      this.guardTarget = t;
      if (p.retarget <= 0) { p.retarget = 0.18; const [nx, nz] = this.navTo(p, t.x + t.vx * 0.5, t.z + t.vz * 0.5); p.tx = nx; p.tz = nz; }
    } else if (p.retarget <= 0) {
      p.retarget = 0.25 + Math.random() * 0.2;
      const guard = this.guard();
      const goal = this.pickHideout(p, guard);
      const [nx, nz] = this.navTo(p, this.nav[goal].x, this.nav[goal].z);
      p.tx = nx; p.tz = nz;
    }
    const dx = p.tx - p.x, dz = p.tz - p.z, L = Math.hypot(dx, dz) || 1;
    this.applyMove(p, dx / L, dz / L, dt);
  }

  private pickHideout(p: CPlayer, guard: CPlayer): number {
    const cand = [5, 6, 7, 8, 9, 10, 11, 12];
    const cur = p.fleeGoal;
    if (cur >= 0) {
      const w = this.nav[cur];
      if (Math.hypot(guard.x - w.x, guard.z - w.z) > 16 && Math.hypot(p.x - w.x, p.z - w.z) > 4) return cur;
    }
    let best = cand[0], bs = -Infinity;
    for (const i of cand) {
      if (i === cur) continue;
      const w = this.nav[i];
      const score = Math.hypot(guard.x - w.x, guard.z - w.z) - Math.hypot(p.x - w.x, p.z - w.z) * 0.1 + Math.random() * 5;
      if (score > bs) { bs = score; best = i; }
    }
    p.fleeGoal = best;
    return best;
  }

  private segClear(x0: number, z0: number, x1: number, z1: number): boolean {
    const dx = x1 - x0, dz = z1 - z0; const dist = Math.hypot(dx, dz);
    const steps = Math.max(2, Math.ceil(dist / 1.2)); const pad = HITBOX + 0.3;
    for (let s = 0; s <= steps; s++) {
      const t = s / steps, x = x0 + dx * t, z = z0 + dz * t;
      for (const c of this.crates) if (Math.abs(x - c.x) < c.hw + pad && Math.abs(z - c.z) < c.hd + pad) return false;
    }
    return true;
  }
  private nearestNode(x: number, z: number): number {
    let best = -1, bd = Infinity;
    for (let i = 0; i < this.nav.length; i++) { const w = this.nav[i], d = Math.hypot(x - w.x, z - w.z); if (d < bd && this.segClear(x, z, w.x, w.z)) { bd = d; best = i; } }
    if (best < 0) for (let i = 0; i < this.nav.length; i++) { const w = this.nav[i], d = Math.hypot(x - w.x, z - w.z); if (d < bd) { bd = d; best = i; } }
    return best;
  }
  private bfs(a: number, b: number): number[] | null {
    const prev = new Array(this.nav.length).fill(-1), seen = new Array(this.nav.length).fill(false);
    const q = [a]; seen[a] = true;
    while (q.length) { const n = q.shift()!; if (n === b) break; for (const m of this.navEdges[n]) if (!seen[m]) { seen[m] = true; prev[m] = n; q.push(m); } }
    if (!seen[b]) return null;
    const path: number[] = []; let cur = b; while (cur !== -1) { path.unshift(cur); cur = prev[cur]; }
    return path;
  }
  private navTo(p: CPlayer, tx: number, tz: number): [number, number] {
    if (this.segClear(p.x, p.z, tx, tz)) return [tx, tz];
    const start = this.nearestNode(p.x, p.z), goal = this.nearestNode(tx, tz);
    if (start < 0 || goal < 0) return [tx, tz];
    if (start === goal) return [this.nav[start].x, this.nav[start].z];
    const path = this.bfs(start, goal);
    if (!path) return [this.nav[start].x, this.nav[start].z];
    let aim = path[0];
    for (const n of path) if (this.segClear(p.x, p.z, this.nav[n].x, this.nav[n].z)) aim = n;
    const ai = path.indexOf(aim);
    if (ai < path.length - 1 && Math.hypot(p.x - this.nav[aim].x, p.z - this.nav[aim].z) < 4.5) aim = path[ai + 1];
    return [this.nav[aim].x, this.nav[aim].z];
  }

  private catchEscaper(p: CPlayer) {
    p.dead = true; p.outAt = ++this.caught;
    this.events.push({ t: 'out', slot: p.slot });
    this.startGrace = 0.6;
  }

  private resolveCrates(p: CPlayer) {
    for (const c of this.crates) {
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
  private clampWalls(p: CPlayer) {
    const m = HALF - HITBOX;
    if (p.x < -m) { p.x = -m; if (p.vx < 0) p.vx = 0; }
    if (p.x > m) { p.x = m; if (p.vx > 0) p.vx = 0; }
    if (p.z < -m) { p.z = -m; if (p.vz < 0) p.vz = 0; }
    if (p.z > m) { p.z = m; if (p.vz > 0) p.vz = 0; }
  }

  private spawnBox() {
    const H = HALF - 4;
    for (let tries = 0; tries < 40; tries++) {
      const x = (Math.random() - 0.5) * 2 * H, z = (Math.random() - 0.5) * 2 * H;
      if (this.crates.every((c) => Math.abs(x - c.x) > c.hw + 2.5 || Math.abs(z - c.z) > c.hd + 2.5)) {
        const id = this.entId++; this.ents.set(id, { id, x, z, kind: 4 }); return;
      }
    }
  }

  private sendState() {
    const players: PlayerState[] = this.players.map((p) => [
      p.slot, Math.round(p.x * 100) / 100, Math.round(p.z * 100) / 100, Math.round(p.vx * 100) / 100, Math.round(p.vz * 100) / 100, 0,
      p.dead ? 0 : 1, p.dead ? 1 : 0, Math.round(p.freezeT * 100) / 100, 0, 0, 0, p.shoesT > 0 ? 2 : 0,
    ]);
    const entities: EntityState[] = [...this.ents.values()].map((e) =>
      [e.id, ET.LOOT, Math.round(e.x * 100) / 100, Math.round(e.z * 100) / 100, 0, e.kind] as EntityState);
    for (const p of this.players) {
      if (!p.socketId) continue;
      const msg: StateMsg = {
        tick: this.tick, timeLeft: Math.max(0, Math.round(this.timeLeft * 10) / 10),
        ring: 0, ack: p.input.seq, players, events: this.events, entities, aux: this.guardIdx,
      };
      this.broadcast(p.socketId, msg);
    }
  }

  private finish(guardWon: boolean) {
    if (this.ended) return;
    this.ended = true;
    this.stop();
    const ranking = [...this.players]
      .map((p) => ({ p, rank: p.slot === this.guardIdx ? (guardWon ? 1e6 : -1) : (!p.dead ? 1e5 : p.outAt) }))
      .sort((a, b) => b.rank - a.rank)
      .map(({ p }) => ({ slot: p.slot, name: p.name, heroKey: p.hero.key, lives: p.dead ? 0 : 1, dead: p.dead, team: p.slot }));
    this.onEnd({ mode: this.mode, winnerTeam: -1, scoreLabel: 'escape', ranking });
  }
}
