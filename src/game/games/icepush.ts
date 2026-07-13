import * as THREE from 'three';
import type { GameModule, MatchContext } from '../context';
import type { Player } from '../player';
import { HITBOX_RADIUS } from '../player';
import { setupRoster, localMove, botMove, collidePlayers, tickRoster, localJump, rankBy } from '../freeroam';
import { fireUltimate, botMaybeUltimate, tickDecoys } from '../ultimates';
import { spawnBolt, tickBolts, type Bolt } from '../boltfx';
import { matchTime } from '../../core/tuning';
import { SFX } from '../../core/audio';
import { setScore, markDead } from '../../ui/hud';

// ICE PUSH — Slip & Slide. A small ROUND rink of slippery ice: smash rivals
// through the ice wall around the rim. Each wall segment saves you once (you
// bounce off and it shatters) — fall through the gap next time. A ⚡ thunder
// box appears every 10 seconds; whoever grabs it strikes the other three with
// lightning: they turn black and stand stunned for 3 seconds.
// 3 lives · 2 minutes · last basher standing.

const SEGS = 16; // wall segments around the rim

interface ThunderBox { m: THREE.Group; x: number; z: number; }

export class IcePushGame implements GameModule {
  readonly stickMode = 'float' as const;
  title = 'Slip & Slide';
  objective = 'Slippery! Smash rivals through the ice wall · 3 lives';

  private ctx!: MatchContext;
  private timeLeft = 120;
  private walls: { m: THREE.Mesh; alive: boolean }[] = [];
  private box: ThunderBox | null = null;
  private boxT = 10;
  private bolts: Bolt[] = [];
  private finished = false;

  init(ctx: MatchContext) {
    this.ctx = ctx;
    this.title = ctx.game.name;
    this.finished = false;
    this.timeLeft = matchTime(120);
    this.box = null;
    this.boxT = 10;
    this.walls = [];
    this.bolts = [];

    setupRoster(ctx, 3, 0.45);

    // Ice wall: 16 arc segments around the rim of the round rink.
    const R = ctx.halfSize;
    const segArc = (2 * Math.PI) / SEGS;
    const segLen = 2 * R * Math.sin(segArc / 2) * 1.04;
    for (let i = 0; i < SEGS; i++) {
      const a = (i + 0.5) * segArc;
      const m = new THREE.Mesh(
        new THREE.BoxGeometry(segLen, 3.4, 1.6),
        new THREE.MeshStandardMaterial({
          color: 0x9adfff, roughness: 0.15, metalness: 0.2,
          transparent: true, opacity: 0.65, emissive: 0x1a4a7a,
        }),
      );
      m.position.set(Math.cos(a) * R, 1.7, Math.sin(a) * R);
      m.rotation.y = -a + Math.PI / 2; // tangent to the circle
      m.castShadow = true;
      ctx.scene.add(m);
      this.walls.push({ m, alive: true });
    }
  }

  private segAt(x: number, z: number): number {
    const a = Math.atan2(z, x);
    const norm = (a + Math.PI * 2) % (Math.PI * 2);
    return Math.min(SEGS - 1, Math.floor((norm / (Math.PI * 2)) * SEGS));
  }

  ability() {
    fireUltimate(this.ctx, this.ctx.players[0]);
  }
  jump() {
    localJump(this.ctx);
  }

  private spawnBox() {
    if (this.box) {
      this.ctx.scene.remove(this.box.m);
      this.box = null;
    }
    const R = this.ctx.halfSize;
    const grp = new THREE.Group();
    const crate = new THREE.Mesh(
      new THREE.BoxGeometry(2.6, 2.6, 2.6),
      new THREE.MeshStandardMaterial({ color: 0xffd23f, emissive: 0xaa7700, emissiveIntensity: 0.5, roughness: 0.4 }),
    );
    crate.castShadow = true;
    grp.add(crate);
    const bolt = new THREE.Mesh(new THREE.ConeGeometry(0.8, 2.2, 4), new THREE.MeshBasicMaterial({ color: 0xfff7aa }));
    bolt.position.y = 2.6;
    grp.add(bolt);
    const a = Math.random() * Math.PI * 2;
    const r = Math.random() * R * 0.7;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    grp.position.set(x, 1.3, z);
    this.ctx.scene.add(grp);
    this.box = { m: grp, x, z };
    this.ctx.fx.banner('⚡ THUNDER BOX!', '#FFD23F');
    SFX.tick();
  }

