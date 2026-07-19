import * as THREE from 'three';
import { setupRoster, tickRoster, rankBy } from '../freeroam';
import type { GameModule, MatchContext } from '../context';
import { matchTime } from '../../core/tuning';
import { SFX } from '../../core/audio';
import { setScore } from '../../ui/hud';

// CROC RIVER RAFT (Sky tier 1) — a CO-OP river run inspired by Mario Party's
// River Survival. All four heroes ride ONE big raft, TWO in front and TWO in the
// back. You PADDLE it yourself with LEFT/RIGHT strokes (kayak-style): paddle both
// sides to surge straight, one side to steer — there's no automatic speed, so
// keep paddling. Easy crocodiles bump you (they can't sink you). Blast through
// the rapids and OVER THE WATERFALL — but paddle FAST there or you flip. Reach
// the checkered flag before the clock runs out.

interface Croc { g: THREE.Group; x: number; z: number; biteCd: number; stunT: number; }

const STROKE_THRUST = 3.6;   // forward speed added per paddle stroke
const MAX_SPEED = 21;
const DRAG = 1.15;           // speed bleeds off when you stop paddling
const STROKE_TURN = 0.3;     // yaw added by a one-sided stroke
const HOLD_INTERVAL = 0.24;  // auto-stroke cadence while a paddle is held
const HALF_W = 12;
const RAFT_R = 3.8;
const CROC_SPEED = 10;       // slow & easy
const FALL_DUR = 1.4;
const DROP = 7;

// Seats: 0,1 FRONT (row +z), 2,3 BACK (row -z).
const SEATS: [number, number][] = [[-1.3, 1.8], [1.3, 1.8], [-1.3, -1.8], [1.3, -1.8]];

export class RaftGame implements GameModule {
  readonly stickMode = 'none' as const;
  title = 'Croc River Raft';
  objective = '🚣 Paddle LEFT + RIGHT to the flag — ride the falls!';

  private ctx!: MatchContext;
  private timeLeft = 50;
  private finished = false;

  private path: THREE.Vector3[] = [];
  private heads: number[] = [];
  private N = 0;
  private waterGeo!: THREE.BufferGeometry;
  private waterBase!: Float32Array;
  private frame = 0;

  private raft!: THREE.Group;
  private paddlesL: THREE.Object3D[] = [];
  private paddlesR: THREE.Object3D[] = [];
  private rx = 0; private rz = 0; private rHead = 0; private rSpeed = 0; private rIdx = 3;
  private raftY = 0;
  private strokes: number[] = [];

  private leftHeld = false; private rightHeld = false;
  private leftT = 0; private rightT = 0;
  private animL = 0; private animR = 0;

  private crocs: Croc[] = [];
  private crocT = 4;

  // Waterfall / rapids challenge.
  private paddlePower = 100;
  private rapidsLo = 0; private rapidsHi = 0; private fallsIdx = 0;
  private rapidsWarned = false;
  private fallState: 'none' | 'falling' | 'done' = 'none';
  private fallT = 0;

  private leftBtn!: HTMLButtonElement;
  private rightBtn!: HTMLButtonElement;
  private powerFill!: HTMLElement;
  private map!: HTMLCanvasElement;
  private mapCtx!: CanvasRenderingContext2D;
  private mapBounds = { minX: 0, maxX: 1, minZ: 0, maxZ: 1 };

  init(ctx: MatchContext) {
    this.ctx = ctx;
    this.title = ctx.game.name;
    this.finished = false;
    this.timeLeft = matchTime(50);
    this.crocs = []; this.crocT = 4;
    this.frame = 0; this.paddlePower = 100; this.rapidsWarned = false;
    this.fallState = 'none'; this.fallT = 0; this.raftY = 0;
    this.leftHeld = this.rightHeld = false; this.leftT = this.rightT = 0; this.animL = this.animR = 0;

    ctx.scene.fog = new THREE.Fog(new THREE.Color(0xbfe0ff).getHex(), 160, 520);

    this.buildCourse();
    setupRoster(ctx, '🚣', 0.5);
    this.buildUI();

    this.rIdx = 3;
    const c = this.path[this.rIdx];
    this.rx = c.x; this.rz = c.z; this.rHead = this.heads[this.rIdx]; this.rSpeed = 0;
    this.raft = this.makeRaft();
    ctx.scene.add(this.raft);

    this.strokes = [];
    ctx.players.forEach((p) => {
      this.strokes[p.index] = 0;
      p.sitting = true; p.vx = 0; p.vz = 0; p.y = 0.9;
      setScore(p, '🚣');
    });
    this.seatPlayers();

    this.spawnCroc();
    ctx.fx.banner('PADDLE! 🚣 LEFT + RIGHT', '#4DC3FF');
  }

