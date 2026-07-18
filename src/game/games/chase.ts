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

// --- pickup item models: each looks like the power it grants ----------------
function makeShoe(): THREE.Group {
  const g = new THREE.Group();
  const white = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6 });
  const green = new THREE.MeshStandardMaterial({ color: 0x2fbf4a, roughness: 0.5, emissive: 0x0d3a12, emissiveIntensity: 0.35 });
  const sole = new THREE.Mesh(new THREE.BoxGeometry(2.7, 0.5, 1.25), white);
  sole.position.y = 0.25; g.add(sole);
  const upper = new THREE.Mesh(new THREE.BoxGeometry(1.8, 1.0, 1.15), green);
  upper.position.set(-0.35, 0.95, 0); g.add(upper);
  const toe = new THREE.Mesh(new THREE.SphereGeometry(0.62, 10, 8), green);
  toe.position.set(0.8, 0.7, 0); toe.scale.set(1.25, 0.9, 0.95); g.add(toe);
  const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.2, 1.2), white);
  stripe.position.set(-0.2, 0.9, 0); stripe.rotation.z = 0.35; g.add(stripe);
  return g;
}
function makeIce(): THREE.Group {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: 0x9fdcff, roughness: 0.1, metalness: 0.15, transparent: true, opacity: 0.88, emissive: 0x2a6aa0, emissiveIntensity: 0.55, flatShading: true });
  const core = new THREE.Mesh(new THREE.OctahedronGeometry(1.4, 0), mat);
  core.scale.y = 1.5; g.add(core);
  for (let i = 0; i < 3; i++) { const s = new THREE.Mesh(new THREE.OctahedronGeometry(0.5, 0), mat); const a = (i / 3) * Math.PI * 2; s.position.set(Math.cos(a) * 1.25, -0.5 + Math.random() * 1.1, Math.sin(a) * 1.25); s.scale.y = 1.4; g.add(s); }
  return g;
}
function makeSling(): THREE.Group {
  const g = new THREE.Group();
  const wood = new THREE.MeshStandardMaterial({ color: 0x8a5a2e, roughness: 0.8 });
  const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.34, 1.7, 7), wood);
  g.add(handle);
  const forkL = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.27, 1.5, 6), wood);
  forkL.position.set(-0.55, 1.25, 0); forkL.rotation.z = 0.55; g.add(forkL);
  const forkR = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.27, 1.5, 6), wood);
  forkR.position.set(0.55, 1.25, 0); forkR.rotation.z = -0.55; g.add(forkR);
  const band = new THREE.Mesh(new THREE.TorusGeometry(0.72, 0.09, 6, 16, Math.PI), new THREE.MeshStandardMaterial({ color: 0xff3d9e, emissive: 0x7a1040, emissiveIntensity: 0.4 }));
  band.position.y = 1.9; band.rotation.x = Math.PI / 2; g.add(band);
  return g;
}

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

    // Guard starts in the middle room; escapers wait out in the corridor
    // corners, so the guard has to break out through a gap to chase.
    const H = ctx.halfSize;
    const corners = [[H * 0.78, H * 0.78], [-H * 0.78, H * 0.78], [-H * 0.78, -H * 0.78], [H * 0.78, -H * 0.78]];
    let ci = 0;
    ctx.players.forEach((p, i) => {
      p.invulnT = 0;
      if (i === this.guardIdx) { p.x = 0; p.z = 0; }
      else { const c = corners[ci++ % 4]; p.x = c[0]; p.z = c[1]; }
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
  // A simple, readable layout instead of random crates: an inner sandstone wall
  // makes a square with an ENTRANCE in the middle of each side. You can run the
  // outer loop, cut through any of the 4 gaps, or roam the middle room. A couple
  // of boulders add cover. Everything here is a solid barrier you can't cross.
  private inner = 0;
  private buildCrates() {
    const H = this.ctx.halfSize;
    const inner = H * 0.5;
    this.inner = inner;
    const gap = 5.5; // half-width of each entrance
    const thick = 1.5; // wall half-thickness
    const height = 4.4;
    const wallMat = new THREE.MeshStandardMaterial({ color: 0xcaa25c, roughness: 1, flatShading: true, emissive: 0x2a1c0a });
    const capMat = new THREE.MeshStandardMaterial({ color: 0xab8148, roughness: 1, flatShading: true });
    const wall = (cx: number, cz: number, hw: number, hd: number) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(hw * 2, height, hd * 2), wallMat);
      m.position.set(cx, height / 2, cz); m.castShadow = true; m.receiveShadow = true;
      this.ctx.scene.add(m);
      const cap = new THREE.Mesh(new THREE.BoxGeometry(hw * 2 + 0.6, 0.7, hd * 2 + 0.6), capMat);
      cap.position.set(cx, height + 0.05, cz); this.ctx.scene.add(cap);
      this.crates.push({ x: cx, z: cz, hw, hd });
    };
    const seg = (inner - gap) / 2; // half-length of each wall segment
    for (const sz of [-inner, inner]) { // north + south walls (gap centred)
      wall(-(gap + seg), sz, seg, thick);
      wall(gap + seg, sz, seg, thick);
    }
    for (const sx of [-inner, inner]) { // east + west walls
      wall(sx, -(gap + seg), thick, seg);
      wall(sx, gap + seg, thick, seg);
    }
    // Boulders: two in the middle room + one per corridor corner, for cover.
    const rocks: [number, number, number][] = [
      [inner * 0.5, -inner * 0.4, 2.6], [-inner * 0.55, inner * 0.45, 2.4],
      [inner * 1.55, inner * 1.55, 2.6], [-inner * 1.55, -inner * 1.55, 2.5],
      [inner * 1.55, -inner * 1.55, 2.4], [-inner * 1.55, inner * 1.55, 2.5],
    ];
    for (const [x, z, s] of rocks) { this.ctx.scene.add(this.makeRock(x, z, s)); this.crates.push({ x, z, hw: s, hd: s }); }
    this.buildDesert();
  }

  private makeRock(x: number, z: number, s: number): THREE.Group {
    const g = new THREE.Group();
    const rock = new THREE.Mesh(
      new THREE.DodecahedronGeometry(s * 1.15, 0),
      new THREE.MeshStandardMaterial({ color: 0xb08050, roughness: 1, flatShading: true, emissive: 0x241206 }),
    );
    rock.position.y = s * 0.7;
    rock.scale.y = 0.9;
    rock.rotation.set(Math.random(), Math.random() * 6, Math.random());
    rock.castShadow = true; rock.receiveShadow = true;
    g.add(rock);
    g.position.set(x, 0, z);
    return g;
  }

  /** Seamless desert around the yard: one big sand floor so the arena and the
   *  surroundings are the SAME ground (no floating platform), then red-rock
   *  mountains, saguaro cacti, low dunes and rocks. */
  private buildDesert() {
    const H = this.ctx.halfSize;
    const scene = this.ctx.scene;

    // One continuous sand floor just under the arena, matching its tone, so the
    // yard reads as part of the desert rather than a slab on a backdrop.
    const sand = new THREE.Mesh(
      new THREE.PlaneGeometry(360, 360),
      new THREE.MeshStandardMaterial({ color: 0xc9a25b, roughness: 1 }),
    );
    sand.rotation.x = -Math.PI / 2;
    sand.position.y = -0.06;
    sand.receiveShadow = true;
    scene.add(sand);

    const mesaMats = [
      new THREE.MeshStandardMaterial({ color: 0xb5651d, roughness: 1, flatShading: true }),
      new THREE.MeshStandardMaterial({ color: 0x9c4f1a, roughness: 1, flatShading: true }),
    ];
    const duneMat = new THREE.MeshStandardMaterial({ color: 0xd7ad64, roughness: 1 });
    const cactusMat = new THREE.MeshStandardMaterial({ color: 0x3f7a34, roughness: 0.9 });

    // Big flat-topped MOUNTAINS/mesas on the far horizon + smaller buttes nearer.
    const butte = (x: number, z: number, rad: number, hgt: number) => {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(rad * 0.78, rad, hgt, 7), mesaMats[0]);
      m.position.set(x, hgt / 2 - 4, z); scene.add(m);
      const top = new THREE.Mesh(new THREE.CylinderGeometry(rad * 0.42, rad * 0.6, hgt * 0.5, 7), mesaMats[1]);
      top.position.set(x, hgt + hgt * 0.25 - 4, z); scene.add(top);
    };
    for (let i = 0; i < 6; i++) { // distant mountains
      const a = (i / 6) * Math.PI * 2 + 0.5;
      butte(Math.cos(a) * H * 2.7, Math.sin(a) * H * 2.7, 20 + Math.random() * 14, 34 + Math.random() * 26);
    }
    for (let i = 0; i < 6; i++) { // nearer buttes
      const a = (i / 6) * Math.PI * 2 + 0.9;
      butte(Math.cos(a) * H * 1.65, Math.sin(a) * H * 1.65, 7 + Math.random() * 5, 10 + Math.random() * 8);
    }

    // Saguaro cacti (trunk + upswept arms) — a whole crowd around the yard.
    const saguaro = (x: number, z: number, sc: number) => {
      const g = new THREE.Group();
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.9 * sc, 1.1 * sc, 10 * sc, 8), cactusMat);
      trunk.position.y = 5 * sc; trunk.castShadow = true; g.add(trunk);
      const arm = (side: number, y: number) => {
        const horiz = new THREE.Mesh(new THREE.CylinderGeometry(0.5 * sc, 0.55 * sc, 2.4 * sc, 7), cactusMat);
        horiz.rotation.z = Math.PI / 2; horiz.position.set(side * 1.5 * sc, y, 0); g.add(horiz);
        const up = new THREE.Mesh(new THREE.CylinderGeometry(0.5 * sc, 0.55 * sc, 3 * sc, 7), cactusMat);
        up.position.set(side * 2.6 * sc, y + 1.5 * sc, 0); g.add(up);
      };
      arm(1, 6 * sc); arm(-1, 7.5 * sc);
      g.position.set(x, 0, z); g.rotation.y = Math.random() * 6;
      scene.add(g);
    };
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2 + 0.1;
      const r = H * (1.14 + Math.random() * 0.55);
      saguaro(Math.cos(a) * r, Math.sin(a) * r, 0.7 + Math.random() * 0.6);
    }

    // Low dunes + scattered rocks over the sand.
    for (let i = 0; i < 14; i++) {
      const a = Math.random() * Math.PI * 2, r = H * (1.25 + Math.random() * 1.1);
      const dune = new THREE.Mesh(new THREE.SphereGeometry(9 + Math.random() * 10, 12, 6), duneMat);
      dune.scale.set(1, 0.14, 1);
      dune.position.set(Math.cos(a) * r, -0.5, Math.sin(a) * r);
      scene.add(dune);
    }
    const rockMat = new THREE.MeshStandardMaterial({ color: 0xa8794c, roughness: 1, flatShading: true });
    for (let i = 0; i < 14; i++) {
      const a = Math.random() * Math.PI * 2, r = H * (1.1 + Math.random() * 0.9);
      const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(1.2 + Math.random() * 2, 0), rockMat);
      rock.position.set(Math.cos(a) * r, 0.4, Math.sin(a) * r);
      scene.add(rock);
    }
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
      const nav = this.routeThroughGap(p, t.x + t.vx * 0.25, t.z + t.vz * 0.25);
      p.tx = nav[0]; p.tz = nav[1];
    }
    botMove(this.ctx, p, p.tx, p.tz, dt, { noClamp: true, speedMul: this.speedMul(p) });
  }

  /** If bot and target are on opposite sides of the inner wall, head to the
   *  nearest entrance gap first so the guard doesn't grind against a wall. */
  private routeThroughGap(p: Player, tx: number, tz: number): [number, number] {
    const inner = this.inner;
    const pIn = Math.abs(p.x) < inner - 1 && Math.abs(p.z) < inner - 1;
    const tIn = Math.abs(tx) < inner - 1 && Math.abs(tz) < inner - 1;
    if (pIn === tIn) return [tx, tz];
    const gaps: [number, number][] = [[0, -inner], [0, inner], [-inner, 0], [inner, 0]];
    let g = gaps[0], bd = Infinity;
    for (const gg of gaps) { const d = Math.hypot(gg[0] - p.x, gg[1] - p.z); if (d < bd) { bd = d; g = gg; } }
    return g;
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
    this.placeBox(kind, x, z);
  }

  private placeBox(kind: Box['kind'], x: number, z: number) {
    // Each pickup looks like what it does — a real running shoe, an ice shard,
    // or a slingshot — so you can tell at a glance what you're grabbing.
    const item = kind === 'shoes' ? makeShoe() : kind === 'freeze' ? makeIce() : makeSling();
    const group = new THREE.Group();
    item.position.y = 2.4;
    group.add(item);
    // A soft coloured glow ring on the ground marks it as a pickup.
    const col = kind === 'shoes' ? 0x7ed321 : kind === 'freeze' ? 0x4da6ff : 0xff3d9e;
    const ring = new THREE.Mesh(new THREE.RingGeometry(1.6, 2.2, 20),
      new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.55, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2; ring.position.y = 0.2;
    group.add(ring);
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