  private grabBox(p: Player) {
    if (!this.box) return;
    this.ctx.scene.remove(this.box.m);
    this.box = null;
    SFX.zap();
    this.ctx.fx.shake(3);
    this.ctx.fx.banner(p.you ? '⚡ ZAP THEM ALL!' : `⚡ ${p.hero.name} GOT THE BOX!`, '#FFD23F');
    for (const q of this.ctx.players) {
      if (q === p || q.dead) continue;
      // Lightning strikes each rival: blacked out + stunned for 3 seconds.
      q.freezeT = Math.max(q.freezeT, 3);
      q.zapped = true;
      q.vx *= 0.1;
      q.vz *= 0.1;
      this.bolts.push(spawnBolt(this.ctx.scene, q.x, q.z));
      this.ctx.fx.burst(q.x, q.z, '#FFF7AA', 14);
    }
  }

  tick(dt: number, elapsed: number) {
    if (this.finished) return;
    const ctx = this.ctx;
    this.timeLeft -= dt;
    ctx.setClock(this.timeLeft);
    if (this.timeLeft <= 0) return this.doFinish();
    tickDecoys(ctx, dt);
    this.bolts = tickBolts(ctx.scene, this.bolts, dt);

    // ⚡ box every 10s.
    this.boxT -= dt;
    if (this.boxT <= 0) {
      this.boxT = 10;
      this.spawnBox();
    }
    if (this.box) {
      this.box.m.rotation.y += dt * 2;
      for (const p of ctx.players) {
        if (p.dead || p.freezeT > 0) continue;
        if (Math.hypot(p.x - this.box.x, p.z - this.box.z) < HITBOX_RADIUS + 2) {
          this.grabBox(p);
          break;
        }
      }
    }

    localMove(ctx, dt, { noClamp: true });
    for (const p of ctx.players.slice(1)) {
      if (p.dead) continue;
      p.retarget -= dt;
      if (p.retarget <= 0) {
        p.retarget = ctx.diff.lapse + Math.random() * ctx.diff.lapse;
        if (this.box) {
          p.tx = this.box.x;
          p.tz = this.box.z;
        } else {
          const foes = ctx.players.filter((q) => q !== p && !q.dead);
          const t = foes[Math.floor(Math.random() * foes.length)];
          p.tx = t ? t.x : 0;
          p.tz = t ? t.z : 0;
        }
      }
      botMove(ctx, p, p.tx, p.tz, dt, { noClamp: true });
      botMaybeUltimate(ctx, p, dt);
    }
    collidePlayers(ctx);
    this.checkWalls();
    tickRoster(ctx, dt, elapsed);
  }

  private checkWalls() {
    const ctx = this.ctx;
    const R = ctx.halfSize;
    for (const p of ctx.players) {
      if (p.dead || p.invulnT > 0) continue;
      const r = Math.hypot(p.x, p.z);
      if (r < R - 1) continue;
      const seg = this.segAt(p.x, p.z);
      const wall = this.walls[seg];
      if (wall && wall.alive && r < R + 1.5) {
        // The ice wall saves you once — bounce back in, wall shatters.
        wall.alive = false;
        wall.m.visible = false;
        SFX.crack();
        ctx.fx.burst(p.x, p.z, '#9ADFFF', 16);
        ctx.fx.shake(1.5);
        if (p.you) ctx.fx.banner('THE ICE SAVED YOU!', '#9ADFFF');
        const nx = -p.x / (r || 1);
        const nz = -p.z / (r || 1);
        p.vx = nx * 22;
        p.vz = nz * 22;
        const rr = R - 1.6;
        p.x = (p.x / (r || 1)) * rr;
        p.z = (p.z / (r || 1)) * rr;
      } else if (!wall?.alive && r > R + 1) {
        // No wall here anymore: down you go.
        p.lives--;
        setScore(p, Math.max(p.lives, 0));
        SFX.fall();
        ctx.fx.burst(p.x, p.z, p.hero.col, 18);
        ctx.fx.banner(p.you ? 'YOU FELL THROUGH!' : p.hero.name + ' FELL!', p.hero.col);
        if (p.lives <= 0) {
          p.dead = true;
          markDead(p);
          SFX.out();
          ctx.fx.banner(p.you ? 'YOU ARE OUT!' : p.hero.name + ' IS OUT!', '#FF4D4D');
          const alive = ctx.players.filter((q) => !q.dead);
          if (p.you || alive.length <= 1) setTimeout(() => this.doFinish(), 900);
        } else {
          p.x = (Math.random() - 0.5) * R * 0.3;
          p.z = (Math.random() - 0.5) * R * 0.3;
          p.vx = 0;
          p.vz = 0;
          p.invulnT = 1;
        }
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
