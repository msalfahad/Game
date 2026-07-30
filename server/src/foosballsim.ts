import { heroByKey, type HeroDef } from './heroes.js';
import { ET, TICK_RATE, type EntityState, type InputMsg, type MatchEndMsg, type MatchMode, type PlayerState, type SimEvent, type StateMsg } from './protocol.js';
import type { GameSim, MatchSeat } from './sim.js';

// Authoritative Foot Brawl (Wildwood table-football) at 20Hz. Always 2v2: slots
// 0,1 = BLUE (team 0), 2,3 = RED (team 1). Each player slides up/down a fixed
// rail; SMASH cannons the ball (stuns the first blocker), WIDEN throws the enemy
// goal open. First team to 3 goals (or ahead at the 1-min whistle) wins. Mirrors
// src/game/games/foosball.ts. aux packs the score + widen state; the ball is a
// single ET.ITEM entity. PlayerState: cd = smash cooldown, shieldT = widen
// cooldown, freezeT = stun.

const HALF = 30;
const HITBOX = 3.0;
const BALL_R = 1.1;
const BALL_SPEED = 20;
const BALL_MAX = 34;
const SMASH_V = 42;
const MOVE_SPEED = 22;
const WIN_GOALS = 3;
const SMASH_CD = 3;
const STUN_TIME = 1.2;
const WIDEN_CD = 6;
const WIDEN_TIME = 3.5;
const WIDEN_MUL = 1.8;
const DUR = 60;

const X = HALF * 0.52;
const Z = HALF * 0.42;
const GOAL_HALF = Z * 0.44;
const RAIL_X = [-X * 0.34, -X * 0.80, X * 0.34, X * 0.80];

interface FPlayer {
  slot: number; socketId: string | null; name: string; hero: HeroDef; team: number;
  z: number; vz: number;
  stunT: number; smashCd: number; widenCd: number;
  wantSmash: boolean; wantWiden: boolean;
  input: InputMsg;
}

