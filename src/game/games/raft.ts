import * as THREE from 'three';
import type { GameModule, MatchContext } from '../context';
import { setupRoster, tickRoster, rankBy } from '../freeroam';
import { matchTime } from '../../core/tuning';
import { SFX } from '../../core/audio';
import { setScore } from '../../ui/hud';

// CROC RIVER RAFT (Sky tier 1) — a CO-OP river-survival run inspired by Mario
// Party's River Survival. All four heroes ride ONE inflatable raft, two paddling
// on the left and two on the right. You steer the whole raft down a winding
// forest river with the stick, hold PADDLE to surge, and tap WHACK to bonk the
// hungry crocodiles that chase and bite the raft. Grab floating balloons for
// extra time. Reach the checkered finish banner before the raft is sunk or the
// clock runs out — survive together!

interface Croc { g: THREE.Group; x: number; z: number; biteCd: number; stunT: number; }
interface Balloon { x: number; z: number; g: THREE.Group; }

const CRUISE = 11;
const BOOST = 19;
const ACCEL = 2.0;
const TURN = 1.8;
const HALF_W = 12;
const RAFT_R = 3.2;
const CROC_SPEED = 15;

// Winding centreline control points (x, z) — the SAME river layout as the boat
// race, for a consistent forest-river map.
const CTRL: [number, number][] = [
  [0, 66], [-22, 46], [20, 22], [-20, -4], [18, -30], [-10, -52], [0, -70],
];

// Seat offsets on the raft (raft faces +z): players 0,1 paddle on the LEFT,
// players 2,3 on the RIGHT — two a side, like the reference.
const SEATS: [number, number][] = [[-1.4, 0.9], [-1.4, -0.9], [1.4, 0.9], [1.4, -0.9]];

export class RaftGame implements GameModule {
  readonly stickMode = 'float' as const;
  title = 'Croc River Raft';
  objective = '🚣 Paddle to the flag — whack the crocs & survive!';

  private ctx!: MatchContext;
  private timeLeft = 40;
  private finished = false;

  private path: THREE.Vector3[] = [];
  private heads: number[] = [];
  private N = 0;
  private water: THREE.Mesh | null = null;

  private raft!: THREE.Group;
  private paddles: THREE.Mesh[] = [];
  private rx = 0; private rz = 0; private rHead = 0; private rSpeed = 0; private rIdx = 3;
  private hp = 100;
  private strokes: number[] = [];
  private whacks = 0;

  private crocs: Croc[] = [];
  private crocT = 3;
  private balloons: Balloon[] = [];
  private balloonT = 5;

  private boosting = false;
  private paddleBtn!: HTMLButtonElement;
  private whackBtn!: HTMLButtonElement;
  private hpFill!: HTMLElement;
  private map!: HTMLCanvasElement;
  private mapCtx!: CanvasRenderingContext2D;
  private mapBounds = { minX: 0, maxX: 1, minZ: 0, maxZ: 1 };

  init(ctx: MatchContext) {
    this.ctx = ctx;
    this.title = ctx.game.name;
    this.finished = false;
    this.timeLeft = matchTime(40);
    this.crocs = []; this.balloons = []; this.crocT = 3; this.balloonT = 5;
    this.hp = 100; this.whacks = 0;

    // Push the sky-family haze far back so the forest river reads crisply.
    ctx.scene.fog = new THREE.Fog(new THREE.Color(0xbfe0ff).getHex(), 150, 460);

    this.buildCourse();
    setupRoster(ctx, '🚣', 0.5);
    this.buildUI();

    // Raft at the start of the river.
    this.rIdx = 3;
    const c = this.path[this.rIdx];
    this.rx = c.x; this.rz = c.z; this.rHead = this.heads[this.rIdx]; this.rSpeed = 0;
    this.raft = this.makeRaft();
    ctx.scene.add(this.raft);

    this.strokes = [];
    ctx.players.forEach((p) => {
      this.strokes[p.index] = 0;
      p.sitting = true;
      p.vx = 0; p.vz = 0; p.y = 0.9;
      setScore(p, '🚣');
    });
    this.seatPlayers();

    // Two crocs to start.
    this.spawnCroc(); this.spawnCroc();
    ctx.fx.banner('PADDLE! 🚣', '#4DC3FF');
  }

