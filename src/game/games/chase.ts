import * as THREE from 'three';
import type { GameModule, MatchContext } from '../context';
import type { Player } from '../player';
import { HITBOX_RADIUS } from '../player';
import { setupRoster, localMove, botMove, tickRoster, rankBy } from '../freeroam';
import { matchTime } from '../../core/tuning';
import { SFX } from '../../core/audio';
import { markDead, setScore, setObjective } from '../../ui/hud';

// THE GREAT ESCAPE (Dune Clash). Top-down chase: 3 players are the ESCAPE TEAM,
// 1 random player is the GUARD (faster, carries a stick). Touch = caught/out.
// The guard navigates the walled maze with a waypoint graph (string-pulled
// shortest path) so it actually hunts you down instead of grinding on walls.
// Escapers grab pickups that let them SABOTAGE each other (it's every runner
// for themselves — outlast the others): SHOES (speed burst for yourself),
// FREEZE (freeze the nearest rival in place → guard bait), and a STUN BOLT
// (homing shot that stuns + knocks the nearest rival). With no rival left they
// fall back onto the guard. Guard wins by catching all 3 before time; any
// survivor wins otherwise. No power buttons — pure movement + auto pickups.

interface Crate { x: number; z: number; hw: number; hd: number; }
interface Box { x: number; z: number; kind: 'shoes' | 'freeze' | 'sling'; group: THREE.Group; }
interface Bolt { x: number; z: number; vx: number; vz: number; group: THREE.Group; life: number; target: Player; }
interface NavNode { x: number; z: number; }

