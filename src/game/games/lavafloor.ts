import * as THREE from 'three';
import type { GameModule, MatchContext } from '../context';
import type { Player } from '../player';
import { setupRoster, localMove, botMove, collidePlayers, tickRoster, rankBy } from '../freeroam';
import { tryJump } from '../physics';
import { matchTime } from '../../core/tuning';
import { SFX } from '../../core/audio';
import { markDead } from '../../ui/hud';

// FLOOR IS LAVA (Inferno). A grid of stone tiles floats over a REAL lava pool.
// Step on a tile and it drops into the lava 1 second later, leaving a gap. Keep
// moving to fresh tiles; JUMP and DOUBLE-JUMP (a forward leap of ~2 tiles) to
// clear the growing gaps. Fall in the lava and you're out — last one standing
// wins. Speed pickups appear on the tiles at random (max 2 out at once).

const N = 9;                 // grid size
const BREAK_TIME = 1.0;      // tile drops 1s after it's stepped on
const LEAP_TIME = 0.42;      // double-jump forward-leap duration
const TILE_TOP = 0;          // tile surface height

type TState = 'solid' | 'breaking' | 'gone';
interface Tile { m: THREE.Mesh; gx: number; gy: number; x: number; z: number; state: TState; t: number; fallY: number; }
interface Pickup { x: number; z: number; group: THREE.Group; tile: Tile; }

export class LavaFloorGame implements GameModule {
  readonly stickMode = 'float' as const;
  title = 'Floor Is Lava';
  objective = '🌋 The floor is lava! Jump across — last one out wins!';

  private ctx!: MatchContext;
  private tiles: Tile[] = [];
  private step = 6;
  private timeLeft = 75;
  private finished = false;
  private outCount = 0;
  private startGrace = 1.6;

  private leapT: number[] = [];
  private leapX: number[] = [];
  private leapZ: number[] = [];
  private overGapT: number[] = [];

  private lava!: THREE.Mesh;
  private lavaTex!: THREE.CanvasTexture;
  private pickups: Pickup[] = [];
  private pickupT = 5;

  init(ctx: MatchContext) {
    this.ctx = ctx;
    this.title = ctx.game.name;
    this.finished = false;
    this.timeLeft = matchTime(75);
    this.outCount = 0;
    this.startGrace = 2.6;
    const half = ctx.halfSize;
    this.step = (half * 2) / N;

    ctx.world.floorMesh.visible = false; // our tiles + lava are the ground
    this.buildLava();
    this.buildTiles();

    setupRoster(ctx, 'IN', 0.58); // spread to the four quadrants, not clustered
    // Land everyone centred on a solid tile.
    ctx.players.forEach((p) => {
      p.y = 0; p.vy = 0; p.grounded = true;
      const t = this.tileAt(p.x, p.z);
      if (t) { p.x = t.x; p.z = t.z; p.tx = t.x; p.tz = t.z; }
    });
    this.leapT = ctx.players.map(() => 0);
    this.leapX = ctx.players.map(() => 0);
    this.leapZ = ctx.players.map(() => 0);
    this.overGapT = ctx.players.map(() => 0);
    this.pickups = [];
    this.pickupT = 5;

    ctx.fx.banner('THE FLOOR IS LAVA! 🌋', '#ff7a2e');
  }

  // --- build ------------------------------------------------------------------
  private buildLava() {
    const scene = this.ctx.scene;
    const half = this.ctx.halfSize;
    this.lavaTex = this.makeLavaTexture();
    this.lavaTex.wrapS = this.lavaTex.wrapT = THREE.RepeatWrapping;
    this.lavaTex.repeat.set(3, 3);
    this.lava = new THREE.Mesh(
      new THREE.PlaneGeometry(half * 3, half * 3),
      new THREE.MeshStandardMaterial({ map: this.lavaTex, emissiveMap: this.lavaTex, emissive: 0xff5a1e, emissiveIntensity: 2.2, roughness: 0.6 }),
    );
    this.lava.rotation.x = -Math.PI / 2;
    this.lava.position.y = -1.5; // just under the tiles so it glows through every gap
    scene.add(this.lava);
    // A warm glow rising off the lava.
    const glow = new THREE.PointLight(0xff7a2e, 3, half * 4, 0.4);
    glow.position.set(0, 2, 0);
    scene.add(glow);
  }

