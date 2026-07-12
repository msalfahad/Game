import * as THREE from 'three';
import type { GameModule, MatchContext } from '../context';
import type { Player } from '../player';
import { HITBOX_RADIUS } from '../player';
import { setupRoster, localMove, botMove, collidePlayers, tickRoster, localJump, rankBy } from '../freeroam';
import { fireUltimate, botMaybeUltimate, tickDecoys } from '../ultimates';
import { Powerups } from '../powerups';
import { matchTime } from '../../core/tuning';
import { SFX } from '../../core/audio';
import { setScore, markDead } from '../../ui/hud';

// PUSHOUT — shove rivals off a shrinking circular platform (Ring Rumble,
// Tree Top Tumble, Cactus Chaos, Gear Bash). Edge mods: a cactus ring that
// bounces and stings, or rotating gear arms that sweep players toward the rim.

export class PushoutGame implements GameModule {
  readonly stickMode = 'float' as const;
  title = 'Pushout';
  objective = 'Shove rivals off the shrinking ring · 3 lives';

  private ctx!: MatchContext;
  private timeLeft = 90;
  private duration = 90;
  private ringR = 30;
  private cacti: THREE.Mesh[] = [];
  private gears: THREE.Mesh[] = [];
  private gearAngle = 0;
  private powerups!: Powerups;
  private finished = false;

  init(ctx: MatchContext) {
    this.ctx = ctx;
    this.title = ctx.game.name;
    this.finished = false;
    this.duration = this.timeLeft = matchTime(90);
    this.ringR = ctx.halfSize;
    this.cacti = [];
    this.gears = [];

    setupRoster(ctx, 3, 0.5);
    // Circle spawn positions.
    ctx.players.forEach((p, i) => {
      const a = (i * Math.PI) / 2 + Math.PI / 4;
      p.x = Math.cos(a) * ctx.halfSize * 0.5;
      p.z = Math.sin(a) * ctx.halfSize * 0.5;
    });

    const edge = ctx.game.mods?.edge;
    if (edge === 'cacti') {
      for (let i = 0; i < 8; i++) {
        const cactus = new THREE.Mesh(
          new THREE.ConeGeometry(1.6, 6, 7),
          new THREE.MeshStandardMaterial({ color: 0x3e8a44, roughness: 0.9, emissive: 0x1a3a1c }),
        );
        cactus.castShadow = true;
        ctx.scene.add(cactus);
        this.cacti.push(cactus);
      }
    } else if (edge === 'gears') {
      for (let i = 0; i < 2; i++) {
        const bar = new THREE.Mesh(
          new THREE.BoxGeometry(ctx.halfSize * 0.92, 1.6, 2.2),
          new THREE.MeshStandardMaterial({ color: 0x8a929e, roughness: 0.5, metalness: 0.7, emissive: 0x223038 }),
        );
        bar.castShadow = true;
        ctx.scene.add(bar);
        this.gears.push(bar);
      }
    }

    this.powerups = new Powerups(ctx, ['speed', 'shield', 'giant'], () => this.leader());
  }

  private leader(): Player | null {
    const alive = this.ctx.players.filter((p) => !p.dead);
    return alive.sort((a, b) => b.lives - a.lives)[0] ?? null;
  }

  ability() {
    fireUltimate(this.ctx, this.ctx.players[0]);
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
    const prog = 1 - this.timeLeft / this.duration;
    ctx.hazards.setProgress(prog);
    ctx.hazards.tick(dt, ctx.players);
    this.powerups.tick(dt);
    tickDecoys(ctx, dt);

    // Ring shrinks to 45% over the match.
    this.ringR = ctx.halfSize * (1 - prog * 0.55);
    const s = this.ringR / ctx.halfSize;
    ctx.world.floorMesh.scale.setScalar(s);
    if (ctx.world.ringMesh) ctx.world.ringMesh.scale.set(s, s, 1);

    localMove(ctx, dt, { noClamp: true });
    for (const p of ctx.players.slice(1)) {
      if (p.dead) continue;
      p.retarget -= dt;
      if (p.retarget <= 0) {
        p.retarget = ctx.diff.lapse + Math.random() * ctx.diff.lapse;
        const edgeDist = Math.hypot(p.x, p.z);
        if (edgeDist > this.ringR * 0.72) {
          p.tx = 0; p.tz = 0; // recover toward center
        } else {
          const foes = ctx.players.filter((q) => q !== p && !q.dead);
          const t = foes[Math.floor(Math.random() * foes.length)];
          p.tx = t ? t.x + (Math.random() - 0.5) * ctx.diff.err * 20 : 0;
          p.tz = t ? t.z + (Math.random() - 0.5) * ctx.diff.err * 20 : 0;
        }
      }
      botMove(ctx, p, p.tx, p.tz, dt, { noClamp: true });
      botMaybeUltimate(ctx, p, dt);
    }
    collidePlayers(ctx);
    this.tickEdgeMods(dt);
    this.checkFalls();
    tickRoster(ctx, dt, elapsed);
  }

