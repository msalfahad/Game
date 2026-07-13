import * as THREE from 'three';
import type { GameModule, MatchContext } from '../context';
import type { Player } from '../player';
import { HITBOX_RADIUS } from '../player';
import { speedMult, strengthMult, accuracyMult } from '../../data/characters';
import { SFX } from '../../core/audio';
import { matchTime } from '../../core/tuning';
import { makeHeads } from '../../ui/hud';

// Frostbite 1.1 — Ice Hockey Brawl. Four players guard the four walls of a
// small rink; pucks bounce around and each goal costs the conceding player a
// point. Zero points = out. Ability arms a power shot (flavoured as the hero's
// ultimate). Bots predict puck arrival, gated by difficulty (SPEC section 13).
// Hazards: blizzard curves the puck; icicles/boulders shove & briefly freeze
// the paddles (map tier ramp).

interface Puck {
  x: number; z: number; y: number;
  vx: number; vz: number; vy: number;
  power: number; grace: number;
  m: THREE.Mesh;
}

export class HockeyGame implements GameModule {
  title = 'Ice Hockey Brawl';
  readonly objective = 'Guard your wall · 10 pts each · 0 = OUT';
  readonly stickMode = 'hidden' as const;

  private ctx!: MatchContext;
  private balls: Puck[] = [];
  private timeLeft = 120;
  private duration = 120;
  private half = 14;

  init(ctx: MatchContext) {
    this.ctx = ctx;
    this.title = ctx.game.name;
    this.half = ctx.halfSize;
    this.duration = this.timeLeft = matchTime(120);
    this.finished = false;
    this.balls = [];
    for (const p of ctx.players) {
      p.pts = 10;
      p.pos = 0.5;
      p.dead = false;
      p.cd = 0;
      p.armed = false;
      p.retarget = 0;
      p.want = 0.5;
      p.vx = 0; p.vz = 0;
      p.buildRider(ctx.scene);
    }
    makeHeads(ctx.players, 10);
    this.buildSpawnPad();
    this.spawnBall();
    this.updateRiders();
  }

  private edgePos(p: Player): [number, number] {
    const P = (p.pos - 0.5) * 2 * this.half;
    if (p.side === 'bottom') return [P, this.half];
    if (p.side === 'top') return [P, -this.half];
    if (p.side === 'left') return [-this.half, P];
    return [this.half, P];
  }

  /** Glowing center pad — the clear place every puck comes out of. */
  private buildSpawnPad() {
    const pad = new THREE.Mesh(
      new THREE.CircleGeometry(2.6, 28),
      new THREE.MeshBasicMaterial({ color: 0x0a1230, transparent: true, opacity: 0.85 }),
    );
    pad.rotation.x = -Math.PI / 2;
    pad.position.y = 0.12;
    this.ctx.scene.add(pad);
    const rim = new THREE.Mesh(
      new THREE.TorusGeometry(2.6, 0.22, 8, 32),
      new THREE.MeshBasicMaterial({ color: 0xff8a2e }),
    );
    rim.rotation.x = -Math.PI / 2;
    rim.position.y = 0.2;
    this.ctx.scene.add(rim);
  }

  private spawnBall() {
    const a = Math.random() * Math.PI * 2;
    const m = new THREE.Mesh(
      new THREE.SphereGeometry(0.9, 16, 16),
      new THREE.MeshStandardMaterial({ color: 0xff8a2e, emissive: 0x7a3000, roughness: 0.3, metalness: 0.3 }),
    );
    m.castShadow = true;
    this.ctx.scene.add(m);
    this.balls.push({ x: 0, z: 0, vx: Math.cos(a) * 25, vz: Math.sin(a) * 25, y: 1.4, vy: 0, power: 0, grace: 0.7, m });
  }

  private resetBall(b: Puck) {
    b.x = 0; b.z = 0;
    const a = Math.random() * Math.PI * 2;
    b.vx = Math.cos(a) * 23; b.vz = Math.sin(a) * 23;
    b.grace = 0.8; b.power = 0;
  }

  private updateRiders() {
    for (const p of this.ctx.players) {
      if (p.dead) { p.group.visible = false; continue; }
      const [x, z] = this.edgePos(p);
      // Keep p.x/p.z in sync so the walk-frame animation sees the movement
      // (bob() derives stride + facing from position deltas).
      p.x = x; p.z = z;
      p.group.position.set(x, 0, z);
      p.setArmedGlow(p.armed);
    }
  }

  ability() {
    const you = this.ctx.players[0];
    if (!you || you.dead || you.cd > 0) return;
    if (!you.armed) {
      you.armed = true;
      SFX.power();
      this.ctx.fx.banner(you.hero.ultName.toUpperCase() + ' ARMED!', you.hero.col);
    }
  }

