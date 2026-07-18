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
import { spawnBolt, tickBolts, type Bolt } from '../boltfx';

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
  big?: boolean;
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
  private powerups: Powerups | null = null;
  private finished = false;
  // Snowball Smash mode: no HP — most HITS in 100s wins; snow doesn't slip;
  // perks (shoes/zap/shield) drop at random spots every 5-10s.
  private snow = false;
  private perks: { m: THREE.Group; x: number; z: number; kind: 'shoes' | 'zap' | 'shield' }[] = [];
  private perkT = 6;
  private bolts: Bolt[] = []; // zap lightning strikes — faded + culled each tick
  // "SLIPPERY" sign in the bottom-middle — solid cover to hide behind.
  // KEEP IN SYNC with server freesim + onlinefreeroam.
  private signZ = 0;
  private static readonly SIGN_HW = 4.6;
  private static readonly SIGN_HD = 1.1;

  init(ctx: MatchContext) {
    this.ctx = ctx;
    this.title = ctx.game.name;
    this.finished = false;
    this.proj = (ctx.game.mods?.proj as Proj) ?? 'crate';
    this.snow = this.proj === 'snowball';
    if (this.snow) this.objective = 'Most hits in 100s wins · grab 👟⚡🛡️ perks';
    this.duration = this.timeLeft = matchTime(this.snow ? 100 : 90);
    this.items = [];
    this.missiles = [];
    this.perks = [];
    this.perkT = 5 + Math.random() * 5;
    setupRoster(ctx, this.snow ? 0 : 100, 0.55);
    for (let i = 0; i < 6; i++) this.dropItem();
    this.powerups = this.snow ? null : new Powerups(ctx, ['speed', 'shield', 'giant', 'heal'], () => this.leader());
    if (this.snow) {
      this.signZ = ctx.halfSize * 0.55;
      this.buildSign();
    }
  }

  /** Cartoon "⚠ SLIPPERY" A-frame sign — solid cover in the bottom middle. */
  private buildSign() {
    const grp = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ color: 0xffd23f, roughness: 0.55 });
    const mk = (tilt: number, zOff: number) => {
      const panel = new THREE.Mesh(new THREE.BoxGeometry(9, 5.4, 0.35), mat);
      panel.rotation.x = tilt;
      panel.position.set(0, 2.7, zOff);
      panel.castShadow = true;
      grp.add(panel);
      return panel;
    };
    mk(-0.16, 0.55);
    mk(0.16, -0.55);
    // Face label.
    const c = document.createElement('canvas');
    c.width = 256; c.height = 128;
    const x = c.getContext('2d')!;
    x.fillStyle = '#1a2033';
    x.font = 'bold 46px Nunito, sans-serif';
    x.textAlign = 'center';
    x.fillText('⚠ SLIPPERY', 128, 58);
    x.font = '44px serif';
    x.fillText('❄', 128, 108);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    const face = new THREE.Mesh(
      new THREE.PlaneGeometry(8.4, 4.4),
      new THREE.MeshBasicMaterial({ map: t, transparent: true, depthWrite: false }),
    );
    face.rotation.x = -0.16;
    face.position.set(0, 2.9, 0.78);
    grp.add(face);
    grp.position.set(0, 0, this.signZ);
    this.ctx.scene.add(grp);
  }

  /** Solid sign collision: push players out along the smaller penetration axis. */
  private pushOffSign(p: Player) {
    const HW = ThrowFightGame.SIGN_HW + HITBOX_RADIUS * 0.8;
    const HD = ThrowFightGame.SIGN_HD + HITBOX_RADIUS * 0.8;
    const dz = p.z - this.signZ;
    if (Math.abs(p.x) >= HW || Math.abs(dz) >= HD) return;
    const penX = HW - Math.abs(p.x);
    const penZ = HD - Math.abs(dz);
    if (penX < penZ) {
      p.x = Math.sign(p.x || 1) * HW;
      p.vx = Math.sign(p.x) * Math.abs(p.vx) * 0.3;
    } else {
      p.z = this.signZ + Math.sign(dz || 1) * HD;
      p.vz = Math.sign(dz || 1) * Math.abs(p.vz) * 0.3;
    }
  }

  private leader(): Player | null {
    const alive = this.ctx.players.filter((p) => !p.dead);
    return alive.sort((a, b) => b.hp - a.hp)[0] ?? null;
  }

  // --- Snowball Smash perks --------------------------------------------------
  private spawnPerk() {
    const kinds = ['shoes', 'zap', 'shield'] as const;
    const kind = kinds[Math.floor(Math.random() * kinds.length)];
    const emoji = kind === 'shoes' ? '👟' : kind === 'zap' ? '⚡' : '🛡️';
    const grp = new THREE.Group();
    const base = new THREE.Mesh(
      new THREE.CylinderGeometry(1.5, 1.7, 0.5, 16),
      new THREE.MeshStandardMaterial({ color: 0x9adfff, emissive: 0x2a6a9a, emissiveIntensity: 0.5 }),
    );
    grp.add(base);
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const x2 = c.getContext('2d')!;
    x2.font = '50px serif';
    x2.textAlign = 'center';
    x2.textBaseline = 'middle';
    x2.fillText(emoji, 32, 36);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, depthWrite: false }));
    sp.scale.set(3.2, 3.2, 1);
    sp.position.y = 2.6;
    grp.add(sp);
    const x = (Math.random() - 0.5) * this.ctx.halfSize * 1.6;
    const z = (Math.random() - 0.5) * this.ctx.halfSize * 1.6;
    grp.position.set(x, 0.3, z);
    this.ctx.scene.add(grp);
    this.perks.push({ m: grp, x, z, kind });
  }

  private grabPerk(p: Player, kind: 'shoes' | 'zap' | 'shield') {
    const ctx = this.ctx;
    SFX.power();
    if (kind === 'shoes') {
      p.shoesT = 5;
      p.setStatusIcon('👟', 5);
      ctx.fx.banner(p.you ? '👟 SPEED x2!' : `👟 ${p.hero.name} IS FAST!`, '#7ED321');
    } else if (kind === 'shield') {
      p.shieldT = 5;
      p.setStatusIcon('🛡️', 5);
      ctx.fx.banner(p.you ? '🛡️ SHIELD! Hits on you do not count' : `🛡️ ${p.hero.name} IS SHIELDED!`, '#9ADFFF');
    } else {
      SFX.zap();
      p.setStatusIcon('⚡', 3);
      ctx.fx.banner(p.you ? '⚡ ZAP THEM ALL!' : `⚡ ${p.hero.name} ZAPPED YOU!`, '#FFD23F');
      for (const q of ctx.players) {
        if (q === p || q.dead) continue;
        q.freezeT = Math.max(q.freezeT, 3);
        q.zapped = true;
        this.bolts.push(spawnBolt(ctx.scene, q.x, q.z));
        ctx.fx.burst(q.x, q.z, '#FFD23F', 12);
      }
      ctx.fx.shake(2);
    }
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
    // Leaves the HAND: start beside the body at throwing height, launched
    // slightly along the aim so it reads like a real throw.
    const hx = p.x + dx * 1.6, hz = p.z + dz * 1.6;
    m.position.set(hx, 4.2, hz);
    this.ctx.scene.add(m);
    this.missiles.push({
      m, x: hx, z: hz, y: 4.2,
      vx: dx * s.speed, vz: dz * s.speed, vy: 7,
      owner: p,
      dmg: s.dmg * strengthMult(p.hero) * (big ? 1.6 : 1),
      big,
    } as Missile & { big: boolean });
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
    // Snowball Smash runs the full clock — nobody gets eliminated.
    if (this.timeLeft <= 0 || (!this.snow && (alive.length <= 1 || ctx.players[0].dead))) return this.doFinish();
    ctx.hazards.setProgress(1 - this.timeLeft / this.duration);
    ctx.hazards.tick(dt, ctx.players);
    this.powerups?.tick(dt);
    tickDecoys(ctx, dt);

    if (this.items.length < 6 && Math.random() < dt * 0.6) this.dropItem();

    // Perk drops: 👟 / ⚡ / 🛡️ at a random spot every 5-10 seconds.
    if (this.snow) {
      this.perkT -= dt;
      if (this.perkT <= 0) {
        this.perkT = 5 + Math.random() * 5;
        if (this.perks.length < 2) this.spawnPerk();
      }
      for (const pk of this.perks) pk.m.rotation.y += dt * 2;
      for (const p of ctx.players) {
        if (p.dead) continue;
        this.perks = this.perks.filter((pk) => {
          if (Math.hypot(pk.x - p.x, pk.z - p.z) < HITBOX_RADIUS + 2) {
            ctx.scene.remove(pk.m);
            this.grabPerk(p, pk.kind);
            return false;
          }
          return true;
        });
      }
    }

    const moveOpts = this.snow ? { surfaceOverride: 'metal' as const } : {};
    localMove(ctx, dt, moveOpts);
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
          // Perks are tempting — grab a nearby one on the way.
          if (this.snow && this.perks.length && Math.random() < 0.5) {
            const pk = this.perks[0];
            if (Math.hypot(pk.x - p.x, pk.z - p.z) < 22) { p.tx = pk.x; p.tz = pk.z; }
          }
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
      botMove(ctx, p, p.tx, p.tz, dt, moveOpts);
      botMaybeUltimate(ctx, p, dt);
    }
    collidePlayers(ctx);
    if (this.snow) for (const p of ctx.players) if (!p.dead) this.pushOffSign(p);

    // Pickups.
    for (const p of ctx.players) {
      if (p.dead || p.held) continue;
      this.items = this.items.filter((it) => {
        if (Math.hypot(it.x - p.x, it.z - p.z) < HITBOX_RADIUS + 2) {
          ctx.scene.remove(it.m);
          p.held = true;
          (p as any)._heldBig = it.big;
          const hm = this.makeProjMesh(false, it.big);
          // Carried IN HAND — beside the body at arm height, not overhead.
          hm.scale.setScalar(0.75);
          hm.position.set(1.6, 3.6, 1.0);
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
      // The SLIPPERY sign is solid cover: low throws splat against it.
      if (this.snow && Math.abs(pr.x) < ThrowFightGame.SIGN_HW + 0.8 &&
          Math.abs(pr.z - this.signZ) < ThrowFightGame.SIGN_HD + 0.8 && pr.y < 5.6) {
        ctx.fx.burst(pr.x, pr.z, '#F0F8FF', 10);
        SFX.tick();
        ctx.scene.remove(pr.m);
        return false;
      }
      for (const q of ctx.players) {
        if (q === pr.owner || q.dead) continue;
        if (Math.hypot(q.x - pr.x, q.z - pr.z) < HITBOX_RADIUS + 1.6 && pr.y < HITBOX_RADIUS * 2.6) {
          if (this.snow) {
            // Hit-count scoring: big snowballs are worth DOUBLE. A shield
            // means hits on you don't count at all.
            const L = Math.hypot(pr.vx, pr.vz) || 1;
            if (q.shieldT > 0) {
              ctx.fx.burst(q.x, q.z, '#9ADFFF', 10);
              if (q.you) ctx.fx.banner('🛡️ BLOCKED!', '#9ADFFF');
              SFX.tick();
            } else {
              pr.owner.score += pr.big ? 2 : 1;
              setScore(pr.owner, pr.owner.score);
              // Splat! 0.5s stun + a visible stagger.
              q.freezeT = Math.max(q.freezeT, 0.5);
              q.flinchT = 0.5;
              q.vx += (pr.vx / L) * (pr.big ? 30 : 20);
              q.vz += (pr.vz / L) * (pr.big ? 30 : 20);
              ctx.fx.burst(q.x, q.z, '#F0F8FF', pr.big ? 20 : 12);
              ctx.fx.shake(pr.big ? 2 : 1.2);
              SFX.hit();
              if (pr.owner.you) ctx.fx.banner(pr.big ? '+2 BIG HIT!' : '+1 HIT!', '#F0F8FF');
            }
          } else if (aoe) this.explode(pr.x, pr.z, pr.owner);
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
    this.bolts = tickBolts(ctx.scene, this.bolts, dt); // fade + remove zap strikes
    tickRoster(ctx, dt, elapsed);
  }

  private doFinish() {
    if (this.finished) return;
    this.finished = true;
    if (this.snow) {
      this.ctx.players.forEach((p) => ((p as any)._res = p.score + ' hits'));
      this.ctx.finish(rankBy(this.ctx, (p) => p.score), 'Most snowball hits wins.');
      return;
    }
    this.ctx.players.forEach((p) => ((p as any)._res = p.dead ? 'OUT' : Math.max(Math.round(p.hp), 0) + ' HP'));
    this.ctx.finish(rankBy(this.ctx, (p) => (p.dead ? -1 : p.hp)), 'Last basher standing wins.');
  }
}
