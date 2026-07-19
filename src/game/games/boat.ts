import * as THREE from 'three';
import type { GameModule, MatchContext } from '../context';
import type { Player } from '../player';
import { setupRoster, tickRoster, rankBy } from '../freeroam';
import { matchTime } from '../../core/tuning';
import { SFX } from '../../core/audio';
import { setScore } from '../../ui/hud';

// RIVER RUSH — BOAT KART ARENA (Wildwood tier 1). A third-person boat race down
// one long, winding forest river that flows through distinct sections: a calm
// launch, forest S-curves, foaming RAPIDS with moving rocks, a GIANT WAVE that
// surges back at you, a SPLIT island (wide/safe vs tight/boost), a final push
// past BOOST PADS, and a CASTLE finish. Flowing (non-flat) animated water, dense
// bank forest, distant snow peaks. Hold SPEED to floor it, weave for weapons,
// ram rivals. First across the castle gate wins; else furthest at the buzzer.

type Item = 'rocket' | 'oil' | 'boost' | 'emp' | 'ice';
const ITEM_EMOJI: Record<Item, string> = { rocket: '🚀', oil: '🛢️', boost: '👟', emp: '⚡', ice: '🧊' };
const ALL_ITEMS: Item[] = ['rocket', 'oil', 'boost', 'emp', 'ice'];

interface Pickup { x: number; z: number; kind: Item; group: THREE.Group; }
interface Oil { x: number; z: number; group: THREE.Group; }
interface Shot { x: number; z: number; vx: number; vz: number; kind: 'ice' | 'rocket'; owner: number; group: THREE.Group; life: number; }
interface Obstacle { x: number; z: number; r: number; idx: number; amp: number; sp: number; base: number; mesh?: THREE.Object3D; moving: boolean; }
interface Pad { x: number; z: number; idx: number; }

const CRUISE = 12;
const BOOST = 20;
const ACCEL = 2.2;
const TURN = 2.0;
const BOAT_R = 2.6;

// Long, gently-winding centreline (x, z) from the calm launch (top) down to the
// castle finish (bottom). Big, smooth bends so 4 boats can drift side by side.
const CTRL: [number, number][] = [
  [0, 175], [-70, 150], [64, 116], [-58, 82], [78, 44],
  [-70, 8], [60, -30], [-78, -66], [54, -104], [-40, -140], [0, -172],
];

export class BoatGame implements GameModule {
  readonly stickMode = 'float' as const;
  title = 'River Rush';
  objective = '🚤 Race to the castle! Grab weapons & ram rivals!';

  private ctx!: MatchContext;
  private timeLeft = 90;
  private finished = false;

  private path: THREE.Vector3[] = [];
  private heads: number[] = [];
  private widths: number[] = [];
  private N = 0;

  private boats: THREE.Group[] = [];
  private head: number[] = [];
  private speed: number[] = [];
  private spinT: number[] = [];
  private idx: number[] = [];
  private held: (Item | null)[] = [];
  private botItemT: number[] = [];
  private cruiseMul: number[] = [];
  private done: boolean[] = [];
  private finishOrder: number[] = [];
  private padCd: number[] = [];
  private sprayT = 0;

  private pickups: Pickup[] = [];
  private oils: Oil[] = [];
  private shots: Shot[] = [];
  private pickupT = 1.5;
  private obstacles: Obstacle[] = [];
  private pads: Pad[] = [];

  // Animated water.
  private waterGeo!: THREE.BufferGeometry;
  private waterBase!: Float32Array;
  private waterAmp!: Float32Array;
  private frame = 0;

  // Giant wave.
  private waveMesh!: THREE.Mesh;
  private waveIdx = 0;
  private waveActive = false;
  private waveCd = 6;
  private waveLo = 0; private waveHi = 0;

  private boosting = false;
  private itemBtn!: HTMLButtonElement;
  private speedBtn!: HTMLButtonElement;
  private map!: HTMLCanvasElement;
  private mapCtx!: CanvasRenderingContext2D;
  private mapBounds = { minX: 0, maxX: 1, minZ: 0, maxZ: 1 };

  init(ctx: MatchContext) {
    this.ctx = ctx;
    this.title = ctx.game.name;
    this.finished = false;
    this.timeLeft = matchTime(90);
    this.pickups = []; this.oils = []; this.shots = [];
    this.pickupT = 1.5; this.finishOrder = []; this.obstacles = []; this.pads = [];
    this.frame = 0; this.waveActive = false; this.waveCd = 6; this.sprayT = 0;

    // Push the fog back so the long river reads into the distance without a wall
    // of haze; keep a warm forest tone.
    ctx.scene.fog = new THREE.Fog(new THREE.Color(0x9fd8b0).getHex(), 130, 520);

    this.buildCourse();
    setupRoster(ctx, '1st', 0.5);
    this.buildUI();

    this.boats = []; this.head = []; this.speed = []; this.spinT = [];
    this.idx = []; this.held = []; this.botItemT = []; this.cruiseMul = []; this.done = []; this.padCd = [];

    const startH = this.heads[2];
    ctx.players.forEach((p, i) => {
      const lane = (i - 1.5) * (this.widths[2] * 0.42);
      const perpX = Math.cos(startH), perpZ = -Math.sin(startH);
      const c = this.path[2];
      p.x = c.x + perpX * lane;
      p.z = c.z + perpZ * lane;
      p.vx = 0; p.vz = 0; p.y = 0.5;
      p.sitting = true;
      this.head[p.index] = startH;
      this.speed[p.index] = 0;
      this.spinT[p.index] = 0;
      this.idx[p.index] = 2;
      this.held[p.index] = null;
      this.botItemT[p.index] = 0;
      this.cruiseMul[p.index] = 0.9 + Math.random() * 0.16;
      this.done[p.index] = false;
      this.padCd[p.index] = 0;
      p.standFacing = startH;
      const boat = this.makeBoat(p.hero.col);
      boat.position.set(p.x, 0, p.z);
      boat.rotation.y = startH;
      ctx.scene.add(boat);
      this.boats[p.index] = boat;
      setScore(p, '1st');
    });

    ctx.fx.banner('GO! 🚤', '#4DC3FF');
  }

  // --- section helpers --------------------------------------------------------
  /** Half-width of the channel at course fraction f (calm-wide → rapids-narrow
   *  → wave-wide → split-widest → final). Smoothly interpolated. */
  private widthAt(f: number): number {
    const kf: [number, number][] = [
      [0, 16], [0.10, 16], [0.22, 13], [0.40, 9.5], [0.55, 15], [0.72, 18], [0.86, 14], [1, 14],
    ];
    for (let i = 0; i < kf.length - 1; i++) {
      const [a, wa] = kf[i], [b, wb] = kf[i + 1];
      if (f <= b) { const t = (f - a) / (b - a); return wa + (wb - wa) * t; }
    }
    return 14;
  }
  private waveAmpAt(f: number): number {
    if (f >= 0.32 && f < 0.48) return 0.6;   // rapids chop
    if (f >= 0.48 && f < 0.63) return 0.85;  // giant-wave zone
    if (f < 0.10) return 0.1;                // calm launch
    return 0.3;
  }
  private currentAt(f: number): number {
    if (f >= 0.32 && f < 0.48) return 1.3;   // rapids run fast
    if (f >= 0.80) return 1.15;              // final push
    if (f < 0.10) return 0.85;               // calm start
    return 1;
  }