  private tickEdgeMods(dt: number) {
    const ctx = this.ctx;
    // Cacti sit just inside the rim and sting on contact.
    this.cacti.forEach((c, i) => {
      const a = (i / this.cacti.length) * Math.PI * 2 + performance.now() / 9000;
      const r = this.ringR * 0.9;
      c.position.set(Math.cos(a) * r, 1, Math.sin(a) * r);
      for (const p of ctx.players) {
        if (p.dead || p.invulnT > 0) continue;
        const d = Math.hypot(p.x - c.position.x, p.z - c.position.z);
        if (d < HITBOX_RADIUS + 1.6) {
          const nx = (p.x - c.position.x) / (d || 1), nz = (p.z - c.position.z) / (d || 1);
          // Bounce inward-ish, sting freeze.
          p.vx = nx * 26 - (p.x / this.ringR) * 14;
          p.vz = nz * 26 - (p.z / this.ringR) * 14;
          p.freezeT = Math.max(p.freezeT, 0.25);
          SFX.hit();
          ctx.fx.burst(p.x, p.z, '#3E8A44', 8);
          if (p.you) ctx.fx.banner('OUCH!', '#3E8A44');
        }
      }
    });

    // Gear arms rotate around the center and sweep players outward.
    if (this.gears.length) {
      this.gearAngle += dt * (0.6 + (1 - this.timeLeft / this.duration) * 0.5);
      this.gears.forEach((bar, i) => {
        const a = this.gearAngle + i * Math.PI;
        const mid = this.ringR * 0.48;
        bar.position.set(Math.cos(a) * mid, 1, Math.sin(a) * mid);
        bar.rotation.y = -a;
        bar.scale.x = this.ringR / this.ctx.halfSize;
        for (const p of ctx.players) {
          if (p.dead || p.y > 2.2) continue; // jumpable
          // Distance from bar's long axis.
          const relX = p.x - 0, relZ = p.z - 0;
          const r = Math.hypot(relX, relZ);
          if (r > this.ringR || r < 1) continue;
          let diff = Math.atan2(relZ, relX) - a;
          while (diff > Math.PI) diff -= Math.PI * 2;
          while (diff < -Math.PI) diff += Math.PI * 2;
          if (Math.abs(diff) > Math.PI / 2) continue;
          const perp = Math.abs(Math.sin(diff)) * r;
          if (perp < 2.6) {
            // Push perpendicular to the bar, in its sweep direction.
            const sweepX = -Math.sin(a), sweepZ = Math.cos(a);
            p.vx += sweepX * 40 * dt * 10;
            p.vz += sweepZ * 40 * dt * 10;
          }
        }
      });
    }
  }

  private checkFalls() {
    const ctx = this.ctx;
    for (const p of ctx.players) {
      if (p.dead || p.invulnT > 0) continue;
      if (Math.hypot(p.x, p.z) <= this.ringR) continue;
      p.lives--;
      setScore(p, Math.max(p.lives, 0));
      SFX.fall();
      ctx.fx.burst(p.x, p.z, p.hero.col, 20);
      ctx.fx.shake(2);
      ctx.fx.banner(p.you ? 'YOU FELL!' : p.hero.name + ' FELL!', p.hero.col);
      if (p.lives <= 0) {
        p.dead = true;
        markDead(p);
        SFX.out();
        ctx.fx.banner(p.you ? 'YOU ARE OUT!' : p.hero.name + ' IS OUT!', '#FF4D4D');
        const alive = ctx.players.filter((q) => !q.dead);
        if (p.you || alive.length <= 1) setTimeout(() => this.doFinish(), 900);
      } else {
        p.x = (Math.random() - 0.5) * this.ringR * 0.4;
        p.z = (Math.random() - 0.5) * this.ringR * 0.4;
        p.vx = 0; p.vz = 0;
        p.invulnT = 1;
      }
    }
  }

  private doFinish() {
    if (this.finished) return;
    this.finished = true;
    this.ctx.players.forEach((p) => ((p as any)._res = p.dead ? 'OUT' : Math.max(p.lives, 0) + ' lives'));
    this.ctx.finish(rankBy(this.ctx, (p) => (p.dead ? -1 : p.lives)), 'Last basher standing wins.');
  }
}
