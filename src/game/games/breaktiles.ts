import * as THREE from 'three';
import type { GameModule, MatchContext } from '../context';
import type { Player } from '../player';
import { setupRoster, localMove, botMove, collidePlayers, tickRoster, localJump, rankBy } from '../freeroam';
import { fireUltimate, botMaybeUltimate, tickDecoys } from '../ultimates';
import { Powerups } from '../powerups';
import { matchTime } from '../../core/tuning';
import { SFX } from '../../core/audio';
import { setScore, markDead } from '../../ui/hud';

// BREAKTILES — the floor gives way beneath you (Slip & Slide, Floor Is Lava,
// Shifting Sands, Poison Pond, Falling Platform, Sinking Ship). Tiles crack
// when stood on, then fall; a decay pattern eats the arena from outside in
// ('ring'), from one side ('side' — the sinking ship's bow), or tiles sink and
// later resurface ('respawn' — shifting sands). 3 lives; last basher standing.

const N = 11;

interface Tile {
  m: THREE.Mesh;
  gx: number;
  gy: number;
  alive: boolean;
  crack: number; // -1 = untouched, else countdown to falling
  respawnT: number;
  fallY: number;
}

export class BreakTilesGame implements GameModule {
  readonly stickMode = 'float' as const;
  title = 'Break Tiles';
  objective = 'The floor falls away · 3 lives · last one standing';

  private ctx!: MatchContext;
  private tiles: Tile[] = [];
  private step = 1;
  private timeLeft = 90;
  private duration = 90;
  private decayT = 0;
  private powerups!: Powerups;
  private finished = false;

  init(ctx: MatchContext) {
    this.ctx = ctx;
    this.title = ctx.game.name;
    this.finished = false;
    this.duration = this.timeLeft = matchTime(90);
    const half = ctx.halfSize;
    this.step = (half * 2) / N;

    // The themed world floor hides; the tile grid becomes the ground.
    ctx.world.floorMesh.visible = false;

    const trim = ctx.family.theme.trim;
    this.tiles = [];
    const pond = !!ctx.game.mods?.pond;
    for (let gy = 0; gy < N; gy++) {
      for (let gx = 0; gx < N; gx++) {
        const inPond = pond && Math.abs(gx - (N - 1) / 2) <= 1 && Math.abs(gy - (N - 1) / 2) <= 1;
        const m = new THREE.Mesh(
          new THREE.BoxGeometry(this.step * 0.94, 1.2, this.step * 0.94),
          new THREE.MeshStandardMaterial({
            color: 0x556080 + ((gx + gy) % 2) * 0x0a0a14,
            roughness: 0.8,
            emissive: trim,
            emissiveIntensity: 0.04,
          }),
        );
        m.position.set(-half + this.step * (gx + 0.5), -0.6, -half + this.step * (gy + 0.5));
        m.receiveShadow = true;
        if (inPond) m.visible = false;
        ctx.scene.add(m);
        this.tiles.push({ m, gx, gy, alive: !inPond, crack: -1, respawnT: 0, fallY: 0 });
      }
    }

    setupRoster(ctx, 3, 0.4);
    this.powerups = new Powerups(ctx, ['speed', 'shield', 'giant'], () => this.leader());
  }

  private leader(): Player | null {
    const alive = this.ctx.players.filter((p) => !p.dead);
    return alive.sort((a, b) => b.lives - a.lives)[0] ?? null;
  }

  private tileAt(x: number, z: number): Tile | null {
    const half = this.ctx.halfSize;
    const gx = Math.floor((x + half) / this.step);
    const gy = Math.floor((z + half) / this.step);
    if (gx < 0 || gy < 0 || gx >= N || gy >= N) return null;
    return this.tiles[gy * N + gx];
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
    const prog = 1 - this.timeLeft / this.duration;
    ctx.hazards.setProgress(prog);
    ctx.hazards.tick(dt, ctx.players);
    this.powerups.tick(dt);
    tickDecoys(ctx, dt);
    if (this.timeLeft <= 0) return this.doFinish();

    localMove(ctx, dt);
    // Bots: run toward the safest (most-alive-neighbors) tile near the center,
    // re-picked on the difficulty lapse.
    for (const p of ctx.players.slice(1)) {
      if (p.dead) continue;
      p.retarget -= dt;
      if (p.retarget <= 0) {
        p.retarget = ctx.diff.lapse * 2 + Math.random() * ctx.diff.lapse;
        let best: Tile | null = null, bs = -1;
        for (let i = 0; i < 14; i++) {
          const t = this.tiles[Math.floor(Math.random() * this.tiles.length)];
          if (!t.alive || t.crack >= 0) continue;
          const cx = t.m.position.x, cz = t.m.position.z;
          const centerBias = 1 - Math.hypot(cx, cz) / (ctx.halfSize * 1.5);
          const near = 1 - Math.hypot(cx - p.x, cz - p.z) / (ctx.halfSize * 2);
          const s = centerBias + near + Math.random() * ctx.diff.err * 2;
          if (s > bs) { bs = s; best = t; }
        }
        p.tx = best ? best.m.position.x : 0;
        p.tz = best ? best.m.position.z : 0;
      }
      botMove(ctx, p, p.tx, p.tz, dt);
      botMaybeUltimate(ctx, p, dt);
    }
    collidePlayers(ctx);

    this.tickTiles(dt, prog);
    this.checkFalls();
    tickRoster(ctx, dt, elapsed);
  }