  // --- course (shared look with the boat race) --------------------------------
  private buildCourse() {
    const scene = this.ctx.scene;
    const pts3 = CTRL.map(([x, z]) => new THREE.Vector3(x, 0, z));
    const curve = new THREE.CatmullRomCurve3(pts3, false, 'catmullrom', 0.5);
    this.path = curve.getPoints(499);
    this.N = this.path.length;
    this.heads = this.path.map((_, i) => {
      const a = this.path[Math.max(0, i - 1)];
      const b = this.path[Math.min(this.N - 1, i + 1)];
      return Math.atan2(b.x - a.x, b.z - a.z);
    });

    const left: THREE.Vector3[] = [], right: THREE.Vector3[] = [];
    const bankL: THREE.Vector3[] = [], bankR: THREE.Vector3[] = [];
    for (let i = 0; i < this.N; i++) {
      const c = this.path[i], h = this.heads[i];
      const px = Math.cos(h), pz = -Math.sin(h);
      left.push(new THREE.Vector3(c.x - px * HALF_W, 0.32, c.z - pz * HALF_W));
      right.push(new THREE.Vector3(c.x + px * HALF_W, 0.32, c.z + pz * HALF_W));
      bankL.push(new THREE.Vector3(c.x - px * (HALF_W + 5), 0.85, c.z - pz * (HALF_W + 5)));
      bankR.push(new THREE.Vector3(c.x + px * (HALF_W + 5), 0.85, c.z + pz * (HALF_W + 5)));
    }
    const waterMat = new THREE.MeshStandardMaterial({
      color: 0x2b8fe0, roughness: 0.2, metalness: 0.35, emissive: 0x1466a8, emissiveIntensity: 0.6,
    });
    this.water = this.ribbon(left, right, waterMat);
    scene.add(this.water);
    const bankMat = new THREE.MeshStandardMaterial({ color: 0xc9a76b, roughness: 1 });
    scene.add(this.ribbon(bankL, left, bankMat));
    scene.add(this.ribbon(right, bankR, bankMat));

    for (let i = 6; i < this.N - 6; i += 9) {
      for (const side of [-1, 1]) {
        if (Math.random() < 0.35) continue;
        const c = this.path[i], h = this.heads[i];
        const px = Math.cos(h), pz = -Math.sin(h);
        const off = HALF_W + 6 + Math.random() * 10;
        this.addTree(c.x + px * off * side, c.z + pz * off * side);
      }
    }

    this.buildFinish();

    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const c of this.path) {
      minX = Math.min(minX, c.x); maxX = Math.max(maxX, c.x);
      minZ = Math.min(minZ, c.z); maxZ = Math.max(maxZ, c.z);
    }
    const pad = HALF_W + 6;
    this.mapBounds = { minX: minX - pad, maxX: maxX + pad, minZ: minZ - pad, maxZ: maxZ + pad };
  }

  private ribbon(a: THREE.Vector3[], b: THREE.Vector3[], mat: THREE.Material): THREE.Mesh {
    const n = a.length;
    const pos = new Float32Array(n * 2 * 3);
    for (let i = 0; i < n; i++) {
      pos[i * 6 + 0] = a[i].x; pos[i * 6 + 1] = a[i].y; pos[i * 6 + 2] = a[i].z;
      pos[i * 6 + 3] = b[i].x; pos[i * 6 + 4] = b[i].y; pos[i * 6 + 5] = b[i].z;
    }
    const idx: number[] = [];
    for (let i = 0; i < n - 1; i++) {
      const l0 = i * 2, r0 = i * 2 + 1, l1 = (i + 1) * 2, r1 = (i + 1) * 2 + 1;
      idx.push(l0, l1, r0, r0, l1, r1);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const m = new THREE.Mesh(geo, mat);
    m.receiveShadow = true;
    return m;
  }

  private addTree(x: number, z: number) {
    const g = new THREE.Group();
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.5, 3, 6),
      new THREE.MeshStandardMaterial({ color: 0x6b4a2a, roughness: 1 }));
    trunk.position.y = 1.5; trunk.castShadow = true; g.add(trunk);
    const green = new THREE.MeshStandardMaterial({ color: 0x2f6b34, roughness: 1, flatShading: true });
    for (let i = 0; i < 3; i++) {
      const cone = new THREE.Mesh(new THREE.ConeGeometry(2.4 - i * 0.5, 2.4, 7), green);
      cone.position.y = 3.2 + i * 1.3; cone.castShadow = true; g.add(cone);
    }
    g.position.set(x, 0.4, z);
    g.rotation.y = Math.random() * 6;
    g.scale.setScalar(0.8 + Math.random() * 0.7);
    this.ctx.scene.add(g);
  }

  private buildFinish() {
    const scene = this.ctx.scene;
    const iFin = this.N - 4;
    const c = this.path[iFin], h = this.heads[iFin];
    const px = Math.cos(h), pz = -Math.sin(h);
    const rows = 2, cols = 8, cw = (HALF_W * 2) / cols;
    for (let r = 0; r < rows; r++) {
      for (let col = 0; col < cols; col++) {
        const off = (col - (cols - 1) / 2) * cw;
        const along = (r - 0.5) * cw;
        const white = (r + col) % 2 === 0;
        const tile = new THREE.Mesh(new THREE.BoxGeometry(cw, 0.08, cw),
          new THREE.MeshStandardMaterial({ color: white ? 0xffffff : 0x111111, roughness: 0.7 }));
        tile.position.set(c.x + px * off + Math.sin(h) * along, 0.34, c.z + pz * off + Math.cos(h) * along);
        tile.rotation.y = h;
        scene.add(tile);
      }
    }
    const poleMat = new THREE.MeshStandardMaterial({ color: 0xdedede, roughness: 0.6, metalness: 0.3 });
    for (const side of [-1, 1]) {
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 14, 10), poleMat);
      pole.position.set(c.x + px * (HALF_W + 1.5) * side, 7, c.z + pz * (HALF_W + 1.5) * side);
      pole.castShadow = true; scene.add(pole);
    }
    const bw = (HALF_W + 1.5) * 2, bcols = 14, brows = 3, bcw = bw / bcols, bch = 1.5;
    const banner = new THREE.Group();
    for (let r = 0; r < brows; r++) {
      for (let col = 0; col < bcols; col++) {
        const white = (r + col) % 2 === 0;
        const tile = new THREE.Mesh(new THREE.PlaneGeometry(bcw, bch),
          new THREE.MeshStandardMaterial({ color: white ? 0xffffff : 0x111111, roughness: 0.8, side: THREE.DoubleSide }));
        tile.position.set((col - (bcols - 1) / 2) * bcw, (brows - 1) / 2 * bch - r * bch, 0);
        banner.add(tile);
      }
    }
    banner.position.set(c.x, 11, c.z);
    banner.rotation.y = h + Math.PI / 2;
    scene.add(banner);
    const spr = this.textSprite('🏁 FINISH 🏁');
    spr.position.set(c.x, 13.6, c.z); scene.add(spr);
  }

  private textSprite(txt: string): THREE.Sprite {
    const c = document.createElement('canvas'); c.width = 512; c.height = 128;
    const x = c.getContext('2d')!;
    x.font = '900 60px Bungee, system-ui, sans-serif';
    x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillStyle = '#fff'; x.strokeStyle = '#12142e'; x.lineWidth = 8;
    x.strokeText(txt, 256, 70); x.fillText(txt, 256, 70);
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
    sp.scale.set(14, 3.5, 1);
    return sp;
  }

  // --- raft + croc models -----------------------------------------------------
  private makeRaft(): THREE.Group {
    const g = new THREE.Group();
    const red = new THREE.MeshStandardMaterial({ color: 0xd83b3b, roughness: 0.5 });
    const white = new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.5 });
    const blue = new THREE.MeshStandardMaterial({ color: 0x3b7bd8, roughness: 0.6 });
    // Inflatable ring — a rounded rectangle made of tube segments (red/white).
    const ring = new THREE.Group();
    const rx = 2.4, rz = 2.9;
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      const seg = new THREE.Mesh(new THREE.SphereGeometry(0.85, 8, 8), i % 2 ? red : white);
      seg.position.set(Math.cos(a) * rx, 0.7, Math.sin(a) * rz);
      seg.scale.set(1, 0.8, 1); ring.add(seg);
    }
    g.add(ring);
    // Floor mat.
    const floor = new THREE.Mesh(new THREE.CylinderGeometry(rx, rx, 0.2, 20), blue);
    floor.scale.z = rz / rx; floor.position.y = 0.55; g.add(floor);
    // Paddles — one per seat, angled outward.
    this.paddles = [];
    SEATS.forEach(([sx, sz]) => {
      const pad = new THREE.Group();
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 2.4, 6),
        new THREE.MeshStandardMaterial({ color: 0xcaa46a, roughness: 0.8 }));
      shaft.position.y = -0.6; shaft.rotation.z = Math.PI / 2 * (sx < 0 ? -1 : 1); pad.add(shaft);
      const blade = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.9, 0.08), red);
      blade.position.set((sx < 0 ? -1 : 1) * 1.9, -0.9, 0); pad.add(blade);
      pad.position.set(sx, 1.5, sz);
      g.add(pad); this.paddles.push(blade);
    });
    g.castShadow = true;
    return g;
  }

  private makeCroc(): THREE.Group {
    const g = new THREE.Group();
    const skin = new THREE.MeshStandardMaterial({ color: 0x3c6e35, roughness: 0.9, flatShading: true });
    const belly = new THREE.MeshStandardMaterial({ color: 0x86a05a, roughness: 0.9 });
    const body = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.7, 3.4), skin);
    body.position.y = 0.35; body.castShadow = true; g.add(body);
    const und = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.3, 3.0), belly);
    und.position.y = 0.05; g.add(und);
    // Snout (upper + lower jaw).
    const upper = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.35, 1.6), skin);
    upper.position.set(0, 0.5, 2.2); g.add(upper);
    const lower = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.25, 1.5), belly);
    lower.position.set(0, 0.18, 2.2); g.add(lower);
    // Eyes.
    for (const sx of [-0.35, 0.35]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.22, 8, 8),
        new THREE.MeshStandardMaterial({ color: 0xffe23a, emissive: 0x554400, emissiveIntensity: 0.5 }));
      eye.position.set(sx, 0.75, 1.2); g.add(eye);
      const pup = new THREE.Mesh(new THREE.SphereGeometry(0.1, 6, 6), new THREE.MeshStandardMaterial({ color: 0x111 }));
      pup.position.set(sx, 0.8, 1.38); g.add(pup);
    }
    // Tail.
    const tail = new THREE.Mesh(new THREE.ConeGeometry(0.5, 2.0, 6), skin);
    tail.rotation.x = -Math.PI / 2; tail.position.set(0, 0.35, -2.4); g.add(tail);
    // Back ridges.
    for (let i = 0; i < 4; i++) {
      const spike = new THREE.Mesh(new THREE.ConeGeometry(0.18, 0.4, 4), skin);
      spike.position.set(0, 0.75, -1.2 + i * 0.7); g.add(spike);
    }
    return g;
  }

  // --- tick -------------------------------------------------------------------
  ability() { this.whack(); }
  jump() { this.whack(); }

  tick(dt: number, elapsed: number) {
    if (this.finished) return;
    const ctx = this.ctx;
    this.timeLeft -= dt;
    ctx.setClock(this.timeLeft);

    this.driveRaft(dt);
    this.seatPlayers();
    this.animatePaddles(elapsed);
    // Everyone paddles → contribution accrues (you a touch faster when boosting).
    for (const p of ctx.players) if (!p.dead) this.strokes[p.index] += dt * (p.you && this.boosting ? 2 : 1);

    this.tickCrocs(dt);
    this.tickBalloons(dt);
    if (this.water) (this.water.material as THREE.MeshStandardMaterial).emissiveIntensity = 0.4 + Math.sin(elapsed * 3) * 0.15;

    this.updateHud();
    tickRoster(ctx, dt, elapsed);

    // Chase camera behind the raft — pulled back so the river ahead (and the
    // crocs closing in) stays in view.
    ctx.camera.chaseBehind(this.rx, 1.2, this.rz, this.rHead, 17, 7);

    if (this.rIdx >= this.N - 4) return this.doFinish(true, 'You reached the flag — the crew survived!');
    if (this.hp <= 0) return this.doFinish(false, 'The crocs sank the raft!');
    if (this.timeLeft <= 0) return this.doFinish(false, 'Out of time on the river!');
  }

  private driveRaft(dt: number) {
    const steer = -this.ctx.input.ax;
    this.rHead += steer * TURN * dt;
    const target = (this.boosting ? BOOST : CRUISE);
    this.rSpeed += (target - this.rSpeed) * ACCEL * dt;
    const fx = Math.sin(this.rHead), fz = Math.cos(this.rHead);
    this.rx += fx * this.rSpeed * dt;
    this.rz += fz * this.rSpeed * dt;

    // Progress + channel clamp against the nearest centreline sample.
    let best = this.rIdx, bd = Infinity;
    for (let s = Math.max(0, this.rIdx - 4); s <= Math.min(this.N - 1, this.rIdx + 40); s++) {
      const c = this.path[s];
      const d = (c.x - this.rx) * (c.x - this.rx) + (c.z - this.rz) * (c.z - this.rz);
      if (d < bd) { bd = d; best = s; }
    }
    this.rIdx = best;
    const c = this.path[best];
    const dx = this.rx - c.x, dz = this.rz - c.z, dist = Math.hypot(dx, dz);
    const lim = HALF_W - RAFT_R;
    if (dist > lim && dist > 0.001) {
      this.rx = c.x + (dx / dist) * lim;
      this.rz = c.z + (dz / dist) * lim;
      this.rSpeed *= 0.9;
    }
    this.raft.position.set(this.rx, 0, this.rz);
    this.raft.rotation.y = this.rHead;
  }

  private seatPlayers() {
    const s = Math.sin(this.rHead), c = Math.cos(this.rHead);
    this.ctx.players.forEach((p, i) => {
      const [sx, sz] = SEATS[i] ?? [0, 0];
      p.x = this.rx + sx * c + sz * s;
      p.z = this.rz - sx * s + sz * c;
      p.y = 0.9;
      p.sitting = true;
      p.standFacing = this.rHead;
    });
  }

  private animatePaddles(elapsed: number) {
    const rate = this.boosting ? 12 : 6;
    this.paddles.forEach((blade, i) => {
      blade.parent!.rotation.x = Math.sin(elapsed * rate + i * 1.5) * 0.5;
    });
  }

  // --- crocodiles -------------------------------------------------------------
  private spawnCroc() {
    if (this.crocs.length >= 4) return;
    // Lurk AHEAD of and beside the raft (in view of the chase cam) so you see
    // them coming; they then turn and chase.
    const s = Math.min(this.N - 5, this.rIdx + 10 + Math.floor(Math.random() * 18));
    const c = this.path[s], h = this.heads[s];
    const px = Math.cos(h), pz = -Math.sin(h);
    const off = (Math.random() < 0.5 ? -1 : 1) * (HALF_W * 0.5 + Math.random() * HALF_W * 0.4);
    const g = this.makeCroc();
    const x = c.x + px * off, z = c.z + pz * off;
    g.position.set(x, 0, z);
    this.ctx.scene.add(g);
    this.crocs.push({ g, x, z, biteCd: 0, stunT: 0 });
  }

  private tickCrocs(dt: number) {
    // Ramp the pack up over time.
    this.crocT -= dt;
    if (this.crocT <= 0) { this.crocT = 7; this.spawnCroc(); }

    for (const cr of this.crocs) {
      const dx = this.rx - cr.x, dz = this.rz - cr.z, d = Math.hypot(dx, dz) || 1;
      cr.biteCd -= dt;
      if (cr.stunT > 0) {
        cr.stunT -= dt;
        // Stunned: drift AWAY from the raft, belly-up-ish wobble.
        cr.x -= (dx / d) * 8 * dt; cr.z -= (dz / d) * 8 * dt;
        cr.g.rotation.z = Math.sin(cr.stunT * 20) * 0.4;
      } else {
        // Chase the raft.
        cr.x += (dx / d) * CROC_SPEED * dt;
        cr.z += (dz / d) * CROC_SPEED * dt;
        cr.g.rotation.z = 0;
        // Bite when alongside.
        if (d < RAFT_R + 1.6 && cr.biteCd <= 0) {
          cr.biteCd = 1.7;
          this.hp = Math.max(0, this.hp - 12);
          SFX.bump(); this.ctx.fx.shake(1.6);
          this.ctx.fx.burst(this.rx, this.rz, '#3c6e35', 12);
          this.ctx.fx.banner('🐊 CHOMP!', '#FF4D4D');
          // Knock the raft a little.
          this.rx += (dx / d) * 1.2; this.rz += (dz / d) * 1.2; this.rSpeed *= 0.85;
        }
      }
      // Keep crocs in the channel; face their travel direction; bob in the water.
      const near = this.path[this.nearestIdx(cr.x, cr.z, cr === this.crocs[0] ? this.rIdx : this.rIdx)];
      const bx = cr.x - near.x, bz = cr.z - near.z, bl = Math.hypot(bx, bz);
      if (bl > HALF_W - 0.5) { cr.x = near.x + (bx / bl) * (HALF_W - 0.5); cr.z = near.z + (bz / bl) * (HALF_W - 0.5); }
      cr.g.position.set(cr.x, 0.05 + Math.sin(performance.now() / 400 + cr.x) * 0.06, cr.z);
      cr.g.rotation.y = Math.atan2(this.rx - cr.x, this.rz - cr.z);
    }
  }

  private nearestIdx(x: number, z: number, hint: number): number {
    let best = hint, bd = Infinity;
    for (let s = Math.max(0, hint - 30); s <= Math.min(this.N - 1, hint + 30); s++) {
      const c = this.path[s];
      const d = (c.x - x) * (c.x - x) + (c.z - z) * (c.z - z);
      if (d < bd) { bd = d; best = s; }
    }
    return best;
  }

  private whack() {
    if (this.finished) return;
    // Bonk the nearest un-stunned croc within reach; else a harmless paddle splash.
    let best: Croc | null = null, bd = 8;
    for (const cr of this.crocs) {
      if (cr.stunT > 0) continue;
      const d = Math.hypot(this.rx - cr.x, this.rz - cr.z);
      if (d < bd) { bd = d; best = cr; }
    }
    if (best) {
      best.stunT = 2.2;
      best.biteCd = Math.max(best.biteCd, 1.0);
      this.whacks++;
      SFX.hit(); this.ctx.fx.burst(best.x, best.z, '#ffe23a', 14); this.ctx.fx.shake(0.8);
      this.ctx.fx.banner('WHACK! 🪵', '#FFD23F');
    } else {
      SFX.tick();
    }
  }

  // --- time balloons ----------------------------------------------------------
  private tickBalloons(dt: number) {
    this.balloonT -= dt;
    if (this.balloonT <= 0 && this.balloons.length < 2) { this.balloonT = 6 + Math.random() * 4; this.spawnBalloon(); }
    for (let i = this.balloons.length - 1; i >= 0; i--) {
      const b = this.balloons[i];
      b.g.rotation.y += dt;
      if (Math.hypot(this.rx - b.x, this.rz - b.z) < RAFT_R + 1.4) {
        this.ctx.scene.remove(b.g);
        this.balloons.splice(i, 1);
        this.timeLeft += 6;
        SFX.gem(); this.ctx.fx.burst(b.x, b.z, '#ff5aa0', 14);
        this.ctx.fx.banner('🎈 +6s!', '#ff5aa0');
      }
    }
  }

  private spawnBalloon() {
    const s = Math.min(this.N - 8, this.rIdx + 20 + Math.floor(Math.random() * 30));
    const c = this.path[s], h = this.heads[s];
    const px = Math.cos(h), pz = -Math.sin(h);
    const off = (Math.random() - 0.5) * HALF_W * 1.2;
    const x = c.x + px * off, z = c.z + pz * off;
    const g = new THREE.Group();
    const balloon = new THREE.Mesh(new THREE.SphereGeometry(1.0, 14, 12),
      new THREE.MeshStandardMaterial({ color: 0xff5aa0, roughness: 0.4, emissive: 0x551027, emissiveIntensity: 0.4 }));
    balloon.scale.y = 1.2; balloon.position.y = 4; g.add(balloon);
    const str = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 3, 4),
      new THREE.MeshStandardMaterial({ color: 0xffffff }));
    str.position.y = 1.9; g.add(str);
    const spr = this.textSprite('+6s');
    spr.scale.set(5, 1.4, 1); spr.position.y = 6; g.add(spr);
    g.position.set(x, 0, z);
    this.ctx.scene.add(g);
    this.balloons.push({ x, z, g });
  }

  // --- HUD: paddle/whack buttons, HP bar, minimap -----------------------------
  private buildUI() {
    document.getElementById('raftUI')?.remove();
    const ui = document.createElement('div');
    ui.id = 'raftUI';
    ui.style.cssText = 'position:fixed;inset:0;z-index:8;pointer-events:none;font-family:Bungee,system-ui,sans-serif;';
    ui.innerHTML = `
      <div style="position:fixed;top:70px;left:50%;transform:translateX(-50%);display:flex;flex-direction:column;align-items:center;gap:6px;">
        <canvas id="rMap" width="150" height="150" style="width:120px;height:120px;background:rgba(10,20,34,.55);
          border:2px solid rgba(255,255,255,.35);border-radius:12px;"></canvas>
        <div style="width:150px;height:14px;background:rgba(0,0,0,.45);border:2px solid rgba(255,255,255,.4);border-radius:8px;overflow:hidden;">
          <div id="rHp" style="height:100%;width:100%;background:linear-gradient(90deg,#ff4d4d,#ffd23f,#7CF07C);transition:width .15s;"></div>
        </div>
        <div style="font-size:10px;color:#fff;letter-spacing:1px;text-shadow:0 1px 2px #000;">RAFT HEALTH</div>
      </div>
      <div data-nostick style="position:fixed;right:20px;bottom:26px;display:flex;flex-direction:column;gap:14px;align-items:center;">
        <button id="rWhack" style="pointer-events:auto;">🪵 WHACK</button>
        <button id="rPaddle" style="pointer-events:auto;">🚣 PADDLE</button>
      </div>`;
    document.body.appendChild(ui);
    const btnCss = 'font-family:Bungee,system-ui,sans-serif;font-size:18px;border:none;border-radius:16px;padding:16px 22px;color:#12142e;cursor:pointer;box-shadow:0 5px 0 rgba(0,0,0,.35);touch-action:none;user-select:none;';
    this.whackBtn = ui.querySelector('#rWhack')!;
    this.paddleBtn = ui.querySelector('#rPaddle')!;
    this.whackBtn.style.cssText += btnCss + 'background:#FFD23F;';
    this.paddleBtn.style.cssText += btnCss + 'background:#4DC3FF;';
    this.whackBtn.addEventListener('pointerdown', (e) => {
      e.preventDefault(); e.stopPropagation(); this.whack();
      this.whackBtn.style.filter = 'brightness(1.25)';
      setTimeout(() => this.whackBtn && (this.whackBtn.style.filter = ''), 120);
    });
    const down = (e: Event) => { e.preventDefault(); e.stopPropagation(); this.boosting = true; this.paddleBtn.style.filter = 'brightness(1.25)'; };
    const up = (e: Event) => { e.preventDefault(); this.boosting = false; this.paddleBtn.style.filter = ''; };
    this.paddleBtn.addEventListener('pointerdown', down);
    this.paddleBtn.addEventListener('pointerup', up);
    this.paddleBtn.addEventListener('pointerleave', up);
    this.paddleBtn.addEventListener('pointercancel', up);
    this.hpFill = ui.querySelector('#rHp')!;
    this.map = ui.querySelector('#rMap')!;
    this.mapCtx = this.map.getContext('2d')!;
  }

  private mapXY(x: number, z: number): [number, number] {
    const { minX, maxX, minZ, maxZ } = this.mapBounds;
    const w = this.map.width, h = this.map.height, pad = 10;
    return [pad + ((x - minX) / (maxX - minX)) * (w - pad * 2), pad + ((z - minZ) / (maxZ - minZ)) * (h - pad * 2)];
  }

  private updateHud() {
    if (this.hpFill) this.hpFill.style.width = Math.max(0, this.hp) + '%';
    if (!this.mapCtx) return;
    const g = this.mapCtx;
    g.clearRect(0, 0, this.map.width, this.map.height);
    g.strokeStyle = 'rgba(120,200,255,.85)'; g.lineWidth = 6; g.lineJoin = 'round';
    g.beginPath();
    for (let i = 0; i < this.N; i += 6) {
      const [mx, my] = this.mapXY(this.path[i].x, this.path[i].z);
      if (i === 0) g.moveTo(mx, my); else g.lineTo(mx, my);
    }
    g.stroke();
    const f = this.path[this.N - 4];
    const [fx, fy] = this.mapXY(f.x, f.z);
    g.fillStyle = '#fff'; g.fillRect(fx - 5, fy - 5, 10, 10);
    g.fillStyle = '#111'; g.fillRect(fx - 5, fy - 5, 5, 5); g.fillRect(fx, fy, 5, 5);
    // Crocs.
    for (const cr of this.crocs) {
      const [mx, my] = this.mapXY(cr.x, cr.z);
      g.beginPath(); g.arc(mx, my, 3, 0, Math.PI * 2);
      g.fillStyle = cr.stunT > 0 ? '#9aa' : '#3c6e35'; g.fill();
    }
    // Raft (big yellow dot).
    const [rx, ry] = this.mapXY(this.rx, this.rz);
    g.beginPath(); g.arc(rx, ry, 6, 0, Math.PI * 2);
    g.fillStyle = '#FFD23F'; g.fill();
    g.lineWidth = 2; g.strokeStyle = '#fff'; g.stroke();
  }

  private doFinish(won: boolean, sub: string) {
    if (this.finished) return;
    this.finished = true;
    document.getElementById('raftUI')?.remove();
    for (const cr of this.crocs) this.ctx.scene.remove(cr.g);
    for (const b of this.balloons) this.ctx.scene.remove(b.g);
    for (const p of this.ctx.players) p.sitting = false;
    if (won) { SFX.win(); this.ctx.fx.banner('🏁 YOU MADE IT!', '#7CF07C'); }
    else { SFX.fall(); this.ctx.fx.banner('🐊 THE RAFT WENT DOWN!', '#FF4D4D'); }
    const ctx = this.ctx;
    // Co-op: on a win the local skipper leads the crew; everyone else ranks by
    // how much they paddled + crocs whacked.
    const ranked = rankBy(ctx, (p) =>
      this.strokes[p.index] + (p.you ? this.whacks * 4 + (won ? 1e7 : 0) : 0));
    ctx.players.forEach((p) => {
      (p as any)._res = won ? '🏁 Survived' : 'Sank';
    });
    ctx.finish(ranked, sub);
  }
}
