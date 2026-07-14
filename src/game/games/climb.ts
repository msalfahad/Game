import * as THREE from 'three';
import type { GameModule, MatchContext } from '../context';
import type { Player } from '../player';
import { HITBOX_RADIUS } from '../player';
import { setupRoster, localMove, botMove, collidePlayers, tickRoster, localJump } from '../freeroam';
import { matchTime } from '../../core/tuning';
import { SFX } from '../../core/audio';
import { setScore, showClimbMap, updateClimbMap, hideClimbMap } from '../../ui/hud';
import { HEROES } from '../../data/characters';
import { Player as PlayerClass } from '../player';

// CLIMB — Avalanche Run. A one-minute scramble up a LONG NARROW mountain
// corridor: the summit line is far up-slope, boulders tumble down, the pace
// is deliberately slower, and the camera follows the climber. A ❄ freeze box
// appears every 10 seconds — grab it and everyone else is frozen for 3s.

export const CLIMB_W = 12; // corridor half-width
export const CLIMB_L = 62; // slope half-length — a proper mountain to climb
const CLIMB_PACE = 0.7; // everyone climbs slower

interface Rock { m: THREE.Mesh; x: number; z: number; vz: number; vx: number; }
interface FreezeBox { m: THREE.Group; x: number; z: number; }
interface LavaBall {
  m: THREE.Mesh;
  x: number; z: number; y: number;
  vx: number; vz: number; vy: number;
  r: number; big: boolean; life: number;
}
// Volcano Rush: sideways speed is normal, only the CLIMB is slow.
const LATERAL_BOOST = 1.45;

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
  // Volcano Rush: crater guardian bot + lava balls + dressing.
  private volcano = false;
  private thrower: PlayerClass | null = null;
  private throwT = 2.5;
  private balls: LavaBall[] = [];
  private embers: THREE.Sprite[] = [];

  init(ctx: MatchContext) {
    this.ctx = ctx;
    this.title = ctx.game.name;
    this.finished = false;
    this.timeLeft = matchTime(60);
    this.rocks = [];
    this.rockT = 1;
    this.box = null;
    this.boxT = 10;

    this.volcano = !!ctx.game.mods?.volcano;
    this.thrower = null;
    this.throwT = 2.5;
    this.balls = [];
    this.embers = [];
    if (this.volcano) this.objective = 'CLIMB the volcano! Dodge lava rocks & the guardian\'s fireballs';

    setupRoster(ctx, '0m', 0.45);
    // Line up at the bottom of the long slope.
    ctx.players.forEach((p, i) => {
      p.x = (i - 1.5) * 5.5;
      p.z = CLIMB_L - 4;
    });
    showClimbMap(ctx.players.map((p) => p.hero.col), 0);
    if (this.volcano) this.buildVolcano();

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

  /** Crater cone, glowing rim, lava cracks, embers and the GUARDIAN bot. */
  private buildVolcano() {
    const ctx = this.ctx;
    // Crater beyond the summit.
    const cone = new THREE.Mesh(
      new THREE.ConeGeometry(30, 22, 24, 1, true),
      new THREE.MeshStandardMaterial({ color: 0x241008, roughness: 0.95, side: THREE.DoubleSide }),
    );
    cone.position.set(0, 4, -(CLIMB_L + 22));
    ctx.scene.add(cone);
    const glow = new THREE.Mesh(
      new THREE.CircleGeometry(11, 24),
      new THREE.MeshBasicMaterial({ color: 0xff7a2e }),
    );
    glow.rotation.x = -Math.PI / 2;
    glow.position.set(0, 15.2, -(CLIMB_L + 22));
    ctx.scene.add(glow);
    const rim = new THREE.Mesh(
      new THREE.TorusGeometry(11.5, 1.2, 10, 30),
      new THREE.MeshStandardMaterial({ color: 0x3a1408, emissive: 0xff5e2e, emissiveIntensity: 0.9 }),
    );
    rim.rotation.x = Math.PI / 2;
    rim.position.set(0, 15.4, -(CLIMB_L + 22));
    ctx.scene.add(rim);
    // Lava cracks glowing through the slope.
    for (let i = 0; i < 8; i++) {
      const crack = new THREE.Mesh(
        new THREE.PlaneGeometry(0.9 + Math.random() * 1.4, 7 + Math.random() * 12),
        new THREE.MeshBasicMaterial({ color: 0xff6a2e, transparent: true, opacity: 0.55 }),
      );
      crack.rotation.x = -Math.PI / 2;
      crack.rotation.z = (Math.random() - 0.5) * 0.9;
      crack.position.set((Math.random() - 0.5) * (CLIMB_W * 2 - 5), 0.12, (Math.random() - 0.5) * 2 * (CLIMB_L - 8));
      ctx.scene.add(crack);
    }
    // Rising embers.
    for (let i = 0; i < 16; i++) {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ color: 0xffa64d, transparent: true, opacity: 0.85, depthWrite: false }));
      sp.scale.setScalar(0.5 + Math.random() * 0.6);
      sp.position.set((Math.random() - 0.5) * CLIMB_W * 2, Math.random() * 14, (Math.random() - 0.5) * 2 * CLIMB_L);
      ctx.scene.add(sp);
      this.embers.push(sp);
    }
    // The crater GUARDIAN: a hero who is NOT one of the four in the match.
    const used = new Set(ctx.players.map((p) => p.hero.key));
    const pool = HEROES.filter((h) => !used.has(h.key));
    const hero = pool[Math.floor(Math.random() * pool.length)] ?? HEROES[0];
    const bot = new PlayerClass(hero, false, 4, 0);
    bot.buildRider(ctx.scene);
    bot.x = 0;
    bot.z = -(CLIMB_L + 5.5);
    bot.group.position.set(bot.x, 0, bot.z);
    this.thrower = bot;
  }

  private throwLava() {
    const ctx = this.ctx;
    const bot = this.thrower!;
    const alive = ctx.players.filter((p) => !p.dead);
    if (!alive.length) return;
    // Aim at the CLOSEST climber (highest up) half the time, otherwise anyone.
    const closest = [...alive].sort((a, b) => a.z - b.z)[0];
    const target = Math.random() < 0.5 ? closest : alive[Math.floor(Math.random() * alive.length)];
    const big = Math.random() < 0.3;
    const r = big ? 4.5 : 3; // character-sized; big = 1.5x
    const m = new THREE.Mesh(
      new THREE.SphereGeometry(r, 14, 14),
      new THREE.MeshStandardMaterial({ color: 0x2a1008, emissive: big ? 0xff3a10 : 0xff5e2e, emissiveIntensity: 1, roughness: 0.7 }),
    );
    const sx = bot.x, sz = bot.z + 2;
    m.position.set(sx, 4, sz);
    ctx.scene.add(m);
    // Slow ballistic lob that lands on the target.
    const tx = target.x + (Math.random() - 0.5) * 4;
    const tz = target.z + (Math.random() - 0.5) * 4;
    const T = Math.max(1.3, Math.min(2.6, Math.hypot(tx - sx, tz - sz) / 15));
    this.balls.push({
      m, x: sx, z: sz, y: 4,
      vx: (tx - sx) / T,
      vz: (tz - sz) / T,
      vy: (r * 0.7 - 4 + 15 * T * T) / T,
      r, big, life: 6,
    });
    // Guardian faces the throw.
    bot.vx = Math.sign(tx - sx) * 3;
    SFX.bump();
  }

  private tickVolcano(dt: number, elapsed: number) {
    const ctx = this.ctx;
    // Guardian paces the crater rim and lobs fireballs.
    const bot = this.thrower;
    if (bot) {
      bot.x = Math.sin(elapsed * 0.5) * (CLIMB_W - 5);
      bot.group.position.set(bot.x, 0, bot.z);
      bot.bob(elapsed, 7);
      bot.tickEffects(dt);
    }
    this.throwT -= dt;
    if (this.throwT <= 0) {
      this.throwT = 2.3 + Math.random() * 1.6;
      this.throwLava();
    }
    // Lava balls: fly, land, roll downhill, knock climbers back.
    this.balls = this.balls.filter((b) => {
      b.x += b.vx * dt;
      b.z += b.vz * dt;
      b.y += b.vy * dt;
      b.vy -= 30 * dt;
      const ground = b.r * 0.7;
      if (b.y <= ground) {
        if (b.vy < -4) ctx.fx.burst(b.x, b.z, '#FF6A2E', b.big ? 14 : 8);
        b.y = ground;
        b.vy = 0;
        b.vz = Math.max(b.vz, 9 + (b.big ? 3 : 0)); // rolls DOWN the slope
        b.vx *= 0.92;
        b.life -= dt * 2.5;
      }
      const w = CLIMB_W - 1.2;
      if (b.x < -w) { b.x = -w; b.vx = Math.abs(b.vx); }
      if (b.x > w) { b.x = w; b.vx = -Math.abs(b.vx); }
      b.m.position.set(b.x, b.y, b.z);
      b.m.rotation.x += dt * (b.big ? 2.4 : 4);
      for (const p of ctx.players) {
        if (p.dead || (p as any)._rockCd > performance.now()) continue;
        if (Math.hypot(p.x - b.x, p.z - b.z) < HITBOX_RADIUS + b.r * 0.8 && b.y < 6) {
          (p as any)._rockCd = performance.now() + 1300;
          // STUN + knocked back down — big balls hit much harder.
          p.freezeT = Math.max(p.freezeT, b.big ? 1.4 : 0.8);
          p.flinchT = 0.6;
          p.vz += b.big ? 44 : 26;
          p.vx += Math.sign(p.x - b.x) * (b.big ? 16 : 8);
          SFX.hit();
          ctx.fx.burst(p.x, p.z, '#FF6A2E', b.big ? 22 : 12);
          ctx.fx.shake(b.big ? 2.6 : 1.6);
          if (p.you) ctx.fx.banner(b.big ? '💥 BIG FIREBALL!' : '🔥 FIREBALL HIT!', '#FF6A2E');
        }
      }
      b.life -= dt * 0.2;
      if (b.life <= 0 || b.z > CLIMB_L + 6) {
        ctx.scene.remove(b.m);
        return false;
      }
      return true;
    });
    // Embers drift upward.
    for (const e of this.embers) {
      e.position.y += dt * (1.5 + (e.scale.x - 0.5) * 2);
      e.position.x += Math.sin(elapsed * 2 + e.position.z) * dt * 0.6;
      if (e.position.y > 16) e.position.y = 0.5;
    }
  }

  private spawnRock(prog: number) {
    const m = new THREE.Mesh(
      new THREE.DodecahedronGeometry(2.1 + Math.random() * 0.8),
      this.volcano
        ? new THREE.MeshStandardMaterial({ color: 0x35180c, emissive: 0xb03a10, emissiveIntensity: 0.55, roughness: 0.85 })
        : new THREE.MeshStandardMaterial({ color: 0x9db8cc, roughness: 0.8 }),
    );
    m.castShadow = true;
    const x = (Math.random() - 0.5) * (CLIMB_W - 2) * 2;
    m.position.set(x, 2, -(CLIMB_L + 4));
    this.ctx.scene.add(m);
    // Volcano rocks tumble DIAGONALLY and bounce between the walls.
    const vx = this.volcano ? (Math.random() < 0.5 ? -1 : 1) * (4 + Math.random() * 6) : 0;
    this.rocks.push({ m, x, z: -(CLIMB_L + 4), vz: 13 + prog * 7 + Math.random() * 5, vx });
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
      this.rockT = Math.max(this.volcano ? 1.0 : 0.55, (this.volcano ? 1.8 : 1.3) - prog * 0.6);
      this.spawnRock(prog);
    }
    this.rocks = this.rocks.filter((r) => {
      r.z += r.vz * dt;
      r.x += r.vx * dt;
      const rw = CLIMB_W - 1.5;
      if (r.x < -rw) { r.x = -rw; r.vx = Math.abs(r.vx); }
      if (r.x > rw) { r.x = rw; r.vx = -Math.abs(r.vx); }
      r.m.position.z = r.z;
      r.m.position.x = r.x;
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

    // Volcano: sideways speed normal, only the climb itself is slow.
    const preX = this.volcano ? ctx.players.map((p) => p.x) : null;
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
    if (preX) ctx.players.forEach((p, i) => (p.x = preX[i] + (p.x - preX[i]) * LATERAL_BOOST));
    collidePlayers(ctx);
    if (this.volcano) this.tickVolcano(dt, elapsed);

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