  private tickTiles(dt: number, prog: number) {
    const mods = this.ctx.game.mods ?? {};
    const respawnMode = mods.decay === 'respawn';

    // Stepping cracks tiles.
    for (const p of this.ctx.players) {
      if (p.dead || p.y > 0.5) continue;
      const t = this.tileAt(p.x, p.z);
      if (t && t.alive && t.crack < 0) {
        t.crack = respawnMode ? 0.55 : 0.8;
        SFX.crack();
      }
    }

    // Ambient decay eats the arena as the match escalates.
    this.decayT -= dt;
    if (this.decayT <= 0 && prog > 0.15) {
      this.decayT = Math.max(0.5, 1.6 - prog * 1.2);
      const candidates = this.tiles.filter((t) => t.alive && t.crack < 0);
      if (candidates.length > 8) {
        let pick: Tile | null = null;
        if (mods.decay === 'side') {
          // Sinking ship: lowest gy (the bow) goes first.
          candidates.sort((a, b) => a.gy - b.gy || Math.random() - 0.5);
          pick = candidates[Math.floor(Math.random() * Math.min(8, candidates.length))];
        } else {
          // Ring: outermost first.
          const c = (N - 1) / 2;
          candidates.sort((a, b) => Math.max(Math.abs(b.gx - c), Math.abs(b.gy - c)) - Math.max(Math.abs(a.gx - c), Math.abs(a.gy - c)));
          pick = candidates[Math.floor(Math.random() * Math.min(6, candidates.length))];
        }
        if (pick) pick.crack = 0.7;
      }
    }

    for (const t of this.tiles) {
      if (t.alive && t.crack >= 0) {
        t.crack -= dt;
        // Cracking shake.
        t.m.position.y = -0.6 + Math.sin(t.crack * 40) * 0.12;
        (t.m.material as THREE.MeshStandardMaterial).emissiveIntensity = 0.25;
        if (t.crack <= 0) {
          t.alive = false;
          t.fallY = 0;
          t.respawnT = respawnMode ? 3 : Infinity;
        }
      } else if (!t.alive && t.m.visible) {
        t.fallY += dt * 24;
        t.m.position.y = -0.6 - t.fallY;
        if (t.fallY > 26) t.m.visible = false;
        if (t.respawnT !== Infinity) {
          t.respawnT -= dt;
          if (t.respawnT <= 0) this.reviveTile(t);
        }
      } else if (!t.alive && t.respawnT !== Infinity) {
        t.respawnT -= dt;
        if (t.respawnT <= 0) this.reviveTile(t);
      }
    }
  }

  private reviveTile(t: Tile) {
    t.alive = true;
    t.crack = -1;
    t.fallY = 0;
    t.m.visible = true;
    t.m.position.y = -0.6;
    (t.m.material as THREE.MeshStandardMaterial).emissiveIntensity = 0.04;
  }

  private checkFalls() {
    const ctx = this.ctx;
    for (const p of ctx.players) {
      if (p.dead || p.invulnT > 0 || p.y > 0.5) continue;
      const t = this.tileAt(p.x, p.z);
      if (t && t.alive) continue;
      // No tile underfoot: down you go.
      p.lives--;
      setScore(p, Math.max(p.lives, 0));
      SFX.fall();
      ctx.fx.burst(p.x, p.z, p.hero.col, 18);
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
        // Respawn on a safe tile near the center.
        const safe = this.tiles.filter((t2) => t2.alive && t2.crack < 0);
        safe.sort((a, b) => Math.hypot(a.m.position.x, a.m.position.z) - Math.hypot(b.m.position.x, b.m.position.z));
        const spot = safe[Math.floor(Math.random() * Math.min(8, safe.length))] ?? safe[0];
        p.x = spot ? spot.m.position.x : 0;
        p.z = spot ? spot.m.position.z : 0;
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