  private concede(p: Player, b: Puck) {
    p.pts--;
    this.ctx.setScore(p, p.pts);
    this.ctx.fx.shake(2.5);
    SFX.goal();
    this.ctx.fx.burst(b.x, b.z, p.hero.col, 26);
    this.ctx.fx.banner(p.you ? 'YOU GOT SCORED ON!' : 'GOAL ON ' + p.hero.name + '!', p.hero.col);
    if (p.pts <= 0) {
      p.dead = true;
      p.headEl?.classList.add('dead');
      p.group.visible = false;
      SFX.out();
      this.ctx.fx.banner(p.you ? 'YOU ARE OUT!' : p.hero.name + ' IS OUT!', '#FF4D4D');
      if (p.you || this.ctx.players.slice(1).every((q) => q.dead)) setTimeout(() => this.doFinish(), 900);
    }
    this.resetBall(b);
  }

  private finished = false;
  private doFinish() {
    if (this.finished) return;
    this.finished = true;
    const ranked = [...this.ctx.players].sort((a, b) => b.pts - a.pts);
    this.ctx.players.forEach((p) => ((p as any)._res = Math.max(p.pts, 0) + ' pts' + (p.dead ? ' · OUT' : '')));
    this.ctx.finish(ranked, 'Highest points wins.');
  }

  tick(dt: number) {
    this.timeLeft -= dt;
    this.ctx.setClock(this.timeLeft);
    if (this.timeLeft <= 0) { this.doFinish(); return; }

    // Escalation: add pucks over time; ramp hazards.
    if (this.timeLeft < this.duration * 0.7 && this.balls.length < 2) this.spawnBall();
    if (this.timeLeft < this.duration * 0.33 && this.balls.length < 3) this.spawnBall();
    this.ctx.hazards.setProgress(1 - this.timeLeft / this.duration);
    this.ctx.hazards.tick(dt, this.ctx.players);

    const prevPos = this.ctx.players.map((p) => p.pos);
    this.controlLocal(dt);
    this.controlBots(dt);
    this.ctx.players.forEach((p, i) => ((p as any)._pvel = (p.pos - prevPos[i]) / Math.max(dt, 1e-4)));
    this.applyHazardShoves(dt);
    this.tickPucks(dt);
    this.updateRiders();
    this.ctx.players.forEach((p, i) => { if (!p.dead) p.bob((performance.now() / 1000), i + p.pos * 6); });
  }

  private paddleSpeed(p: Player) {
    return 0.85 + speedMult(p.hero) * 1.1; // quick, Crash-style paddles
  }

  private controlLocal(dt: number) {
    const you = this.ctx.players[0];
    if (you.dead) return;
    you.cd = Math.max(0, you.cd - dt);
    if (you.freezeT > 0) { you.freezeT = Math.max(0, you.freezeT - dt); return; } // frozen by hazard
    if (this.ctx.input.hockeyDX !== 0) {
      you.pos += this.ctx.input.hockeyDX / (innerWidth * 0.75);
      this.ctx.input.hockeyDX = 0;
    } else {
      you.pos += this.ctx.input.ax * this.paddleSpeed(you) * dt;
    }
    const R = HITBOX_RADIUS / this.half / 2 + 0.02;
    you.pos = Math.max(R, Math.min(1 - R, you.pos));
  }

  private controlBots(dt: number) {
    const D = this.ctx.diff;
    for (const p of this.ctx.players.slice(1)) {
      if (p.dead) continue;
      if (p.freezeT > 0) { p.freezeT = Math.max(0, p.freezeT - dt); continue; }
      p.retarget -= dt;
      if (p.retarget <= 0) {
        p.retarget = D.lapse + Math.random() * D.lapse;
        let target: Puck | null = null;
        let best = 1e9;
        for (const b of this.balls) {
          let d: number | null = null;
          if (p.side === 'top' && b.vz < 0) d = (b.z + this.half) / -b.vz;
          if (p.side === 'left' && b.vx < 0) d = (b.x + this.half) / -b.vx;
          if (p.side === 'right' && b.vx > 0) d = (this.half - b.x) / b.vx;
          if (p.side === 'bottom' && b.vz > 0) d = (this.half - b.z) / b.vz;
          if (d != null && d < best) { best = d; target = b; }
        }
        let w = 0.5;
        if (target) {
          const tp = p.side === 'top' || p.side === 'bottom' ? target.x : target.z;
          // Accuracy tightens the aim error.
          const err = D.err / accuracyMult(p.hero);
          w = (tp / this.half + 1) / 2 + (Math.random() - 0.5) * err;
        }
        p.want = w;
      }
      const v = this.paddleSpeed(p) * D.cap * dt;
      if (Math.abs(p.want - p.pos) > 0.008) p.pos += Math.sign(p.want - p.pos) * Math.min(v, Math.abs(p.want - p.pos));
      const R = HITBOX_RADIUS / this.half / 2 + 0.02;
      p.pos = Math.max(R, Math.min(1 - R, p.pos));
    }
  }

