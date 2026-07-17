import * as THREE from 'three';
import type { GameModule, MatchContext } from '../context';
import type { Player } from '../player';
import { HITBOX_RADIUS } from '../player';
import { setupRoster, localMove, botMove, tickRoster, rankBy } from '../freeroam';
import { matchTime } from '../../core/tuning';
import { SFX } from '../../core/audio';
import { markDead, setScore, setObjective } from '../../ui/hud';

// THE GREAT ESCAPE (Dune Clash). Top-down chase: 3 players are the ESCAPE TEAM,
// 1 random player is the GUARD (faster, carries a stick). Touch = caught/out;
// the guard works through them one at a time. Escapers hide behind crates and
// grab pickups that spawn every 5s: SHOES (speed burst), FREEZE (freeze the
// guard 2s), and a SLINGSHOT (auto-fires a bolt that slows the guard 4s from
// range). Guard wins by catching all 3 before time; any survivor wins otherwise.
// No power buttons — pure movement + automatic pickups/catches.

interface Crate { x: number; z: number; hw: number; hd: number; }
interface Box { x: number; z: number; kind: 'shoes' | 'freeze' | 'sling'; group: THREE.Group; }
interface Bolt { x: number; z: number; vx: number; vz: number; group: THREE.Group; life: number; }

const GUARD_SPEED = 1.26; // guard's flat speed advantage
const SHOES_SPEED = 1.55; // escaper speed while shod (beats the guard)
const CATCH_R = HITBOX_RADIUS * 2 + 2.5; // stick reach

export class ChaseGame implements GameModule {
  readonly stickMode = 'float' as const;
  title = 'The Great Escape';
  objective = 'Escape the guard!';

  private ctx!: MatchContext;
  private guardIdx = 0;
  private timeLeft = 55;
  private finished = false;
  private crates: Crate[] = [];
  private boxes: Box[] = [];
  private bolts: Bolt[] = [];
  private boxT = 3;
  private caughtOrder = 0;
  private guardSlowT = 0;
  private startGrace = 1.6;

  init(ctx: MatchContext) {
    this.ctx = ctx;
    this.title = ctx.game.name;
    this.finished = false;
    this.timeLeft = matchTime(55);
    this.crates = [];
    this.boxes = [];
    this.bolts = [];
    this.boxT = 3;
    this.caughtOrder = 0;
    this.guardSlowT = 0;
    this.startGrace = 1.6;

    setupRoster(ctx, '', 0.7);
    this.guardIdx = Math.floor(Math.random() * ctx.players.length);
    this.buildCrates();

    // Guard in the centre, escapers pushed to the four corners (far away).
    const H = ctx.halfSize;
    ctx.players.forEach((p, i) => {
      p.invulnT = 0;
      if (i === this.guardIdx) { p.x = 0; p.z = 0; }
      else {
        const a = (i / ctx.players.length) * Math.PI * 2 + Math.PI / 4;
        p.x = Math.cos(a) * H * 0.8;
        p.z = Math.sin(a) * H * 0.8;
      }
      p.vx = 0; p.vz = 0;
      setScore(p, i === this.guardIdx ? '🥢 GUARD' : '🏃');
    });
    this.attachStick();

    const youGuard = this.guardIdx === 0;
    this.objective = youGuard ? '🥢 You are the GUARD — catch all 3!' : '🏃 RUN! Escape the guard!';
    setObjective(this.objective);
    ctx.fx.banner(youGuard ? 'YOU ARE THE GUARD! 🥢' : 'RUN! 🏃', youGuard ? '#FF4D4D' : '#7ED321');
  }

  private guard(): Player { return this.ctx.players[this.guardIdx]; }
  private escapers(): Player[] { return this.ctx.players.filter((p) => p.index !== this.guardIdx); }
  private aliveEscapers(): Player[] { return this.escapers().filter((p) => !p.dead); }

