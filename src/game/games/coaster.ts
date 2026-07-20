import * as THREE from 'three';
import type { GameModule, MatchContext } from '../context';
import { setupRoster, tickRoster, rankBy } from '../freeroam';
import { matchTime } from '../../core/tuning';
import { SFX } from '../../core/audio';
import { setScore } from '../../ui/hud';

// ROLLER RUSH DUO (Sky tier 4). A 2v2 roller-coaster PUMP RACE. You + an AI
// teammate share ONE cart, sitting FACING each other, each working a red lever.
// Mash SPEED UP to pump your lever (0.5m a pump, ~2 pumps/sec) while your mate
// pumps the other — both pumps drive the cart down a long sky-carnival coaster.
// The screen rides with YOUR cart; a mini track up top shows both teams racing.
// Ride BOOST GATES + downhill DROPS for free speed, grab POWER-UPS (turbo /
// shield / magnet), tap SWITCHES for a shortcut, and brace for HAZARDS. First
// cart to 100m wins (~1 minute).

type Item = 'turbo' | 'shield' | 'magnet';
type Ev = { d: number; kind: 'boost' | 'hazard' | 'switch' | Item; done: boolean };

const FINISH_M = 100;
const PUMP_M = 0.5;
const PUMP_CD = 0.5;    // your lever spring-back (max ~2 pumps/s → ~1 m/s)
const TEAM_CD = 0.72;   // AI teammate cadence (~0.7 m/s)

// Coaster centreline control points [x, y (hills), z]. Two parallel rails hang
// off this: yours (left) and the rivals' (right, far to the side / off-screen).
const CTRL: [number, number, number][] = [
  [0, 10, 0], [30, 4, -40], [-22, 18, -84], [26, 6, -128], [-30, 20, -172],
  [12, 8, -214], [40, 22, -256], [-24, 5, -300], [16, 16, -340], [-10, 10, -376], [0, 12, -410],
];
const RAIL_OFF = 32; // lateral gap between the two rails

export class CoasterGame implements GameModule {
  readonly stickMode = 'none' as const;
  title = 'Roller Rush Duo';
  objective = '🎢 Mash SPEED UP — pump to the finish!';

  private ctx!: MatchContext;
  private finished = false;
  private timeLeft = 90;

  private path: THREE.Vector3[] = [];
  private N = 0;

  private dist = [0, 0];      // metres per team (0 = you, 1 = rivals)
  private speed = [0, 0];     // coast momentum
  private carts: THREE.Group[] = [];
  private levers: THREE.Object3D[][] = [[], []]; // [team][riderInCart]
  private leverAnim = [0, 0, 0, 0]; // per player
  private pumpT = [0, 0, 0, 0];     // per-player lever cooldown
  private pumpLock = 0;             // you: locked out (hazard) for a beat
  private autoPumpT = 0;            // magnet: auto-pump you for a while
  private shieldT = 0;
  private pumps = [0, 0, 0, 0];     // pump counts (for the results)

  private events: Ev[] = [];
  private switchT = 0;              // active switch window
  private held: Item | null = null;
  private enemyEvT = 5;

  private speedBtn!: HTMLButtonElement;
  private useBtn!: HTMLButtonElement;
  private switchBtn!: HTMLButtonElement;
  private map!: HTMLCanvasElement;
  private mapCtx!: CanvasRenderingContext2D;

