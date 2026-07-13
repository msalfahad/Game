import * as THREE from 'three';
import type { GameModule, MatchContext } from '../context';
import type { Player } from '../player';
import { HITBOX_RADIUS } from '../player';
import { setupRoster, localMove, botMove, collidePlayers, tickRoster, localJump } from '../freeroam';
import { matchTime } from '../../core/tuning';
import { SFX } from '../../core/audio';
import { setScore } from '../../ui/hud';

// CLIMB — Avalanche Run. A one-minute vertical scramble: everyone starts at
// the bottom, the summit line is at the top, and boulders tumble down the
// slope. Getting hit knocks you back down. A ❄ freeze box appears every 10
// seconds — grab it and everyone else is frozen for 3 seconds.

interface Rock { m: THREE.Mesh; x: number; z: number; vz: number; }
interface FreezeBox { m: THREE.Group; x: number; z: number; }

export class ClimbGame implements GameModule {
  readonly stickMode = 'float' as const;
  title = 'Avalanche Run';
  objective = 'CLIMB! First to the summit line · rocks knock you down';

  private ctx!: MatchContext;
  private timeLeft = 60;
  private rocks: Rock[] = [];
  private rockT = 1;
  private box: FreezeBox | null = null;
  private boxT = 10;
  private finished = false;

