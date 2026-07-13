import * as THREE from 'three';
import type { GameModule, MatchContext } from '../context';
import type { Player } from '../player';
import { HITBOX_RADIUS } from '../player';
import { setupRoster, localMove, botMove, collidePlayers, tickRoster, localJump, rankBy } from '../freeroam';
import { fireUltimate, botMaybeUltimate, tickDecoys } from '../ultimates';
import { Powerups } from '../powerups';
import { accuracyMult, strengthMult } from '../../data/characters';
import { matchTime } from '../../core/tuning';
import { SFX } from '../../core/audio';
import { setScore, markDead } from '../../ui/hud';

// THROWFIGHT — grab & hurl projectiles to drain rival HP (Snowball Smash,
// Blast Zone, Cannon Blast, Crate Brawl). Projectile flavor changes damage,
// speed and blast behavior; bombs explode with an area knockback. Ability
// throws when holding, otherwise fires your ultimate.

type Proj = 'snowball' | 'bomb' | 'cannon' | 'crate';

interface PickupItem { m: THREE.Mesh; x: number; z: number; big: boolean; }
interface Missile {
  m: THREE.Mesh;
  x: number; z: number; y: number;
  vx: number; vz: number; vy: number;
  owner: Player;
  dmg: number;
}

const PROJ_STATS: Record<Proj, { dmg: number; speed: number; aoe: boolean; col: number }> = {
  snowball: { dmg: 14, speed: 52, aoe: false, col: 0xf0f8ff },
  bomb: { dmg: 24, speed: 40, aoe: true, col: 0x2a2a34 },
  cannon: { dmg: 20, speed: 48, aoe: false, col: 0x1a1a22 },
  crate: { dmg: 18, speed: 46, aoe: false, col: 0xc98a3f },
};

export class ThrowFightGame implements GameModule {
  readonly stickMode = 'float' as const;
  title = 'Throw Fight';
  objective = 'Grab ammo · hurl it · last basher standing';

  private ctx!: MatchContext;
  private proj: Proj = 'crate';
  private items: PickupItem[] = [];
  private missiles: Missile[] = [];
  private timeLeft = 90;
  private duration = 90;
  private powerups!: Powerups;
  private finished = false;

  init(ctx: MatchContext) {
    this.ctx = ctx;
    this.title = ctx.game.name;
    this.finished = false;
    this.proj = (ctx.game.mods?.proj as Proj) ?? 'crate';
    this.duration = this.timeLeft = matchTime(90);
    this.items = [];
    this.missiles = [];
    setupRoster(ctx, 100, 0.55);
    for (let i = 0; i < 6; i++) this.dropItem();
    this.powerups = new Powerups(ctx, ['speed', 'shield', 'giant', 'heal'], () => this.leader());
  }

  private leader(): Player | null {
    const alive = this.ctx.players.filter((p) => !p.dead);
    return alive.sort((a, b) => b.hp - a.hp)[0] ?? null;
  }

  private makeProjMesh(thrown: boolean, big = false): THREE.Mesh {
    const m = this.makeProjMeshInner(thrown);
    if (big) m.scale.setScalar(1.5);
    return m;
  }

  private makeProjMeshInner(thrown: boolean): THREE.Mesh {
    const s = PROJ_STATS[this.proj];
    let m: THREE.Mesh;
    if (this.proj === 'crate') {
      m = new THREE.Mesh(new THREE.BoxGeometry(2.6, 2.6, 2.6),
        new THREE.MeshStandardMaterial({ color: s.col, roughness: 0.9 }));
    } else if (this.proj === 'bomb') {
      m = new THREE.Mesh(new THREE.SphereGeometry(1.5, 12, 12),
        new THREE.MeshStandardMaterial({ color: s.col, roughness: 0.4, metalness: 0.5, emissive: 0xff5e2e, emissiveIntensity: thrown ? 0.6 : 0.25 }));
    } else if (this.proj === 'snowball') {
      m = new THREE.Mesh(new THREE.SphereGeometry(1.4, 12, 12),
        new THREE.MeshStandardMaterial({ color: s.col, roughness: 0.9 }));
    } else {
      m = new THREE.Mesh(new THREE.SphereGeometry(1.4, 12, 12),
        new THREE.MeshStandardMaterial({ color: s.col, roughness: 0.35, metalness: 0.75 }));
    }
    m.castShadow = true;
    return m;
  }

