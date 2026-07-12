import * as THREE from 'three';
import type { GameModule, MatchContext } from '../context';
import type { Player } from '../player';
import { HITBOX_RADIUS } from '../player';
import { setupRoster, localMove, botMove, collidePlayers, tickRoster, localJump, rankBy } from '../freeroam';
import { fireUltimate, botMaybeUltimate, tickDecoys } from '../ultimates';
import { Powerups } from '../powerups';
import { matchTime } from '../../core/tuning';
import { SFX } from '../../core/audio';
import { setScore } from '../../ui/hud';

// COLLECT — pickups rain in; grab the most before time runs out (Gem Grab,
// Treasure Scramble). The magnet power-up vacuums nearby loot toward you.

interface Loot { m: THREE.Mesh; x: number; z: number; y: number; vy: number; col: number; }

export class CollectGame implements GameModule {
  readonly stickMode = 'float' as const;
  title = 'Collect';
  objective = 'Grab the most loot before time runs out';

  private ctx!: MatchContext;
  private loot: Loot[] = [];
  private spawnT = 0;
  private timeLeft = 60;
  private duration = 60;
  private coin = false;
  private powerups!: Powerups;
  private finished = false;

  init(ctx: MatchContext) {
    this.ctx = ctx;
    this.title = ctx.game.name;
    this.finished = false;
    this.coin = !!ctx.game.mods?.coin;
    this.duration = this.timeLeft = matchTime(60);
    this.loot = [];
    this.spawnT = 0;
    setupRoster(ctx, 0, 0.5);
    for (let i = 0; i < 5; i++) this.drop();
    this.powerups = new Powerups(ctx, ['speed', 'magnet', 'giant'], () => this.leader());
  }

  private leader(): Player | null {
    return [...this.ctx.players].sort((a, b) => b.score - a.score)[0] ?? null;
  }

  private drop() {
    let m: THREE.Mesh;
    let col: number;
    if (this.coin) {
      col = 0xffd23f;
      m = new THREE.Mesh(
        new THREE.CylinderGeometry(1.3, 1.3, 0.4, 14),
        new THREE.MeshStandardMaterial({ color: col, emissive: 0x8a6a10, roughness: 0.3, metalness: 0.8 }),
      );
      m.rotation.x = Math.PI / 2;
    } else {
      const cols = [0x2ef2ff, 0xffd23f, 0xff3d9e, 0xb6ff2e];
      col = cols[Math.floor(Math.random() * 4)];
      m = new THREE.Mesh(
        new THREE.OctahedronGeometry(1.4),
        new THREE.MeshStandardMaterial({ color: col, emissive: col, emissiveIntensity: 0.5, roughness: 0.2, metalness: 0.6 }),
      );
    }
    m.castShadow = true;
    this.ctx.scene.add(m);
    this.loot.push({
      m,
      x: (Math.random() - 0.5) * this.ctx.halfSize * 1.7,
      z: (Math.random() - 0.5) * this.ctx.halfSize * 1.7,
      y: 40,
      vy: 0,
      col,
    });
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
    ctx.hazards.setProgress(1 - this.timeLeft / this.duration);
    ctx.hazards.tick(dt, ctx.players);
    this.powerups.tick(dt);
    tickDecoys(ctx, dt);

    this.spawnT += dt;
    if (this.spawnT > 0.8 && this.loot.length < 11) {
      this.spawnT = 0;
      this.drop();
    }

    localMove(ctx, dt);
    for (const p of ctx.players.slice(1)) {
      p.retarget -= dt;
      if (p.retarget <= 0) {
        p.retarget = ctx.diff.lapse + Math.random() * ctx.diff.lapse;
        let best: Loot | null = null, bd = 1e9;
        for (const g of this.loot) {
          if (g.y > 3) continue;
          const d = Math.hypot(g.x - p.x, g.z - p.z);
          if (d < bd) { bd = d; best = g; }
        }
        p.tx = best ? best.x : 0;
        p.tz = best ? best.z : 0;
      }
      botMove(ctx, p, p.tx, p.tz, dt);
      botMaybeUltimate(ctx, p, dt);
    }
    collidePlayers(ctx);

    this.loot = this.loot.filter((g) => {
      g.y += g.vy * dt;
      g.vy -= 60 * dt;
      if (g.y < 1.4) { g.y = 1.4; g.vy = Math.abs(g.vy) * 0.4; }
      // Magnet pull.
      for (const p of ctx.players) {
        if (this.powerups.magnetT[p.index] > 0 && g.y < 4) {
          const dx = p.x - g.x, dz = p.z - g.z;
          const L = Math.hypot(dx, dz);
          if (L < 26 && L > 0.5) {
            g.x += (dx / L) * dt * 30;
            g.z += (dz / L) * dt * 30;
          }
        }
      }
      for (const p of ctx.players) {
        if (g.y < 4 && Math.hypot(g.x - p.x, g.z - p.z) < HITBOX_RADIUS + 2) {
          p.score++;
          setScore(p, p.score);
          SFX.gem();
          ctx.fx.burst(g.x, g.z, '#' + g.col.toString(16).padStart(6, '0'), 10);
          ctx.scene.remove(g.m);
          return false;
        }
      }
      g.m.position.set(g.x, g.y, g.z);
      g.m.rotation.y += dt * 3;
      if (!this.coin) g.m.rotation.x += dt * 1.5;
      return true;
    });

    tickRoster(ctx, dt, elapsed);
  }

  private doFinish() {
    if (this.finished) return;
    this.finished = true;
    const unit = this.coin ? 'coins' : 'gems';
    this.ctx.players.forEach((p) => ((p as any)._res = `${p.score} ${unit}`));
    this.ctx.finish(rankBy(this.ctx, (p) => p.score), `Most ${unit} wins.`);
  }
}
