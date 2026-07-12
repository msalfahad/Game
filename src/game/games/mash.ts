import * as THREE from 'three';
import type { GameModule, MatchContext } from '../context';
import { HITBOX_RADIUS } from '../player';
import { setupRoster, localMove, botMove, collidePlayers, tickRoster, localJump, rankBy } from '../freeroam';
import { matchTime } from '../../core/tuning';
import { SFX } from '../../core/audio';
import { setScore } from '../../ui/hud';

// MASH — smash the pop-up targets (Mallet Mash, Robot Rumble). Robots wander;
// golden targets score big. Ability = shockwave that smashes everything near.

interface Target {
  m: THREE.Mesh;
  x: number;
  z: number;
  vx: number;
  vz: number;
  gold: boolean;
  life: number;
  rise: number;
}

export class MashGame implements GameModule {
  readonly stickMode = 'float' as const;
  title = 'Mash';
  objective = 'Smash pop-up targets · gold = 5 pts';

  private ctx!: MatchContext;
  private targets: Target[] = [];
  private spawnT = 0;
  private timeLeft = 60;
  private robots = false;
  private finished = false;

  init(ctx: MatchContext) {
    this.ctx = ctx;
    this.title = ctx.game.name;
    this.finished = false;
    this.robots = !!ctx.game.mods?.robots;
    this.timeLeft = matchTime(60);
    this.targets = [];
    this.spawnT = 0;
    setupRoster(ctx, 0, 0.5);
    for (let i = 0; i < 7; i++) this.pop();
  }

  private pop() {
    const gold = Math.random() < 0.2;
    let m: THREE.Mesh;
    if (this.robots) {
      m = new THREE.Mesh(
        new THREE.BoxGeometry(gold ? 3 : 2.4, gold ? 3 : 2.4, gold ? 3 : 2.4),
        new THREE.MeshStandardMaterial({
          color: gold ? 0xffd23f : 0x8a929e,
          roughness: 0.4,
          metalness: 0.7,
          emissive: gold ? 0xffd23f : 0x2ef2ff,
          emissiveIntensity: gold ? 0.4 : 0.25,
        }),
      );
      const eye = new THREE.Mesh(
        new THREE.SphereGeometry(0.5, 8, 8),
        new THREE.MeshBasicMaterial({ color: 0xff3040 }),
      );
      eye.position.set(0, 0.5, 1.3);
      m.add(eye);
    } else {
      m = new THREE.Mesh(
        new THREE.SphereGeometry(gold ? 2.2 : 1.8, 12, 12),
        new THREE.MeshStandardMaterial({
          color: gold ? 0xffd23f : 0xe86ac8,
          emissive: gold ? 0xffd23f : 0x000000,
          emissiveIntensity: gold ? 0.4 : 0,
          roughness: 0.5,
        }),
      );
      const stem = new THREE.Mesh(
        new THREE.CylinderGeometry(0.8, 1.1, 2, 8),
        new THREE.MeshStandardMaterial({ color: 0xeee0c0 }),
      );
      stem.position.y = -2;
      m.add(stem);
    }
    m.castShadow = true;
    const x = (Math.random() - 0.5) * this.ctx.halfSize * 1.7;
    const z = (Math.random() - 0.5) * this.ctx.halfSize * 1.7;
    m.position.set(x, -3, z);
    this.ctx.scene.add(m);
    const wander = this.robots ? 5 : 0;
    this.targets.push({
      m, x, z,
      vx: (Math.random() - 0.5) * wander,
      vz: (Math.random() - 0.5) * wander,
      gold,
      life: 4 + Math.random() * 3,
      rise: 0,
    });
  }

  private smash(pi: number) {
    const p = this.ctx.players[pi];
    if (p.cd > 0 || p.dead) return;
    p.cd = 7;
    let hit = 0;
    this.targets = this.targets.filter((g) => {
      if (Math.hypot(g.x - p.x, g.z - p.z) < 16 && g.rise > 0.4) {
        p.score += g.gold ? 5 : 2;
        hit++;
        this.ctx.fx.burst(g.x, g.z, g.gold ? '#FFD23F' : '#E86AC8', 10);
        this.ctx.scene.remove(g.m);
        return false;
      }
      return true;
    });
    setScore(p, p.score);
    SFX.power();
    this.ctx.fx.shake(1.5);
    this.ctx.fx.banner(p.you ? `SHOCKWAVE! +${hit}` : '', p.hero.col);
  }

  ability() {
    this.smash(0);
  }
  jump() {
    localJump(this.ctx);
  }

  tick(dt: number, elapsed: number) {
    if (this.finished) return;
    const ctx = this.ctx;
    this.timeLeft -= dt;
    ctx.setClock(this.timeLeft);
    if (this.timeLeft <= 0) return this.doFinish();
    ctx.hazards.setProgress(1 - this.timeLeft / matchTime(60));
    ctx.hazards.tick(dt, ctx.players);

    this.spawnT += dt;
    if (this.spawnT > 0.7 && this.targets.length < 12) {
      this.spawnT = 0;
      this.pop();
    }

    localMove(ctx, dt);
    for (const p of ctx.players.slice(1)) {
      const pi = ctx.players.indexOf(p);
      p.retarget -= dt;
      if (p.retarget <= 0) {
        p.retarget = ctx.diff.lapse + Math.random() * ctx.diff.lapse;
        let best: Target | null = null, bd = 1e9;
        for (const g of this.targets) {
          if (g.rise < 0.4) continue;
          const w = g.gold ? 0.6 : 1;
          const d = Math.hypot(g.x - p.x, g.z - p.z) * w;
          if (d < bd) { bd = d; best = g; }
        }
        p.tx = best ? best.x : 0;
        p.tz = best ? best.z : 0;
        if (ctx.diff.cap > 0.55 && p.cd <= 0 && Math.random() < 0.12) this.smash(pi);
      }
      botMove(ctx, p, p.tx, p.tz, dt);
    }
    collidePlayers(ctx);

    this.targets = this.targets.filter((g) => {
      if (g.rise < 1) g.rise = Math.min(1, g.rise + dt * 3);
      if (this.robots && g.rise >= 1) {
        g.x += g.vx * dt;
        g.z += g.vz * dt;
        const m = ctx.halfSize - 2;
        if (Math.abs(g.x) > m) g.vx *= -1;
        if (Math.abs(g.z) > m) g.vz *= -1;
      }
      g.m.position.x = g.x;
      g.m.position.z = g.z;
      g.m.position.y = -3 + g.rise * 4.5;
      g.m.rotation.y += dt * 2;
      g.life -= dt;
      if (g.life <= 0) {
        ctx.scene.remove(g.m);
        return false;
      }
      for (const p of ctx.players) {
        if (g.rise > 0.4 && Math.hypot(g.x - p.x, g.z - p.z) < HITBOX_RADIUS + 1.5) {
          p.score += g.gold ? 5 : 2;
          setScore(p, p.score);
          SFX.gem();
          ctx.fx.burst(g.x, g.z, g.gold ? '#FFD23F' : '#E86AC8', g.gold ? 16 : 8);
          ctx.scene.remove(g.m);
          return false;
        }
      }
      return true;
    });

    tickRoster(ctx, dt, elapsed);
  }

  private doFinish() {
    if (this.finished) return;
    this.finished = true;
    this.ctx.players.forEach((p) => ((p as any)._res = p.score + ' pts'));
    this.ctx.finish(rankBy(this.ctx, (p) => p.score), 'Most targets smashed wins.');
  }
}