  // --- course -----------------------------------------------------------------
  private buildCourse() {
    const scene = this.ctx.scene;
    const pts3 = CTRL.map(([x, z]) => new THREE.Vector3(x, 0, z));
    const curve = new THREE.CatmullRomCurve3(pts3, false, 'catmullrom', 0.5);
    this.path = curve.getPoints(699);
    this.N = this.path.length;
    this.heads = this.path.map((_, i) => {
      const a = this.path[Math.max(0, i - 1)];
      const b = this.path[Math.min(this.N - 1, i + 1)];
      return Math.atan2(b.x - a.x, b.z - a.z);
    });
    this.widths = this.path.map((_, i) => this.widthAt(i / (this.N - 1)));

    // Banks + bankside forest (trees strictly on land, set well back — nothing
    // in the water).
    const bankL: THREE.Vector3[] = [], bankR: THREE.Vector3[] = [];
    const edgeL: THREE.Vector3[] = [], edgeR: THREE.Vector3[] = [];
    for (let i = 0; i < this.N; i++) {
      const c = this.path[i], h = this.heads[i], w = this.widths[i];
      const px = Math.cos(h), pz = -Math.sin(h);
      edgeL.push(new THREE.Vector3(c.x - px * w, 0.32, c.z - pz * w));
      edgeR.push(new THREE.Vector3(c.x + px * w, 0.32, c.z + pz * w));
      bankL.push(new THREE.Vector3(c.x - px * (w + 7), 1.0, c.z - pz * (w + 7)));
      bankR.push(new THREE.Vector3(c.x + px * (w + 7), 1.0, c.z + pz * (w + 7)));
    }
    // Sandy/mud shore ribbons (banks), then a thin white FOAM line at the water's
    // edge on each side.
    const bankMat = new THREE.MeshStandardMaterial({ color: 0xb99866, roughness: 1 });
    scene.add(this.ribbon(bankL, edgeL, bankMat));
    scene.add(this.ribbon(edgeR, bankR, bankMat));
    const foamMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6, emissive: 0x334455, emissiveIntensity: 0.4, transparent: true, opacity: 0.8 });
    const foamLo = (edge: THREE.Vector3[], inward: number) =>
      edge.map((v, i) => { const h = this.heads[i], px = Math.cos(h) * inward, pz = -Math.sin(h) * inward; return new THREE.Vector3(v.x + px * 1.1, 0.4, v.z + pz * 1.1); });
    scene.add(this.ribbon(foamLo(edgeL, 1), edgeL, foamMat));
    scene.add(this.ribbon(edgeR, foamLo(edgeR, -1), foamMat));

    // Flowing (animated) water surface.
    this.buildWater();

    // Bankside forest — dense but ALL on land, past the shore.
    for (let i = 8; i < this.N - 8; i += 7) {
      for (const side of [-1, 1]) {
        if (Math.random() < 0.25) continue;
        const c = this.path[i], h = this.heads[i], w = this.widths[i];
        const px = Math.cos(h), pz = -Math.sin(h);
        const off = w + 9 + Math.random() * 26;
        this.addTree(c.x + px * off * side, c.z + pz * off * side);
      }
    }

    this.buildSections();
    this.buildMountains();
    this.buildStartDock();
    this.buildCastleFinish();

    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const c of this.path) {
      minX = Math.min(minX, c.x); maxX = Math.max(maxX, c.x);
      minZ = Math.min(minZ, c.z); maxZ = Math.max(maxZ, c.z);
    }
    const pad = 24;
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

  /** The river surface: a 3-column strip (left / centre / right) whose vertices
   *  are displaced by travelling sine waves each frame → flowing, non-flat water
   *  that gets choppier through the rapids and the giant-wave zone. */
  private buildWater() {
    const cols = 3;
    const pos = new Float32Array(this.N * cols * 3);
    const amp = new Float32Array(this.N * cols);
    for (let i = 0; i < this.N; i++) {
      const c = this.path[i], h = this.heads[i], w = this.widths[i];
      const px = Math.cos(h), pz = -Math.sin(h);
      const a = this.waveAmpAt(i / (this.N - 1));
      for (let j = 0; j < cols; j++) {
        const t = (j - 1); // -1, 0, 1
        const vi = (i * cols + j) * 3;
        pos[vi] = c.x + px * w * t;
        pos[vi + 1] = 0.32;
        pos[vi + 2] = c.z + pz * w * t;
        amp[i * cols + j] = a;
      }
    }
    const idx: number[] = [];
    for (let i = 0; i < this.N - 1; i++) {
      for (let j = 0; j < cols - 1; j++) {
        const a0 = (i * cols + j), b0 = (i * cols + j + 1), a1 = ((i + 1) * cols + j), b1 = ((i + 1) * cols + j + 1);
        idx.push(a0, a1, b0, b0, a1, b1);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setIndex(idx); geo.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({
      color: 0x2f8fd8, roughness: 0.16, metalness: 0.4, emissive: 0x0f4f86, emissiveIntensity: 0.55,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    this.ctx.scene.add(mesh);
    this.waterGeo = geo;
    this.waterBase = pos.slice();
    this.waterAmp = amp;

    // Giant wave crest (hidden until it surges through the wave zone).
    const waveGeo = new THREE.BoxGeometry(1, 1, 1);
    this.waveMesh = new THREE.Mesh(waveGeo, new THREE.MeshStandardMaterial({
      color: 0xbfe6ff, roughness: 0.1, metalness: 0.3, transparent: true, opacity: 0.82, emissive: 0x4f9fd0, emissiveIntensity: 0.6,
    }));
    this.waveMesh.visible = false;
    this.ctx.scene.add(this.waveMesh);
    this.waveLo = Math.floor(this.N * 0.48);
    this.waveHi = Math.floor(this.N * 0.63);
  }

  private addTree(x: number, z: number) {
    const g = new THREE.Group();
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.6, 3.2, 6),
      new THREE.MeshStandardMaterial({ color: 0x6b4a2a, roughness: 1 }));
    trunk.position.y = 1.6; trunk.castShadow = true; g.add(trunk);
    const green = new THREE.MeshStandardMaterial({ color: 0x2c6b34, roughness: 1, flatShading: true });
    for (let i = 0; i < 3; i++) {
      const cone = new THREE.Mesh(new THREE.ConeGeometry(2.7 - i * 0.6, 2.7, 7), green);
      cone.position.y = 3.4 + i * 1.5; cone.castShadow = true; g.add(cone);
    }
    g.position.set(x, 0.6, z);
    g.rotation.y = Math.random() * 6;
    g.scale.setScalar(0.9 + Math.random() * 0.9);
    this.ctx.scene.add(g);
  }

  private makeRock(s: number): THREE.Mesh {
    const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(s, 0),
      new THREE.MeshStandardMaterial({ color: 0x8b8378, roughness: 1, flatShading: true }));
    rock.rotation.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
    rock.scale.y = 0.8; rock.castShadow = true;
    return rock;
  }

  /** Section set-dressing + gameplay: moving rocks in the rapids, a split-path
   *  island, and boost pads on the final push. */
  private buildSections() {
    const scene = this.ctx.scene;

    // RAPIDS — moving rocks that slide side to side across the narrow channel.
    for (const f of [0.35, 0.40, 0.45]) {
      const i = Math.floor(this.N * f);
      const rock = this.makeRock(2.4);
      rock.position.y = 1.0;
      scene.add(rock);
      this.obstacles.push({ x: this.path[i].x, z: this.path[i].z, r: 2.6, idx: i, amp: this.widths[i] * 0.55, sp: 0.8 + Math.random() * 0.5, base: Math.random() * 6, mesh: rock, moving: true });
    }
    // Foam patches over the rapids.
    for (const f of [0.34, 0.37, 0.42, 0.46]) {
      const i = Math.floor(this.N * f);
      const foam = new THREE.Mesh(new THREE.CircleGeometry(2.4, 12),
        new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6, transparent: true, opacity: 0.5, emissive: 0x99bbcc, emissiveIntensity: 0.4 }));
      foam.rotation.x = -Math.PI / 2; foam.position.set(this.path[i].x, 0.46, this.path[i].z);
      scene.add(foam);
    }

    // SPLIT PATH — an island in the middle of the widest section; boats pick a
    // side. A boost pad rewards the tighter right-hand line.
    const si = Math.floor(this.N * 0.71);
    const isle = new THREE.Group();
    const mound = new THREE.Mesh(new THREE.SphereGeometry(6, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: 0x4a7a38, roughness: 1, flatShading: true }));
    mound.scale.y = 0.6; mound.position.y = 0.3; isle.add(mound);
    const sand = new THREE.Mesh(new THREE.CylinderGeometry(7, 7.4, 0.6, 18),
      new THREE.MeshStandardMaterial({ color: 0xc9a76b, roughness: 1 }));
    sand.position.y = 0.35; isle.add(sand);
    isle.position.set(this.path[si].x, 0, this.path[si].z);
    scene.add(isle);
    for (let k = 0; k < 4; k++) {
      const a = Math.random() * 6;
      this.addTree(this.path[si].x + Math.cos(a) * 3, this.path[si].z + Math.sin(a) * 3);
    }
    this.obstacles.push({ x: this.path[si].x, z: this.path[si].z, r: 6.5, idx: si, amp: 0, sp: 0, base: 0, moving: false });
    { // boost pad on the tight side of the island
      const h = this.heads[si], px = Math.cos(h), pz = -Math.sin(h);
      this.addPad(this.path[si].x + px * (this.widths[si] * 0.72), this.path[si].z + pz * (this.widths[si] * 0.72), si);
    }

    // FINAL PUSH — boost pads down the home stretch.
    for (const f of [0.84, 0.90, 0.95]) {
      const i = Math.floor(this.N * f);
      const off = (Math.random() - 0.5) * this.widths[i] * 0.6;
      const h = this.heads[i], px = Math.cos(h), pz = -Math.sin(h);
      this.addPad(this.path[i].x + px * off, this.path[i].z + pz * off, i);
    }
  }

  private addPad(x: number, z: number, idx: number) {
    const g = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ color: 0x2fe0e0, emissive: 0x1090b0, emissiveIntensity: 0.9, roughness: 0.4, side: THREE.DoubleSide });
    for (let i = 0; i < 2; i++) {
      const bar = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 1.1), mat);
      bar.rotation.x = -Math.PI / 2; bar.rotation.z = i === 0 ? 0.6 : -0.6;
      bar.position.set(i === 0 ? -0.9 : 0.9, 0.46, 0); g.add(bar);
    }
    g.position.set(x, 0, z);
    g.rotation.y = this.heads[idx];
    this.ctx.scene.add(g);
    this.pads.push({ x, z, idx });
  }

  private buildMountains() {
    const scene = this.ctx.scene;
    const rock = new THREE.MeshStandardMaterial({ color: 0x6d6a72, roughness: 1, flatShading: true });
    const snow = new THREE.MeshStandardMaterial({ color: 0xf2f6ff, roughness: 0.9, flatShading: true });
    for (let i = 0; i < 11; i++) {
      const a = (i / 11) * Math.PI * 2 + 0.3;
      const r = 240 + Math.random() * 90;
      const hgt = 60 + Math.random() * 70;
      const rad = 34 + Math.random() * 26;
      const m = new THREE.Mesh(new THREE.ConeGeometry(rad, hgt, 6), rock);
      m.position.set(Math.cos(a) * r, hgt / 2 - 6, Math.sin(a) * r);
      m.rotation.y = Math.random() * 6; scene.add(m);
      const cap = new THREE.Mesh(new THREE.ConeGeometry(rad * 0.42, hgt * 0.3, 6), snow);
      cap.position.set(m.position.x, hgt * 0.85 - 6, m.position.z);
      cap.rotation.y = m.rotation.y; scene.add(cap);
    }
  }

  private buildStartDock() {
    const scene = this.ctx.scene;
    const i = 2;
    const c = this.path[i], h = this.heads[i];
    const px = Math.cos(h), pz = -Math.sin(h);
    const wood = new THREE.MeshStandardMaterial({ color: 0x8a5a30, roughness: 0.9 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x5f3d1f, roughness: 1 });
    for (const side of [-1, 1]) {
      const dock = new THREE.Group();
      for (let k = 0; k < 5; k++) {
        const plank = new THREE.Mesh(new THREE.BoxGeometry(6, 0.3, 1.1), k % 2 ? dark : wood);
        plank.position.set(0, 0.55, -2.4 + k * 1.2); dock.add(plank);
      }
      for (const [ox, oz] of [[-2.4, -2.4], [2.4, -2.4], [-2.4, 2.4], [2.4, 2.4]] as const) {
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 2, 6), dark);
        post.position.set(ox, 0, oz); dock.add(post);
      }
      dock.position.set(c.x + px * (this.widths[i] + 2.5) * side, 0, c.z + pz * (this.widths[i] + 2.5) * side);
      dock.rotation.y = h;
      scene.add(dock);
    }
  }

  private buildCastleFinish() {
    const scene = this.ctx.scene;
    const iFin = this.N - 6;
    const c = this.path[iFin], h = this.heads[iFin];
    const px = Math.cos(h), pz = -Math.sin(h);
    const w = this.widths[iFin];

    // Checkered mat across the water at the line.
    const cols = 8, cw = (w * 2) / cols;
    for (let r = 0; r < 2; r++) for (let col = 0; col < cols; col++) {
      const off = (col - (cols - 1) / 2) * cw, along = (r - 0.5) * cw;
      const white = (r + col) % 2 === 0;
      const tile = new THREE.Mesh(new THREE.BoxGeometry(cw, 0.1, cw),
        new THREE.MeshStandardMaterial({ color: white ? 0xffffff : 0x111111, roughness: 0.7 }));
      tile.position.set(c.x + px * off + Math.sin(h) * along, 0.36, c.z + pz * off + Math.cos(h) * along);
      tile.rotation.y = h; scene.add(tile);
    }

    // Stone castle straddling the river behind the line — the big landmark.
    const stone = new THREE.MeshStandardMaterial({ color: 0x9aa0a8, roughness: 1, flatShading: true });
    const stoneD = new THREE.MeshStandardMaterial({ color: 0x74797f, roughness: 1, flatShading: true });
    const roof = new THREE.MeshStandardMaterial({ color: 0x8a2f3a, roughness: 0.9, flatShading: true });
    const tower = (tx: number, tz: number, rad: number, hgt: number) => {
      const g = new THREE.Group();
      const body = new THREE.Mesh(new THREE.CylinderGeometry(rad, rad * 1.1, hgt, 10), stone);
      body.position.y = hgt / 2; body.castShadow = true; g.add(body);
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        const merlon = new THREE.Mesh(new THREE.BoxGeometry(1, 1.4, 1), stoneD);
        merlon.position.set(Math.cos(a) * rad, hgt + 0.7, Math.sin(a) * rad); g.add(merlon);
      }
      const cone = new THREE.Mesh(new THREE.ConeGeometry(rad * 1.3, hgt * 0.5, 10), roof);
      cone.position.y = hgt + hgt * 0.25; g.add(cone);
      g.position.set(tx, 0, tz); scene.add(g);
    };
    // Two flanking gate towers + two taller keep towers behind, plus a wall with
    // a gate arch the boats pass under (the checkered banner hangs on it).
    const gy = w + 6;
    tower(c.x + px * gy, c.z + pz * gy, 5, 30);
    tower(c.x - px * gy, c.z - pz * gy, 5, 30);
    const bx = c.x - Math.sin(h) * 26, bz = c.z - Math.cos(h) * 26; // behind the line
    tower(bx + px * (gy + 4), bz + pz * (gy + 4), 6.5, 44);
    tower(bx - px * (gy + 4), bz - pz * (gy + 4), 6.5, 44);
    // Curtain wall between the gate towers (with a gap = the gate the river runs
    // through).
    for (const side of [-1, 1]) {
      const wall = new THREE.Mesh(new THREE.BoxGeometry((gy - w - 1), 16, 3), stone);
      wall.position.set(c.x + px * (w + 1 + (gy - w - 1) / 2) * side, 8, c.z + pz * (w + 1 + (gy - w - 1) / 2) * side);
      wall.rotation.y = h; wall.castShadow = true; scene.add(wall);
    }

    // Checkered banner across the gate.
    const poleMat = new THREE.MeshStandardMaterial({ color: 0xdedede, roughness: 0.6, metalness: 0.3 });
    for (const side of [-1, 1]) {
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 20, 10), poleMat);
      pole.position.set(c.x + px * (w + 1.5) * side, 10, c.z + pz * (w + 1.5) * side);
      pole.castShadow = true; scene.add(pole);
    }
    const bcols = 16, brows = 3, bcw = ((w + 1.5) * 2) / bcols, bch = 1.6;
    const banner = new THREE.Group();
    for (let r = 0; r < brows; r++) for (let col = 0; col < bcols; col++) {
      const white = (r + col) % 2 === 0;
      const tile = new THREE.Mesh(new THREE.PlaneGeometry(bcw, bch),
        new THREE.MeshStandardMaterial({ color: white ? 0xffffff : 0x111111, roughness: 0.8, side: THREE.DoubleSide }));
      tile.position.set((col - (bcols - 1) / 2) * bcw, (brows - 1) / 2 * bch - r * bch, 0); banner.add(tile);
    }
    banner.position.set(c.x, 14, c.z); banner.rotation.y = h + Math.PI / 2; scene.add(banner);
    const spr = this.textSprite('🏁 FINISH 🏁');
    spr.position.set(c.x, 17, c.z); scene.add(spr);
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
    sp.scale.set(16, 4, 1);
    return sp;
  }

  // --- boat + item models -----------------------------------------------------
  private makeBoat(col: number | string): THREE.Group {
    const g = new THREE.Group();
    const hullMat = new THREE.MeshStandardMaterial({ color: col, roughness: 0.4, metalness: 0.3 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x14141c, roughness: 0.7 });
    const white = new THREE.MeshStandardMaterial({ color: 0xf0f4ff, roughness: 0.5 });
    const hull = new THREE.Mesh(new THREE.BoxGeometry(3.0, 0.9, 5.0), hullMat);
    hull.position.y = 0.55; hull.castShadow = true; g.add(hull);
    const bow = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 1.5, 2.4, 4), hullMat);
    bow.rotation.x = Math.PI / 2; bow.rotation.y = Math.PI / 4; bow.position.set(0, 0.55, 3.2); g.add(bow);
    const deck = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.2, 3.4), white);
    deck.position.set(0, 1.05, 0.4); g.add(deck);
    const dash = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.9, 0.5), white);
    dash.position.set(0, 1.5, 1.1); g.add(dash);
    const seat = new THREE.Mesh(new THREE.BoxGeometry(1.6, 1.1, 0.4), dark);
    seat.position.set(0, 1.5, -1.0); g.add(seat);
    const ws = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.7, 0.08),
      new THREE.MeshStandardMaterial({ color: 0x9fd8ff, roughness: 0.1, metalness: 0.2, transparent: true, opacity: 0.6 }));
    ws.position.set(0, 2.0, 1.35); ws.rotation.x = -0.3; g.add(ws);
    const motor = new THREE.Mesh(new THREE.BoxGeometry(0.7, 1.1, 0.7), dark);
    motor.position.set(0, 0.9, -2.7); g.add(motor);
    return g;
  }

  private itemModel(kind: Item): THREE.Object3D {
    const g = new THREE.Group();
    if (kind === 'ice') {
      g.add(new THREE.Mesh(new THREE.OctahedronGeometry(1.0, 0),
        new THREE.MeshStandardMaterial({ color: 0x9fdcff, roughness: 0.1, metalness: 0.2, emissive: 0x2a6aa0, emissiveIntensity: 0.5, flatShading: true })));
    } else if (kind === 'oil') {
      const drum = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.7, 1.2, 12),
        new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.5, metalness: 0.3, emissive: 0x101010 }));
      g.add(drum);
    } else if (kind === 'boost') {
      for (let i = 0; i < 2; i++) {
        const c = new THREE.Mesh(new THREE.ConeGeometry(0.9, 1.2, 4),
          new THREE.MeshStandardMaterial({ color: 0x2fe04a, emissive: 0x0d5a1a, emissiveIntensity: 0.6, roughness: 0.4 }));
        c.rotation.x = -Math.PI / 2; c.position.z = -0.6 + i * 1.0; g.add(c);
      }
    } else if (kind === 'emp') {
      const m = new THREE.Mesh(new THREE.OctahedronGeometry(1.1, 0),
        new THREE.MeshStandardMaterial({ color: 0xffe23a, emissive: 0xffd000, emissiveIntensity: 0.8, roughness: 0.3, flatShading: true }));
      m.scale.set(0.6, 1.5, 0.6); g.add(m);
    } else { // rocket
      const b = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 1.8, 10),
        new THREE.MeshStandardMaterial({ color: 0xd23b3b, roughness: 0.4, metalness: 0.3 }));
      b.rotation.x = Math.PI / 2; g.add(b);
      const tip = new THREE.Mesh(new THREE.ConeGeometry(0.5, 0.9, 10), new THREE.MeshStandardMaterial({ color: 0xeeeeee }));
      tip.rotation.x = Math.PI / 2; tip.position.z = 1.3; g.add(tip);
    }
    return g;
  }

  private emojiSprite(txt: string, scale = 3): THREE.Sprite {
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const x = c.getContext('2d')!;
    x.font = '90px serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillText(txt, 64, 70);
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
    sp.scale.set(scale, scale, 1);
    return sp;
  }

  // --- tick -------------------------------------------------------------------
  ability() { this.useItem(this.ctx.players[0]); }
  jump() { this.useItem(this.ctx.players[0]); }

  tick(dt: number, elapsed: number) {
    if (this.finished) return;
    const ctx = this.ctx;
    this.frame++;
    this.timeLeft -= dt;
    ctx.setClock(this.timeLeft);

    for (const p of ctx.players) if (!p.dead) this.driveBoat(p, dt);
    this.separateBoats();
    this.resolveObstacles();

    for (const p of ctx.players) {
      const b = this.boats[p.index];
      if (!b) continue;
      b.position.set(p.x, 0, p.z);
      b.rotation.y = this.head[p.index];
      b.rotation.z = Math.sin(elapsed * 3 + p.index) * 0.06;
      b.position.y = Math.sin(elapsed * 2.4 + p.index * 1.3) * 0.14;
      b.visible = !p.dead;
      p.standFacing = this.head[p.index];
      p.y = 0.5 + b.position.y;
    }

    this.animateWater(elapsed);
    this.tickObstacles(elapsed);
    this.tickWave(dt);
    this.tickPads();
    this.tickSpray();
    this.tickPickups(dt);
    this.tickOils();
    this.tickShots(dt);

    for (const p of ctx.players.slice(1)) {
      if (p.dead || this.done[p.index] || !this.held[p.index]) continue;
      this.botItemT[p.index] -= dt;
      if (this.botItemT[p.index] <= 0) this.useItem(p);
    }

    this.rankBoats();
    this.updateMinimap();
    tickRoster(ctx, dt, elapsed);

    const you = ctx.players[0];
    ctx.camera.chaseBehind(you.x, you.y, you.z, this.head[you.index], 14, 7.5);

    if (this.timeLeft <= 0) this.doFinish();
  }

  private animateWater(elapsed: number) {
    const pos = this.waterGeo.attributes.position.array as Float32Array;
    const base = this.waterBase, amp = this.waterAmp;
    const cols = 3;
    for (let i = 0; i < this.N; i++) {
      for (let j = 0; j < cols; j++) {
        const vi = (i * cols + j) * 3;
        const a = amp[i * cols + j];
        pos[vi + 1] = base[vi + 1]
          + Math.sin(elapsed * 2.2 - i * 0.22 + j * 0.7) * a
          + Math.sin(elapsed * 3.3 + i * 0.11) * a * 0.4;
      }
    }
    this.waterGeo.attributes.position.needsUpdate = true;
    if (this.frame % 6 === 0) this.waterGeo.computeVertexNormals();
  }

  private driveBoat(p: Player, dt: number) {
    const i = p.index;
    if (this.done[i]) { this.speed[i] *= 0.9; return; }

    if (this.spinT[i] > 0) {
      this.spinT[i] -= dt;
      this.head[i] += dt * 10;
      this.speed[i] += (CRUISE * 0.15 - this.speed[i]) * ACCEL * dt;
    } else if (p.freezeT > 0) {
      this.speed[i] += (0 - this.speed[i]) * 6 * dt;
    } else {
      let steer = 0;
      if (i === 0) steer = -this.ctx.input.ax;
      else steer = this.botSteer(p);
      this.head[i] += steer * TURN * dt;
      const wantBoost = i === 0 ? this.boosting : Math.random() < 0.7;
      const cur = this.currentAt(this.idx[i] / (this.N - 1));
      let target = (wantBoost ? BOOST : CRUISE) * this.cruiseMul[i] * cur;
      if (p.speedT > 0) target *= 1.6;
      this.speed[i] += (target - this.speed[i]) * ACCEL * dt;
    }

    const fx = Math.sin(this.head[i]), fz = Math.cos(this.head[i]);
    p.x += fx * this.speed[i] * dt;
    p.z += fz * this.speed[i] * dt;
    p.vx = fx * this.speed[i]; p.vz = fz * this.speed[i];

    let best = this.idx[i], bd = Infinity;
    for (let s = Math.max(0, this.idx[i] - 4); s <= Math.min(this.N - 1, this.idx[i] + 44); s++) {
      const c = this.path[s];
      const d = (c.x - p.x) * (c.x - p.x) + (c.z - p.z) * (c.z - p.z);
      if (d < bd) { bd = d; best = s; }
    }
    this.idx[i] = best;

    const c = this.path[best];
    const dx = p.x - c.x, dz = p.z - c.z, dist = Math.hypot(dx, dz);
    const lim = this.widths[best] - BOAT_R;
    if (dist > lim && dist > 0.001) {
      p.x = c.x + (dx / dist) * lim;
      p.z = c.z + (dz / dist) * lim;
      this.speed[i] *= 0.86;
      if (p.you && this.speed[i] > 6) SFX.bump();
    }

    if (best >= this.N - 6) this.crossFinish(p);
  }

  private botSteer(p: Player): number {
    const i = p.index;
    const ahead = this.path[Math.min(this.N - 1, this.idx[i] + 16)];
    let tx = ahead.x, tz = ahead.z;
    if (!this.held[i]) {
      let best: Pickup | null = null, bd = 22;
      for (const pk of this.pickups) {
        const d = Math.hypot(pk.x - p.x, pk.z - p.z);
        if (d < bd) { bd = d; best = pk; }
      }
      if (best) { tx = (tx + best.x) / 2; tz = (tz + best.z) / 2; }
    }
    const want = Math.atan2(tx - p.x, tz - p.z);
    let d = want - this.head[i];
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return Math.max(-1, Math.min(1, d * 2));
  }

  private separateBoats() {
    const ps = this.ctx.players;
    for (let a = 0; a < ps.length; a++) {
      for (let b = a + 1; b < ps.length; b++) {
        const pa = ps[a], pb = ps[b];
        if (pa.dead || pb.dead) continue;
        const dx = pb.x - pa.x, dz = pb.z - pa.z, d = Math.hypot(dx, dz);
        const min = BOAT_R * 2;
        if (d > 0.001 && d < min) {
          const push = (min - d) / 2, nx = dx / d, nz = dz / d;
          pa.x -= nx * push; pa.z -= nz * push;
          pb.x += nx * push; pb.z += nz * push;
          const rel = Math.abs(this.speed[pa.index] - this.speed[pb.index]);
          if (rel > 10) {
            this.ctx.fx.burst((pa.x + pb.x) / 2, (pa.z + pb.z) / 2, '#ffffff', 6);
            if (pa.you || pb.you) { SFX.bump(); this.ctx.fx.shake(0.8); }
          }
        }
      }
    }
  }

  private resolveObstacles() {
    for (const o of this.obstacles) {
      for (const p of this.ctx.players) {
        if (p.dead || this.done[p.index]) continue;
        const dx = p.x - o.x, dz = p.z - o.z, d = Math.hypot(dx, dz);
        const min = o.r + BOAT_R;
        if (d > 0.001 && d < min) {
          const nx = dx / d, nz = dz / d;
          p.x = o.x + nx * min; p.z = o.z + nz * min;
          const into = p.vx * nx + p.vz * nz;
          if (into < 0) { this.speed[p.index] *= 0.7; if (o.moving) this.spinT[p.index] = Math.max(this.spinT[p.index], 0.6); }
          if (p.you) { SFX.bump(); this.ctx.fx.shake(0.7); }
        }
      }
    }
  }

  private tickObstacles(elapsed: number) {
    for (const o of this.obstacles) {
      if (!o.moving || !o.mesh) continue;
      const h = this.heads[o.idx], px = Math.cos(h), pz = -Math.sin(h);
      const off = Math.sin(elapsed * o.sp + o.base) * o.amp;
      o.x = this.path[o.idx].x + px * off;
      o.z = this.path[o.idx].z + pz * off;
      o.mesh.position.set(o.x, 1.0 + Math.sin(elapsed * 2 + o.base) * 0.2, o.z);
      o.mesh.rotation.y = elapsed * 0.5;
    }
  }

  private tickWave(dt: number) {
    if (!this.waveActive) {
      this.waveCd -= dt;
      if (this.waveCd <= 0) {
        this.waveActive = true;
        this.waveIdx = this.waveHi; // start downstream, surge UP-river
        this.waveMesh.visible = true;
      }
      return;
    }
    // March the wave upstream (toward lower indices).
    this.waveIdx -= dt * 90;
    if (this.waveIdx <= this.waveLo) {
      this.waveActive = false; this.waveMesh.visible = false;
      this.waveCd = 6 + Math.random() * 3;
      return;
    }
    const wi = Math.max(0, Math.floor(this.waveIdx));
    const c = this.path[wi], h = this.heads[wi], w = this.widths[wi];
    this.waveMesh.position.set(c.x, 2.4, c.z);
    this.waveMesh.rotation.y = h;
    this.waveMesh.scale.set(w * 2.2, 5.5, 3.2);
    // Push any boat the wave sweeps over back down-river.
    for (const p of this.ctx.players) {
      if (p.dead || this.done[p.index]) continue;
      if (Math.abs(this.idx[p.index] - this.waveIdx) < 10) {
        const fx = Math.sin(this.head[p.index]), fz = Math.cos(this.head[p.index]);
        p.x -= fx * 26 * dt; p.z -= fz * 26 * dt; // shoved backward
        this.speed[p.index] *= 0.9;
        if (p.you && this.frame % 20 === 0) { this.ctx.fx.shake(1.2); this.ctx.fx.banner('🌊 GIANT WAVE!', '#bfe6ff'); }
      }
    }
  }

  private tickPads() {
    for (const p of this.ctx.players) {
      if (p.dead || this.done[p.index]) continue;
      if (this.padCd[p.index] > 0) { this.padCd[p.index] -= 0.016; continue; }
      for (const pad of this.pads) {
        if (Math.hypot(p.x - pad.x, p.z - pad.z) < 3.4) {
          p.speedT = Math.max(p.speedT, 1.8);
          this.padCd[p.index] = 1.2;
          this.ctx.fx.burst(p.x, p.z, '#2fe0e0', 10);
          if (p.you) { SFX.power(); this.ctx.fx.banner('⚡ BOOST PAD!', '#2fe0e0'); }
          break;
        }
      }
    }
  }

  private tickSpray() {
    // White water spray behind boats that are drifting hard or boosting.
    this.sprayT -= 0.016;
    if (this.sprayT > 0) return;
    this.sprayT = 0.08;
    for (const p of this.ctx.players) {
      if (p.dead || this.done[p.index]) continue;
      const drifting = p.index === 0 ? Math.abs(this.ctx.input.ax) > 0.55 : false;
      if (drifting || p.speedT > 0 || this.spinT[p.index] > 0) {
        const bx = p.x - Math.sin(this.head[p.index]) * 2.8;
        const bz = p.z - Math.cos(this.head[p.index]) * 2.8;
        this.ctx.fx.burst(bx, bz, '#eaf6ff', 4);
      }
    }
  }

  private rankBoats() {
    const ranked = [...this.ctx.players].sort((a, b) => this.progressScore(b) - this.progressScore(a));
    ranked.forEach((p, r) => setScore(p, this.done[p.index] ? '🏁' : ['1st', '2nd', '3rd', '4th'][r]));
  }

  private progressScore(p: Player): number {
    const fin = this.finishOrder.indexOf(p.index);
    if (fin >= 0) return 1e6 - fin;
    return this.idx[p.index];
  }

  private crossFinish(p: Player) {
    if (this.done[p.index]) return;
    this.done[p.index] = true;
    this.finishOrder.push(p.index);
    this.speed[p.index] *= 0.4;
    if (p.you) { this.ctx.fx.banner('🏁 FINISH!', p.hero.col); SFX.win(); }
    else this.ctx.fx.banner(`${p.hero.name} finishes!`, p.hero.col);
    if (p.you || this.ctx.players.every((q) => this.done[q.index] || q.dead)) {
      setTimeout(() => this.doFinish(), p.you ? 700 : 300);
    }
  }

  // --- pickups ----------------------------------------------------------------
  private tickPickups(dt: number) {
    this.pickupT -= dt;
    if (this.pickupT <= 0 && this.pickups.length < 6) { this.pickupT = 1.2 + Math.random() * 1.6; this.spawnPickup(); }
    for (const pk of this.pickups) pk.group.rotation.y += dt * 1.6;
    for (let i = this.pickups.length - 1; i >= 0; i--) {
      const pk = this.pickups[i];
      const taker = this.ctx.players.find((p) => !p.dead && !this.done[p.index] && !this.held[p.index] && Math.hypot(p.x - pk.x, p.z - pk.z) < 3.6);
      if (!taker) continue;
      this.ctx.scene.remove(pk.group);
      this.pickups.splice(i, 1);
      this.giveItem(taker, pk.kind);
      SFX.gem();
    }
  }

  private spawnPickup() {
    const kind = ALL_ITEMS[Math.floor(Math.random() * ALL_ITEMS.length)];
    const s = 10 + Math.floor(Math.random() * (this.N - 20));
    const c = this.path[s], h = this.heads[s], w = this.widths[s];
    const px = Math.cos(h), pz = -Math.sin(h);
    const off = (Math.random() - 0.5) * w * 1.2;
    const x = c.x + px * off, z = c.z + pz * off;
    const group = new THREE.Group();
    const model = this.itemModel(kind); model.position.y = 1.6; group.add(model);
    const spr = this.emojiSprite(ITEM_EMOJI[kind], 2.6); spr.position.y = 3.6; group.add(spr);
    const ring = new THREE.Mesh(new THREE.RingGeometry(1.4, 2.0, 20),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.4, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2; ring.position.y = 0.5; group.add(ring);
    group.position.set(x, 0, z);
    this.ctx.scene.add(group);
    this.pickups.push({ x, z, kind, group });
  }

  private giveItem(p: Player, kind: Item) {
    this.held[p.index] = kind;
    p.setStatusIcon(ITEM_EMOJI[kind], 999);
    if (p.index !== 0) this.botItemT[p.index] = 0.7 + Math.random() * 2.2;
    else { this.updateItemBtn(); this.ctx.fx.banner(`${ITEM_EMOJI[kind]} GOT IT! tap ITEM`, '#FFD23F'); }
  }

  // --- using items ------------------------------------------------------------
  private useItem(p: Player) {
    const kind = this.held[p.index];
    if (!kind || p.dead || this.done[p.index] || this.finished) return;
    this.held[p.index] = null;
    p.setStatusIcon(null);
    if (p.index === 0) this.updateItemBtn();
    if (kind === 'boost') {
      p.speedT = Math.max(p.speedT, 2.8);
      this.ctx.fx.burst(p.x, p.z, '#2fe04a', 10);
      if (p.you) this.ctx.fx.banner('👟 BOOST!', '#2fe04a');
    } else if (kind === 'oil') {
      this.dropOil(p);
    } else if (kind === 'emp') {
      this.empAll(p);
    } else {
      this.fireShot(p, kind); // ice or rocket
    }
    SFX.power();
  }

  private dropOil(p: Player) {
    const bx = p.x - Math.sin(this.head[p.index]) * 3.5;
    const bz = p.z - Math.cos(this.head[p.index]) * 3.5;
    const group = new THREE.Group();
    const slick = new THREE.Mesh(new THREE.CircleGeometry(2.2, 16),
      new THREE.MeshStandardMaterial({ color: 0x0a0a0a, roughness: 0.3, metalness: 0.5, transparent: true, opacity: 0.85, side: THREE.DoubleSide }));
    slick.rotation.x = -Math.PI / 2; slick.position.y = 0.42; group.add(slick);
    group.position.set(bx, 0, bz);
    this.ctx.scene.add(group);
    this.oils.push({ x: bx, z: bz, group });
    if (p.you) this.ctx.fx.banner('🛢️ OIL SLICK!', '#333');
  }

  private tickOils() {
    for (let i = this.oils.length - 1; i >= 0; i--) {
      const b = this.oils[i];
      const hit = this.ctx.players.find((p) => !p.dead && this.spinT[p.index] <= 0 && p.freezeT <= 0 && Math.hypot(p.x - b.x, p.z - b.z) < 2.6);
      if (!hit) continue;
      this.ctx.scene.remove(b.group);
      this.oils.splice(i, 1);
      this.spinT[hit.index] = 1.3;
      SFX.bump();
      this.ctx.fx.burst(hit.x, hit.z, '#111', 10);
      this.ctx.fx.banner(hit.you ? 'SPUN OUT! 🛢️' : '', '#333');
    }
  }

  private empAll(by: Player) {
    for (const p of this.ctx.players) {
      if (p === by || p.dead || this.done[p.index]) continue;
      p.freezeT = Math.max(p.freezeT, 1.0);
      p.zapped = true;
      this.ctx.fx.burst(p.x, p.z, '#ffe23a', 8);
    }
    this.ctx.fx.shake(1.4);
    if (by.you) this.ctx.fx.banner('⚡ EMP! rivals stunned', '#ffe23a');
    else if (this.ctx.players[0].freezeT > 0) this.ctx.fx.banner('⚡ EMP\'d!', '#ffe23a');
  }

  private fireShot(p: Player, kind: 'ice' | 'rocket') {
    const speed = kind === 'rocket' ? 46 : 30;
    const fx = Math.sin(this.head[p.index]), fz = Math.cos(this.head[p.index]);
    const group = new THREE.Group();
    const model = this.itemModel(kind); model.position.y = 1.0; group.add(model);
    group.position.set(p.x + fx * 3.5, 0, p.z + fz * 3.5);
    this.ctx.scene.add(group);
    this.shots.push({ x: p.x + fx * 3.5, z: p.z + fz * 3.5, vx: fx * speed, vz: fz * speed, kind, owner: p.index, group, life: kind === 'rocket' ? 2.4 : 3.2 });
    if (p.you) this.ctx.fx.banner(kind === 'rocket' ? '🚀 ROCKET!' : '🧊 ICE SHOT!', '#FF4D4D');
  }

  private aheadOf(owner: number): Player | null {
    let best: Player | null = null, bd = Infinity;
    for (const p of this.ctx.players) {
      if (p.index === owner || p.dead || this.done[p.index]) continue;
      const lead = this.idx[p.index] - this.idx[owner];
      if (lead > -20 && lead < bd) { bd = lead; best = p; }
    }
    return best;
  }

  private tickShots(dt: number) {
    for (let i = this.shots.length - 1; i >= 0; i--) {
      const s = this.shots[i];
      s.life -= dt;
      const tgt = this.aheadOf(s.owner);
      if (tgt) {
        const dx = tgt.x - s.x, dz = tgt.z - s.z, L = Math.hypot(dx, dz) || 1;
        const homing = s.kind === 'rocket' ? 120 : 70;
        s.vx += (dx / L) * homing * dt; s.vz += (dz / L) * homing * dt;
        const sp = Math.hypot(s.vx, s.vz), cap = s.kind === 'rocket' ? 52 : 34;
        if (sp > cap) { s.vx = (s.vx / sp) * cap; s.vz = (s.vz / sp) * cap; }
      }
      s.x += s.vx * dt; s.z += s.vz * dt;
      s.group.position.set(s.x, 0.8, s.z);
      s.group.rotation.y = Math.atan2(s.vx, s.vz);
      let hit: Player | null = null;
      for (const p of this.ctx.players) {
        if (p.index === s.owner || p.dead || this.done[p.index]) continue;
        if (Math.hypot(p.x - s.x, p.z - s.z) < 2.8) { hit = p; break; }
      }
      if (hit) {
        if (s.kind === 'rocket') { hit.freezeT = Math.max(hit.freezeT, 0.9); hit.zapped = true; this.spinT[hit.index] = 0.6; }
        else { hit.freezeT = Math.max(hit.freezeT, 1.1); hit.zapped = true; }
        SFX.hit();
        this.ctx.fx.burst(hit.x, hit.z, s.kind === 'rocket' ? '#FF4D4D' : '#9fdcff', 14);
        this.ctx.fx.shake(1.4);
        if (hit.you) this.ctx.fx.banner(s.kind === 'rocket' ? 'ROCKETED! 🚀' : 'FROZEN! 🧊', '#FF4D4D');
        this.ctx.scene.remove(s.group); this.shots.splice(i, 1);
      } else if (s.life <= 0) {
        this.ctx.scene.remove(s.group); this.shots.splice(i, 1);
      }
    }
  }

  // --- DOM overlay: buttons + minimap -----------------------------------------
  private buildUI() {
    document.getElementById('boatUI')?.remove();
    const ui = document.createElement('div');
    ui.id = 'boatUI';
    ui.style.cssText = 'position:fixed;inset:0;z-index:8;pointer-events:none;font-family:Bungee,system-ui,sans-serif;';
    ui.innerHTML = `
      <canvas id="bMap" width="150" height="180" style="position:fixed;top:70px;left:50%;transform:translateX(-50%);
        width:110px;height:132px;background:rgba(10,20,34,.55);border:2px solid rgba(255,255,255,.35);border-radius:12px;"></canvas>
      <div data-nostick style="position:fixed;right:20px;bottom:26px;display:flex;flex-direction:column;gap:14px;align-items:center;">
        <button id="kItem" style="pointer-events:auto;">🎁 ITEM</button>
        <button id="kSpeed" style="pointer-events:auto;">🚤 SPEED</button>
      </div>`;
    document.body.appendChild(ui);
    const btnCss = 'font-family:Bungee,system-ui,sans-serif;font-size:18px;border:none;border-radius:16px;padding:16px 22px;color:#12142e;cursor:pointer;box-shadow:0 5px 0 rgba(0,0,0,.35);touch-action:none;user-select:none;';
    this.itemBtn = ui.querySelector('#kItem')!;
    this.speedBtn = ui.querySelector('#kSpeed')!;
    this.itemBtn.style.cssText += btnCss + 'background:#FFD23F;opacity:0.45;';
    this.speedBtn.style.cssText += btnCss + 'background:#4DC3FF;';
    this.itemBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); this.useItem(this.ctx.players[0]); });
    const down = (e: Event) => { e.preventDefault(); e.stopPropagation(); this.boosting = true; this.speedBtn.style.filter = 'brightness(1.25)'; };
    const up = (e: Event) => { e.preventDefault(); this.boosting = false; this.speedBtn.style.filter = ''; };
    this.speedBtn.addEventListener('pointerdown', down);
    this.speedBtn.addEventListener('pointerup', up);
    this.speedBtn.addEventListener('pointerleave', up);
    this.speedBtn.addEventListener('pointercancel', up);
    this.map = ui.querySelector('#bMap')!;
    this.mapCtx = this.map.getContext('2d')!;
  }

  private mapXY(x: number, z: number): [number, number] {
    const { minX, maxX, minZ, maxZ } = this.mapBounds;
    const w = this.map.width, h = this.map.height, pad = 10;
    return [pad + ((x - minX) / (maxX - minX)) * (w - pad * 2), pad + ((z - minZ) / (maxZ - minZ)) * (h - pad * 2)];
  }

  private updateMinimap() {
    if (!this.mapCtx) return;
    const g = this.mapCtx;
    g.clearRect(0, 0, this.map.width, this.map.height);
    g.strokeStyle = 'rgba(120,200,255,.85)'; g.lineWidth = 5; g.lineJoin = 'round';
    g.beginPath();
    for (let i = 0; i < this.N; i += 8) {
      const [mx, my] = this.mapXY(this.path[i].x, this.path[i].z);
      if (i === 0) g.moveTo(mx, my); else g.lineTo(mx, my);
    }
    g.stroke();
    const f = this.path[this.N - 6];
    const [fx, fy] = this.mapXY(f.x, f.z);
    g.fillStyle = '#fff'; g.fillRect(fx - 4, fy - 4, 8, 8);
    g.fillStyle = '#111'; g.fillRect(fx - 4, fy - 4, 4, 4); g.fillRect(fx, fy, 4, 4);
    for (const p of this.ctx.players) {
      if (p.dead) continue;
      const [mx, my] = this.mapXY(p.x, p.z);
      g.beginPath(); g.arc(mx, my, p.you ? 5 : 4, 0, Math.PI * 2);
      g.fillStyle = '#' + new THREE.Color(p.hero.col).getHexString(); g.fill();
      g.lineWidth = 2; g.strokeStyle = p.you ? '#fff' : 'rgba(0,0,0,.5)'; g.stroke();
    }
  }

  private updateItemBtn() {
    if (!this.itemBtn) return;
    const has = !!this.held[0];
    this.itemBtn.textContent = has ? `${ITEM_EMOJI[this.held[0]!]} USE` : '🎁 ITEM';
    this.itemBtn.style.opacity = has ? '1' : '0.45';
  }

  private doFinish() {
    if (this.finished) return;
    this.finished = true;
    document.getElementById('boatUI')?.remove();
    for (const pk of this.pickups) this.ctx.scene.remove(pk.group);
    for (const b of this.oils) this.ctx.scene.remove(b.group);
    for (const s of this.shots) this.ctx.scene.remove(s.group);
    for (const p of this.ctx.players) p.sitting = false;
    const ctx = this.ctx;
    const ranked = rankBy(ctx, (p) => this.progressScore(p));
    ctx.players.forEach((p) => {
      const fin = this.finishOrder.indexOf(p.index);
      (p as any)._res = fin >= 0 ? `Finished #${fin + 1}` : `${Math.round((this.idx[p.index] / (this.N - 6)) * 100)}% down`;
    });
    ctx.finish(ranked, `${ranked[0].hero.name} takes the castle!`);
  }
}
