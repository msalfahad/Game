import { heroByKey, speedMult, strengthMult, accuracyMult, defenseMult, type HeroDef } from './heroes.js';
import { TICK_RATE, type InputMsg, type MatchEndMsg, type MatchMode, type EntityState, type PlayerState, type SimEvent, type StateMsg } from './protocol.js';
import { ET } from './protocol.js';
import type { MatchSeat } from './sim.js';
import type { OnlineGameDef } from './catalog.js';

// Universal authoritative free-roam simulation (20Hz) covering the remaining
// online mechanics: collect, mash, paint, breaktiles, throwfight, race and
// dodge. Physics constants mirror the client (src/game/physics.ts et al):
// BASE_SPEED 14, accel top*2.6, metal grip 0.02^dt, 3.0 hitboxes.

const HALF = 30;
const HITBOX = 3.0;
const BASE_SPEED = 14;
const JUMP_V = 22;
const GRAVITY = 60;
const ULT_CD = 14;
const WPS = 8; // race gates (matches the client's RaceGame)
const PAINT_N = 9;
const BREAK_N = 11;
const R_ICE = 21; // Slip & Slide round rink radius
const ICE_SEGS = 16;
const CLIMB_W = 12; // Avalanche Run corridor half-width
const CLIMB_L = 62; // Avalanche Run slope half-length (keep in sync with client)
const CLIMB_PACE = 0.7;
// Snowball Smash "SLIPPERY" sign cover (bottom middle). KEEP IN SYNC with client.
const SIGN_Z = HALF * 0.55;
const SIGN_HW = 4.6;
const SIGN_HD = 1.1;

interface FPlayer {
  slot: number;
  socketId: string | null;
  name: string;
  team: number;
  hero: HeroDef;
  x: number; z: number; vx: number; vz: number; y: number; vy: number;
  face: { x: number; z: number };
  lives: number; // also HP (throwfight)
  score: number;
  dead: boolean;
  held: boolean;
  invulnT: number; freezeT: number; shieldT: number; speedT: number; shoesT: number; cd: number;
  wp: number; lap: number;
  hitCd: number; // per-player laser/log damage cooldown
  input: InputMsg;
  ackSeq: number;
  retarget: number; tx: number; tz: number;
}

interface Ent {
  id: number;
  type: number;
  x: number; z: number; y: number;
  vx: number; vz: number; vy: number;
  extra: number;
  life: number; // <=0 handled per type; Infinity = persistent
  owner: number; // missiles
  rise: number; // targets
}

const PROJ = [
  { dmg: 14, speed: 52, aoe: false }, // 0 snowball
  { dmg: 24, speed: 40, aoe: true }, // 1 bomb
  { dmg: 20, speed: 48, aoe: false }, // 2 cannon
  { dmg: 18, speed: 46, aoe: false }, // 3 crate
];
const PROJ_IDX: Record<string, number> = { snowball: 0, bomb: 1, cannon: 2, crate: 3 };

export class FreeSim {
  private players: FPlayer[];
  private ents = new Map<number, Ent>();
  private nextId = 1;
  private tiles: Int8Array | null = null; // paint: owner+1 (0=none); breaktiles: 0 gone,1 alive,2 cracking
  private crackT: Float32Array | null = null;
  private respawnT: Float32Array | null = null;
  private beams: number[] = [];
  private aux = 0;
  private timeLeft: number;
  private duration: number;
  private tickN = 0;
  private events: SimEvent[] = [];
  private spawnT = 0;
  // Snowball Smash: hit-count scoring, no elimination, random perk drops.
  private snow = false;
  private decayT = 0;
  private beltT = 8;
  private ended = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private mech: OnlineGameDef['mechanic'];
  private mods: OnlineGameDef['mods'];

  constructor(
    seats: MatchSeat[],
    game: OnlineGameDef,
    private mode: MatchMode,
    private broadcast: (socketId: string, msg: StateMsg) => void,
    private onEnd: (msg: MatchEndMsg) => void,
  ) {
    this.mech = game.mechanic;
    this.mods = game.mods;
    this.snow = this.mech === 'throwfight' && this.mods.proj === 'snowball';
    this.duration = this.timeLeft = game.duration;
    const spots = [[-0.5, 0.5], [0.5, -0.5], [-0.5, -0.5], [0.5, 0.5]];
    this.players = seats.map((s, i) => ({
      slot: i,
      socketId: s.socketId,
      name: s.name,
      team: this.mode === '2v2' ? s.team : i,
      hero: heroByKey(s.heroKey),
      x: spots[i][0] * HALF,
      z: spots[i][1] * HALF,
      vx: 0, vz: 0, y: 0, vy: 0,
      face: { x: 0, z: -1 },
      lives: this.mech === 'throwfight' ? 100 : 3,
      score: 0,
      dead: false,
      held: false,
      invulnT: 0, freezeT: 0, shieldT: 0, speedT: 0, shoesT: 0, cd: 0,
      wp: 0, lap: 0,
      hitCd: 0,
      input: { seq: 0, ax: 0, ay: 0 },
      ackSeq: 0,
      retarget: 0, tx: 0, tz: 0,
    }));
    this.initMechanic();
  }

  private initMechanic() {
    if (this.mech === 'paint') {
      this.tiles = new Int8Array(PAINT_N * PAINT_N).fill(0);
    } else if (this.mech === 'breaktiles') {
      const n = BREAK_N * BREAK_N;
      this.tiles = new Int8Array(n).fill(1);
      this.crackT = new Float32Array(n).fill(-1);
      this.respawnT = new Float32Array(n).fill(0);
      if (this.mods.pond) {
        const c = (BREAK_N - 1) / 2;
        for (let gy = 0; gy < BREAK_N; gy++)
          for (let gx = 0; gx < BREAK_N; gx++)
            if (Math.abs(gx - c) <= 1 && Math.abs(gy - c) <= 1) this.tiles[gy * BREAK_N + gx] = 0;
      }
      // Race-style spawn tightening: keep everyone on tiles.
      for (const p of this.players) { p.x *= 0.8; p.z *= 0.8; }
    } else if (this.mech === 'collect') {
      for (let i = 0; i < 5; i++) this.dropLoot();
    } else if (this.mech === 'mash') {
      for (let i = 0; i < 7; i++) this.popTarget();
    } else if (this.mech === 'throwfight') {
      for (let i = 0; i < 6; i++) this.dropItem();
      this.spawnT = 5 + Math.random() * 5; // first perk drop (snowball mode)
    } else if (this.mech === 'race') {
      const g0 = this.wpPos(0);
      this.players.forEach((p, i) => {
        p.x = g0.x - 6 - (i % 2) * 5;
        p.z = g0.z + (i - 1.5) * 5;
      });
    } else if (this.mech === 'dodge' && this.mods.hz === 'lasers') {
      this.beams = [Math.random() * 6, Math.random() * 6 + Math.PI];
    } else if (this.mech === 'icepush') {
      // 16 breakable arc segments around the round rink (1 intact, 0 shattered).
      this.tiles = new Int8Array(ICE_SEGS).fill(1);
      this.spawnT = 10; // first thunder box
      // Spawn inside the smaller round rink.
      for (const p of this.players) { p.x *= 0.55; p.z *= 0.55; }
    } else if (this.mech === 'climb') {
      this.players.forEach((p, i) => {
        p.x = (i - 1.5) * 5.5;
        p.z = CLIMB_L - 4;
      });
      this.spawnT = 10; // first freeze box
      this.decayT = 1; // rock timer reuse
    }
  }