  // --- build -----------------------------------------------------------------
  private buildCrates() {
    const H = this.ctx.halfSize;
    const mat = new THREE.MeshStandardMaterial({ color: 0xb9762f, roughness: 0.85, emissive: 0x2a1608 });
    const add = (x: number, z: number, s = 2.4) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(s * 2, 5, s * 2), mat);
      m.position.set(x, 2.5, z);
      m.castShadow = true;
      m.receiveShadow = true;
      this.ctx.scene.add(m);
      this.crates.push({ x, z, hw: s, hd: s });
    };
    // Four crates along each edge (inset from the wall).
    const inset = H - 6;
    const spots = [-H * 0.6, -H * 0.2, H * 0.2, H * 0.6];
    for (const s of spots) { add(s, -inset); add(s, inset); add(-inset, s); add(inset, s); }
    // A few interior obstacles to break up the middle (like the yard's tyres).
    add(0, 0, 3); add(-H * 0.34, -H * 0.3); add(H * 0.34, H * 0.3); add(H * 0.32, -H * 0.34); add(-H * 0.32, H * 0.34);
  }

  private attachStick() {
    const g = new THREE.Group();
    const shaft = new THREE.Mesh(
      new THREE.CylinderGeometry(0.28, 0.28, 6.5, 8),
      new THREE.MeshStandardMaterial({ color: 0x8a5a2e, roughness: 0.8, emissive: 0x1a0e04 }),
    );
    shaft.rotation.z = Math.PI / 2.4;
    shaft.position.set(2.2, 3.4, 0);
    g.add(shaft);
    this.guard().group.add(g);
    this.guard().setStatusIcon('🥢 GUARD', 9999);
  }

  // --- tick ------------------------------------------------------------------
  ability() {}

  tick(dt: number, elapsed: number) {
    if (this.finished) return;
    const ctx = this.ctx;
    this.timeLeft -= dt;
    ctx.setClock(this.timeLeft);
    this.startGrace = Math.max(0, this.startGrace - dt);
    this.guardSlowT = Math.max(0, this.guardSlowT - dt);

    const guard = this.guard();

    // --- movement (guard faster; shoes beat the guard; freeze/slow stop him) --
    if (this.guardIdx === 0) this.moveLocal(guard, dt);
    else this.moveBotGuard(guard, dt);
    for (const p of this.escapers()) {
      if (p.dead) continue;
      if (p.index === 0) this.moveLocal(p, dt);
      else this.moveBotEscaper(p, dt);
    }

    // --- crate + wall collision ----------------------------------------------
    for (const p of ctx.players) if (!p.dead) { this.resolveCrates(p); this.clampWalls(p); }

    // --- catches --------------------------------------------------------------
    if (this.startGrace <= 0 && guard.freezeT <= 0) {
      for (const p of this.aliveEscapers()) {
        if (Math.hypot(p.x - guard.x, p.z - guard.z) < CATCH_R) this.catchEscaper(p);
      }
    }

    // --- pickups + bolts ------------------------------------------------------
    this.boxT -= dt;
    if (this.boxT <= 0 && this.boxes.length < 3) { this.boxT = 5; this.spawnBox(); }
    for (const b of this.boxes) b.group.rotation.y += dt * 2;
    this.checkPickups();
    this.tickBolts(dt);

    tickRoster(ctx, dt, elapsed);

    // --- win / lose -----------------------------------------------------------
    if (this.aliveEscapers().length === 0) this.doFinish(true);
    else if (this.timeLeft <= 0) this.doFinish(false);
  }

  private speedMul(p: Player): number {
    if (p.index === this.guardIdx) return GUARD_SPEED * (this.guardSlowT > 0 ? 0.5 : 1);
    return p.shoesT > 0 ? SHOES_SPEED : 1;
  }

  private moveLocal(p: Player, dt: number) {
    if (p.freezeT > 0) return;
    localMove(this.ctx, dt, { noClamp: true, speedMul: this.speedMul(p) });
  }

  private moveBotGuard(p: Player, dt: number) {
    if (p.freezeT > 0) return;
    p.retarget -= dt;
    const prey = this.aliveEscapers();
    if (!prey.length) return;
    if (p.retarget <= 0) {
      p.retarget = 0.2;
      // Chase the nearest escaper, aiming slightly ahead of them.
      let t = prey[0], best = Infinity;
      for (const q of prey) { const d = Math.hypot(q.x - p.x, q.z - p.z); if (d < best) { best = d; t = q; } }
      p.tx = t.x + t.vx * 0.25;
      p.tz = t.z + t.vz * 0.25;
    }
    botMove(this.ctx, p, p.tx, p.tz, dt, { noClamp: true, speedMul: this.speedMul(p) });
  }

  private moveBotEscaper(p: Player, dt: number) {
    if (p.freezeT > 0) return;
    const guard = this.guard();
    p.retarget -= dt;
    if (p.retarget <= 0) {
      p.retarget = 0.25 + Math.random() * 0.2;
      const gd = Math.hypot(guard.x - p.x, guard.z - p.z);
      const box = this.nearestBox(p);
      // Grab a nearby pickup when the guard isn't breathing down your neck.
      if (box && gd > 14 && Math.hypot(box.x - p.x, box.z - p.z) < 22) {
        p.tx = box.x; p.tz = box.z;
      } else {
        // Flee directly away from the guard, biased along the walls.
        const ax = p.x - guard.x, az = p.z - guard.z;
        const L = Math.hypot(ax, az) || 1;
        p.tx = p.x + (ax / L) * 30 + (Math.random() - 0.5) * 12;
        p.tz = p.z + (az / L) * 30 + (Math.random() - 0.5) * 12;
      }
    }
    botMove(this.ctx, p, p.tx, p.tz, dt, { noClamp: true, speedMul: this.speedMul(p) });
  }

  private catchEscaper(p: Player) {
    p.dead = true;
    (p as any)._outAt = ++this.caughtOrder;
    markDead(p);
    SFX.hit();
    this.ctx.fx.burst(p.x, p.z, p.hero.col, 20);
    this.ctx.fx.shake(2);
    this.ctx.fx.banner(p.you ? 'YOU GOT CAUGHT!' : `${p.hero.name} caught!`, '#FF4D4D');
    setObjective(`Escapers left: ${this.aliveEscapers().length}`);
    this.startGrace = 0.6; // brief beat before the next can be tagged
  }

  // --- crates / walls --------------------------------------------------------
  private resolveCrates(p: Player) {
    for (const c of this.crates) {
      const dx = p.x - c.x, dz = p.z - c.z;
      const clampX = Math.max(-c.hw, Math.min(c.hw, dx));
      const clampZ = Math.max(-c.hd, Math.min(c.hd, dz));
      const nx = c.x + clampX, nz = c.z + clampZ;
      let ox = p.x - nx, oz = p.z - nz;
      let d = Math.hypot(ox, oz);
      if (d >= HITBOX_RADIUS) continue;
      if (d < 0.0001) {
        // Centre is inside the box — pop out along the smallest penetration.
        const px = c.hw - Math.abs(dx), pz = c.hd - Math.abs(dz);
        if (px < pz) { ox = Math.sign(dx) || 1; oz = 0; d = 1; }
        else { ox = 0; oz = Math.sign(dz) || 1; d = 1; }
      }
      const push = HITBOX_RADIUS - d;
      const ux = ox / d, uz = oz / d;
      p.x += ux * push; p.z += uz * push;
      const into = p.vx * ux + p.vz * uz;
      if (into < 0) { p.vx -= into * ux; p.vz -= into * uz; }
    }
  }

  private clampWalls(p: Player) {
    const H = this.ctx.halfSize - HITBOX_RADIUS;
    if (p.x < -H) { p.x = -H; if (p.vx < 0) p.vx = 0; }
    if (p.x > H) { p.x = H; if (p.vx > 0) p.vx = 0; }
    if (p.z < -H) { p.z = -H; if (p.vz < 0) p.vz = 0; }
    if (p.z > H) { p.z = H; if (p.vz > 0) p.vz = 0; }
  }

  // --- pickups ---------------------------------------------------------------
  private openSpot(): { x: number; z: number } {
    const H = this.ctx.halfSize - 4;
    for (let tries = 0; tries < 30; tries++) {
      const x = (Math.random() - 0.5) * 2 * H;
      const z = (Math.random() - 0.5) * 2 * H;
      if (this.crates.every((c) => Math.abs(x - c.x) > c.hw + 2.5 || Math.abs(z - c.z) > c.hd + 2.5)) return { x, z };
    }
    return { x: 0, z: 0 };
  }

  private spawnBox() {
    const kinds: Box['kind'][] = ['shoes', 'freeze', 'sling'];
    const kind = kinds[Math.floor(Math.random() * kinds.length)];
    const { x, z } = this.openSpot();
    const col = kind === 'shoes' ? 0x7ed321 : kind === 'freeze' ? 0x4da6ff : 0xff3d9e;
    const group = new THREE.Group();
    const cube = new THREE.Mesh(
      new THREE.BoxGeometry(2.2, 2.2, 2.2),
      new THREE.MeshStandardMaterial({ color: col, emissive: col, emissiveIntensity: 0.55, roughness: 0.4, metalness: 0.3 }),
    );
    cube.position.y = 2.2;
    group.add(cube);
    group.position.set(x, 0, z);
    this.ctx.scene.add(group);
    this.boxes.push({ x, z, kind, group });
  }

  private nearestBox(p: Player): Box | null {
    let best: Box | null = null, bd = Infinity;
    for (const b of this.boxes) { const d = Math.hypot(b.x - p.x, b.z - p.z); if (d < bd) { bd = d; best = b; } }
    return best;
  }

  private checkPickups() {
    for (let i = this.boxes.length - 1; i >= 0; i--) {
      const b = this.boxes[i];
      // Only ESCAPERS benefit — the guard walks over boxes.
      const taker = this.aliveEscapers().find((p) => Math.hypot(p.x - b.x, p.z - b.z) < HITBOX_RADIUS + 1.5);
      if (!taker) continue;
      this.ctx.scene.remove(b.group);
      this.boxes.splice(i, 1);
      if (b.kind === 'shoes') {
        taker.shoesT = Math.max(taker.shoesT, 5);
        this.ctx.fx.banner(taker.you ? '👟 SPEED!' : '', '#7ED321');
      } else if (b.kind === 'freeze') {
        const g = this.guard();
        g.freezeT = Math.max(g.freezeT, 2);
        g.zapped = true;
        SFX.zap();
        this.ctx.fx.burst(g.x, g.z, '#4DA6FF', 14);
        this.ctx.fx.banner(taker.you ? '❄️ GUARD FROZEN!' : '', '#4DA6FF');
      } else {
        this.fireBolt(taker);
        this.ctx.fx.banner(taker.you ? '🎯 SLINGSHOT!' : '', '#FF3D9E');
      }
      SFX.power();
    }
  }

  // --- slingshot bolt (homes on the guard, slows him 4s) ---------------------
  private fireBolt(from: Player) {
    const g = this.guard();
    const dx = g.x - from.x, dz = g.z - from.z, L = Math.hypot(dx, dz) || 1;
    const group = new THREE.Group();
    const m = new THREE.Mesh(
      new THREE.SphereGeometry(0.9, 10, 10),
      new THREE.MeshStandardMaterial({ color: 0xff3d9e, emissive: 0xff3d9e, emissiveIntensity: 0.8 }),
    );
    m.position.y = 3;
    group.add(m);
    group.position.set(from.x, 0, from.z);
    this.ctx.scene.add(group);
    this.bolts.push({ x: from.x, z: from.z, vx: (dx / L) * 46, vz: (dz / L) * 46, group, life: 2.5 });
  }

  private tickBolts(dt: number) {
    const g = this.guard();
    for (let i = this.bolts.length - 1; i >= 0; i--) {
      const b = this.bolts[i];
      b.life -= dt;
      // Gentle homing so it reliably connects.
      const dx = g.x - b.x, dz = g.z - b.z, L = Math.hypot(dx, dz) || 1;
      b.vx += (dx / L) * 90 * dt; b.vz += (dz / L) * 90 * dt;
      const sp = Math.hypot(b.vx, b.vz) || 1; const cap = 52;
      if (sp > cap) { b.vx = (b.vx / sp) * cap; b.vz = (b.vz / sp) * cap; }
      b.x += b.vx * dt; b.z += b.vz * dt;
      b.group.position.set(b.x, 0, b.z);
      if (L < HITBOX_RADIUS + 1.2) {
        this.guardSlowT = Math.max(this.guardSlowT, 4);
        SFX.hit();
        this.ctx.fx.burst(g.x, g.z, '#FF3D9E', 14);
        if (g.you) this.ctx.fx.banner('SLOWED!', '#FF3D9E');
        this.ctx.scene.remove(b.group);
        this.bolts.splice(i, 1);
      } else if (b.life <= 0) {
        this.ctx.scene.remove(b.group);
        this.bolts.splice(i, 1);
      }
    }
  }

  private doFinish(guardCaughtAll: boolean) {
    if (this.finished) return;
    this.finished = true;
    for (const b of this.boxes) this.ctx.scene.remove(b.group);
    for (const b of this.bolts) this.ctx.scene.remove(b.group);
    const ctx = this.ctx;
    ctx.players.forEach((p) => {
      if (p.index === this.guardIdx) (p as any)._res = guardCaughtAll ? '🥢 CAUGHT ALL' : 'GUARD';
      else (p as any)._res = p.dead ? 'CAUGHT' : '🏃 ESCAPED';
    });
    const subtitle = guardCaughtAll ? 'The guard caught everyone!' : 'The escape team survived!';
    ctx.finish(rankBy(ctx, (p) => {
      if (p.index === this.guardIdx) return guardCaughtAll ? 1e6 : -1;
      if (!p.dead) return 1e5; // survived
      return (p as any)._outAt ?? 0; // caught later ranks higher
    }), subtitle);
  }
}