  private dropItem() {
    // Snowball fights mix in bigger snowballs that hit ~60% harder.
    const big = this.proj === 'snowball' && Math.random() < 0.35;
    const m = this.makeProjMesh(false, big);
    const x = (Math.random() - 0.5) * this.ctx.halfSize * 1.6;
    const z = (Math.random() - 0.5) * this.ctx.halfSize * 1.6;
    m.position.set(x, 1.5, z);
    this.ctx.scene.add(m);
    this.items.push({ m, x, z, big });
  }

  ability() {
    const you = this.ctx.players[0];
    if (you.dead) return;
    if (you.held) this.throw(you);
    else fireUltimate(this.ctx, you);
  }
  jump() {
    localJump(this.ctx);
  }

  private throw(p: Player) {
    if (!p.held) return;
    p.held = false;
    if ((p as any)._heldMesh) {
      p.group.remove((p as any)._heldMesh);
      (p as any)._heldMesh = null;
    }
    // Auto-aim at the nearest living rival; accuracy tightens the spread.
    let tgt: Player | null = null, bd = 1e9;
    for (const q of this.ctx.players) {
      if (q === p || q.dead) continue;
      const d = Math.hypot(q.x - p.x, q.z - p.z);
      if (d < bd) { bd = d; tgt = q; }
    }
    let dx = p.face.x, dz = p.face.z;
    if (tgt) {
      dx = tgt.x - p.x;
      dz = tgt.z - p.z;
      const L = Math.hypot(dx, dz) || 1;
      dx /= L; dz /= L;
      const err = (1.075 - accuracyMult(p.hero)) * 2.2 + (p.you ? 0 : this.ctx.diff.err * 0.8);
      const a = Math.atan2(dz, dx) + (Math.random() - 0.5) * err;
      dx = Math.cos(a); dz = Math.sin(a);
    }
    const s = PROJ_STATS[this.proj];
    const big = !!(p as any)._heldBig;
    (p as any)._heldBig = false;
    const m = this.makeProjMesh(true, big);
    m.position.set(p.x, 3, p.z);
    this.ctx.scene.add(m);
    this.missiles.push({
      m, x: p.x, z: p.z, y: 3,
      vx: dx * s.speed, vz: dz * s.speed, vy: 6,
      owner: p,
      dmg: s.dmg * strengthMult(p.hero) * (big ? 1.6 : 1),
    });
    SFX.bump();
  }

  private explode(x: number, z: number, owner: Player) {
    const ctx = this.ctx;
    ctx.fx.burst(x, z, '#FF5E2E', 24);
    ctx.fx.shake(2.5);
    SFX.goal();
    for (const q of ctx.players) {
      if (q === owner || q.dead) continue;
      const d = Math.hypot(q.x - x, q.z - z);
      if (d < 7) {
        this.damage(q, 22 * (1 - d / 10));
        const nx = (q.x - x) / (d || 1), nz = (q.z - z) / (d || 1);
        const damp = q.shieldT > 0 ? 0.5 : 1;
        q.vx += nx * 32 * damp;
        q.vz += nz * 32 * damp;
      }
    }
  }

  private damage(q: Player, dmg: number) {
    if (q.shieldT > 0) {
      q.shieldT = 0; // shield absorbs the hit
      this.ctx.fx.banner(q.you ? 'SHIELD BROKE!' : '', q.hero.col);
      return;
    }
    q.hp -= dmg;
    setScore(q, Math.max(Math.round(q.hp), 0));
    if (q.hp <= 0) {
      q.dead = true;
      markDead(q);
      SFX.out();
      this.ctx.fx.banner(q.you ? 'YOU ARE OUT!' : q.hero.name + ' IS OUT!', '#FF4D4D');
    }
  }