export class FoosballSim implements GameSim {
  private players: FPlayer[];
  private bx = 0; private bz = 0; private bvx = 0; private bvz = 0;
  private score = [0, 0];
  private widenT = [0, 0];
  private resetT = 1.6;
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
    this.players = seats.map((s, i) => ({
      slot: i, socketId: s.socketId, name: s.name, hero: heroByKey(s.heroKey),
      team: i < 2 ? 0 : 1,
      z: (i % 2 === 0 ? -1 : 1) * Z * 0.28, vz: 0,
      stunT: 0, smashCd: 0, widenCd: 0, wantSmash: false, wantWiden: false,
      input: { seq: 0, ax: 0, ay: 0 },
    }));
  }

  start() { this.timer = setInterval(() => this.step(1 / TICK_RATE), 1000 / TICK_RATE); }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }
  dropPlayer(socketId: string) { const p = this.players.find((q) => q.socketId === socketId); if (p) p.socketId = null; }
  get humanCount(): number { return this.players.filter((p) => p.socketId !== null).length; }
  applyInput(socketId: string, msg: InputMsg) {
    const p = this.players.find((q) => q.socketId === socketId);
    if (!p) return;
    p.input = { seq: msg.seq, ax: 0, ay: Math.max(-1, Math.min(1, msg.ay || 0)) };
    if (msg.jump) p.wantSmash = true;
    if (msg.ult) p.wantWiden = true;
  }

  private railX(i: number) { return RAIL_X[i]; }
  private enemyGoalSide(team: number) { return team === 0 ? 1 : 0; }
  private effGoalHalf(side: number) { return GOAL_HALF * (this.widenT[side] > 0 ? WIDEN_MUL : 1); }

  private step(dt: number) {
    if (this.ended) return;
    this.tick++;
    this.timeLeft -= dt;

    for (const p of this.players) {
      p.smashCd = Math.max(0, p.smashCd - dt);
      p.widenCd = Math.max(0, p.widenCd - dt);
      if (p.stunT > 0) { p.stunT -= dt; p.vz = 0; }
    }
    for (const side of [0, 1]) this.widenT[side] = Math.max(0, this.widenT[side] - dt);

    if (this.resetT > 0) {
      this.resetT -= dt;
      if (this.resetT <= 0) this.kickoff();
    } else {
      for (const p of this.players) {
        if (p.socketId) this.moveHuman(p, dt);
        else this.moveBot(p, dt);
      }
      // Edge-triggered abilities.
      for (const p of this.players) {
        if (p.wantSmash) { p.wantSmash = false; this.doSmash(p); }
        if (p.wantWiden) { p.wantWiden = false; this.doWiden(p); }
      }
      this.tickBall(dt);
    }

    this.sendState();
    this.events = [];

    if (this.score[0] >= WIN_GOALS) return this.finish(0);
    if (this.score[1] >= WIN_GOALS) return this.finish(1);
    if (this.timeLeft <= 0) return this.finish(this.score[0] >= this.score[1] ? 0 : 1);
  }

  private moveHuman(p: FPlayer, dt: number) {
    if (p.stunT > 0) { p.vz = 0; return; }
    p.z += p.input.ay * MOVE_SPEED * dt;
    p.vz = p.input.ay * MOVE_SPEED;
    p.z = Math.max(-Z + HITBOX, Math.min(Z - HITBOX, p.z));
  }

  private moveBot(p: FPlayer, dt: number) {
    if (p.stunT > 0) { p.vz = 0; return; }
    const lead = this.bz + this.bvz * 0.18;
    const onMySide = p.team === 0 ? this.bx < 4 : this.bx > -4;
    const spd = MOVE_SPEED * (onMySide ? 0.9 : 0.6) * 0.8;
    const dz = lead - p.z;
    const step = Math.max(-spd * dt, Math.min(spd * dt, dz));
    p.z += step;
    p.vz = Math.sign(dz) * Math.min(Math.abs(dz) / dt, spd);
    p.z = Math.max(-Z + HITBOX, Math.min(Z - HITBOX, p.z));
    if (p.smashCd <= 0 && Math.hypot(this.bx - this.railX(p.slot), this.bz - p.z) < HITBOX + BALL_R + 3 && Math.random() < 1.2 * dt) this.doSmash(p);
    const attacking = p.team === 0 ? this.bx > 2 : this.bx < -2;
    if (p.widenCd <= 0 && attacking && Math.random() < 0.5 * dt) this.doWiden(p);
  }

  private doSmash(p: FPlayer) {
    if (this.resetT > 0 || p.stunT > 0 || p.smashCd > 0) return;
    const px = this.railX(p.slot);
    if (Math.hypot(this.bx - px, this.bz - p.z) >= HITBOX + BALL_R + 4) return;
    p.smashCd = SMASH_CD;
    const dir = p.team === 0 ? 1 : -1;
    const dz = this.bz - p.z, L = Math.hypot(dir * 7, dz) || 1;
    this.bx = px + dir * (HITBOX + BALL_R + 0.6);
    this.bvx = (dir * 7 / L) * SMASH_V; this.bvz = (dz / L) * SMASH_V;
    this.events.push({ t: 'hit', slot: p.slot });
    // Stun the first rival in the shot's path.
    let victim = -1, bestT = Infinity;
    for (const o of this.players) {
      if (o.slot === p.slot) continue;
      const ox = this.railX(o.slot);
      if ((ox - this.bx) * dir <= 0) continue;
      const t = (ox - this.bx) / this.bvx;
      if (t <= 0) continue;
      const predZ = this.bz + this.bvz * t;
      if (Math.abs(o.z - predZ) > HITBOX + BALL_R + 1.5) continue;
      if (t < bestT) { bestT = t; victim = o.slot; }
    }
    if (victim >= 0) { this.players[victim].stunT = STUN_TIME; this.events.push({ t: 'power', slot: victim, k: 9 }); }
  }

  private doWiden(p: FPlayer) {
    if (this.resetT > 0 || p.stunT > 0 || p.widenCd > 0) return;
    p.widenCd = WIDEN_CD;
    this.widenT[this.enemyGoalSide(p.team)] = WIDEN_TIME;
    this.events.push({ t: 'power', slot: p.slot, k: 8 });
  }

  private tickBall(dt: number) {
    this.bx += this.bvx * dt; this.bz += this.bvz * dt;
    if (this.bz > Z - BALL_R) { this.bz = Z - BALL_R; this.bvz = -Math.abs(this.bvz); }
    if (this.bz < -Z + BALL_R) { this.bz = -Z + BALL_R; this.bvz = Math.abs(this.bvz); }
    for (const sx of [-1, 1]) {
      if (sx < 0 ? this.bx < -X + BALL_R : this.bx > X - BALL_R) {
        const side = sx < 0 ? 0 : 1;
        if (Math.abs(this.bz) < this.effGoalHalf(side)) { this.onGoal(sx < 0 ? 1 : 0); return; }
        this.bx = sx < 0 ? -X + BALL_R : X - BALL_R; this.bvx = -this.bvx;
      }
    }
    for (const p of this.players) {
      if (p.stunT > 0) continue;
      const px = this.railX(p.slot);
      const dx = this.bx - px, dz = this.bz - p.z, d = Math.hypot(dx, dz), min = HITBOX + BALL_R;
      if (d < min && d > 0.001) {
        const nz = dz / d, sp = Math.hypot(this.bvx, this.bvz), dir = p.team === 0 ? 1 : -1;
        this.bx = px + dir * (min + 0.4);
        this.bz = p.z + nz * min;
        this.bvx = dir * Math.max(sp * 0.72, BALL_SPEED * 0.85);
        this.bvz = nz * sp * 0.6 + p.vz * 0.5;
      }
    }
    let sp = Math.hypot(this.bvx, this.bvz);
    if (sp < BALL_SPEED) { const k = BALL_SPEED / (sp || 1); this.bvx *= k; this.bvz *= k; }
    else if (sp > BALL_MAX) { const k = BALL_MAX / sp; this.bvx *= k; this.bvz *= k; }
  }

  private onGoal(scorer: number) {
    this.score[scorer]++;
    this.events.push({ t: 'goal', slot: scorer });
    this.bx = 0; this.bz = 0; this.bvx = 0; this.bvz = 0;
    this.resetT = 1.4;
    this.widenT = [0, 0];
    for (const p of this.players) { p.z = (p.slot % 2 === 0 ? -1 : 1) * Z * 0.28; p.vz = 0; p.stunT = 0; }
  }

  private kickoff() {
    const dir = Math.random() < 0.5 ? 1 : -1;
    this.bvx = dir * BALL_SPEED * 0.8; this.bvz = (Math.random() - 0.5) * BALL_SPEED * 0.6;
  }

  private sendState() {
    const players: PlayerState[] = this.players.map((p) => [
      p.slot, Math.round(this.railX(p.slot) * 100) / 100, Math.round(p.z * 100) / 100,
      0, Math.round(p.vz * 100) / 100, 0,
      1, 0, Math.round(p.stunT * 100) / 100, Math.round(p.widenCd * 100) / 100,
      Math.round(p.smashCd * 100) / 100, this.score[p.team], p.team,
    ]);
    // Ball as a single entity; extra encodes widen state (bit0 left, bit1 right).
    const widenBits = (this.widenT[0] > 0 ? 1 : 0) | (this.widenT[1] > 0 ? 2 : 0);
    const entities: EntityState[] = [[1, ET.ITEM, Math.round(this.bx * 100) / 100, Math.round(this.bz * 100) / 100, 0, widenBits]];
    // aux packs score: blue*100 + red.
    const aux = this.score[0] * 100 + this.score[1];
    for (const p of this.players) {
      if (!p.socketId) continue;
      const msg: StateMsg = {
        tick: this.tick, timeLeft: Math.max(0, Math.round(this.timeLeft * 10) / 10),
        ring: 0, ack: p.input.seq, players, events: this.events, entities, aux,
      };
      this.broadcast(p.socketId, msg);
    }
  }

  private finish(winTeam: number) {
    if (this.ended) return;
    this.ended = true;
    this.stop();
    const ranking = [...this.players]
      .map((p) => ({ p, rank: p.team === winTeam ? 1e6 + this.score[p.team] : this.score[p.team] }))
      .sort((a, b) => b.rank - a.rank)
      .map(({ p }) => ({ slot: p.slot, name: p.name, heroKey: p.hero.key, lives: this.score[p.team], dead: false, team: p.team }));
    this.onEnd({ mode: this.mode, winnerTeam: winTeam, scoreLabel: 'goals', ranking });
  }
}