const GUARD_SPEED = 1.4; // guard's flat speed advantage — reels runners in
const SHOES_SPEED = 1.62; // escaper speed while shod (still beats the guard)
const CATCH_R = HITBOX_RADIUS * 2 + 3.2; // stick reach

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
  private nav: NavNode[] = [];
  private navEdges: number[][] = [];

  init(ctx: MatchContext) {
    this.ctx = ctx;
    this.title = ctx.game.name;
    this.finished = false;
    this.timeLeft = matchTime(55);
    this.crates = [];
    this.boxes = [];
    this.bolts = [];
    this.boxT = 2 + Math.random() * 3;
    this.caughtOrder = 0;
    this.guardSlowT = 0;
    this.startGrace = 1.6;
    this.guardTarget = null;
    this.guardTargetT = 0;

    setupRoster(ctx, '', 0.7);
    this.guardIdx = Math.floor(Math.random() * ctx.players.length);
    this.buildCrates();
    this.buildNav();

    // Guard starts in the middle room; escapers wait out in the corridor
    // corners, so the guard has to break out through a gap to chase.
    const H = ctx.halfSize;
    // Open corridor corners (no rocks there now) so escapers never spawn stuck.
    const corners = [[H * 0.68, H * 0.68], [-H * 0.68, H * 0.68], [-H * 0.68, -H * 0.68], [H * 0.68, -H * 0.68]];
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
    // Small boulders for LIGHT cover, all in the OPEN middle room (diagonals,
    // clear of the centre and the four entrance lanes). The corridors and
    // corners stay clear so nobody gets trapped.
    const rocks: [number, number, number][] = [
      [8, 8, 1.9], [-8, -8, 1.9], [9, -7, 1.8], [-7, 9, 1.8],
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
    if (this.boxT <= 0 && this.boxes.length < 3) { this.boxT = 3 + Math.random() * 5; this.spawnBox(); } // random timing
    for (const b of this.boxes) b.group.rotation.y += dt * 2;
    this.checkPickups();
    this.tickBolts(dt);

    tickRoster(ctx, dt, elapsed);

    // --- win / lose -----------------------------------------------------------
    if (this.aliveEscapers().length === 0) this.doFinish(true);
    else if (this.timeLeft <= 0) this.doFinish(false);
  }

  private speedMul(p: Player): number {
    if (p.index === this.guardIdx) {
      // The guard SPRINTS to close a big gap, then eases to base speed for the
      // precise tag — so runners get reeled in, but a fresh pair of SHOES still
      // outruns the guard at close range (the escape valve).
      let boost = 1;
      const prey = this.aliveEscapers();
      if (prey.length) {
        let d = Infinity;
        for (const q of prey) d = Math.min(d, Math.hypot(q.x - p.x, q.z - p.z));
        boost = d > 20 ? 1.42 : d > 12 ? 1.2 : 1;
      }
      return GUARD_SPEED * boost * (this.guardSlowT > 0 ? 0.5 : 1);
    }
    return p.shoesT > 0 ? SHOES_SPEED : 1;
  }

  private moveLocal(p: Player, dt: number) {
    if (p.freezeT > 0) return;
    localMove(this.ctx, dt, { noClamp: true, speedMul: this.speedMul(p) });
  }

  // --- guard bot: hunts the nearest escaper through the maze ------------------
  private guardTarget: Player | null = null;
  private guardTargetT = 0;
  private moveBotGuard(p: Player, dt: number) {
    if (p.freezeT > 0) return;
    p.retarget -= dt;
    this.guardTargetT -= dt;
    const prey = this.aliveEscapers();
    if (!prey.length) return;

    // Pick a prey to commit to. Keep the current one for a dwell period so the
    // guard doesn't dither at a junction flipping between equidistant runners —
    // only switch when it expires, the target dies, or someone is much closer.
    let t = this.guardTarget && !this.guardTarget.dead ? this.guardTarget : null;
    if (!t || this.guardTargetT <= 0) {
      let best = Infinity, pick = prey[0];
      for (const q of prey) { const d = Math.hypot(q.x - p.x, q.z - p.z); if (d < best) { best = d; pick = q; } }
      if (t && t !== pick) {
        const cur = Math.hypot(t.x - p.x, t.z - p.z);
        if (cur > best * 1.6) t = pick; // current one drifted far — swap
      } else t = pick;
      this.guardTargetT = 1.6;
    }
    this.guardTarget = t;

    if (p.retarget <= 0) {
      p.retarget = 0.18;
      // Lead the target (intercept, don't tail) then route around the walls.
      const [nx, nz] = this.navTo(p, t.x + t.vx * 0.5, t.z + t.vz * 0.5);
      p.tx = nx; p.tz = nz;
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
      let tx: number, tz: number;
      // Grab a nearby pickup when the guard isn't breathing down your neck.
      if (box && gd > 14 && Math.hypot(box.x - p.x, box.z - p.z) < 24) {
        tx = box.x; tz = box.z;
      } else {
        // Flee roughly AWAY from the guard (with a little wobble). Natural, not
        // superhuman — so a faster guard can corner you against a wall.
        const ax = p.x - guard.x, az = p.z - guard.z, L = Math.hypot(ax, az) || 1;
        const jitter = (Math.random() - 0.5) * 0.9;
        const dirx = ax / L, dirz = az / L;
        tx = p.x + (dirx * Math.cos(jitter) - dirz * Math.sin(jitter)) * 34;
        tz = p.z + (dirx * Math.sin(jitter) + dirz * Math.cos(jitter)) * 34;
      }
      const [nx, nz] = this.navTo(p, tx, tz);
      p.tx = nx; p.tz = nz;
    }
    botMove(this.ctx, p, p.tx, p.tz, dt, { noClamp: true, speedMul: this.speedMul(p) });
  }

  // --- waypoint navigation ----------------------------------------------------
  // A tiny graph the bots steer along so they route through the entrance gaps
  // instead of grinding on the inner walls. Nodes: middle, the 4 gaps, and the
  // 4 corridor corners; edges connect neighbours with clear line-of-sight.
  private buildNav() {
    const H = this.ctx.halfSize;
    const inner = this.inner;
    const cr = (inner + H) / 2; // radius of the outer corridor ring
    // Every edge below is a straight, axis-aligned line that stays clear of the
    // inner walls: centre↔gaps run along an axis through the room; gaps↔corridor
    // mids run straight out through the opening; corridor mids↔corners run along
    // the outer ring. No edge cuts a wall corner, so the guard never snags.
    this.nav = [
      { x: 0, z: 0 },          // 0  centre
      { x: 0, z: -inner },     // 1  N gap
      { x: 0, z: inner },      // 2  S gap
      { x: inner, z: 0 },      // 3  E gap
      { x: -inner, z: 0 },     // 4  W gap
      { x: 0, z: -cr },        // 5  N corridor mid
      { x: 0, z: cr },         // 6  S corridor mid
      { x: cr, z: 0 },         // 7  E corridor mid
      { x: -cr, z: 0 },        // 8  W corridor mid
      { x: cr, z: -cr },       // 9  NE corner
      { x: -cr, z: -cr },      // 10 NW corner
      { x: cr, z: cr },        // 11 SE corner
      { x: -cr, z: cr },       // 12 SW corner
    ];
    this.navEdges = [
      [1, 2, 3, 4],     // 0  centre → gaps
      [0, 5],           // 1  N gap ↔ centre, N mid
      [0, 6],           // 2  S gap ↔ centre, S mid
      [0, 7],           // 3  E gap ↔ centre, E mid
      [0, 8],           // 4  W gap ↔ centre, W mid
      [1, 9, 10],       // 5  N mid ↔ N gap, NE, NW
      [2, 11, 12],      // 6  S mid ↔ S gap, SE, SW
      [3, 9, 11],       // 7  E mid ↔ E gap, NE, SE
      [4, 10, 12],      // 8  W mid ↔ W gap, NW, SW
      [5, 7],           // 9  NE ↔ N mid, E mid
      [5, 8],           // 10 NW ↔ N mid, W mid
      [6, 7],           // 11 SE ↔ S mid, E mid
      [6, 8],           // 12 SW ↔ S mid, W mid
    ];
  }

  /** True if a straight line from (x0,z0) to (x1,z1) clears every wall/rock. */
  private segClear(x0: number, z0: number, x1: number, z1: number): boolean {
    const dx = x1 - x0, dz = z1 - z0;
    const dist = Math.hypot(dx, dz);
    const steps = Math.max(2, Math.ceil(dist / 1.2));
    const pad = HITBOX_RADIUS + 0.3;
    for (let s = 0; s <= steps; s++) {
      const t = s / steps, x = x0 + dx * t, z = z0 + dz * t;
      for (const c of this.crates) {
        if (Math.abs(x - c.x) < c.hw + pad && Math.abs(z - c.z) < c.hd + pad) return false;
      }
    }
    return true;
  }

  private nearestVisibleNode(x: number, z: number): number {
    let best = -1, bd = Infinity;
    for (let i = 0; i < this.nav.length; i++) {
      const w = this.nav[i], d = Math.hypot(x - w.x, z - w.z);
      if (d < bd && this.segClear(x, z, w.x, w.z)) { bd = d; best = i; }
    }
    if (best < 0) { // nothing visible — snap to the plain nearest as a fallback
      for (let i = 0; i < this.nav.length; i++) {
        const w = this.nav[i], d = Math.hypot(x - w.x, z - w.z);
        if (d < bd) { bd = d; best = i; }
      }
    }
    return best;
  }

  private bfs(a: number, b: number): number[] | null {
    const prev = new Array(this.nav.length).fill(-1);
    const seen = new Array(this.nav.length).fill(false);
    const q = [a]; seen[a] = true;
    while (q.length) {
      const n = q.shift()!;
      if (n === b) break;
      for (const m of this.navEdges[n]) if (!seen[m]) { seen[m] = true; prev[m] = n; q.push(m); }
    }
    if (!seen[b]) return null;
    const path: number[] = []; let cur = b;
    while (cur !== -1) { path.unshift(cur); cur = prev[cur]; }
    return path;
  }

  /** Immediate steering target toward (tx,tz), routed around walls. Uses
   *  string-pulling: aim at the farthest path waypoint still in clear sight. */
  private navTo(p: Player, tx: number, tz: number): [number, number] {
    if (this.segClear(p.x, p.z, tx, tz)) return [tx, tz];
    const start = this.nearestVisibleNode(p.x, p.z);
    const goal = this.nearestVisibleNode(tx, tz);
    if (start < 0 || goal < 0) return [tx, tz];
    if (start === goal) return [this.nav[start].x, this.nav[start].z];
    const path = this.bfs(start, goal);
    if (!path) return [this.nav[start].x, this.nav[start].z];
    // Farthest path node still in clear sight (string-pulling for smoothness)…
    let aim = path[0];
    for (const n of path) if (this.segClear(p.x, p.z, this.nav[n].x, this.nav[n].z)) aim = n;
    // …but once we've basically reached that node, commit to the NEXT hop along
    // the (hand-verified, traversable) graph edge so we don't stall on a node
    // whose successor is hidden behind a wall corner.
    const ai = path.indexOf(aim);
    if (ai < path.length - 1 && Math.hypot(p.x - this.nav[aim].x, p.z - this.nav[aim].z) < 4.5) aim = path[ai + 1];
    return [this.nav[aim].x, this.nav[aim].z];
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
    for (let tries = 0; tries < 40; tries++) {
      const x = (Math.random() - 0.5) * 2 * H;
      const z = (Math.random() - 0.5) * 2 * H;
      const clearOfWalls = this.crates.every((c) => Math.abs(x - c.x) > c.hw + 2.5 || Math.abs(z - c.z) > c.hd + 2.5);
      const clearOfBoxes = this.boxes.every((b) => Math.hypot(x - b.x, z - b.z) > 14); // never right next to another pickup
      if (clearOfWalls && clearOfBoxes) return { x, z };
    }
    return { x: (Math.random() - 0.5) * 2 * H, z: (Math.random() - 0.5) * 2 * H };
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
        // Speed is the only self-buff — outrun the guard for a few seconds.
        taker.shoesT = Math.max(taker.shoesT, 5);
        this.ctx.fx.banner(taker.you ? '👟 SPEED!' : '', '#7ED321');
      } else if (b.kind === 'freeze') {
        // Freeze the nearest RIVAL escaper in place (guard bait). No rival? the
        // guard gets it instead so the pickup is never wasted.
        const victim = this.nearestRival(taker);
        if (victim) {
          victim.freezeT = Math.max(victim.freezeT, victim.index === this.guardIdx ? 2 : 1.8);
          victim.zapped = true;
          SFX.zap();
          this.ctx.fx.burst(victim.x, victim.z, '#4DA6FF', 14);
          const froze = victim.index === this.guardIdx ? 'GUARD FROZEN' : `${victim.hero.name} FROZEN`;
          this.ctx.fx.banner(taker.you ? '❄️ ' + froze + '!' : victim.you ? '❄️ YOU\'RE FROZEN!' : '', '#4DA6FF');
        }
      } else {
        // Stun bolt: homing shot at the nearest rival (or the guard if alone).
        const victim = this.nearestRival(taker);
        if (victim) {
          this.fireBolt(taker, victim);
          this.ctx.fx.banner(taker.you ? '💫 STUN BOLT!' : '', '#FF3D9E');
        }
      }
      SFX.power();
    }
  }

  /** Nearest OTHER alive escaper to attack; if you're the last runner, the
   *  guard becomes the target so freeze/stun still do something. */
  private nearestRival(p: Player): Player | null {
    let best: Player | null = null, bd = Infinity;
    for (const q of this.aliveEscapers()) {
      if (q === p) continue;
      const d = Math.hypot(q.x - p.x, q.z - p.z);
      if (d < bd) { bd = d; best = q; }
    }
    return best ?? this.guard();
  }

  // --- stun bolt (homes on its target: stuns a rival, or slows the guard) -----
  private fireBolt(from: Player, target: Player) {
    const dx = target.x - from.x, dz = target.z - from.z, L = Math.hypot(dx, dz) || 1;
    const group = new THREE.Group();
    const m = new THREE.Mesh(
      new THREE.SphereGeometry(0.9, 10, 10),
      new THREE.MeshStandardMaterial({ color: 0xff3d9e, emissive: 0xff3d9e, emissiveIntensity: 0.8 }),
    );
    m.position.y = 3;
    group.add(m);
    group.position.set(from.x, 0, from.z);
    this.ctx.scene.add(group);
    this.bolts.push({ x: from.x, z: from.z, vx: (dx / L) * 46, vz: (dz / L) * 46, group, life: 2.5, target });
  }

  private tickBolts(dt: number) {
    for (let i = this.bolts.length - 1; i >= 0; i--) {
      const b = this.bolts[i];
      const tg = b.target;
      b.life -= dt;
      // Gentle homing so it reliably connects with whoever it's chasing.
      const dx = tg.x - b.x, dz = tg.z - b.z, L = Math.hypot(dx, dz) || 1;
      b.vx += (dx / L) * 90 * dt; b.vz += (dz / L) * 90 * dt;
      const sp = Math.hypot(b.vx, b.vz) || 1; const cap = 52;
      if (sp > cap) { b.vx = (b.vx / sp) * cap; b.vz = (b.vz / sp) * cap; }
      b.x += b.vx * dt; b.z += b.vz * dt;
      b.group.position.set(b.x, 0, b.z);
      if (!tg.dead && L < HITBOX_RADIUS + 1.2) {
        SFX.hit();
        this.ctx.fx.burst(tg.x, tg.z, '#FF3D9E', 14);
        if (tg.index === this.guardIdx) {
          this.guardSlowT = Math.max(this.guardSlowT, 4);
          if (tg.you) this.ctx.fx.banner('SLOWED!', '#FF3D9E');
        } else {
          // Stun a rival: brief freeze + a shove in the bolt's direction.
          tg.freezeT = Math.max(tg.freezeT, 1.1);
          tg.zapped = true;
          const kl = Math.hypot(b.vx, b.vz) || 1;
          tg.vx += (b.vx / kl) * 9; tg.vz += (b.vz / kl) * 9;
          if (tg.you) this.ctx.fx.banner('💫 STUNNED!', '#FF3D9E');
        }
        this.ctx.scene.remove(b.group);
        this.bolts.splice(i, 1);
      } else if (b.life <= 0 || tg.dead) {
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