  tick(dt: number, elapsed: number) {
    if (this.finished) return;
    const ctx = this.ctx;
    this.timeLeft -= dt;
    ctx.setClock(this.timeLeft);
    const alive = ctx.players.filter((p) => !p.dead);
    if (this.timeLeft <= 0 || alive.length <= 1 || ctx.players[0].dead) return this.doFinish();
    ctx.hazards.setProgress(1 - this.timeLeft / this.duration);
    ctx.hazards.tick(dt, ctx.players);
    this.powerups.tick(dt);
    tickDecoys(ctx, dt);

    if (this.items.length < 6 && Math.random() < dt * 0.6) this.dropItem();

    localMove(ctx, dt);
    for (const p of ctx.players.slice(1)) {
      if (p.dead) continue;
      p.retarget -= dt;
      if (p.retarget <= 0) {
        p.retarget = ctx.diff.lapse + Math.random() * ctx.diff.lapse;
        if (!p.held) {
          let c: PickupItem | null = null, bd = 1e9;
          for (const it of this.items) {
            const d = Math.hypot(it.x - p.x, it.z - p.z);
            if (d < bd) { bd = d; c = it; }
          }
          p.tx = c ? c.x : 0;
          p.tz = c ? c.z : 0;
        } else {
          let q: Player | null = null, bd = 1e9;
          for (const o of ctx.players) {
            if (o === p || o.dead) continue;
            const d = Math.hypot(o.x - p.x, o.z - p.z);
            if (d < bd) { bd = d; q = o; }
          }
          if (q) {
            p.face = { x: (q.x - p.x) / (bd || 1), z: (q.z - p.z) / (bd || 1) };
            if (bd < ctx.halfSize * 1.2 && Math.random() < 0.5) this.throw(p);
          }
          p.tx = p.x; p.tz = p.z;
        }
      }
      botMove(ctx, p, p.tx, p.tz, dt);
      botMaybeUltimate(ctx, p, dt);
    }
    collidePlayers(ctx);

    // Pickups.
    for (const p of ctx.players) {
      if (p.dead || p.held) continue;
      this.items = this.items.filter((it) => {
        if (Math.hypot(it.x - p.x, it.z - p.z) < HITBOX_RADIUS + 2) {
          ctx.scene.remove(it.m);
          p.held = true;
          (p as any)._heldBig = it.big;
          const hm = this.makeProjMesh(false, it.big);
          hm.scale.setScalar(0.7);
          hm.position.set(0, HITBOX_RADIUS * 2.4, 0);
          p.group.add(hm);
          (p as any)._heldMesh = hm;
          SFX.tick();
          return false;
        }
        return true;
      });
    }

    // Missiles.
    const aoe = PROJ_STATS[this.proj].aoe;
    this.missiles = this.missiles.filter((pr) => {
      pr.x += pr.vx * dt;
      pr.z += pr.vz * dt;
      pr.y += pr.vy * dt;
      pr.vy -= 30 * dt;
      pr.m.position.set(pr.x, Math.max(pr.y, 1), pr.z);
      pr.m.rotation.x += dt * 6;
      pr.m.rotation.y += dt * 4;
      for (const q of ctx.players) {
        if (q === pr.owner || q.dead) continue;
        if (Math.hypot(q.x - pr.x, q.z - pr.z) < HITBOX_RADIUS + 1.6 && pr.y < HITBOX_RADIUS * 2.6) {
          if (aoe) this.explode(pr.x, pr.z, pr.owner);
          else {
            this.damage(q, pr.dmg);
            const L = Math.hypot(pr.vx, pr.vz) || 1;
            const damp = q.shieldT > 0 ? 0.5 : 1;
            q.vx += (pr.vx / L) * 22 * damp;
            q.vz += (pr.vz / L) * 22 * damp;
            ctx.fx.burst(q.x, q.z, '#FF4D4D', 14);
            ctx.fx.shake(1.5);
            SFX.hit();
          }
          ctx.scene.remove(pr.m);
          return false;
        }
      }
      if (pr.y < 1 || Math.abs(pr.x) > ctx.halfSize + 8 || Math.abs(pr.z) > ctx.halfSize + 8) {
        if (aoe && pr.y < 1 && Math.abs(pr.x) < ctx.halfSize && Math.abs(pr.z) < ctx.halfSize) {
          this.explode(pr.x, pr.z, pr.owner);
        }
        ctx.scene.remove(pr.m);
        return false;
      }
      return true;
    });

    this.items.forEach((it) => (it.m.rotation.y += dt));
    tickRoster(ctx, dt, elapsed);
  }

  private doFinish() {
    if (this.finished) return;
    this.finished = true;
    this.ctx.players.forEach((p) => ((p as any)._res = p.dead ? 'OUT' : Math.max(Math.round(p.hp), 0) + ' HP'));
    this.ctx.finish(rankBy(this.ctx, (p) => (p.dead ? -1 : p.hp)), 'Last basher standing wins.');
  }
}