  init(ctx: MatchContext) {
    this.ctx = ctx;
    this.title = ctx.game.name;
    this.finished = false;
    this.timeLeft = matchTime(60);
    this.rocks = [];
    this.rockT = 1;
    this.box = null;
    this.boxT = 10;

    setupRoster(ctx, '0m', 0.45);
    const half = ctx.halfSize;
    // Line up at the bottom of the mountain.
    ctx.players.forEach((p, i) => {
      p.x = (i - 1.5) * 7;
      p.z = half - 4;
    });

    // Summit line: glowing finish strip across the top edge.
    const line = new THREE.Mesh(
      new THREE.BoxGeometry(half * 2, 0.5, 2),
      new THREE.MeshBasicMaterial({ color: 0xffffff }),
    );
    line.position.set(0, 0.3, -(half - 2.5));
    ctx.scene.add(line);
    const flagMat = new THREE.MeshBasicMaterial({ color: 0xffd23f });
    for (const fx of [-half + 2, half - 2]) {
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 8, 8), flagMat);
      pole.position.set(fx, 4, -(half - 2.5));
      ctx.scene.add(pole);
    }
  }

  ability() {
    // Climbing is pure — no ultimates; the ❄ box is the power.
    localJump(this.ctx);
  }
  jump() {
    localJump(this.ctx);
  }

  private spawnRock(prog: number) {
    const half = this.ctx.halfSize;
    const m = new THREE.Mesh(
      new THREE.DodecahedronGeometry(2.1 + Math.random() * 0.8),
      new THREE.MeshStandardMaterial({ color: 0x9db8cc, roughness: 0.8 }),
    );
    m.castShadow = true;
    const x = (Math.random() - 0.5) * half * 1.8;
    m.position.set(x, 2, -(half + 4));
    this.ctx.scene.add(m);
    this.rocks.push({ m, x, z: -(half + 4), vz: 15 + prog * 8 + Math.random() * 6 });
  }

  private spawnBox() {
    if (this.box) {
      this.ctx.scene.remove(this.box.m);
      this.box = null;
    }
    const half = this.ctx.halfSize;
    const grp = new THREE.Group();
    const crate = new THREE.Mesh(
      new THREE.BoxGeometry(2.4, 2.4, 2.4),
      new THREE.MeshStandardMaterial({ color: 0x9adfff, emissive: 0x2a6a9a, emissiveIntensity: 0.6, roughness: 0.3 }),
    );
    crate.castShadow = true;
    grp.add(crate);
    const x = (Math.random() - 0.5) * half * 1.5;
    const z = (Math.random() - 0.5) * half * 1.2;
    grp.position.set(x, 1.2, z);
    this.ctx.scene.add(grp);
    this.box = { m: grp, x, z };
    this.ctx.fx.banner('❄ FREEZE BOX!', '#9ADFFF');
    SFX.tick();
  }

  private progressM(p: Player): number {
    const half = this.ctx.halfSize;
    return Math.max(0, Math.round(half - 4 - p.z));
  }

  tick(dt: number, elapsed: number) {
    if (this.finished) return;
    const ctx = this.ctx;
    const half = ctx.halfSize;
    this.timeLeft -= dt;
    ctx.setClock(this.timeLeft);
    if (this.timeLeft <= 0) return this.doFinish('Time! Highest climber wins.');
    const prog = 1 - this.timeLeft / matchTime(60);

    // Boulders from the top.
    this.rockT -= dt;
    if (this.rockT <= 0) {
      this.rockT = Math.max(0.55, 1.3 - prog * 0.6);
      this.spawnRock(prog);
    }
    this.rocks = this.rocks.filter((r) => {
      r.z += r.vz * dt;
      r.m.position.z = r.z;
      r.m.rotation.x += dt * 3;
      for (const p of ctx.players) {
        if (p.dead || p.invulnT > 0 || (p as any)._rockCd > performance.now()) continue;
        if (Math.hypot(p.x - r.x, p.z - r.z) < HITBOX_RADIUS + 2.2) {
          (p as any)._rockCd = performance.now() + 700;
          p.vz += 30; // knocked DOWN the mountain
          p.freezeT = Math.max(p.freezeT, 0.35);
          SFX.bump();
          ctx.fx.burst(p.x, p.z, '#9DB8CC', 12);
          ctx.fx.shake(1.5);
          if (p.you) ctx.fx.banner('KNOCKED DOWN!', '#9DB8CC');
        }
      }
      if (r.z > half + 6) {
        ctx.scene.remove(r.m);
        return false;
      }
      return true;
    });

    // ❄ box every 10s.
    this.boxT -= dt;
    if (this.boxT <= 0) {
      this.boxT = 10;
      this.spawnBox();
    }
    if (this.box) {
      this.box.m.rotation.y += dt * 2;
      for (const p of ctx.players) {
        if (p.dead) continue;
        if (Math.hypot(p.x - this.box.x, p.z - this.box.z) < HITBOX_RADIUS + 2) {
          ctx.scene.remove(this.box.m);
          this.box = null;
          SFX.power();
          ctx.fx.banner(p.you ? '❄ FREEZE! GO GO GO!' : `❄ ${p.hero.name} FROZE YOU!`, '#9ADFFF');
          for (const q of ctx.players) {
            if (q === p || q.dead) continue;
            q.freezeT = Math.max(q.freezeT, 3);
            ctx.fx.burst(q.x, q.z, '#9ADFFF', 12);
          }
          break;
        }
      }
    }

    localMove(ctx, dt);
    for (const p of ctx.players.slice(1)) {
      if (p.dead) continue;
      p.retarget -= dt;
      if (p.retarget <= 0) {
        p.retarget = ctx.diff.lapse + Math.random() * ctx.diff.lapse;
        // Climb up, sidestep the nearest incoming rock.
        let dodge = 0;
        for (const r of this.rocks) {
          if (r.z < p.z && p.z - r.z < 14 && Math.abs(r.x - p.x) < 5) {
            dodge = r.x > p.x ? -7 : 7;
            break;
          }
        }
        p.tx = Math.max(-half + 3, Math.min(half - 3, p.x + dodge + (Math.random() - 0.5) * 4));
        p.tz = p.z - 12;
        if (this.box && Math.random() < ctx.diff.cap * 0.5) {
          p.tx = this.box.x;
          p.tz = this.box.z;
        }
      }
      botMove(ctx, p, p.tx, p.tz, dt);
    }
    collidePlayers(ctx);

    // Progress + summit check.
    for (const p of ctx.players) {
      if (p.dead) continue;
      const m = this.progressM(p);
      if (m !== p.score) {
        p.score = m;
        setScore(p, m + 'm');
      }
      if (p.z <= -(half - 3.5)) {
        ctx.fx.banner(p.you ? '🏔️ YOU REACHED THE SUMMIT!' : `🏔️ ${p.hero.name} SUMMITS!`, p.hero.col);
        return this.doFinish(p.you ? 'You conquered the mountain!' : p.hero.name + ' got there first.');
      }
    }

    tickRoster(ctx, dt, elapsed);
  }

  private doFinish(sub: string) {
    if (this.finished) return;
    this.finished = true;
    this.ctx.players.forEach((p) => ((p as any)._res = this.progressM(p) + 'm climbed'));
    const ranked = [...this.ctx.players].sort((a, b) => a.z - b.z);
    this.ctx.finish(ranked, sub);
  }
}