  // Convert hazard-induced velocity (from Hazards writing p.vx/p.vz) into a
  // shove along the player's wall, then damp it out.
  private applyHazardShoves(dt: number) {
    for (const p of this.ctx.players) {
      if (p.dead) continue;
      const lateral = p.side === 'top' || p.side === 'bottom' ? p.vx : p.vz;
      if (Math.abs(lateral) > 0.01) {
        p.pos += (lateral * dt) / (this.half * 2);
        const R = HITBOX_RADIUS / this.half / 2 + 0.02;
        p.pos = Math.max(R, Math.min(1 - R, p.pos));
      }
      p.vx *= Math.pow(0.02, dt);
      p.vz *= Math.pow(0.02, dt);
    }
  }

  private tickPucks(dt: number) {
    const wind = this.ctx.hazards.windForce();
    const edge = this.half - 2;
    for (const b of this.balls) {
      b.grace -= dt;
      // Blizzard curves the puck.
      b.vx += wind.x * dt;
      b.vz += wind.z * dt;
      b.x += b.vx * dt; b.z += b.vz * dt;
      b.y += b.vy * dt; b.vy -= 34 * dt;
      if (b.y < 1.4) { b.y = 1.4; b.vy = Math.abs(b.vy) * 0.7 + 6; }
      if (b.power > 0) b.power -= dt;
      const cap = b.power > 0 ? 46 : 30;
      const sp = Math.hypot(b.vx, b.vz);
      if (sp > cap) { b.vx *= cap / sp; b.vz *= cap / sp; }

      for (const p of this.ctx.players) {
        const R = HITBOX_RADIUS + 1.4;
        if (p.dead) {
          // Sealed wall bounces the puck back.
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
          // Steer the puck: your paddle's motion flings it left/right.
          const steer = ((p as any)._pvel ?? 0) * this.half * 2 * 0.85;
          if (axis === 'z') { b.vz = (p.side === 'bottom' ? -1 : 1) * Math.abs(b.vz) * mult; b.vx += (b.x - px) * 0.9 + steer; }
          else { b.vx = (p.side === 'right' ? -1 : 1) * Math.abs(b.vx) * mult; b.vz += (b.z - pz) * 0.9 + steer; }
          b.vy = 8;
          if (powered) {
            p.armed = false; p.cd = 6; b.power = 2.5;
            this.ctx.fx.shake(3); SFX.power(); this.ctx.fx.banner('POWER SHOT!', '#FF4D4D');
          }
          SFX.hit();
          this.ctx.fx.burst(b.x, b.z, p.hero.col, 8);
          this.ctx.fx.shake(1);
        };
        if (p.side === 'bottom' && b.vz > 0 && b.z > edge - 2 && Math.abs(b.x - px) < R) deflect('z');
        if (p.side === 'top' && b.vz < 0 && b.z < -edge + 2 && Math.abs(b.x - px) < R) deflect('z');
        if (p.side === 'left' && b.vx < 0 && b.x < -edge + 2 && Math.abs(b.z - pz) < R) deflect('x');
        if (p.side === 'right' && b.vx > 0 && b.x > edge - 2 && Math.abs(b.z - pz) < R) deflect('x');
      }

      if (b.grace < 0) {
        const m = this.half + 3;
        const ps = this.ctx.players;
        if (b.z > m && !ps[0].dead) this.concede(ps[0], b);
        else if (b.z < -m && !ps[1].dead) this.concede(ps[1], b);
        else if (b.x < -m && !ps[2].dead) this.concede(ps[2], b);
        else if (b.x > m && !ps[3].dead) this.concede(ps[3], b);
        else if (Math.abs(b.x) > m + 6 || Math.abs(b.z) > m + 6) this.resetBall(b);
      }
      b.m.position.set(b.x, b.y, b.z);
      const mat = b.m.material as THREE.MeshStandardMaterial;
      mat.emissive.setHex(b.power > 0 ? 0xff2020 : 0x7a3000);
      mat.color.setHex(b.power > 0 ? 0xff4d4d : 0xff8a2e);
    }
  }
}
