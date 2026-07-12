import * as THREE from 'three';
import type { GameModule, MatchContext } from '../context';
import { HITBOX_RADIUS } from '../player';
import { surface } from '../../data/surfaces';
import { moveFreeRoam, tryJump, tryDash, tryDive } from '../physics';
import { SFX } from '../../core/audio';
import { makeHeads, setScore } from '../../ui/hud';

// Surface Lab — the greybox free-roam test for the core movement + surface
// systems (SPEC build order step 1). Grab glowing orbs scattered across the
// four surface quadrants + conveyor strip; crossing surfaces to reach them is
// the point. Demonstrates walk / sprint / jump / double-jump / dash / dive and
// ice-slide / mud-slow / sand-drift / conveyor-push feel.

interface Orb { m: THREE.Mesh; x: number; z: number; y: number; vy: number; col: number; }

export class SurfaceLabGame implements GameModule {
  readonly title = 'Surface Lab';
  readonly objective = 'Grab orbs across metal · ice · mud · sand · conveyor';
  readonly stickMode = 'float' as const;

  private ctx!: MatchContext;
  private orbs: Orb[] = [];
  private spawnT = 0;
  private timeLeft = 45;
  private half = 30;

  init(ctx: MatchContext) {
    this.ctx = ctx;
    this.half = ctx.halfSize;
    this.timeLeft = 45;
    this.orbs = [];
    const spots = [[-0.55, 0.55], [0.55, -0.55], [-0.55, -0.55], [0.55, 0.55]];
    ctx.players.forEach((p, i) => {
      p.x = spots[i][0] * this.half;
      p.z = spots[i][1] * this.half;
      p.vx = 0; p.vz = 0; p.y = 0; p.vy = 0;
      p.grounded = true; p.airJumps = 0; p.dashCd = 0; p.diveT = 0;
      p.dead = false; p.cd = 0; p.score = 0; p.retarget = 0;
      p.buildRider(ctx.scene);
    });
    makeHeads(ctx.players, 0);
    for (let i = 0; i < 6; i++) this.dropOrb();
    this.updatePos();
  }

  private dropOrb() {
    const cols = [0x2ef2ff, 0xffd23f, 0xff3d9e, 0xb6ff2e];
    const col = cols[Math.floor(Math.random() * 4)];
    const m = new THREE.Mesh(
      new THREE.OctahedronGeometry(1.4),
      new THREE.MeshStandardMaterial({ color: col, emissive: col, emissiveIntensity: 0.5, roughness: 0.2, metalness: 0.6 }),
    );
    m.castShadow = true;
    this.ctx.scene.add(m);
    this.orbs.push({ m, x: (Math.random() - 0.5) * this.half * 1.7, z: (Math.random() - 0.5) * this.half * 1.7, y: 40, vy: 0, col });
  }

  ability() {
    const you = this.ctx.players[0];
    if (you.dead) return;
    // Airborne ability = dive; grounded = dash. Both flavoured by the ultimate.
    if (!you.grounded) {
      if (tryDive(you)) { SFX.power(); this.ctx.fx.banner(you.hero.ultName.toUpperCase(), you.hero.col); }
    } else if (tryDash(you)) {
      SFX.power();
      this.ctx.fx.burst(you.x, you.z, you.hero.col, 10);
      this.ctx.fx.banner('DASH!', you.hero.col);
    }
  }

  jump() {
    const you = this.ctx.players[0];
    if (!you.dead && tryJump(you)) SFX.tick();
  }

  private updatePos() {
    for (const p of this.ctx.players) {
      p.group.position.set(p.x, p.y, p.z);
      p.setArmedGlow(p.diveT > 0);
    }
  }

  tick(dt: number, elapsed: number) {
    this.timeLeft -= dt;
    this.ctx.setClock(this.timeLeft);
    if (this.timeLeft <= 0) { this.doFinish(); return; }

    this.spawnT += dt;
    if (this.spawnT > 1.0 && this.orbs.length < 12) { this.spawnT = 0; this.dropOrb(); }

    // Local player free-roam. Sprint when the stick is fully deflected.
    const you = this.ctx.players[0];
    const ax = this.ctx.input.ax, ay = this.ctx.input.ay;
    const sprint = Math.hypot(ax, ay) > 0.9;
    const surfHere = surface(this.ctx.world.surfaceAt(you.x, you.z));
    moveFreeRoam(you, ax, ay, surfHere, dt, { halfSize: this.half, sprint });

    // Bots: seek nearest grounded orb, gated by difficulty speed cap.
    const D = this.ctx.diff;
    for (const p of this.ctx.players.slice(1)) {
      p.retarget -= dt;
      if (p.retarget <= 0) {
        p.retarget = D.lapse + Math.random() * D.lapse;
        let best: Orb | null = null, bd = 1e9;
        for (const g of this.orbs) { if (g.y > 3) continue; const d = Math.hypot(g.x - p.x, g.z - p.z); if (d < bd) { bd = d; best = g; } }
        p.tx = best ? best.x : 0;
        p.tz = best ? best.z : 0;
      }
      const dx = p.tx - p.x, dz = p.tz - p.z, L = Math.hypot(dx, dz) || 1;
      const surfBot = surface(this.ctx.world.surfaceAt(p.x, p.z));
      moveFreeRoam(p, (dx / L) * D.cap, (dz / L) * D.cap, surfBot, dt, { halfSize: this.half, sprint: D.cap > 0.9 });
      // occasional bot dash on faster tiers
      if (D.cap > 0.7 && p.dashCd <= 0 && Math.random() < dt * 0.4 && L > this.half * 0.5) {
        tryDash(p, dx / L, dz / L);
      }
    }

    // Orb fall + pickup.
    this.orbs = this.orbs.filter((g) => {
      g.y += g.vy * dt; g.vy -= 60 * dt;
      if (g.y < 1.4) { g.y = 1.4; g.vy = Math.abs(g.vy) * 0.4; }
      for (const p of this.ctx.players) {
        if (g.y < 4 && Math.hypot(g.x - p.x, g.z - p.z) < HITBOX_RADIUS + 2) {
          p.score++;
          setScore(p, p.score);
          SFX.tick();
          this.ctx.fx.burst(g.x, g.z, '#' + g.col.toString(16).padStart(6, '0'), 8);
          this.ctx.scene.remove(g.m);
          return false;
        }
      }
      g.m.position.set(g.x, g.y, g.z);
      g.m.rotation.y += dt * 3; g.m.rotation.x += dt * 1.5;
      return true;
    });

    this.updatePos();
    this.ctx.players.forEach((p, i) => p.bob(elapsed, i + p.x * 0.1));
  }

  private finished = false;
  private doFinish() {
    if (this.finished) return;
    this.finished = true;
    this.ctx.players.forEach((p) => ((p as any)._res = p.score + ' orbs'));
    const ranked = [...this.ctx.players].sort((a, b) => b.score - a.score);
    this.ctx.finish(ranked, 'Most orbs collected wins.');
  }
}