  start() { this.timer = setInterval(() => this.step(1 / TICK_RATE), 1000 / TICK_RATE); }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }
  applyInput(socketId: string, msg: InputMsg) {
    const p = this.players.find((q) => q.socketId === socketId);
    if (!p || p.dead) return;
    p.input = {
      seq: msg.seq,
      ax: Math.max(-1, Math.min(1, msg.ax || 0)),
      ay: Math.max(-1, Math.min(1, msg.ay || 0)),
      jump: !!msg.jump,
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

  // --- helpers ----------------------------------------------------------------
  private addEnt(type: number, x: number, z: number, y: number, extra = 0): Ent {
    const e: Ent = { id: this.nextId++, type, x, z, y, vx: 0, vz: 0, vy: 0, extra, life: Infinity, owner: -1, rise: 0 };
    this.ents.set(e.id, e);
    return e;
  }
  private wpPos(i: number) {
    const a = (i / WPS) * Math.PI * 2 + Math.PI / 2;
    const r = HALF * 0.72;
    return { x: Math.cos(a) * r, z: Math.sin(a) * r };
  }
  private openEdges(): boolean {
    if (this.mech === 'icepush') return true;
    return this.mech === 'dodge' && (this.mods.hz === 'logs' || this.mods.hz === 'wind');
  }
  private tileIdx(n: number, x: number, z: number): number {
    const step = (HALF * 2) / n;
    const gx = Math.floor((x + HALF) / step);
    const gy = Math.floor((z + HALF) / step);
    return gx >= 0 && gy >= 0 && gx < n && gy < n ? gy * n + gx : -1;
  }
  private tileCenter(n: number, idx: number) {
    const step = (HALF * 2) / n;
    return { x: -HALF + step * ((idx % n) + 0.5), z: -HALF + step * (Math.floor(idx / n) + 0.5) };
  }

  // --- spawners ----------------------------------------------------------------
  private dropLoot() {
    const e = this.addEnt(ET.LOOT, (Math.random() - 0.5) * HALF * 1.7, (Math.random() - 0.5) * HALF * 1.7, 40, this.mods.coin ? 1 : 0);
    e.vy = 0;
  }
  private popTarget() {
    const gold = Math.random() < 0.2;
    const e = this.addEnt(ET.TARGET, (Math.random() - 0.5) * HALF * 1.7, (Math.random() - 0.5) * HALF * 1.7, 0, gold ? 1 : 0);
    e.life = 4 + Math.random() * 3;
    if (this.mods.robots) {
      e.vx = (Math.random() - 0.5) * 5;
      e.vz = (Math.random() - 0.5) * 5;
    }
  }
  private dropItem() {
    const kind = PROJ_IDX[String(this.mods.proj ?? 'crate')] ?? 3;
    // Snowball fights mix in big snowballs (extra bit 4) that hit ~60% harder.
    const big = kind === 0 && Math.random() < 0.35 ? 4 : 0;
    this.addEnt(ET.ITEM, (Math.random() - 0.5) * HALF * 1.6, (Math.random() - 0.5) * HALF * 1.6, 1.5, kind | big);
  }
  private spawnLog(prog: number) {
    const axis = Math.random() < 0.5;
    const off = HALF + 5;
    const t = (Math.random() - 0.5) * HALF * 1.5;
    const sp = 20 + prog * 10;
    const dir = Math.random() < 0.5 ? 1 : -1;
    const e = this.addEnt(ET.LOG, axis ? -off * dir : t, axis ? t : -off * dir, 1.6, axis ? 0 : 1);
    if (axis) e.vx = sp * dir;
    else e.vz = sp * dir;
  }

  // --- main loop ----------------------------------------------------------------
  private step(dt: number) {
    if (this.ended) return;
    this.tickN++;
    this.timeLeft -= dt;
    const prog = 1 - Math.max(this.timeLeft, 0) / this.duration;

    for (const p of this.players) {
      if (p.dead) continue;
      p.invulnT = Math.max(0, p.invulnT - dt);
      p.freezeT = Math.max(0, p.freezeT - dt);
      p.shieldT = Math.max(0, p.shieldT - dt);
      p.speedT = Math.max(0, p.speedT - dt);
      p.shoesT = Math.max(0, p.shoesT - dt);
      p.hitCd = Math.max(0, p.hitCd - dt);
      p.cd = Math.max(0, p.cd - dt);
      if (p.socketId === null) this.botThink(p, dt);
      this.move(p, dt);
      if (p.input.jump) {
        p.input.jump = false;
        if (p.y <= 0 && p.freezeT <= 0) p.vy = JUMP_V;
      }
      if (p.input.ult) {
        p.input.ult = false;
        this.ability(p);
      }
      if (this.mech === 'dodge' && !p.dead) p.score += dt; // survival time
      p.ackSeq = p.input.seq;
    }

    if (this.mech !== 'race') this.collide();
    this.tickMechanic(dt, prog);
    this.sendState();
    this.events = [];

    // End conditions.
    const elimination = this.mech === 'breaktiles' || (this.mech === 'throwfight' && !this.snow) || this.mech === 'dodge';
    const alive = this.players.filter((p) => !p.dead);
    const aliveTeams = new Set(alive.map((p) => p.team));
    if (this.timeLeft <= 0 || (elimination && aliveTeams.size <= 1)) this.finish();
  }

  private move(p: FPlayer, dt: number) {
    const top = BASE_SPEED * speedMult(p.hero) * (p.speedT > 0 ? 1.35 : 1) * (p.shoesT > 0 ? 2 : 1) * (this.mech === 'climb' ? CLIMB_PACE : 1);
    const accel = top * 2.6;
    if (p.freezeT <= 0) {
      p.vx += p.input.ax * accel * dt;
      p.vz += p.input.ay * accel * dt;
      if (Math.abs(p.input.ax) + Math.abs(p.input.ay) > 0.05) {
        const L = Math.hypot(p.input.ax, p.input.ay) || 1;
        p.face = { x: p.input.ax / L, z: p.input.ay / L };
      }
    }
    // Slip & Slide keeps momentum like real ice.
    const retain = Math.pow(this.mech === 'icepush' ? 0.55 : 0.02, dt);
    p.vx *= retain;
    p.vz *= retain;
    const sp = Math.hypot(p.vx, p.vz);
    if (sp > top) { p.vx *= top / sp; p.vz *= top / sp; }
    p.x += p.vx * dt;
    p.z += p.vz * dt;
    if (p.y > 0 || p.vy !== 0) {
      p.y += p.vy * dt;
      p.vy -= GRAVITY * dt;
      if (p.y <= 0) { p.y = 0; p.vy = 0; }
    }
    if (this.mech === 'climb') {
      const w = CLIMB_W - 1;
      if (p.x < -w) { p.x = -w; p.vx = Math.abs(p.vx) * 0.3; }
      if (p.x > w) { p.x = w; p.vx = -Math.abs(p.vx) * 0.3; }
      if (p.z > CLIMB_L - 1) { p.z = CLIMB_L - 1; p.vz = -Math.abs(p.vz) * 0.3; }
      if (p.z < -(CLIMB_L - 1)) p.z = -(CLIMB_L - 1);
    } else if (!this.openEdges()) {
      const m = HALF - 1;
      if (p.x < -m) { p.x = -m; p.vx = Math.abs(p.vx) * 0.3; }
      if (p.x > m) { p.x = m; p.vx = -Math.abs(p.vx) * 0.3; }
      if (p.z < -m) { p.z = -m; p.vz = Math.abs(p.vz) * 0.3; }
      if (p.z > m) { p.z = m; p.vz = -Math.abs(p.vz) * 0.3; }
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
          const friendly = a.team === b.team;
          const imp = -rel * (friendly ? 0.2 : 1.5);
          const dampA = a.shieldT > 0 ? 0.5 : 1;
          const dampB = b.shieldT > 0 ? 0.5 : 1;
          a.vx -= (nx * imp * strengthMult(b.hero) * dampA) / defenseMult(a.hero);
          a.vz -= (nz * imp * strengthMult(b.hero) * dampA) / defenseMult(a.hero);
          b.vx += (nx * imp * strengthMult(a.hero) * dampB) / defenseMult(b.hero);
          b.vz += (nz * imp * strengthMult(a.hero) * dampB) / defenseMult(b.hero);
        }
      }
    }
  }

  private ability(p: FPlayer) {
    if (p.freezeT > 0) return;
    if (this.mech === 'climb') return; // climbing is pure — the box is the power
    if (this.mech === 'throwfight' && p.held) return this.throwItem(p);
    if (this.mech === 'paint') {
      if (p.cd > 0) return;
      p.cd = 8;
      const n = PAINT_N;
      const idx = this.tileIdx(n, p.x, p.z);
      if (idx >= 0 && this.tiles) {
        const gx = idx % n, gy = Math.floor(idx / n);
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++)
            if (gx + dx >= 0 && gx + dx < n && gy + dy >= 0 && gy + dy < n)
              this.tiles[(gy + dy) * n + (gx + dx)] = p.slot + 1;
      }
      this.events.push({ t: 'ult', slot: p.slot });
      return;
    }
    // Hero ultimate.
    if (p.cd > 0) return;
    p.cd = ULT_CD;
    const rivals = this.players.filter((q) => q !== p && !q.dead && q.team !== p.team);
    const near = (r: number) => rivals.filter((q) => Math.hypot(q.x - p.x, q.z - p.z) < r);
    const knock = (targets: FPlayer[], impulse: number) => {
      for (const q of targets) {
        const d = Math.hypot(q.x - p.x, q.z - p.z) || 1;
        const damp = q.shieldT > 0 ? 0.5 : 1;
        q.vx += ((q.x - p.x) / d) * impulse * strengthMult(p.hero) * damp;
        q.vz += ((q.z - p.z) / d) * impulse * strengthMult(p.hero) * damp;
      }
    };
    switch (p.hero.ult) {
      case 'blink': {
        p.x += p.face.x * 14;
        p.z += p.face.z * 14;
        const m = HALF - 1.5;
        p.x = Math.max(-m, Math.min(m, p.x));
        p.z = Math.max(-m, Math.min(m, p.z));
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
        if (this.mech === 'throwfight') p.lives = Math.min(100, p.lives + 25);
        p.shieldT = Math.max(p.shieldT, 3);
        break;
      case 'clone':
      case 'fortress':
        p.shieldT = Math.max(p.shieldT, 3);
        if (p.hero.ult === 'fortress') knock(near(8), 26);
        break;
    }
    this.events.push({ t: 'ult', slot: p.slot });
  }

  private throwItem(p: FPlayer) {
    p.held = false;
    let tgt: FPlayer | null = null, bd = 1e9;
    for (const q of this.players) {
      if (q === p || q.dead || q.team === p.team) continue;
      const d = Math.hypot(q.x - p.x, q.z - p.z);
      if (d < bd) { bd = d; tgt = q; }
    }
    let dx = p.face.x, dz = p.face.z;
    if (tgt) {
      dx = tgt.x - p.x; dz = tgt.z - p.z;
      const L = Math.hypot(dx, dz) || 1;
      const err = (1.075 - accuracyMult(p.hero)) * 2.2 + (p.socketId ? 0 : 0.2);
      const a = Math.atan2(dz / L, dx / L) + (Math.random() - 0.5) * err;
      dx = Math.cos(a); dz = Math.sin(a);
    }
    const kind = PROJ_IDX[String(this.mods.proj ?? 'crate')] ?? 3;
    const big = (p as any)._heldBig ? 4 : 0;
    (p as any)._heldBig = false;
    const s = PROJ[kind];
    const e = this.addEnt(ET.MISSILE, p.x, p.z, 3, kind | big);
    e.vx = dx * s.speed;
    e.vz = dz * s.speed;
    e.vy = 6;
    e.owner = p.slot;
  }

  private damage(q: FPlayer, dmg: number) {
    if (q.shieldT > 0) { q.shieldT = 0; return; }
    q.lives -= dmg;
    this.events.push({ t: 'hit', slot: q.slot });
    if (q.lives <= 0) {
      q.lives = 0;
      q.dead = true;
      this.events.push({ t: 'out', slot: q.slot });
    }
  }

  private loseLife(p: FPlayer, respawnCenter = true) {
    p.lives--;
    this.events.push({ t: 'fall', slot: p.slot });
    if (p.lives <= 0) {
      p.dead = true;
      this.events.push({ t: 'out', slot: p.slot });
      return;
    }
    if (respawnCenter) {
      p.x = (Math.random() - 0.5) * HALF * 0.4;
      p.z = (Math.random() - 0.5) * HALF * 0.4;
    }
    p.vx = 0; p.vz = 0;
    p.invulnT = 1;
  }

  // --- per-mechanic tick ---------------------------------------------------------
  private tickMechanic(dt: number, prog: number) {
    if (this.mech === 'icepush') this.tickIcePush(dt);
    else if (this.mech === 'climb') this.tickClimb(dt, prog);
    else if (this.mech === 'collect') this.tickCollect(dt);
    else if (this.mech === 'mash') this.tickMash(dt);
    else if (this.mech === 'paint') this.tickPaint();
    else if (this.mech === 'breaktiles') this.tickBreak(dt, prog);
    else if (this.mech === 'throwfight') this.tickThrow(dt);
    else if (this.mech === 'race') this.tickRace(dt);
    else if (this.mech === 'dodge') this.tickDodge(dt, prog);
  }

  private tickIcePush(dt: number) {
    // ⚡ thunder box every 10s; the grabber strikes everyone else with
    // lightning: 3s stun (clients render victims blacked out).
    this.spawnT -= dt;
    if (this.spawnT <= 0) {
      this.spawnT = 10;
      for (const e of this.ents.values()) if (e.type === ET.LOOT) this.ents.delete(e.id);
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * R_ICE * 0.7;
      this.addEnt(ET.LOOT, Math.cos(a) * r, Math.sin(a) * r, 1.3, 3);
    }
    for (const e of this.ents.values()) {
      if (e.type !== ET.LOOT) continue;
      for (const p of this.players) {
        if (p.dead || p.freezeT > 0) continue;
        if (Math.hypot(e.x - p.x, e.z - p.z) < HITBOX + 2) {
          this.ents.delete(e.id);
          this.events.push({ t: 'power', slot: p.slot });
          for (const q of this.players) {
            if (q === p || q.dead || q.team === p.team) continue;
            q.freezeT = Math.max(q.freezeT, 3);
            q.vx *= 0.1;
            q.vz *= 0.1;
          }
          break;
        }
      }
    }
    // Breakable round wall: an arc segment saves you once, then shatters.
    if (!this.tiles) return;
    const segAt = (x: number, z: number): number => {
      const a = (Math.atan2(z, x) + Math.PI * 2) % (Math.PI * 2);
      return Math.min(ICE_SEGS - 1, Math.floor((a / (Math.PI * 2)) * ICE_SEGS));
    };
    for (const p of this.players) {
      if (p.dead || p.invulnT > 0) continue;
      const r = Math.hypot(p.x, p.z);
      if (r < R_ICE - 1) continue;
      const seg = segAt(p.x, p.z);
      if (this.tiles[seg] === 1 && r < R_ICE + 1.5) {
        this.tiles[seg] = 0;
        this.events.push({ t: 'hit', slot: p.slot }); // wall shatter cue
        const nx = -p.x / (r || 1);
        const nz = -p.z / (r || 1);
        p.vx = nx * 22;
        p.vz = nz * 22;
        const rr = R_ICE - 1.6;
        p.x = (p.x / (r || 1)) * rr;
        p.z = (p.z / (r || 1)) * rr;
      } else if (this.tiles[seg] === 0 && r > R_ICE + 1) {
        this.loseLife(p);
      }
    }
  }

  private tickClimb(dt: number, prog: number) {
    // Boulders tumble down the slope; hits knock climbers back down.
    this.decayT -= dt;
    if (this.decayT <= 0) {
      this.decayT = Math.max(0.55, 1.3 - prog * 0.6);
      const e = this.addEnt(ET.LOG, (Math.random() - 0.5) * (CLIMB_W - 2) * 2, -(CLIMB_L + 4), 2, 2);
      e.vz = 13 + prog * 7 + Math.random() * 5;
    }
    for (const e of this.ents.values()) {
      if (e.type !== ET.LOG) continue;
      e.z += e.vz * dt;
      for (const p of this.players) {
        if (p.dead || p.hitCd > 0) continue;
        if (Math.hypot(p.x - e.x, p.z - e.z) < HITBOX + 2.2) {
          p.hitCd = 0.7;
          p.vz += 30;
          p.freezeT = Math.max(p.freezeT, 0.35);
          this.events.push({ t: 'hit', slot: p.slot });
        }
      }
      if (e.z > CLIMB_L + 6) this.ents.delete(e.id);
    }
    // ❄ freeze box every 10s.
    this.spawnT -= dt;
    if (this.spawnT <= 0) {
      this.spawnT = 10;
      for (const e of this.ents.values()) if (e.type === ET.LOOT) this.ents.delete(e.id);
      // ANYWHERE random along the pack's active stretch — luck joins skill.
      const alive = this.players.filter((p) => !p.dead);
      const leadZ = alive.length ? Math.min(...alive.map((p) => p.z)) : 0;
      const tailZ = alive.length ? Math.max(...alive.map((p) => p.z)) : 0;
      const lo = Math.max(-(CLIMB_L - 6), leadZ - 14);
      const hi = Math.min(CLIMB_L - 5, tailZ + 6);
      this.addEnt(
        ET.LOOT,
        (Math.random() - 0.5) * (CLIMB_W - 3) * 2,
        lo + Math.random() * Math.max(0, hi - lo),
        1.2,
        2,
      );
    }
    for (const e of this.ents.values()) {
      if (e.type !== ET.LOOT) continue;
      for (const p of this.players) {
        if (p.dead) continue;
        if (Math.hypot(e.x - p.x, e.z - p.z) < HITBOX + 2) {
          this.ents.delete(e.id);
          this.events.push({ t: 'power', slot: p.slot });
          for (const q of this.players) {
            if (q === p || q.dead) continue;
            q.freezeT = Math.max(q.freezeT, 3);
          }
          break;
        }
      }
    }
    // Progress + summit.
    for (const p of this.players) {
      if (p.dead) continue;
      p.score = Math.max(0, Math.round(CLIMB_L - 4 - p.z));
      if (p.z <= -(CLIMB_L - 3.5)) return this.finish();
    }
  }

  private tickCollect(dt: number) {
    this.spawnT += dt;
    const loots = [...this.ents.values()].filter((e) => e.type === ET.LOOT);
    if (this.spawnT > 0.8 && loots.length < 11) { this.spawnT = 0; this.dropLoot(); }
    for (const e of loots) {
      e.y += e.vy * dt;
      e.vy -= 60 * dt;
      if (e.y < 1.4) { e.y = 1.4; e.vy = Math.abs(e.vy) * 0.4; }
      for (const p of this.players) {
        if (p.dead || e.y > 4) continue;
        if (Math.hypot(e.x - p.x, e.z - p.z) < HITBOX + 2) {
          p.score++;
          this.events.push({ t: 'pick', slot: p.slot });
          this.ents.delete(e.id);
          break;
        }
      }
    }
  }

  private tickMash(dt: number) {
    this.spawnT += dt;
    const targets = [...this.ents.values()].filter((e) => e.type === ET.TARGET);
    if (this.spawnT > 0.7 && targets.length < 12) { this.spawnT = 0; this.popTarget(); }
    for (const e of targets) {
      if (e.rise < 1) e.rise = Math.min(1, e.rise + dt * 3);
      e.y = -3 + e.rise * 4.5;
      if (this.mods.robots && e.rise >= 1) {
        e.x += e.vx * dt;
        e.z += e.vz * dt;
        const m = HALF - 2;
        if (Math.abs(e.x) > m) e.vx *= -1;
        if (Math.abs(e.z) > m) e.vz *= -1;
      }
      e.life -= dt;
      if (e.life <= 0) { this.ents.delete(e.id); continue; }
      for (const p of this.players) {
        if (p.dead || e.rise < 0.4) continue;
        if (Math.hypot(e.x - p.x, e.z - p.z) < HITBOX + 1.5) {
          p.score += e.extra ? 5 : 2;
          this.events.push({ t: 'pick', slot: p.slot });
          this.ents.delete(e.id);
          break;
        }
      }
    }
  }

  private tickPaint() {
    if (!this.tiles) return;
    for (const p of this.players) {
      if (p.dead) continue;
      const idx = this.tileIdx(PAINT_N, p.x, p.z);
      if (idx >= 0 && this.tiles[idx] !== p.slot + 1) this.tiles[idx] = p.slot + 1;
    }
    for (const p of this.players) {
      let n = 0;
      for (let i = 0; i < this.tiles.length; i++) if (this.tiles[i] === p.slot + 1) n++;
      p.score = n;
    }
  }

  private tickBreak(dt: number, prog: number) {
    if (!this.tiles || !this.crackT || !this.respawnT) return;
    const n = BREAK_N;
    const respawnMode = this.mods.decay === 'respawn';
    // Step-cracking.
    for (const p of this.players) {
      if (p.dead || p.y > 0.5) continue;
      const idx = this.tileIdx(n, p.x, p.z);
      if (idx >= 0 && this.tiles[idx] === 1) {
        this.tiles[idx] = 2;
        this.crackT[idx] = respawnMode ? 0.55 : 0.8;
      }
    }
    // Ambient decay.
    this.decayT -= dt;
    if (this.decayT <= 0 && prog > 0.15) {
      this.decayT = Math.max(0.5, 1.6 - prog * 1.2);
      const candidates: number[] = [];
      for (let i = 0; i < this.tiles.length; i++) if (this.tiles[i] === 1) candidates.push(i);
      if (candidates.length > 8) {
        let pick: number;
        if (this.mods.decay === 'side') {
          candidates.sort((a, b) => Math.floor(a / n) - Math.floor(b / n));
          pick = candidates[Math.floor(Math.random() * Math.min(8, candidates.length))];
        } else {
          const c = (n - 1) / 2;
          const ringDist = (i: number) => Math.max(Math.abs((i % n) - c), Math.abs(Math.floor(i / n) - c));
          candidates.sort((a, b) => ringDist(b) - ringDist(a));
          pick = candidates[Math.floor(Math.random() * Math.min(6, candidates.length))];
        }
        this.tiles[pick] = 2;
        this.crackT[pick] = 0.7;
      }
    }
    // Crack countdown + respawn.
    for (let i = 0; i < this.tiles.length; i++) {
      if (this.tiles[i] === 2) {
        this.crackT[i] -= dt;
        if (this.crackT[i] <= 0) {
          this.tiles[i] = 0;
          this.respawnT[i] = respawnMode ? 3 : Infinity;
        }
      } else if (this.tiles[i] === 0 && this.respawnT[i] !== Infinity && this.respawnT[i] > 0) {
        this.respawnT[i] -= dt;
        if (this.respawnT[i] <= 0) this.tiles[i] = 1;
      }
    }
    // Falls.
    for (const p of this.players) {
      if (p.dead || p.invulnT > 0 || p.y > 0.5) continue;
      const idx = this.tileIdx(n, p.x, p.z);
      if (idx >= 0 && this.tiles[idx] >= 1) continue;
      // Respawn on a safe tile near the center.
      const safe: number[] = [];
      for (let i = 0; i < this.tiles.length; i++) if (this.tiles[i] === 1) safe.push(i);
      safe.sort((a, b) => {
        const ca = this.tileCenter(n, a), cb = this.tileCenter(n, b);
        return Math.hypot(ca.x, ca.z) - Math.hypot(cb.x, cb.z);
      });
      const spot = safe[Math.floor(Math.random() * Math.min(8, safe.length))];
      this.loseLife(p, false);
      if (!p.dead && spot !== undefined) {
        const c = this.tileCenter(n, spot);
        p.x = c.x;
        p.z = c.z;
      }
    }
  }

  private tickThrow(dt: number) {
    const items = [...this.ents.values()].filter((e) => e.type === ET.ITEM);
    if (items.length < 6 && Math.random() < dt * 0.6) this.dropItem();
    // Snowball Smash perks: shoes (4) / zap (5) / shield (6) every 5-10s.
    if (this.snow) {
      this.spawnT -= dt;
      const perks = [...this.ents.values()].filter((e) => e.type === ET.LOOT);
      if (this.spawnT <= 0) {
        this.spawnT = 5 + Math.random() * 5;
        if (perks.length < 2) {
          const kind = 4 + Math.floor(Math.random() * 3);
          this.addEnt(ET.LOOT, (Math.random() - 0.5) * HALF * 1.6, (Math.random() - 0.5) * HALF * 1.6, 0.3, kind);
        }
      }
      for (const e of perks) {
        for (const p of this.players) {
          if (p.dead) continue;
          if (Math.hypot(e.x - p.x, e.z - p.z) < HITBOX + 2) {
            this.ents.delete(e.id);
            if (e.extra === 4) p.shoesT = 5;
            else if (e.extra === 6) p.shieldT = 5;
            else {
              for (const q of this.players) {
                if (q === p || q.dead) continue;
                q.freezeT = Math.max(q.freezeT, 3);
              }
            }
            this.events.push({ t: 'power', slot: p.slot, k: e.extra });
            break;
          }
        }
      }
    }
    // Pickups.
    for (const p of this.players) {
      if (p.dead || p.held) continue;
      for (const e of items) {
        if (!this.ents.has(e.id)) continue;
        if (Math.hypot(e.x - p.x, e.z - p.z) < HITBOX + 2) {
          p.held = true;
          (p as any)._heldBig = (e.extra & 4) !== 0;
          this.ents.delete(e.id);
          this.events.push({ t: 'pick', slot: p.slot });
          break;
        }
      }
    }
    // Solid sign collision: push players out along the smaller penetration axis.
    if (this.snow) {
      for (const p of this.players) {
        if (p.dead) continue;
        const HW = SIGN_HW + HITBOX * 0.8;
        const HD = SIGN_HD + HITBOX * 0.8;
        const dz = p.z - SIGN_Z;
        if (Math.abs(p.x) >= HW || Math.abs(dz) >= HD) continue;
        const penX = HW - Math.abs(p.x);
        const penZ = HD - Math.abs(dz);
        if (penX < penZ) {
          p.x = Math.sign(p.x || 1) * HW;
          p.vx = Math.sign(p.x) * Math.abs(p.vx) * 0.3;
        } else {
          p.z = SIGN_Z + Math.sign(dz || 1) * HD;
          p.vz = Math.sign(dz || 1) * Math.abs(p.vz) * 0.3;
        }
      }
    }

    // Missiles.
    for (const e of [...this.ents.values()].filter((x) => x.type === ET.MISSILE)) {
      e.x += e.vx * dt;
      e.z += e.vz * dt;
      e.y += e.vy * dt;
      e.vy -= 30 * dt;
      // The SLIPPERY sign is solid cover: low throws splat against it.
      if (this.snow && Math.abs(e.x) < SIGN_HW + 0.8 && Math.abs(e.z - SIGN_Z) < SIGN_HD + 0.8 && e.y < 5.6) {
        this.ents.delete(e.id);
        continue;
      }
      const s = PROJ[e.extra & 3] ?? PROJ[3];
      const bigMul = (e.extra & 4) !== 0 ? 1.6 : 1;
      let boom = false;
      for (const q of this.players) {
        if (q.slot === e.owner || q.dead) continue;
        const ow = this.players[e.owner];
        if (ow && q.team === ow.team) continue;
        if (Math.hypot(q.x - e.x, q.z - e.z) < HITBOX + 1.6 && e.y < HITBOX * 2.6) {
          if (this.snow) {
            // Hit-count scoring: big snowballs count DOUBLE; a shield means
            // hits on you don't count at all.
            const big = (e.extra & 4) !== 0;
            if (q.shieldT <= 0) {
              const ow2 = this.players[e.owner];
              if (ow2) ow2.score += big ? 2 : 1;
              // Splat! 0.5s stun; the client shows the stagger on 'hit'.
              q.freezeT = Math.max(q.freezeT, 0.5);
              const L = Math.hypot(e.vx, e.vz) || 1;
              q.vx += (e.vx / L) * (big ? 30 : 20);
              q.vz += (e.vz / L) * (big ? 30 : 20);
              this.events.push({ t: 'hit', slot: q.slot });
            }
          } else if (s.aoe) boom = true;
          else {
            const ow2 = this.players[e.owner];
            this.damage(q, s.dmg * bigMul * (ow2 ? strengthMult(ow2.hero) : 1));
            const L = Math.hypot(e.vx, e.vz) || 1;
            const damp = q.shieldT > 0 ? 0.5 : 1;
            q.vx += (e.vx / L) * 22 * damp;
            q.vz += (e.vz / L) * 22 * damp;
          }
          if (!s.aoe || this.snow) this.ents.delete(e.id);
          break;
        }
      }
      if (this.ents.has(e.id)) {
        const out = e.y < 1 || Math.abs(e.x) > HALF + 8 || Math.abs(e.z) > HALF + 8;
        if (boom || (s.aoe && e.y < 1 && Math.abs(e.x) < HALF && Math.abs(e.z) < HALF)) {
          // Bomb AoE.
          for (const q of this.players) {
            const ow = this.players[e.owner];
            if (q.slot === e.owner || q.dead || (ow && q.team === ow.team)) continue;
            const d = Math.hypot(q.x - e.x, q.z - e.z);
            if (d < 7) {
              this.damage(q, 22 * (1 - d / 10));
              const nx = (q.x - e.x) / (d || 1), nz = (q.z - e.z) / (d || 1);
              const damp = q.shieldT > 0 ? 0.5 : 1;
              q.vx += nx * 32 * damp;
              q.vz += nz * 32 * damp;
            }
          }
          this.events.push({ t: 'goal', slot: e.owner }); // reused as "explosion" fx cue
          this.ents.delete(e.id);
        } else if (out) {
          this.ents.delete(e.id);
        }
      }
    }
  }

  private tickRace(dt: number) {
    for (const p of this.players) {
      if (p.dead) continue;
      const t = this.wpPos(p.wp);
      if (Math.hypot(p.x - t.x, p.z - t.z) < 5) {
        p.wp++;
        p.score++;
        this.events.push({ t: 'pick', slot: p.slot });
        if (p.wp >= WPS) {
          p.wp = 0;
          p.lap++;
          if (p.lap >= Number(this.mods.laps ?? 2)) return this.finish();
        }
      }
      // Boost pads on the infield diagonals.
      for (let i = 0; i < 4; i++) {
        const a = (i * Math.PI) / 2 + Math.PI / 4;
        const bx = Math.cos(a) * HALF * 0.4, bz = Math.sin(a) * HALF * 0.4;
        if (Math.hypot(p.x - bx, p.z - bz) < 3 && p.speedT < 1.2) {
          p.speedT = Math.max(p.speedT, 1.6);
          p.vx += p.face.x * 18;
          p.vz += p.face.z * 18;
        }
      }
    }
    void dt;
  }

  private tickDodge(dt: number, prog: number) {
    const hz = String(this.mods.hz ?? 'logs');
    if (hz === 'logs') {
      this.spawnT -= dt;
      if (this.spawnT <= 0) {
        this.spawnT = Math.max(0.8, 2.2 - prog * 1.4);
        this.spawnLog(prog);
      }
      for (const e of [...this.ents.values()].filter((x) => x.type === ET.LOG)) {
        e.x += e.vx * dt;
        e.z += e.vz * dt;
        for (const p of this.players) {
          if (p.dead || p.invulnT > 0 || p.y > 2.6) continue;
          const along = e.vx !== 0 ? Math.abs(p.z - e.z) : Math.abs(p.x - e.x);
          const across = e.vx !== 0 ? Math.abs(p.x - e.x) : Math.abs(p.z - e.z);
          if (across < HITBOX + 1.6 && along < HALF * 0.55) {
            const L = Math.hypot(e.vx, e.vz) || 1;
            p.vx += (e.vx / L) * 34;
            p.vz += (e.vz / L) * 34;
            p.freezeT = Math.max(p.freezeT, 0.25);
          }
        }
        if (Math.abs(e.x) > HALF + 8 || Math.abs(e.z) > HALF + 8) this.ents.delete(e.id);
      }
    } else if (hz === 'lasers') {
      this.beams[0] += dt * (0.7 + prog * 0.8);
      this.beams[1] -= dt * (0.56 + prog * 0.64);
      this.beams.forEach((angle) => {
        for (const p of this.players) {
          if (p.dead || p.invulnT > 0 || p.y > 2.4 || p.hitCd > 0) continue;
          const r = Math.hypot(p.x, p.z);
          if (r > HALF || r < 1) continue;
          let diff = Math.atan2(p.z, p.x) - -angle;
          while (diff > Math.PI) diff -= Math.PI * 2;
          while (diff < -Math.PI) diff += Math.PI * 2;
          if (Math.abs(diff) > Math.PI / 2) continue;
          if (Math.abs(Math.sin(diff)) * r < 1.5) {
            p.hitCd = 0.8;
            if (p.shieldT > 0) { p.shieldT = 0; continue; }
            this.loseLife(p);
          }
        }
      });
    } else if (hz === 'wind') {
      this.aux += dt * 0.25;
      const strength = 10 + prog * 14;
      const gust = 0.7 + 0.3 * Math.sin(this.aux * 3.1);
      for (const p of this.players) {
        if (p.dead) continue;
        p.vx += Math.cos(this.aux) * strength * gust * dt;
        p.vz += Math.sin(this.aux) * strength * gust * dt;
      }
    } else if (hz === 'conveyor') {
      this.beltT -= dt;
      if (this.beltT <= 0) {
        this.beltT = 8;
        this.aux = this.aux === 1 ? -1 : 1;
      }
      if (this.aux === 0) this.aux = 1;
      const push = (8 + prog * 8) * this.aux;
      for (const p of this.players) {
        if (p.dead) continue;
        p.vx += push * dt * 2.4;
        if (Math.abs(p.x) > HALF - 3.4 && p.invulnT <= 0) {
          if (p.shieldT > 0) { p.shieldT = 0; p.x = 0; p.z = 0; p.invulnT = 1; continue; }
          this.loseLife(p);
        }
      }
    }
    // Open-edge falls.
    if (this.openEdges()) {
      for (const p of this.players) {
        if (p.dead || p.invulnT > 0) continue;
        if (Math.abs(p.x) > HALF + 1 || Math.abs(p.z) > HALF + 1) this.loseLife(p);
      }
    }
  }

  // --- bots -----------------------------------------------------------------
  private botThink(p: FPlayer, dt: number) {
    p.retarget -= dt;
    if (p.retarget > 0) {
      this.steer(p);
      return;
    }
    p.retarget = 0.4 + Math.random() * 0.4;
    if (p.cd <= 0 && Math.random() < 0.15) p.input.ult = true;

    if (this.mech === 'collect') {
      let best: Ent | null = null, bd = 1e9;
      for (const e of this.ents.values()) {
        if (e.type !== ET.LOOT || e.y > 3) continue;
        const d = Math.hypot(e.x - p.x, e.z - p.z);
        if (d < bd) { bd = d; best = e; }
      }
      p.tx = best ? best.x : 0;
      p.tz = best ? best.z : 0;
    } else if (this.mech === 'mash') {
      let best: Ent | null = null, bd = 1e9;
      for (const e of this.ents.values()) {
        if (e.type !== ET.TARGET || e.rise < 0.4) continue;
        const d = Math.hypot(e.x - p.x, e.z - p.z) * (e.extra ? 0.6 : 1);
        if (d < bd) { bd = d; best = e; }
      }
      p.tx = best ? best.x : 0;
      p.tz = best ? best.z : 0;
    } else if (this.mech === 'paint') {
      p.tx = (Math.random() - 0.5) * HALF * 1.8;
      p.tz = (Math.random() - 0.5) * HALF * 1.8;
    } else if (this.mech === 'breaktiles') {
      if (this.tiles) {
        let best = -1, bs = -1;
        for (let t = 0; t < 14; t++) {
          const i = Math.floor(Math.random() * this.tiles.length);
          if (this.tiles[i] !== 1) continue;
          const c = this.tileCenter(BREAK_N, i);
          const s = 1 - Math.hypot(c.x, c.z) / (HALF * 1.5) + (1 - Math.hypot(c.x - p.x, c.z - p.z) / (HALF * 2));
          if (s > bs) { bs = s; best = i; }
        }
        if (best >= 0) {
          const c = this.tileCenter(BREAK_N, best);
          p.tx = c.x;
          p.tz = c.z;
        }
      }
    } else if (this.mech === 'throwfight') {
      if (!p.held) {
        let best: Ent | null = null, bd = 1e9;
        for (const e of this.ents.values()) {
          if (e.type !== ET.ITEM) continue;
          const d = Math.hypot(e.x - p.x, e.z - p.z);
          if (d < bd) { bd = d; best = e; }
        }
        p.tx = best ? best.x : 0;
        p.tz = best ? best.z : 0;
        if (this.snow && Math.random() < 0.5) {
          for (const e of this.ents.values()) {
            if (e.type !== ET.LOOT) continue;
            if (Math.hypot(e.x - p.x, e.z - p.z) < 22) { p.tx = e.x; p.tz = e.z; }
            break;
          }
        }
      } else {
        let q: FPlayer | null = null, bd = 1e9;
        for (const o of this.players) {
          if (o === p || o.dead || o.team === p.team) continue;
          const d = Math.hypot(o.x - p.x, o.z - p.z);
          if (d < bd) { bd = d; q = o; }
        }
        if (q) {
          p.face = { x: (q.x - p.x) / (bd || 1), z: (q.z - p.z) / (bd || 1) };
          if (bd < HALF * 1.2 && Math.random() < 0.5) this.throwItem(p);
        }
        p.tx = p.x;
        p.tz = p.z;
      }
    } else if (this.mech === 'race') {
      const t = this.wpPos(p.wp);
      p.tx = t.x + (Math.random() - 0.5) * 8;
      p.tz = t.z + (Math.random() - 0.5) * 8;
    } else if (this.mech === 'icepush') {
      let box: Ent | null = null;
      for (const e of this.ents.values()) if (e.type === ET.LOOT) box = e;
      if (box) {
        p.tx = box.x;
        p.tz = box.z;
      } else {
        const foes = this.players.filter((q) => q !== p && !q.dead && q.team !== p.team);
        const t = foes[Math.floor(Math.random() * foes.length)];
        p.tx = t ? t.x : 0;
        p.tz = t ? t.z : 0;
      }
    } else if (this.mech === 'climb') {
      let dodge = 0;
      for (const e of this.ents.values()) {
        if (e.type !== ET.LOG) continue;
        if (e.z < p.z && p.z - e.z < 14 && Math.abs(e.x - p.x) < 5) {
          dodge = e.x > p.x ? -7 : 7;
          break;
        }
      }
      p.tx = Math.max(-CLIMB_W + 3, Math.min(CLIMB_W - 3, p.x + dodge + (Math.random() - 0.5) * 3));
      p.tz = p.z - 12;
    } else {
      // dodge: drift near center
      p.tx = (Math.random() - 0.5) * HALF * 0.5;
      p.tz = (Math.random() - 0.5) * HALF * 0.5;
    }
    this.steer(p);
  }

  private steer(p: FPlayer) {
    const dx = p.tx - p.x, dz = p.tz - p.z;
    const L = Math.hypot(dx, dz) || 1;
    p.input.ax = (dx / L) * 0.66;
    p.input.ay = (dz / L) * 0.66;
  }

  // --- state / end -------------------------------------------------------------
  private sendState() {
    const players: PlayerState[] = this.players.map((p) => [
      p.slot,
      Math.round(p.x * 100) / 100,
      Math.round(p.z * 100) / 100,
      Math.round(p.vx * 100) / 100,
      Math.round(p.vz * 100) / 100,
      Math.round(p.y * 100) / 100,
      Math.round(p.lives),
      p.dead ? 1 : 0,
      Math.round(p.freezeT * 100) / 100,
      Math.round(p.shieldT * 100) / 100,
      Math.round(p.cd * 10) / 10,
      Math.round(p.score * 10) / 10,
      (p.held ? 1 : 0) | (p.shoesT > 0 ? 2 : 0),
    ]);
    const entities: EntityState[] = [...this.ents.values()].map((e) => [
      e.id, e.type,
      Math.round(e.x * 100) / 100,
      Math.round(e.z * 100) / 100,
      Math.round(e.y * 100) / 100,
      e.extra,
    ]);
    const tiles = this.tiles ? Array.from(this.tiles) : undefined;
    for (const p of this.players) {
      if (!p.socketId) continue;
      const msg: StateMsg = {
        tick: this.tickN,
        timeLeft: Math.max(0, Math.round(this.timeLeft * 10) / 10),
        ring: HALF,
        ack: p.ackSeq,
        players,
        events: this.events,
        entities,
        tiles,
        beams: this.beams.length ? this.beams.map((b) => Math.round(b * 100) / 100) : undefined,
        aux: this.aux || undefined,
      };
      this.broadcast(p.socketId, msg);
    }
  }

  private finish() {
    if (this.ended) return;
    this.ended = true;
    this.stop();
    const scoreBased = this.mech === 'collect' || this.mech === 'mash' || this.mech === 'paint' || this.mech === 'race' || this.mech === 'climb' || this.snow;
    let winnerTeam = -1;
    if (this.mode === '2v2') {
      const teamScore = (team: number) =>
        this.players
          .filter((p) => p.team === team)
          .reduce((v, p) => v + (p.dead ? 0 : 100 + Math.max(p.lives, 0)) + p.score * 0.01, 0);
      winnerTeam = teamScore(0) >= teamScore(1) ? 0 : 1;
    }
    const raceProg = (p: FPlayer) => {
      const t = this.wpPos(p.wp);
      return p.lap * WPS + p.wp + Math.max(0, 1 - Math.hypot(t.x - p.x, t.z - p.z) / (HALF * 4));
    };
    const value = (p: FPlayer) =>
      (this.mode === '2v2' && p.team === winnerTeam ? 100000 : 0) +
      (this.mech === 'race' ? raceProg(p) * 100
        : this.mech === 'climb' ? (CLIMB_L - p.z) * 100
        : scoreBased ? p.score * 100
        : (p.dead ? -1 : p.lives) * 100 + p.score);
    const label = this.snow ? 'hits' : this.mech === 'throwfight' ? 'HP' : this.mech === 'climb' ? 'm' : scoreBased ? 'pts' : 'lives';
    const shown = (p: FPlayer) =>
      this.mech === 'race' ? p.lap * WPS + p.wp : scoreBased ? Math.round(p.score) : Math.max(Math.round(p.lives), 0);
    const ranking = [...this.players]
      .sort((a, b) => value(b) - value(a))
      .map((p) => ({
        slot: p.slot,
        name: p.name,
        heroKey: p.hero.key,
        lives: shown(p),
        dead: p.dead,
        team: p.team,
      }));
    this.onEnd({ mode: this.mode, winnerTeam, scoreLabel: label, ranking });
  }
}