  // --- organic river (no zigzag, no overlaps) ---------------------------------
  private genControlPoints(): THREE.Vector3[] {
    const pts: THREE.Vector3[] = [];
    const steps = 9, z0 = 95, z1 = -95;
    const dz = Math.abs((z1 - z0) / steps);
    let x = 0;
    for (let i = 0; i <= steps; i++) {
      const z = z0 + (z1 - z0) * (i / steps);
      if (i <= 1) x = 0;
      else if (i >= steps - 1) x = x * 0.4;
      else x = Math.max(-40, Math.min(40, x + (Math.random() - 0.5) * 2 * (dz * 0.9)));
      pts.push(new THREE.Vector3(x, 0, z));
    }
    return pts;
  }

  private inRiver(x: number, z: number, margin: number): boolean {
    for (let s = 0; s < this.N; s += 2) {
      const c = this.path[s];
      if (Math.hypot(c.x - x, c.z - z) < HALF_W + margin) return true;
    }
    return false;
  }

  private buildCourse() {
    const scene = this.ctx.scene;
    const curve = new THREE.CatmullRomCurve3(this.genControlPoints(), false, 'centripetal');
    this.path = curve.getPoints(499);
    this.N = this.path.length;
    this.heads = this.path.map((_, i) => {
      const a = this.path[Math.max(0, i - 1)];
      const b = this.path[Math.min(this.N - 1, i + 1)];
      return Math.atan2(b.x - a.x, b.z - a.z);
    });
    this.rapidsLo = Math.floor(this.N * 0.46);
    this.fallsIdx = Math.floor(this.N * 0.58);
    this.rapidsHi = this.fallsIdx;

    // Banks + shore foam.
    const edgeL: THREE.Vector3[] = [], edgeR: THREE.Vector3[] = [];
    const bankL: THREE.Vector3[] = [], bankR: THREE.Vector3[] = [];
    for (let i = 0; i < this.N; i++) {
      const c = this.path[i], h = this.heads[i], px = Math.cos(h), pz = -Math.sin(h);
      edgeL.push(new THREE.Vector3(c.x - px * HALF_W, 0.32, c.z - pz * HALF_W));
      edgeR.push(new THREE.Vector3(c.x + px * HALF_W, 0.32, c.z + pz * HALF_W));
      bankL.push(new THREE.Vector3(c.x - px * (HALF_W + 7), 0.9, c.z - pz * (HALF_W + 7)));
      bankR.push(new THREE.Vector3(c.x + px * (HALF_W + 7), 0.9, c.z + pz * (HALF_W + 7)));
    }
    const bankMat = new THREE.MeshStandardMaterial({ color: 0xb99866, roughness: 1 });
    scene.add(this.ribbon(bankL, edgeL, bankMat));
    scene.add(this.ribbon(edgeR, bankR, bankMat));
    const foamMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6, emissive: 0x334455, emissiveIntensity: 0.4, transparent: true, opacity: 0.8 });
    const foam = (edge: THREE.Vector3[], dir: number) =>
      edge.map((v, i) => { const h = this.heads[i]; return new THREE.Vector3(v.x + Math.cos(h) * dir * 1.1, 0.4, v.z - Math.sin(h) * dir * 1.1); });
    scene.add(this.ribbon(foam(edgeL, 1), edgeL, foamMat));
    scene.add(this.ribbon(edgeR, foam(edgeR, -1), foamMat));

    this.buildWater();

    // Bank forest — validated so nothing lands in the water.
    for (let i = 8; i < this.N - 8; i += 6) {
      for (const side of [-1, 1]) {
        if (Math.random() < 0.25) continue;
        const c = this.path[i], h = this.heads[i], px = Math.cos(h), pz = -Math.sin(h);
        const off = HALF_W + 9 + Math.random() * 22;
        const tx = c.x + px * off * side, tz = c.z + pz * off * side;
        if (this.inRiver(tx, tz, 3)) continue;
        this.addTree(tx, tz);
      }
    }

    this.buildMountains();
    this.buildWaterfall();
    this.buildFinish();

    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const c of this.path) {
      minX = Math.min(minX, c.x); maxX = Math.max(maxX, c.x);
      minZ = Math.min(minZ, c.z); maxZ = Math.max(maxZ, c.z);
    }
    const pad = HALF_W + 8;
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
    geo.setIndex(idx); geo.computeVertexNormals();
    const m = new THREE.Mesh(geo, mat); m.receiveShadow = true;
    return m;
  }

  /** Flowing (non-flat) water: a 3-column strip displaced by travelling waves. */
  private buildWater() {
    const cols = 3;
    const pos = new Float32Array(this.N * cols * 3);
    for (let i = 0; i < this.N; i++) {
      const c = this.path[i], h = this.heads[i], px = Math.cos(h), pz = -Math.sin(h);
      for (let j = 0; j < cols; j++) {
        const t = j - 1, vi = (i * cols + j) * 3;
        pos[vi] = c.x + px * HALF_W * t; pos[vi + 1] = 0.32; pos[vi + 2] = c.z + pz * HALF_W * t;
      }
    }
    const idx: number[] = [];
    for (let i = 0; i < this.N - 1; i++) for (let j = 0; j < cols - 1; j++) {
      const a0 = i * cols + j, b0 = i * cols + j + 1, a1 = (i + 1) * cols + j, b1 = (i + 1) * cols + j + 1;
      idx.push(a0, a1, b0, b0, a1, b1);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setIndex(idx); geo.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({ color: 0x2b8fe0, roughness: 0.18, metalness: 0.4, emissive: 0x1466a8, emissiveIntensity: 0.55 });
    const mesh = new THREE.Mesh(geo, mat); mesh.receiveShadow = true;
    this.ctx.scene.add(mesh);
    this.waterGeo = geo; this.waterBase = pos.slice();
  }

  private animateWater(elapsed: number) {
    const pos = this.waterGeo.attributes.position.array as Float32Array;
    const base = this.waterBase, cols = 3;
    for (let i = 0; i < this.N; i++) {
      const rapids = i >= this.rapidsLo && i <= this.rapidsHi;
      const amp = rapids ? 0.7 : 0.28;
      for (let j = 0; j < cols; j++) {
        const vi = (i * cols + j) * 3;
        pos[vi + 1] = base[vi + 1] + Math.sin(elapsed * 2.4 - i * 0.22 + j * 0.7) * amp + Math.sin(elapsed * 3.4 + i * 0.12) * amp * 0.4;
      }
    }
    this.waterGeo.attributes.position.needsUpdate = true;
    if (this.frame % 6 === 0) this.waterGeo.computeVertexNormals();
  }

  private addTree(x: number, z: number) {
    const g = new THREE.Group();
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.6, 3.2, 6),
      new THREE.MeshStandardMaterial({ color: 0x6b4a2a, roughness: 1 }));
    trunk.position.y = 1.6; trunk.castShadow = true; g.add(trunk);
    const green = new THREE.MeshStandardMaterial({ color: 0x2c6b34, roughness: 1, flatShading: true });
    for (let i = 0; i < 3; i++) {
      const cone = new THREE.Mesh(new THREE.ConeGeometry(2.6 - i * 0.6, 2.6, 7), green);
      cone.position.y = 3.3 + i * 1.4; cone.castShadow = true; g.add(cone);
    }
    g.position.set(x, 0.5, z); g.rotation.y = Math.random() * 6; g.scale.setScalar(0.9 + Math.random() * 0.8);
    this.ctx.scene.add(g);
  }

  private buildMountains() {
    const scene = this.ctx.scene;
    const rock = new THREE.MeshStandardMaterial({ color: 0x6d6a72, roughness: 1, flatShading: true });
    const snow = new THREE.MeshStandardMaterial({ color: 0xf2f6ff, roughness: 0.9, flatShading: true });
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2 + 0.4, r = 150 + Math.random() * 80;
      const hgt = 50 + Math.random() * 60, rad = 28 + Math.random() * 22;
      const m = new THREE.Mesh(new THREE.ConeGeometry(rad, hgt, 6), rock);
      m.position.set(Math.cos(a) * r, hgt / 2 - 6, Math.sin(a) * r); m.rotation.y = Math.random() * 6; scene.add(m);
      const cap = new THREE.Mesh(new THREE.ConeGeometry(rad * 0.42, hgt * 0.3, 6), snow);
      cap.position.set(m.position.x, hgt * 0.85 - 6, m.position.z); cap.rotation.y = m.rotation.y; scene.add(cap);
    }
  }

  /** A cliff + cascading waterfall at the drop point (cosmetic — the raft does a
   *  scripted plunge here). Framed by rocky bluffs. */
  private buildWaterfall() {
    const scene = this.ctx.scene;
    const c = this.path[this.fallsIdx], h = this.heads[this.fallsIdx], px = Math.cos(h), pz = -Math.sin(h);
    const rockMat = new THREE.MeshStandardMaterial({ color: 0x6a6360, roughness: 1, flatShading: true });
    // Rocky bluffs flanking the falls.
    for (const side of [-1, 1]) {
      const bluff = new THREE.Mesh(new THREE.BoxGeometry(16, 20, 12), rockMat);
      bluff.position.set(c.x + px * (HALF_W + 8) * side, 6, c.z + pz * (HALF_W + 8) * side);
      bluff.rotation.y = h; bluff.castShadow = true; scene.add(bluff);
    }
    // The cascade: a wide translucent white sheet dropping below the lip.
    const fallMat = new THREE.MeshStandardMaterial({ color: 0xdaf2ff, roughness: 0.1, metalness: 0.2, transparent: true, opacity: 0.75, emissive: 0x8fc8ff, emissiveIntensity: 0.5, side: THREE.DoubleSide });
    const sheet = new THREE.Mesh(new THREE.PlaneGeometry(HALF_W * 2, DROP + 2), fallMat);
    sheet.position.set(c.x - Math.sin(h) * 1, -DROP / 2 + 0.3, c.z - Math.cos(h) * 1);
    sheet.rotation.y = h + Math.PI / 2; sheet.rotation.x = 0.12; scene.add(sheet);
    // Foam pool at the base.
    const pool = new THREE.Mesh(new THREE.CircleGeometry(HALF_W, 20),
      new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5, transparent: true, opacity: 0.4, emissive: 0x99bbcc, emissiveIntensity: 0.4 }));
    pool.rotation.x = -Math.PI / 2; pool.position.set(c.x - Math.sin(h) * 4, 0.45, c.z - Math.cos(h) * 4); scene.add(pool);
  }

  private buildFinish() {
    const scene = this.ctx.scene;
    const iFin = this.N - 4, c = this.path[iFin], h = this.heads[iFin], px = Math.cos(h), pz = -Math.sin(h);
    const cols = 8, cw = (HALF_W * 2) / cols;
    for (let r = 0; r < 2; r++) for (let col = 0; col < cols; col++) {
      const off = (col - (cols - 1) / 2) * cw, along = (r - 0.5) * cw, white = (r + col) % 2 === 0;
      const tile = new THREE.Mesh(new THREE.BoxGeometry(cw, 0.1, cw),
        new THREE.MeshStandardMaterial({ color: white ? 0xffffff : 0x111111, roughness: 0.7 }));
      tile.position.set(c.x + px * off + Math.sin(h) * along, 0.36, c.z + pz * off + Math.cos(h) * along);
      tile.rotation.y = h; scene.add(tile);
    }
    const poleMat = new THREE.MeshStandardMaterial({ color: 0xdedede, roughness: 0.6, metalness: 0.3 });
    for (const side of [-1, 1]) {
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 14, 10), poleMat);
      pole.position.set(c.x + px * (HALF_W + 1.5) * side, 7, c.z + pz * (HALF_W + 1.5) * side); pole.castShadow = true; scene.add(pole);
    }
    const bcols = 14, brows = 3, bcw = ((HALF_W + 1.5) * 2) / bcols, bch = 1.5;
    const banner = new THREE.Group();
    for (let r = 0; r < brows; r++) for (let col = 0; col < bcols; col++) {
      const white = (r + col) % 2 === 0;
      const tile = new THREE.Mesh(new THREE.PlaneGeometry(bcw, bch),
        new THREE.MeshStandardMaterial({ color: white ? 0xffffff : 0x111111, roughness: 0.8, side: THREE.DoubleSide }));
      tile.position.set((col - (bcols - 1) / 2) * bcw, (brows - 1) / 2 * bch - r * bch, 0); banner.add(tile);
    }
    banner.position.set(c.x, 11, c.z); banner.rotation.y = h + Math.PI / 2; scene.add(banner);
    const spr = this.textSprite('🏁 FINISH 🏁'); spr.position.set(c.x, 13.6, c.z); scene.add(spr);
  }

  private textSprite(txt: string): THREE.Sprite {
    const c = document.createElement('canvas'); c.width = 512; c.height = 128;
    const x = c.getContext('2d')!;
    x.font = '900 60px Bungee, system-ui, sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillStyle = '#fff'; x.strokeStyle = '#12142e'; x.lineWidth = 8; x.strokeText(txt, 256, 70); x.fillText(txt, 256, 70);
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
    sp.scale.set(14, 3.5, 1); return sp;
  }

  // --- raft + croc models -----------------------------------------------------
  private makeRaft(): THREE.Group {
    const g = new THREE.Group();
    const red = new THREE.MeshStandardMaterial({ color: 0xd83b3b, roughness: 0.5 });
    const white = new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.5 });
    const blue = new THREE.MeshStandardMaterial({ color: 0x3b7bd8, roughness: 0.6 });
    // Bigger inflatable ring (fits two rows of two).
    const rx = 3.2, rz = 4.4;
    for (let i = 0; i < 22; i++) {
      const a = (i / 22) * Math.PI * 2;
      const seg = new THREE.Mesh(new THREE.SphereGeometry(1.0, 8, 8), i % 2 ? red : white);
      seg.position.set(Math.cos(a) * rx, 0.75, Math.sin(a) * rz); seg.scale.set(1, 0.8, 1); g.add(seg);
    }
    const floor = new THREE.Mesh(new THREE.CylinderGeometry(rx, rx, 0.22, 22), blue);
    floor.scale.z = rz / rx; floor.position.y = 0.58; g.add(floor);
    // Paddles per seat (left seats paddle left, right seats paddle right).
    this.paddlesL = []; this.paddlesR = [];
    SEATS.forEach(([sx, sz]) => {
      const pad = new THREE.Group();
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 2.6, 6),
        new THREE.MeshStandardMaterial({ color: 0xcaa46a, roughness: 0.8 }));
      shaft.position.y = -0.7; shaft.rotation.z = (Math.PI / 2) * (sx < 0 ? -1 : 1); pad.add(shaft);
      const blade = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.95, 0.08), red);
      blade.position.set((sx < 0 ? -1 : 1) * 2.0, -1.0, 0); pad.add(blade);
      pad.position.set(sx, 1.6, sz); g.add(pad);
      (sx < 0 ? this.paddlesL : this.paddlesR).push(pad);
    });
    g.castShadow = true; return g;
  }

  private makeCroc(): THREE.Group {
    const g = new THREE.Group();
    const skin = new THREE.MeshStandardMaterial({ color: 0x3c6e35, roughness: 0.9, flatShading: true });
    const belly = new THREE.MeshStandardMaterial({ color: 0x86a05a, roughness: 0.9 });
    const body = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.7, 3.4), skin); body.position.y = 0.35; body.castShadow = true; g.add(body);
    const upper = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.35, 1.6), skin); upper.position.set(0, 0.5, 2.2); g.add(upper);
    const lower = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.25, 1.5), belly); lower.position.set(0, 0.18, 2.2); g.add(lower);
    for (const sx of [-0.35, 0.35]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.22, 8, 8),
        new THREE.MeshStandardMaterial({ color: 0xffe23a, emissive: 0x554400, emissiveIntensity: 0.5 }));
      eye.position.set(sx, 0.75, 1.2); g.add(eye);
    }
    const tail = new THREE.Mesh(new THREE.ConeGeometry(0.5, 2.0, 6), skin); tail.rotation.x = -Math.PI / 2; tail.position.set(0, 0.35, -2.4); g.add(tail);
    return g;
  }

  // --- paddling ---------------------------------------------------------------
  private stroke(side: 'L' | 'R') {
    if (this.finished || this.fallState === 'falling') return;
    this.rSpeed = Math.min(MAX_SPEED, this.rSpeed + STROKE_THRUST);
    this.rHead += (side === 'L' ? 1 : -1) * STROKE_TURN; // paddle left → turn right
    this.paddlePower = Math.min(100, this.paddlePower + 15);
    this.strokes[0] = (this.strokes[0] ?? 0) + 1;
    if (side === 'L') this.animL = 1; else this.animR = 1;
    if (Math.random() < 0.5) SFX.tick();
  }

  // Paddling is driven entirely by the LEFT/RIGHT buttons; the corner-tap
  // "ability" is a no-op so a tap on the RIGHT button (which sits in that corner)
  // doesn't fire a second stroke.
  ability() {}

  // --- tick -------------------------------------------------------------------
  tick(dt: number, elapsed: number) {
    if (this.finished) return;
    const ctx = this.ctx;
    this.frame++;
    this.timeLeft -= dt;
    ctx.setClock(this.timeLeft);

    // Held paddles auto-stroke at a steady cadence (tapping faster beats it).
    if (this.leftHeld) { this.leftT -= dt; if (this.leftT <= 0) { this.leftT = HOLD_INTERVAL; this.stroke('L'); } }
    if (this.rightHeld) { this.rightT -= dt; if (this.rightT <= 0) { this.rightT = HOLD_INTERVAL; this.stroke('R'); } }

    this.driveRaft(dt);
    this.seatPlayers();
    this.animatePaddles(dt);
    for (const p of ctx.players.slice(1)) if (!p.dead) this.strokes[p.index] += dt * 0.5;

    this.tickCrocs(dt);
    this.tickRapids(dt);
    this.animateWater(elapsed);

    this.updateHud();
    tickRoster(ctx, dt, elapsed);

    // Zoomed-OUT chase cam so you can see the river and the crocs.
    ctx.camera.chaseBehind(this.rx, this.raftY + 1.4, this.rz, this.rHead, 24, 13);

    if (this.fallState !== 'falling' && this.rIdx >= this.N - 4) return this.doFinish(true, 'You reached the flag — the crew made it!');
    if (this.timeLeft <= 0) return this.doFinish(false, 'Out of time on the river!');
  }

  private driveRaft(dt: number) {
    if (this.fallState === 'falling') {
      // Scripted plunge over the falls — no control, big forward carry.
      this.fallT += dt;
      const t = Math.min(1, this.fallT / FALL_DUR);
      this.raftY = -Math.sin(t * Math.PI) * DROP;
      this.rSpeed = Math.max(this.rSpeed, 16);
    } else {
      this.rSpeed = Math.max(0, this.rSpeed - this.rSpeed * DRAG * dt); // drag: keep paddling!
      this.raftY += (0 - this.raftY) * 6 * dt;
    }
    const fx = Math.sin(this.rHead), fz = Math.cos(this.rHead);
    this.rx += fx * this.rSpeed * dt; this.rz += fz * this.rSpeed * dt;

    let best = this.rIdx, bd = Infinity;
    for (let s = Math.max(0, this.rIdx - 4); s <= Math.min(this.N - 1, this.rIdx + 40); s++) {
      const c = this.path[s]; const d = (c.x - this.rx) ** 2 + (c.z - this.rz) ** 2;
      if (d < bd) { bd = d; best = s; }
    }
    this.rIdx = best;
    const c = this.path[best];
    const dx = this.rx - c.x, dz = this.rz - c.z, dist = Math.hypot(dx, dz), lim = HALF_W - RAFT_R;
    if (dist > lim && dist > 0.001) {
      this.rx = c.x + (dx / dist) * lim; this.rz = c.z + (dz / dist) * lim;
      if (this.fallState !== 'falling') this.rSpeed *= 0.9;
    }
    this.raft.position.set(this.rx, this.raftY, this.rz);
    this.raft.rotation.y = this.rHead;
    this.raft.rotation.x = this.fallState === 'falling' ? Math.min(0.5, this.fallT * 0.6) : Math.sin(performance.now() / 500) * 0.03;
  }

  private seatPlayers() {
    const s = Math.sin(this.rHead), c = Math.cos(this.rHead);
    this.ctx.players.forEach((p, i) => {
      const [sx, sz] = SEATS[i] ?? [0, 0];
      p.x = this.rx + sx * c + sz * s;
      p.z = this.rz - sx * s + sz * c;
      p.y = 0.9 + this.raftY;
      p.sitting = true; p.standFacing = this.rHead;
    });
  }

  private animatePaddles(dt: number) {
    this.animL = Math.max(0, this.animL - dt * 3.5);
    this.animR = Math.max(0, this.animR - dt * 3.5);
    for (const pad of this.paddlesL) pad.rotation.x = -Math.sin(this.animL * Math.PI) * 0.9;
    for (const pad of this.paddlesR) pad.rotation.x = -Math.sin(this.animR * Math.PI) * 0.9;
  }

  // --- rapids + waterfall ------------------------------------------------------
  private tickRapids(dt: number) {
    const inRapids = this.rIdx >= this.rapidsLo && this.rIdx < this.fallsIdx && this.fallState === 'none';
    if (inRapids) {
      if (!this.rapidsWarned) { this.rapidsWarned = true; this.ctx.fx.banner('🌊 RAPIDS! PADDLE FAST!', '#ffe66d'); }
      // A forward current speeds you up, but the power meter drains fast — keep
      // clicking both paddles or you flip.
      this.rSpeed = Math.min(MAX_SPEED, this.rSpeed + 6 * dt);
      this.paddlePower = Math.max(0, this.paddlePower - 30 * dt);
      if (this.paddlePower <= 0) return this.doFinish(false, "You didn't paddle hard enough — the rapids flipped the raft!");
    } else if (this.fallState === 'none') {
      this.paddlePower = Math.min(100, this.paddlePower + 12 * dt);
    }
    // Trigger the plunge at the lip.
    if (this.fallState === 'none' && this.rIdx >= this.fallsIdx) {
      this.fallState = 'falling'; this.fallT = 0;
      this.ctx.fx.banner('🌊 OVER THE FALLS!', '#bfe6ff'); SFX.fall(); this.ctx.fx.shake(1.6);
    }
    if (this.fallState === 'falling' && this.fallT >= FALL_DUR) {
      this.fallState = 'done'; this.raftY = 0;
      this.rSpeed = Math.max(this.rSpeed, 18);
      this.ctx.fx.burst(this.rx, this.rz, '#eaf6ff', 26); SFX.gem(); this.ctx.fx.shake(1.2);
      this.ctx.fx.banner('🌊 SPLASH! nice ride!', '#7CF07C');
    }
  }

  // --- crocodiles (easy, non-lethal) ------------------------------------------
  private spawnCroc() {
    if (this.crocs.length >= 2) return; // few & easy
    const s = Math.min(this.N - 5, this.rIdx + 12 + Math.floor(Math.random() * 16));
    const c = this.path[s], h = this.heads[s], px = Math.cos(h), pz = -Math.sin(h);
    const off = (Math.random() < 0.5 ? -1 : 1) * (HALF_W * 0.45 + Math.random() * HALF_W * 0.3);
    const g = this.makeCroc(); const x = c.x + px * off, z = c.z + pz * off;
    g.position.set(x, 0, z); this.ctx.scene.add(g);
    this.crocs.push({ g, x, z, biteCd: 0, stunT: 0 });
  }

  private tickCrocs(dt: number) {
    this.crocT -= dt;
    if (this.crocT <= 0) { this.crocT = 10; this.spawnCroc(); }
    for (const cr of this.crocs) {
      const dx = this.rx - cr.x, dz = this.rz - cr.z, d = Math.hypot(dx, dz) || 1;
      cr.biteCd -= dt;
      // Amble toward the raft slowly; bump it (a shove + a little slow) but NEVER
      // sink it — just a friendly nibble.
      cr.x += (dx / d) * CROC_SPEED * dt; cr.z += (dz / d) * CROC_SPEED * dt;
      if (d < RAFT_R + 1.4 && cr.biteCd <= 0 && this.fallState !== 'falling') {
        cr.biteCd = 2.2;
        this.rSpeed *= 0.8;
        this.rx += (dx / d) * 1.4; this.rz += (dz / d) * 1.4;
        SFX.bump(); this.ctx.fx.burst(this.rx, this.rz, '#3c6e35', 8);
        this.ctx.fx.banner('🐊 nibble!', '#86a05a');
        // Shove the croc off so it doesn't cling.
        cr.x -= (dx / d) * 4; cr.z -= (dz / d) * 4;
      }
      const near = this.path[this.nearestIdx(cr.x, cr.z, this.rIdx)];
      const bx = cr.x - near.x, bz = cr.z - near.z, bl = Math.hypot(bx, bz);
      if (bl > HALF_W - 0.5) { cr.x = near.x + (bx / bl) * (HALF_W - 0.5); cr.z = near.z + (bz / bl) * (HALF_W - 0.5); }
      cr.g.position.set(cr.x, 0.05 + Math.sin(performance.now() / 400 + cr.x) * 0.06, cr.z);
      cr.g.rotation.y = Math.atan2(this.rx - cr.x, this.rz - cr.z);
    }
  }

  private nearestIdx(x: number, z: number, hint: number): number {
    let best = hint, bd = Infinity;
    for (let s = Math.max(0, hint - 26); s <= Math.min(this.N - 1, hint + 26); s++) {
      const c = this.path[s]; const d = (c.x - x) ** 2 + (c.z - z) ** 2;
      if (d < bd) { bd = d; best = s; }
    }
    return best;
  }

  // --- HUD --------------------------------------------------------------------
  private buildUI() {
    document.getElementById('raftUI')?.remove();
    const ui = document.createElement('div');
    ui.id = 'raftUI';
    ui.style.cssText = 'position:fixed;inset:0;z-index:8;pointer-events:none;font-family:Bungee,system-ui,sans-serif;';
    ui.innerHTML = `
      <div style="position:fixed;top:70px;left:50%;transform:translateX(-50%);display:flex;flex-direction:column;align-items:center;gap:6px;">
        <canvas id="rMap" width="150" height="150" style="width:112px;height:112px;background:rgba(10,20,34,.55);border:2px solid rgba(255,255,255,.35);border-radius:12px;"></canvas>
        <div style="width:150px;height:14px;background:rgba(0,0,0,.45);border:2px solid rgba(255,255,255,.4);border-radius:8px;overflow:hidden;">
          <div id="rPow" style="height:100%;width:100%;background:linear-gradient(90deg,#ff4d4d,#ffd23f,#4DC3FF);transition:width .1s;"></div>
        </div>
        <div style="font-size:10px;color:#fff;letter-spacing:1px;text-shadow:0 1px 2px #000;">PADDLE POWER</div>
      </div>
      <button id="rLeft"  data-nostick style="pointer-events:auto;position:fixed;left:20px;bottom:26px;">◀ LEFT</button>
      <button id="rRight" data-nostick style="pointer-events:auto;position:fixed;right:20px;bottom:26px;">RIGHT ▶</button>`;
    document.body.appendChild(ui);
    const btnCss = 'font-family:Bungee,system-ui,sans-serif;font-size:20px;border:none;border-radius:18px;padding:20px 26px;color:#12142e;background:#4DC3FF;cursor:pointer;box-shadow:0 5px 0 rgba(0,0,0,.35);touch-action:none;user-select:none;';
    this.leftBtn = ui.querySelector('#rLeft')!;
    this.rightBtn = ui.querySelector('#rRight')!;
    this.leftBtn.style.cssText += btnCss;
    this.rightBtn.style.cssText += btnCss;
    const wire = (btn: HTMLButtonElement, side: 'L' | 'R') => {
      const down = (e: Event) => {
        e.preventDefault(); e.stopPropagation();
        this.stroke(side);
        if (side === 'L') { this.leftHeld = true; this.leftT = HOLD_INTERVAL; } else { this.rightHeld = true; this.rightT = HOLD_INTERVAL; }
        btn.style.filter = 'brightness(1.3)';
      };
      const up = (e: Event) => { e.preventDefault(); if (side === 'L') this.leftHeld = false; else this.rightHeld = false; btn.style.filter = ''; };
      btn.addEventListener('pointerdown', down);
      btn.addEventListener('pointerup', up);
      btn.addEventListener('pointerleave', up);
      btn.addEventListener('pointercancel', up);
    };
    wire(this.leftBtn, 'L'); wire(this.rightBtn, 'R');
    this.powerFill = ui.querySelector('#rPow')!;
    this.map = ui.querySelector('#rMap')!;
    this.mapCtx = this.map.getContext('2d')!;
  }

  private mapXY(x: number, z: number): [number, number] {
    const { minX, maxX, minZ, maxZ } = this.mapBounds;
    const w = this.map.width, h = this.map.height, pad = 10;
    return [pad + ((x - minX) / (maxX - minX)) * (w - pad * 2), pad + ((z - minZ) / (maxZ - minZ)) * (h - pad * 2)];
  }

  private updateHud() {
    if (this.powerFill) this.powerFill.style.width = Math.max(0, this.paddlePower) + '%';
    if (!this.mapCtx) return;
    const g = this.mapCtx;
    g.clearRect(0, 0, this.map.width, this.map.height);
    g.strokeStyle = 'rgba(120,200,255,.85)'; g.lineWidth = 5; g.lineJoin = 'round';
    g.beginPath();
    for (let i = 0; i < this.N; i += 6) { const [mx, my] = this.mapXY(this.path[i].x, this.path[i].z); if (i === 0) g.moveTo(mx, my); else g.lineTo(mx, my); }
    g.stroke();
    // Waterfall marker.
    const wf = this.path[this.fallsIdx]; const [wx, wy] = this.mapXY(wf.x, wf.z);
    g.fillStyle = '#bfe6ff'; g.beginPath(); g.arc(wx, wy, 4, 0, Math.PI * 2); g.fill();
    const f = this.path[this.N - 4]; const [fx, fy] = this.mapXY(f.x, f.z);
    g.fillStyle = '#fff'; g.fillRect(fx - 4, fy - 4, 8, 8); g.fillStyle = '#111'; g.fillRect(fx - 4, fy - 4, 4, 4); g.fillRect(fx, fy, 4, 4);
    for (const cr of this.crocs) { const [mx, my] = this.mapXY(cr.x, cr.z); g.beginPath(); g.arc(mx, my, 3, 0, Math.PI * 2); g.fillStyle = '#3c6e35'; g.fill(); }
    const [rx, ry] = this.mapXY(this.rx, this.rz);
    g.beginPath(); g.arc(rx, ry, 6, 0, Math.PI * 2); g.fillStyle = '#FFD23F'; g.fill();
    g.lineWidth = 2; g.strokeStyle = '#fff'; g.stroke();
  }

  private doFinish(won: boolean, sub: string) {
    if (this.finished) return;
    this.finished = true;
    document.getElementById('raftUI')?.remove();
    for (const cr of this.crocs) this.ctx.scene.remove(cr.g);
    for (const p of this.ctx.players) p.sitting = false;
    if (won) { SFX.win(); this.ctx.fx.banner('🏁 YOU MADE IT!', '#7CF07C'); }
    else { SFX.fall(); this.ctx.fx.banner('🚣 WIPEOUT!', '#FF4D4D'); }
    const ctx = this.ctx;
    const ranked = rankBy(ctx, (p) => this.strokes[p.index] + (p.you ? (won ? 1e7 : 0) : 0));
    ctx.players.forEach((p) => { (p as any)._res = won ? '🏁 Made it' : 'Wiped out'; });
    ctx.finish(ranked, sub);
  }
}
