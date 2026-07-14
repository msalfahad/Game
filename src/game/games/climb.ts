import * as THREE from 'three';
import type { GameModule, MatchContext } from '../context';
import type { Player } from '../player';
import { HITBOX_RADIUS } from '../player';
import { setupRoster, localMove, botMove, collidePlayers, tickRoster, localJump } from '../freeroam';
import { matchTime } from '../../core/tuning';
import { SFX } from '../../core/audio';
import { setScore, showClimbMap, updateClimbMap, hideClimbMap } from '../../ui/hud';

// CLIMB — Avalanche Run. A one-minute scramble up a LONG NARROW mountain
// corridor: the summit line is far up-slope, boulders tumble down, the pace
// is deliberately slower, and the camera follows the climber. A ❄ freeze box
// appears every 10 seconds — grab it and everyone else is frozen for 3s.

export const CLIMB_W = 12; // corridor half-width
export const CLIMB_L = 62; // slope half-length — a proper mountain to climb
const CLIMB_PACE = 0.7; // everyone climbs slower

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
    // Line up at the bottom of the long slope.
    ctx.players.forEach((p, i) => {
      p.x = (i - 1.5) * 5.5;
      p.z = CLIMB_L - 4;
    });
    showClimbMap(ctx.players.map((p) => p.hero.col), 0);

    // Summit line: glowing finish strip far up the corridor.
    const line = new THREE.Mesh(
      new THREE.BoxGeometry(CLIMB_W * 2, 0.5, 2),
      new THREE.MeshBasicMaterial({ color: 0xffffff }),
    );
    line.position.set(0, 0.3, -(CLIMB_L - 2.5));
    ctx.scene.add(line);
    const flagMat = new THREE.MeshBasicMaterial({ color: 0xffd23f });
    for (const fx of [-CLIMB_W + 1.5, CLIMB_W - 1.5]) {
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 8, 8), flagMat);
      pole.position.set(fx, 4, -(CLIMB_L - 2.5));
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
    const m = new THREE.Mesh(
      new THREE.DodecahedronGeometry(2.1 + Math.random() * 0.8),
      new THREE.MeshStandardMaterial({ color: 0x9db8cc, roughness: 0.8 }),
    );
    m.castShadow = true;
    const x = (Math.random() - 0.5) * (CLIMB_W - 2) * 2;
    m.position.set(x, 2, -(CLIMB_L + 4));
    this.ctx.scene.add(m);
    this.rocks.push({ m, x, z: -(CLIMB_L + 4), vz: 13 + prog * 7 + Math.random() * 5 });
  }

  private spawnBox() {
    if (this.box) {
      this.ctx.scene.remove(this.box.m);
      this.box = null;
    }
    const grp = new THREE.Group();
    const crate = new THREE.Mesh(
      new THREE.BoxGeometry(2.4, 2.4, 2.4),
      new THREE.MeshStandardMaterial({ color: 0x9adfff, emissive: 0x2a6a9a, emissiveIntensity: 0.6, roughness: 0.3 }),
    );
    crate.castShadow = true;
    grp.add(crate);
    // Drop it ANYWHERE random along the pack's active stretch (a bit past the
    // leader down to a bit behind the last climber) — luck joins the skill.
    const alive = this.ctx.players.filter((p) => !p.dead);
    const leadZ = alive.length ? Math.min(...alive.map((p) => p.z)) : 0;
    const tailZ = alive.length ? Math.max(...alive.map((p) => p.z)) : 0;
    const lo = Math.max(-(CLIMB_L - 6), leadZ - 14);
    const hi = Math.min(CLIMB_L - 5, tailZ + 6);
    const x = (Math.random() - 0.5) * (CLIMB_W - 3) * 2;
    const z = lo + Math.random() * Math.max(0, hi - lo);
    grp.position.set(x, 1.2, z);
    this.ctx.scene.add(grp);
    this.box = { m: grp, x, z };
    this.ctx.fx.banner('❄ FREEZE BOX!', '#9ADFFF');
    SFX.tick();
  }

  private progressM(p: Player): number {
    return Math.max(0, Math.round(CLIMB_L - 4 - p.z));
  }

  tick(dt: number, elapsed: number) {
    if (this.finished) return;
    const ctx = this.ctx;
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
      if (r.z > CLIMB_L + 6) {
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

    localMove(ctx, dt, { speedMul: CLIMB_PACE });
    for (const p of ctx.players.slice(1)) {
      if (p.dead) continue;
      p.retarget -= dt;
      if (p.retarget <= 0) {
        p.retarget = ctx.diff.lapse + Math.random() * ctx.diff.lapse;
        // Climb up, sidestep the nearest incoming rock.
        let dodge = 0;
        for (const r of this.rocks) {
          if (r.z < p.z && p.z - r.z < 14 && Math.abs(r.x - p.x) < 5) {
            dodge = r.x > p.x ? -6 : 6;
            break;
          }
        }
        p.tx = Math.max(-CLIMB_W + 3, Math.min(CLIMB_W - 3, p.x + dodge + (Math.random() - 0.5) * 3));
        p.tz = p.z - 12;
        if (this.box && Math.random() < ctx.diff.cap * 0.5) {
          p.tx = this.box.x;
          p.tz = this.box.z;
        }
      }
      botMove(ctx, p, p.tx, p.tz, dt, { speedMul: CLIMB_PACE });
    }
    collidePlayers(ctx);

    // Keep everyone inside the narrow corridor.
    for (const p of ctx.players) {
      const w = CLIMB_W - 1;
      if (p.x < -w) { p.x = -w; p.vx = Math.abs(p.vx) * 0.3; }
      if (p.x > w) { p.x = w; p.vx = -Math.abs(p.vx) * 0.3; }
      if (p.z > CLIMB_L - 1) { p.z = CLIMB_L - 1; p.vz = -Math.abs(p.vz) * 0.3; }
    }

    // The camera climbs with you.
    ctx.camera.follow(ctx.players[0].z, -(CLIMB_L - 13), CLIMB_L - 13);

    // Minimap: 0 = base, 1 = summit line.
    const total = CLIMB_L - 4 + (CLIMB_L - 3.5);
    updateClimbMap(
      ctx.players.map((p) => (CLIMB_L - 4 - p.z) / total),
      ctx.players.map((p) => p.dead),
    );

    // Progress + summit check.
    for (const p of ctx.players) {
      if (p.dead) continue;
      const m = this.progressM(p);
      if (m !== p.score) {
        p.score = m;
        setScore(p, m + 'm');
      }
      if (p.z <= -(CLIMB_L - 3.5)) {
        ctx.fx.banner(p.you ? '🏔️ YOU REACHED THE SUMMIT!' : `🏔️ ${p.hero.name} SUMMITS!`, p.hero.col);
        return this.doFinish(p.you ? 'You conquered the mountain!' : p.hero.name + ' got there first.');
      }
    }

    tickRoster(ctx, dt, elapsed);
  }

  private doFinish(sub: string) {
    if (this.finished) return;
    this.finished = true;
    hideClimbMap();
    this.ctx.players.forEach((p) => ((p as any)._res = this.progressM(p) + 'm climbed'));
    const ranked = [...this.ctx.players].sort((a, b) => a.z - b.z);
    this.ctx.finish(ranked, sub);
  }
}