  private makeLavaTexture(): THREE.CanvasTexture {
    const c = document.createElement('canvas'); c.width = c.height = 256;
    const x = c.getContext('2d')!;
    x.fillStyle = '#ff8a1e'; x.fillRect(0, 0, 256, 256);
    // Bright molten veins + darker crust cells.
    for (let i = 0; i < 60; i++) {
      const px = Math.random() * 256, py = Math.random() * 256, r = 8 + Math.random() * 30;
      const g = x.createRadialGradient(px, py, 0, px, py, r);
      const hot = Math.random() < 0.5;
      g.addColorStop(0, hot ? '#ffe86a' : '#7a1a06');
      g.addColorStop(1, 'rgba(255,138,30,0)');
      x.fillStyle = g; x.beginPath(); x.arc(px, py, r, 0, Math.PI * 2); x.fill();
    }
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  private buildTiles() {
    const scene = this.ctx.scene, half = this.ctx.halfSize;
    this.tiles = [];
    const geo = new THREE.BoxGeometry(this.step * 0.92, 1.4, this.step * 0.92);
    for (let gy = 0; gy < N; gy++) {
      for (let gx = 0; gx < N; gx++) {
        const shade = (gx + gy) % 2;
        const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
          color: shade ? 0x8c7a63 : 0x9c8a72, roughness: 0.95, emissive: 0x3a1c08, emissiveIntensity: 0.15,
        }));
        const x = -half + this.step * (gx + 0.5);
        const z = -half + this.step * (gy + 0.5);
        m.position.set(x, TILE_TOP - 0.7, z);
        m.castShadow = true; m.receiveShadow = true;
        scene.add(m);
        this.tiles.push({ m, gx, gy, x, z, state: 'solid', t: 0, fallY: 0 });
      }
    }
  }

  private tileAt(x: number, z: number): Tile | null {
    const half = this.ctx.halfSize;
    const gx = Math.floor((x + half) / this.step);
    const gy = Math.floor((z + half) / this.step);
    if (gx < 0 || gy < 0 || gx >= N || gy >= N) return null;
    return this.tiles[gy * N + gx];
  }

  // --- input ------------------------------------------------------------------
  ability() { this.doJump(this.ctx.players[0]); }
  jump() { this.doJump(this.ctx.players[0]); }

  private doJump(p: Player) {
    if (p.dead) return;
    if (p.grounded) {
      tryJump(p); // normal hop
      SFX.tick();
    } else if (p.airJumps > 0) {
      // Double jump = a committed forward LEAP of ~2 tiles.
      p.airJumps--;
      p.vy = 17;
      const dir = Math.hypot(p.face.x, p.face.z) > 0.1 ? p.face : { x: 0, z: -1 };
      this.leapT[p.index] = LEAP_TIME;
      this.leapX[p.index] = dir.x * (this.step * 2) / LEAP_TIME;
      this.leapZ[p.index] = dir.z * (this.step * 2) / LEAP_TIME;
      SFX.power();
      this.ctx.fx.burst(p.x, p.z, '#ffd23f', 6);
    }
  }

  // --- tick -------------------------------------------------------------------
  tick(dt: number, elapsed: number) {
    if (this.finished) return;
    const ctx = this.ctx;
    this.timeLeft -= dt;
    ctx.setClock(this.timeLeft);
    this.startGrace = Math.max(0, this.startGrace - dt);

    // Animate the lava (flowing + pulsing glow).
    this.lavaTex.offset.x += dt * 0.03;
    this.lavaTex.offset.y += dt * 0.02;
    (this.lava.material as THREE.MeshStandardMaterial).emissiveIntensity = 1.4 + Math.sin(elapsed * 2) * 0.35;

    // Movement.
    localMove(ctx, dt);
    for (const p of ctx.players.slice(1)) {
      if (p.dead) continue;
      this.moveBot(p, dt);
    }
    // Apply active double-jump leaps (bypasses the normal speed cap).
    for (const p of ctx.players) {
      if (p.dead || this.leapT[p.index] <= 0) continue;
      this.leapT[p.index] -= dt;
      p.x += this.leapX[p.index] * dt;
      p.z += this.leapZ[p.index] * dt;
    }
    collidePlayers(ctx);
    this.clampArena();

    this.tickTiles(dt);
    this.tickPickups(dt);
    this.checkFalls(dt);
    tickRoster(ctx, dt, elapsed);

    const alive = ctx.players.filter((p) => !p.dead);
    if (alive.length <= 1 || this.timeLeft <= 0) this.doFinish();
  }

  private clampArena() {
    const H = this.ctx.halfSize - 0.5;
    for (const p of this.ctx.players) {
      if (p.dead) continue;
      p.x = Math.max(-H, Math.min(H, p.x));
      p.z = Math.max(-H, Math.min(H, p.z));
    }
  }

  private solidNeighbors(t: Tile): number {
    let n = 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const gx = t.gx + dx, gy = t.gy + dy;
      if (gx < 0 || gy < 0 || gx >= N || gy >= N) continue;
      if (this.tiles[gy * N + gx].state === 'solid') n++;
    }
    return n;
  }

  private moveBot(p: Player, dt: number) {
    const cur = this.tileAt(p.x, p.z);
    const curBad = !cur || cur.state !== 'solid';
    const reached = Math.hypot(p.tx - p.x, p.tz - p.z) < this.step * 0.35;
    p.retarget -= dt;
    // Re-pick when the timer lapses, we've arrived, or we're on a crumbling tile.
    if (p.retarget <= 0 || reached || curBad) {
      p.retarget = 0.25 + Math.random() * 0.2;
      let best: Tile | null = null, bs = -Infinity;
      for (const t of this.tiles) {
        if (t.state !== 'solid' || t === cur) continue;
        const d = Math.hypot(t.x - p.x, t.z - p.z);
        if (d > this.step * 1.9 || d < this.step * 0.5) continue; // one confident step away
        const s = this.solidNeighbors(t) * 1.2         // prefer tiles with escape routes
          + (1 - Math.hypot(t.x, t.z) / (this.ctx.halfSize * 1.7)) * 0.6 // slight centre bias
          - d / this.step + Math.random() * 0.5;
        if (s > bs) { bs = s; best = t; }
      }
      if (best) { p.tx = best.x; p.tz = best.z; }
    }
    botMove(this.ctx, p, p.tx, p.tz, dt);
    // Hop to clear a wide gap toward the target.
    if (p.grounded && Math.hypot(p.tx - p.x, p.tz - p.z) > this.step * 1.4 && Math.random() < dt * 4) this.doJump(p);
  }

  private tickTiles(dt: number) {
    // Stepping on a solid tile starts its 1s break timer.
    for (const p of this.ctx.players) {
      if (p.dead || p.y > 0.4) continue; // only while grounded
      const t = this.tileAt(p.x, p.z);
      if (t && t.state === 'solid') { t.state = 'breaking'; t.t = BREAK_TIME; SFX.crack(); }
    }
    for (const t of this.tiles) {
      if (t.state === 'breaking') {
        t.t -= dt;
        t.m.position.y = (TILE_TOP - 0.7) + Math.sin(t.t * 45) * 0.14; // shake
        const mat = t.m.material as THREE.MeshStandardMaterial;
        mat.emissiveIntensity = 0.6; mat.emissive.setHex(0xff5a1e);
        if (t.t <= 0) { t.state = 'gone'; t.fallY = 0; }
      } else if (t.state === 'gone' && t.m.visible) {
        t.fallY += dt * 26;
        t.m.position.y = (TILE_TOP - 0.7) - t.fallY;
        if (t.fallY > 6) t.m.visible = false;
      }
    }
  }

  // --- pickups ----------------------------------------------------------------
  private tickPickups(dt: number) {
    this.pickupT -= dt;
    if (this.pickupT <= 0 && this.pickups.length < 2) { this.pickupT = 6 + Math.random() * 6; this.spawnPickup(); }
    for (const pk of this.pickups) pk.group.rotation.y += dt * 2;
    // Drop pickups whose tile fell.
    for (let i = this.pickups.length - 1; i >= 0; i--) {
      const pk = this.pickups[i];
      if (pk.tile.state === 'gone') { this.ctx.scene.remove(pk.group); this.pickups.splice(i, 1); continue; }
      const taker = this.ctx.players.find((p) => !p.dead && Math.hypot(p.x - pk.x, p.z - pk.z) < 2.4);
      if (taker) {
        taker.speedT = Math.max(taker.speedT, 4);
        this.ctx.scene.remove(pk.group); this.pickups.splice(i, 1);
        SFX.power(); this.ctx.fx.burst(pk.x, pk.z, '#2fe04a', 10);
        if (taker.you) this.ctx.fx.banner('👟 SPEED!', '#2fe04a');
      }
    }
  }

  private spawnPickup() {
    const solid = this.tiles.filter((t) => t.state === 'solid');
    if (!solid.length) return;
    const t = solid[Math.floor(Math.random() * solid.length)];
    const group = new THREE.Group();
    for (let i = 0; i < 2; i++) {
      const c = new THREE.Mesh(new THREE.ConeGeometry(0.8, 1.1, 4),
        new THREE.MeshStandardMaterial({ color: 0x2fe04a, emissive: 0x0d5a1a, emissiveIntensity: 0.7, roughness: 0.4 }));
      c.rotation.x = -Math.PI / 2; c.position.set(0, 2.2, -0.5 + i * 1.0); group.add(c);
    }
    const ring = new THREE.Mesh(new THREE.RingGeometry(1.4, 2.0, 20),
      new THREE.MeshBasicMaterial({ color: 0x2fe04a, transparent: true, opacity: 0.5, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2; ring.position.y = 0.3; group.add(ring);
    group.position.set(t.x, 0, t.z);
    this.ctx.scene.add(group);
    this.pickups.push({ x: t.x, z: t.z, group, tile: t });
  }

  // --- falls ------------------------------------------------------------------
  private checkFalls(dt: number) {
    for (const p of this.ctx.players) {
      if (p.dead) continue;
      const t = this.tileAt(p.x, p.z);
      const safe = this.startGrace > 0 || p.invulnT > 0 || p.y > 0.35 || this.leapT[p.index] > 0 || (t && t.state !== 'gone');
      if (safe) { this.overGapT[p.index] = 0; continue; }
      // Over the lava — a short coyote-time before you actually drop in.
      this.overGapT[p.index] += dt;
      if (this.overGapT[p.index] < 0.3) continue;
      // Into the lava.
      p.dead = true;
      (p as any)._outAt = ++this.outCount;
      markDead(p);
      SFX.fall(); SFX.out();
      this.ctx.fx.burst(p.x, p.z, '#ff7a2e', 22);
      this.ctx.fx.shake(2.2);
      this.ctx.fx.banner(p.you ? 'YOU FELL IN! 🔥' : `${p.hero.name} melted!`, '#ff4d1e');
    }
  }

  private doFinish() {
    if (this.finished) return;
    this.finished = true;
    for (const pk of this.pickups) this.ctx.scene.remove(pk.group);
    const ctx = this.ctx;
    ctx.players.forEach((p) => ((p as any)._res = p.dead ? 'MELTED' : '🌋 SURVIVED'));
    ctx.finish(rankBy(ctx, (p) => (p.dead ? ((p as any)._outAt ?? 0) : 1e6)), 'Last one out of the lava wins!');
  }
}
