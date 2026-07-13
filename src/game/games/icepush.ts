import * as THREE from 'three';
import type { GameModule, MatchContext } from '../context';
import type { Player } from '../player';
import { HITBOX_RADIUS } from '../player';
import { setupRoster, localMove, botMove, collidePlayers, tickRoster, localJump, rankBy } from '../freeroam';
import { fireUltimate, botMaybeUltimate, tickDecoys } from '../ultimates';
import { matchTime } from '../../core/tuning';
import { SFX } from '../../core/audio';
import { setScore, markDead } from '../../ui/hud';

// ICE PUSH — Slip & Slide. A slippery brawl on solid ice: smash rivals
// through the ice walls around the rink. Each wall segment SAVES you once
// (you bounce off and it shatters) — fall through the gap next time. A ⚡
// thunder box appears every 10 seconds; whoever grabs it zaps everyone else.
// 3 lives · 2 minutes · last basher standing.

const SEGS = 8; // wall segments per side

interface ThunderBox { m: THREE.Group; x: number; z: number; }

export class IcePushGame implements GameModule {
  readonly stickMode = 'float' as const;
  title = 'Slip & Slide';
  objective = 'Slippery! Smash rivals through the ice walls · 3 lives';

  private ctx!: MatchContext;
  private timeLeft = 120;
  private walls: { m: THREE.Mesh; alive: boolean }[] = [];
  private box: ThunderBox | null = null;
  private boxT = 10;
  private finished = false;

  init(ctx: MatchContext) {
    this.ctx = ctx;
    this.title = ctx.game.name;
    this.finished = false;
    this.timeLeft = matchTime(120);
    this.box = null;
    this.boxT = 10;
    this.walls = [];

    setupRoster(ctx, 3, 0.45);

    // 8 ice-wall segments per side, translucent and glowing.
    const half = ctx.halfSize;
    const segLen = (half * 2) / SEGS;
    const mat = () =>
      new THREE.MeshStandardMaterial({
        color: 0x9adfff, roughness: 0.15, metalness: 0.2,
        transparent: true, opacity: 0.65, emissive: 0x1a4a7a,
      });
    for (let side = 0; side < 4; side++) {
      for (let i = 0; i < SEGS; i++) {
        const along = -half + segLen * (i + 0.5);
        const horiz = side < 2; // 0 bottom(z+), 1 top(z-), 2 left(x-), 3 right(x+)
        const m = new THREE.Mesh(new THREE.BoxGeometry(horiz ? segLen * 0.96 : 1.6, 3.4, horiz ? 1.6 : segLen * 0.96), mat());
        m.position.set(
          horiz ? along : side === 2 ? -half : half,
          1.7,
          horiz ? (side === 0 ? half : -half) : along,
        );
        m.castShadow = true;
        ctx.scene.add(m);
        this.walls.push({ m, alive: true });
      }
    }
  }

  /** Wall segment index for a position beyond the rink edge, or -1. */
  private segAt(x: number, z: number): number {
    const half = this.ctx.halfSize;
    const segLen = (half * 2) / SEGS;
    const idx = (along: number) => Math.max(0, Math.min(SEGS - 1, Math.floor((along + half) / segLen)));
    if (z >= half - 1) return 0 * SEGS + idx(x);
    if (z <= -half + 1) return 1 * SEGS + idx(x);
    if (x <= -half + 1) return 2 * SEGS + idx(z);
    if (x >= half - 1) return 3 * SEGS + idx(z);
    return -1;
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
    const half = this.ctx.halfSize;
    const grp = new THREE.Group();
    const crate = new THREE.Mesh(
      new THREE.BoxGeometry(2.6, 2.6, 2.6),
      new THREE.MeshStandardMaterial({ color: 0xffd23f, emissive: 0xaa7700, emissiveIntensity: 0.5, roughness: 0.4 }),
    );
    crate.castShadow = true;
    grp.add(crate);
    const bolt = new THREE.Mesh(
      new THREE.ConeGeometry(0.8, 2.2, 4),
      new THREE.MeshBasicMaterial({ color: 0xfff7aa }),
    );
    bolt.position.y = 2.6;
    grp.add(bolt);
    const x = (Math.random() - 0.5) * half * 1.4;
    const z = (Math.random() - 0.5) * half * 1.4;
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
    SFX.power();
    this.ctx.fx.shake(2.5);
    this.ctx.fx.banner(p.you ? '⚡ ZAP THEM ALL!' : `⚡ ${p.hero.name} GOT THE BOX!`, '#FFD23F');
    for (const q of this.ctx.players) {
      if (q === p || q.dead) continue;
      q.freezeT = Math.max(q.freezeT, 2);
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

    // ⚡ box every 10s.
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
          this.grabBox(p);
          break;
        }
      }
    }

    // Slippery movement: the family surface is ice, so localMove/botMove pick
    // it up automatically. Edges are open — the walls do the saving.
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
    const half = ctx.halfSize;
    for (const p of ctx.players) {
      if (p.dead || p.invulnT > 0) continue;
      const inside = Math.abs(p.x) < half - 1 && Math.abs(p.z) < half - 1;
      if (inside) continue;
      const seg = this.segAt(p.x, p.z);
      const wall = seg >= 0 ? this.walls[seg] : null;
      if (wall && wall.alive) {
        // The ice wall saves you once — bounce back in, wall shatters.
        wall.alive = false;
        wall.m.visible = false;
        SFX.crack();
        ctx.fx.burst(p.x, p.z, '#9ADFFF', 16);
        ctx.fx.shake(1.5);
        if (p.you) ctx.fx.banner('THE ICE SAVED YOU!', '#9ADFFF');
        const nx = Math.abs(p.x) > Math.abs(p.z) ? -Math.sign(p.x) : 0;
        const nz = nx === 0 ? -Math.sign(p.z) : 0;
        p.vx = nx * 22 + (nx === 0 ? p.vx * 0.4 : 0);
        p.vz = nz * 22 + (nz === 0 ? p.vz * 0.4 : 0);
        p.x = Math.max(-(half - 1.4), Math.min(half - 1.4, p.x));
        p.z = Math.max(-(half - 1.4), Math.min(half - 1.4, p.z));
      } else if (Math.abs(p.x) > half + 1 || Math.abs(p.z) > half + 1) {
        // No wall left here: down you go.
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
          p.x = (Math.random() - 0.5) * half * 0.3;
          p.z = (Math.random() - 0.5) * half * 0.3;
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