  init(ctx: MatchContext) {
    this.ctx = ctx;
    this.title = ctx.game.name;
    this.finished = false;
    this.timeLeft = matchTime(90);
    this.dist = [0, 0]; this.speed = [0, 0];
    this.leverAnim = [0, 0, 0, 0]; this.pumpT = [0, 0, 0, 0]; this.pumps = [0, 0, 0, 0];
    this.pumpLock = 0; this.autoPumpT = 0; this.shieldT = 0; this.switchT = 0; this.held = null; this.enemyEvT = 5;

    ctx.scene.fog = new THREE.Fog(new THREE.Color(0x8fb8e8).getHex(), 120, 460);

    this.buildTrack();
    setupRoster(ctx, '0m', 0.5);

    // Teams: 0,1 = YOUR cart, 2,3 = RIVAL cart.
    this.carts = [this.makeCart(0x4DC3FF, 0), this.makeCart(0xff4da6, 1)];
    ctx.scene.add(this.carts[0]); ctx.scene.add(this.carts[1]);
    ctx.players.forEach((p) => { p.sitting = true; p.vx = 0; p.vz = 0; setScore(p, '0m'); });

    this.events = [
      { d: 12, kind: 'turbo', done: false }, { d: 18, kind: 'boost', done: false },
      { d: 32, kind: 'hazard', done: false }, { d: 38, kind: 'switch', done: false },
      { d: 44, kind: 'shield', done: false }, { d: 50, kind: 'boost', done: false },
      { d: 64, kind: 'hazard', done: false }, { d: 70, kind: 'magnet', done: false },
      { d: 74, kind: 'switch', done: false }, { d: 82, kind: 'boost', done: false },
      { d: 90, kind: 'hazard', done: false },
    ];

    this.buildUI();
    this.syncCarts(0);
    ctx.fx.banner('GO! 🎢 MASH SPEED UP!', '#FFD23F');
  }

  // --- track ------------------------------------------------------------------
  private buildTrack() {
    const scene = this.ctx.scene;
    const pts = CTRL.map(([x, y, z]) => new THREE.Vector3(x, y, z));
    const curve = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.5);
    this.path = curve.getPoints(499);
    this.N = this.path.length;

    // Two rails (left = yours, right = rivals) as ribbon beds + steel rails +
    // ties + support pillars into the sky.
    for (const side of [-1, 1]) {
      const bed: THREE.Vector3[] = [], railA: THREE.Vector3[] = [], railB: THREE.Vector3[] = [];
      for (let i = 0; i < this.N; i++) {
        const c = this.path[i]; const [px, pz] = this.perp(i);
        const cx = c.x + px * RAIL_OFF * side, cz = c.z + pz * RAIL_OFF * side;
        bed.push(new THREE.Vector3(cx - px * 2.4, c.y, cz - pz * 2.4));
        bed.push(new THREE.Vector3(cx + px * 2.4, c.y, cz + pz * 2.4)); // handled below
        railA.push(new THREE.Vector3(cx - px * 1.8, c.y + 0.5, cz - pz * 1.8));
        railB.push(new THREE.Vector3(cx + px * 1.8, c.y + 0.5, cz + pz * 1.8));
      }
      // Bed ribbon.
      const bedL: THREE.Vector3[] = [], bedR: THREE.Vector3[] = [];
      for (let i = 0; i < this.N; i++) { bedL.push(bed[i * 2]); bedR.push(bed[i * 2 + 1]); }
      scene.add(this.ribbon(bedL, bedR, new THREE.MeshStandardMaterial({ color: 0x3a3f4d, roughness: 0.9 })));
      // Steel rails.
      const railMat = new THREE.MeshStandardMaterial({ color: 0x9aa4b4, roughness: 0.4, metalness: 0.6, emissive: side < 0 ? 0x0a3a55 : 0x551033, emissiveIntensity: 0.5 });
      scene.add(this.tube(railA, 0.22, railMat)); scene.add(this.tube(railB, 0.22, railMat));
      // Ties + pillars every few samples.
      const tieMat = new THREE.MeshStandardMaterial({ color: 0x5a4632, roughness: 1 });
      const pillarMat = new THREE.MeshStandardMaterial({ color: 0x4a5464, roughness: 0.8 });
      for (let i = 6; i < this.N - 4; i += 6) {
        const c = this.path[i]; const [px, pz] = this.perp(i);
        const cx = c.x + px * RAIL_OFF * side, cz = c.z + pz * RAIL_OFF * side;
        const tie = new THREE.Mesh(new THREE.BoxGeometry(4.6, 0.3, 0.7), tieMat);
        tie.position.set(cx, c.y + 0.2, cz); tie.rotation.y = this.head(i); scene.add(tie);
        const pillar = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.6, c.y + 14, 6), pillarMat);
        pillar.position.set(cx, (c.y - 14) / 2, cz); scene.add(pillar);
      }
    }

    this.buildScenery();
    this.buildFinishArch();
  }

  private perp(i: number): [number, number] { const h = this.head(i); return [Math.cos(h), -Math.sin(h)]; }
  private head(i: number): number {
    const a = this.path[Math.max(0, i - 1)], b = this.path[Math.min(this.N - 1, i + 1)];
    return Math.atan2(b.x - a.x, b.z - a.z);
  }

  private ribbon(a: THREE.Vector3[], b: THREE.Vector3[], mat: THREE.Material): THREE.Mesh {
    const n = a.length; const pos = new Float32Array(n * 2 * 3);
    for (let i = 0; i < n; i++) {
      pos[i * 6] = a[i].x; pos[i * 6 + 1] = a[i].y; pos[i * 6 + 2] = a[i].z;
      pos[i * 6 + 3] = b[i].x; pos[i * 6 + 4] = b[i].y; pos[i * 6 + 5] = b[i].z;
    }
    const idx: number[] = [];
    for (let i = 0; i < n - 1; i++) { const l0 = i * 2, r0 = i * 2 + 1, l1 = (i + 1) * 2, r1 = (i + 1) * 2 + 1; idx.push(l0, l1, r0, r0, l1, r1); }
    const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(pos, 3)); geo.setIndex(idx); geo.computeVertexNormals();
    return new THREE.Mesh(geo, mat);
  }

  private tube(pts: THREE.Vector3[], r: number, mat: THREE.Material): THREE.Mesh {
    const curve = new THREE.CatmullRomCurve3(pts);
    return new THREE.Mesh(new THREE.TubeGeometry(curve, Math.min(300, pts.length), r, 6, false), mat);
  }

  private buildScenery() {
    const scene = this.ctx.scene;
    const rockA = new THREE.MeshStandardMaterial({ color: 0x7a6f8a, roughness: 1, flatShading: true });
    const grass = new THREE.MeshStandardMaterial({ color: 0x4a8a44, roughness: 1, flatShading: true });
    // Floating sky-islands scattered around the track for depth + carnival feel.
    for (let i = 8; i < this.N - 8; i += 14) {
      const c = this.path[i];
      for (const s of [-1, 1]) {
        if (Math.random() < 0.3) continue;
        const [px, pz] = this.perp(i);
        const ix = c.x + px * (RAIL_OFF + 22 + Math.random() * 30) * s, iz = c.z + pz * (RAIL_OFF + 22) * s;
        const iy = c.y - 6 - Math.random() * 20;
        const g = new THREE.Group();
        const rock = new THREE.Mesh(new THREE.ConeGeometry(6 + Math.random() * 5, 16, 6), rockA); rock.position.y = -6; rock.rotation.x = Math.PI; g.add(rock);
        const top = new THREE.Mesh(new THREE.CylinderGeometry(6 + Math.random() * 4, 5, 2.5, 8), grass); g.add(top);
        if (Math.random() < 0.5) { const tent = new THREE.Mesh(new THREE.ConeGeometry(2.4, 4, 8), new THREE.MeshStandardMaterial({ color: Math.random() < 0.5 ? 0xff4da6 : 0xffd23f, roughness: 0.6, emissive: 0x331022, emissiveIntensity: 0.3 })); tent.position.y = 3; g.add(tent); }
        g.position.set(ix, iy, iz); scene.add(g);
      }
    }
  }

  private buildFinishArch() {
    const scene = this.ctx.scene;
    const i = this.N - 3, c = this.path[i]; const [px, pz] = this.perp(i);
    for (const side of [-1, 1]) {
      const cx = c.x + px * RAIL_OFF * side, cz = c.z + pz * RAIL_OFF * side;
      const postMat = new THREE.MeshStandardMaterial({ color: 0xffd23f, emissive: 0x8a6a00, emissiveIntensity: 0.6, roughness: 0.4 });
      for (const s of [-1, 1]) { const post = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 9, 8), postMat); post.position.set(cx + px * 3 * s, c.y + 4.5, cz + pz * 3 * s); scene.add(post); }
      const bar = new THREE.Mesh(new THREE.BoxGeometry(7.5, 1.4, 0.6), postMat); bar.position.set(cx, c.y + 9, cz); bar.rotation.y = this.head(i); scene.add(bar);
      const spr = this.textSprite('🏁 FINISH'); spr.position.set(cx, c.y + 11.5, cz); scene.add(spr);
      // Checkered banner.
      const bcols = 10, bcw = 7.5 / bcols;
      for (let r = 0; r < 2; r++) for (let col = 0; col < bcols; col++) {
        const white = (r + col) % 2 === 0;
        const tile = new THREE.Mesh(new THREE.PlaneGeometry(bcw, 0.7), new THREE.MeshStandardMaterial({ color: white ? 0xffffff : 0x111111, side: THREE.DoubleSide }));
        tile.position.set(cx + (col - (bcols - 1) / 2) * bcw, c.y + 8.4 - r * 0.7, cz); tile.rotation.y = this.head(i); scene.add(tile);
      }
    }
  }

  private textSprite(txt: string): THREE.Sprite {
    const c = document.createElement('canvas'); c.width = 512; c.height = 128;
    const x = c.getContext('2d')!; x.font = '900 58px Bungee, system-ui, sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillStyle = '#fff'; x.strokeStyle = '#12142e'; x.lineWidth = 8; x.strokeText(txt, 256, 70); x.fillText(txt, 256, 70);
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false })); sp.scale.set(11, 2.8, 1); return sp;
  }

  // --- cart -------------------------------------------------------------------
  private makeCart(col: number, team: number): THREE.Group {
    const g = new THREE.Group();
    const body = new THREE.MeshStandardMaterial({ color: col, roughness: 0.4, metalness: 0.4 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x2a2f3a, roughness: 0.7 });
    const red = new THREE.MeshStandardMaterial({ color: 0xd83030, roughness: 0.5, emissive: 0x400 });
    const hull = new THREE.Mesh(new THREE.BoxGeometry(3.4, 1.6, 5.6), body); hull.position.y = 1.4; hull.castShadow = true; g.add(hull);
    const floor = new THREE.Mesh(new THREE.BoxGeometry(3.0, 0.3, 5.0), dark); floor.position.y = 0.9; g.add(floor);
    for (const wz of [-2, 2]) for (const wx of [-1.8, 1.8]) { const w = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.7, 0.4, 12), dark); w.rotation.z = Math.PI / 2; w.position.set(wx, 0.5, wz); g.add(w); }
    // Two red pump levers — one at each end (the riders face each other over them).
    this.levers[team] = [];
    for (const [lz, ri] of [[1.7, 0], [-1.7, 1]] as const) {
      const lever = new THREE.Group();
      const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 2.2, 8), red); arm.position.y = 1.1; lever.add(arm);
      const grip = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.3, 0.4), red); grip.position.y = 2.1; lever.add(grip);
      lever.position.set(0, 1.0, lz * 0.55); lever.rotation.x = lz > 0 ? -0.3 : 0.3;
      g.add(lever); this.levers[team][ri] = lever;
    }
    return g;
  }

  // --- input ------------------------------------------------------------------
  ability() { this.pump(0); } // corner tap also pumps
  jump() { this.pump(0); }

  private pump(pi: number) {
    if (this.finished) return;
    const team = pi < 2 ? 0 : 1;
    if (pi === 0 && this.pumpLock > 0) return;
    if (this.pumpT[pi] > 0) return;
    this.pumpT[pi] = pi === 0 ? PUMP_CD : (pi === 1 ? TEAM_CD : this.enemyCd());
    this.leverAnim[pi] = 1;
    this.pumps[pi]++;
    this.dist[team] = Math.min(FINISH_M, this.dist[team] + PUMP_M);
    if (pi === 0) { SFX.tick(); if (this.speedBtn) { this.speedBtn.style.transform = 'scale(0.94)'; setTimeout(() => this.speedBtn && (this.speedBtn.style.transform = ''), 80); } }
  }

  private enemyCd(): number { return 0.7 - this.ctx.diff.cap * 0.2; }

  private useItem() {
    if (!this.held || this.finished) return;
    const it = this.held; this.held = null; this.updateItemBtn();
    if (it === 'turbo') { this.speed[0] += 14; this.ctx.fx.banner('⚡ TURBO!', '#ffe23a'); this.ctx.fx.burst(0, 0, '#ffe23a', 0); }
    else if (it === 'shield') { this.shieldT = 20; this.ctx.fx.banner('🛡️ SHIELD UP!', '#4DC3FF'); }
    else { this.autoPumpT = 3.2; this.ctx.fx.banner('🧲 MAGNET — auto-pump!', '#a86bff'); }
    SFX.power();
  }

  private hitSwitch() {
    if (this.switchT <= 0 || this.finished) return;
    this.switchT = 0; this.switchBtn.style.display = 'none';
    this.speed[0] += 7; this.ctx.fx.banner('🔀 SHORTCUT! nice', '#7CF07C'); SFX.gem();
  }

  // --- tick -------------------------------------------------------------------
  tick(dt: number, elapsed: number) {
    if (this.finished) return;
    const ctx = this.ctx;
    this.timeLeft -= dt; ctx.setClock(this.timeLeft);
    this.pumpLock = Math.max(0, this.pumpLock - dt);
    this.shieldT = Math.max(0, this.shieldT - dt);
    this.switchT = Math.max(0, this.switchT - dt);
    if (this.switchT <= 0 && this.switchBtn) this.switchBtn.style.display = 'none';
    for (let i = 0; i < 4; i++) { this.pumpT[i] = Math.max(0, this.pumpT[i] - dt); this.leverAnim[i] = Math.max(0, this.leverAnim[i] - dt * 4); }

    // Magnet: auto-pump you.
    if (this.autoPumpT > 0) { this.autoPumpT -= dt; this.pump(0); }
    // AI teammate + both rivals pump on their cadence.
    this.pump(1); this.pump(2); this.pump(3);

    // Coast: downhill drops add a MODEST bonus, uphill saps it, plus decay — the
    // pumping (0.5m a stroke) stays the main driver so the ride lands near 1 min.
    for (const t of [0, 1]) {
      const slope = this.slopeAt(this.dist[t]);
      this.speed[t] += (-slope * 7) * dt;             // downhill (slope<0) → faster
      this.speed[t] = Math.max(0, this.speed[t] - this.speed[t] * 1.5 * dt);
      this.speed[t] = Math.min(7, this.speed[t]); // room for turbo/boost bursts
      this.dist[t] = Math.min(FINISH_M, this.dist[t] + this.speed[t] * dt);
    }

    this.tickEvents();
    this.tickEnemyEvents(dt);
    this.syncCarts(elapsed);
    this.updateUI();
    tickRoster(ctx, dt, elapsed);

    // Camera rides YOUR cart.
    const you = this.cartPose(this.dist[0]);
    ctx.camera.chaseBehind(you.x, you.y + 2.6, you.z, you.h, 17, 9.5);

    if (this.dist[0] >= FINISH_M) return this.doFinish(0, 'Your cart hits the finish first! 🏁');
    if (this.dist[1] >= FINISH_M) return this.doFinish(1, 'The rivals beat you to the finish!');
    if (this.timeLeft <= 0) return this.doFinish(this.dist[0] >= this.dist[1] ? 0 : 1, 'Time! Furthest cart wins.');
  }

  /** Track slope (dy per metre) at a distance, for the coaster coast feel. */
  private slopeAt(d: number): number {
    const f = d / FINISH_M, i = Math.min(this.N - 2, Math.floor(f * (this.N - 1)));
    return (this.path[i + 1].y - this.path[i].y);
  }

  /** World pose of a cart at distance d along its rail (team decides which rail). */
  private cartPose(d: number, side = -1): { x: number; y: number; z: number; h: number } {
    const f = Math.max(0, Math.min(1, d / FINISH_M));
    const fi = f * (this.N - 1), i = Math.min(this.N - 2, Math.floor(fi)), t = fi - i;
    const a = this.path[i], b = this.path[i + 1];
    const [px, pz] = this.perp(i);
    const cx = a.x + (b.x - a.x) * t, cy = a.y + (b.y - a.y) * t, cz = a.z + (b.z - a.z) * t;
    return { x: cx + px * RAIL_OFF * side, y: cy, z: cz + pz * RAIL_OFF * side, h: this.head(i) };
  }

  private syncCarts(elapsed: number) {
    for (const t of [0, 1]) {
      const pose = this.cartPose(this.dist[t], t === 0 ? -1 : 1);
      const cart = this.carts[t];
      cart.position.set(pose.x, pose.y + 0.9, pose.z);
      cart.rotation.y = pose.h; cart.rotation.z = Math.sin(elapsed * 4 + t) * 0.03;
      // Riders sit FACING each other over the levers.
      const s = Math.sin(pose.h), c = Math.cos(pose.h);
      const seat = [[0, 1.7], [0, -1.7]];
      for (let r = 0; r < 2; r++) {
        const p = this.ctx.players[t * 2 + r];
        const [sx, sz] = seat[r];
        p.x = pose.x + sx * c + sz * s; p.z = pose.z - sx * s + sz * c; p.y = pose.y + 1.6;
        p.sitting = true; p.standFacing = r === 0 ? pose.h + Math.PI : pose.h; // face each other
        const lever = this.levers[t][r];
        if (lever) lever.rotation.x = (r === 0 ? -0.3 : 0.3) + Math.sin(this.leverAnim[t * 2 + r] * Math.PI) * (r === 0 ? 0.9 : -0.9);
      }
    }
  }

  // --- events -----------------------------------------------------------------
  private tickEvents() {
    for (const e of this.events) {
      if (e.done || this.dist[0] < e.d) continue;
      e.done = true;
      if (e.kind === 'boost') { this.speed[0] += 6.5; this.ctx.fx.banner('🔷 BOOST GATE!', '#4DC3FF'); SFX.gem(); }
      else if (e.kind === 'hazard') {
        if (this.shieldT > 0) { this.shieldT = 0; this.ctx.fx.banner('🛡️ BLOCKED THE HAZARD!', '#4DC3FF'); }
        else { this.speed[0] *= 0.3; this.pumpLock = 0.7; this.ctx.fx.shake(1.4); this.ctx.fx.banner('💥 HAZARD! braced', '#FF4D4D'); SFX.bump(); }
      } else if (e.kind === 'switch') {
        this.switchT = 1.4; if (this.switchBtn) this.switchBtn.style.display = 'block';
        this.ctx.fx.banner('🔀 SWITCH! tap for a shortcut', '#7CF07C');
      } else { // power-up
        this.held = e.kind; this.updateItemBtn();
        this.ctx.fx.banner(`${ITEM_EMOJI[e.kind]} grabbed — tap USE!`, '#FFD23F'); SFX.gem();
      }
    }
  }

  // Rivals hit their own boosts/bumps so the mini-track stays lively.
  private tickEnemyEvents(dt: number) {
    this.enemyEvT -= dt;
    if (this.enemyEvT <= 0) {
      this.enemyEvT = 6 + Math.random() * 5;
      if (Math.random() < 0.55) this.speed[1] += 5.5; else this.speed[1] *= 0.4;
    }
  }

  // --- HUD --------------------------------------------------------------------
  private buildUI() {
    document.getElementById('coUI')?.remove();
    const ui = document.createElement('div');
    ui.id = 'coUI';
    ui.style.cssText = 'position:fixed;inset:0;z-index:8;pointer-events:none;font-family:Bungee,system-ui,sans-serif;';
    ui.innerHTML = `
      <canvas id="coMap" width="220" height="90" style="position:fixed;top:70px;left:50%;transform:translateX(-50%);
        width:180px;height:74px;background:rgba(10,20,34,.55);border:2px solid rgba(255,255,255,.35);border-radius:12px;"></canvas>
      <button id="coUse" style="pointer-events:auto;position:fixed;left:20px;bottom:30px;display:none;">🎁 USE</button>
      <button id="coSwitch" style="pointer-events:auto;position:fixed;left:50%;transform:translateX(-50%);bottom:150px;display:none;">🔀 SWITCH!</button>
      <button id="coSpeed" style="pointer-events:auto;position:fixed;right:20px;bottom:24px;">⬇️ SPEED UP</button>`;
    document.body.appendChild(ui);
    const btnCss = 'font-family:Bungee,system-ui,sans-serif;border:none;border-radius:18px;color:#12142e;cursor:pointer;box-shadow:0 6px 0 rgba(0,0,0,.35);touch-action:none;user-select:none;';
    this.speedBtn = ui.querySelector('#coSpeed')!;
    this.useBtn = ui.querySelector('#coUse')!;
    this.switchBtn = ui.querySelector('#coSwitch')!;
    this.speedBtn.style.cssText += btnCss + 'font-size:24px;padding:26px 34px;background:#FFD23F;';
    this.useBtn.style.cssText += btnCss + 'font-size:17px;padding:16px 22px;background:#7CF07C;';
    this.switchBtn.style.cssText += btnCss + 'font-size:19px;padding:16px 26px;background:#4DC3FF;';
    this.speedBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); this.pump(0); });
    this.useBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); this.useItem(); });
    this.switchBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); this.hitSwitch(); });
    this.map = ui.querySelector('#coMap')!;
    this.mapCtx = this.map.getContext('2d')!;
  }

  private updateItemBtn() {
    if (!this.useBtn) return;
    this.useBtn.style.display = this.held ? 'block' : 'none';
    if (this.held) this.useBtn.textContent = `${ITEM_EMOJI[this.held]} USE`;
  }

  private updateUI() {
    for (const t of [0, 1]) for (let r = 0; r < 2; r++) setScore(this.ctx.players[t * 2 + r], `${Math.floor(this.dist[t])}m`);
    if (!this.mapCtx) return;
    const g = this.mapCtx, w = this.map.width, h = this.map.height;
    g.clearRect(0, 0, w, h);
    g.font = '13px Bungee, sans-serif'; g.textBaseline = 'middle';
    const rowY = [30, 60];
    for (const t of [0, 1]) {
      const y = rowY[t]; const pad = 14, x0 = pad, x1 = w - pad - 16;
      g.strokeStyle = 'rgba(255,255,255,.25)'; g.lineWidth = 6; g.beginPath(); g.moveTo(x0, y); g.lineTo(x1, y); g.stroke();
      g.fillStyle = '#111'; g.font = '11px Bungee'; g.textAlign = 'left'; g.fillText('🏁', x1 + 1, y);
      const f = this.dist[t] / FINISH_M;
      g.fillStyle = t === 0 ? '#4DC3FF' : '#ff4da6';
      g.beginPath(); g.arc(x0 + (x1 - x0) * f, y, 7, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#fff'; g.textAlign = 'left'; g.fillText(t === 0 ? 'YOU' : 'RIVAL', x0, y - 13);
      g.textAlign = 'right'; g.fillText(`${Math.floor(this.dist[t])}m`, x1, y - 13);
    }
    // Shield indicator on the SPEED button tint.
    if (this.speedBtn) this.speedBtn.style.background = this.pumpLock > 0 ? '#8a8f99' : (this.autoPumpT > 0 ? '#a86bff' : '#FFD23F');
  }

  private doFinish(winTeam: number, sub: string) {
    if (this.finished) return;
    this.finished = true;
    document.getElementById('coUI')?.remove();
    const ctx = this.ctx;
    ctx.players.forEach((p) => { const t = p.index < 2 ? 0 : 1; (p as any)._res = `${Math.floor(this.dist[t])}m · ${this.pumps[p.index]} pumps`; });
    if (winTeam === 0) { SFX.win(); ctx.fx.banner('🏁 YOU WIN!', '#7CF07C'); } else { SFX.lose(); ctx.fx.banner('🏁 RIVALS WIN', '#FF4D4D'); }
    ctx.finish(rankBy(ctx, (p) => (p.index < 2 ? 0 : 1) === winTeam ? 1e6 + this.pumps[p.index] : this.pumps[p.index]), sub);
  }
}

const ITEM_EMOJI: Record<Item, string> = { turbo: '⚡', shield: '🛡️', magnet: '🧲' };
