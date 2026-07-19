import * as THREE from 'three';
import type { GameModule, MatchContext } from '../context';
import type { Player } from '../player';
import { setupRoster, tickRoster, rankBy } from '../freeroam';
import { matchTime } from '../../core/tuning';
import { SFX } from '../../core/audio';
import { setScore } from '../../ui/hud';

// BOAT BASH RACE (Wildwood tier 1). A third-person speed-boat race down a wide,
// winding forest river. You always surge forward; hold SPEED to floor it and
// steer with the stick to weave through the bends, snatch weapon pickups, and
// RAM the other three boats. Grab a weapon (shown above your boat) and tap it:
//   ⚽ ball    – rolls forward and homes on the boat ahead, bumping it
//   🛢️ mine    – drop it behind you; anyone who hits it spins out
//   👟 boost   – 1.6x speed for a few seconds
//   ⚡ zap      – stuns every rival boat for a beat
//   🚀 torpedo  – fires forward and slams the boat ahead
// First boat across the checkered finish banner wins; if the 1-minute clock
// runs out first, furthest down the river wins. A minimap up top tracks everyone.

type Item = 'ball' | 'mine' | 'boost' | 'zap' | 'rocket';
const ITEM_EMOJI: Record<Item, string> = { ball: '⚽', mine: '🛢️', boost: '👟', zap: '⚡', rocket: '🚀' };
const ALL_ITEMS: Item[] = ['ball', 'mine', 'boost', 'zap', 'rocket'];

interface Pickup { x: number; z: number; kind: Item; group: THREE.Group; }
interface Mine { x: number; z: number; group: THREE.Group; }
interface Shot { x: number; z: number; vx: number; vz: number; kind: 'ball' | 'rocket'; owner: number; group: THREE.Group; life: number; }

const CRUISE = 17;
const BOOST = 29;
const ACCEL = 2.2;
const TURN = 2.0;
const HALF_W = 12;      // river channel half-width (≈24 wide → 4 boats abreast)
const BOAT_R = 2.6;     // boat collision radius

// Winding centreline control points (x, z) — a wide river snaking down through
// the forest, start at the top, finish banner at the bottom.
const CTRL: [number, number][] = [
  [0, 66], [-22, 46], [20, 22], [-20, -4], [18, -30], [-10, -52], [0, -70],
];

export class BoatGame implements GameModule {
  readonly stickMode = 'float' as const;
  title = 'Boat Bash Race';
  objective = '🚤 Race to the flag! Grab weapons & ram rivals!';

  private ctx!: MatchContext;
  private timeLeft = 60;
  private finished = false;

  // Course sampling.
  private path: THREE.Vector3[] = [];
  private heads: number[] = [];   // tangent heading at each sample
  private N = 0;

  // Per-boat state (indexed by player.index).
  private boats: THREE.Group[] = [];
  private head: number[] = [];
  private speed: number[] = [];
  private spinT: number[] = [];
  private idx: number[] = [];      // nearest sample index (progress)
  private held: (Item | null)[] = [];
  private botItemT: number[] = [];
  private cruiseMul: number[] = [];
  private done: boolean[] = [];
  private finishOrder: number[] = [];

  private pickups: Pickup[] = [];
  private mines: Mine[] = [];
  private shots: Shot[] = [];
  private pickupT = 1.5;
  private water: THREE.Mesh | null = null;

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
    this.timeLeft = matchTime(60);
    this.pickups = []; this.mines = []; this.shots = [];
    this.pickupT = 1.5;
    this.finishOrder = [];

    this.buildCourse();
    setupRoster(ctx, '1st', 0.5);
    this.buildUI();

    this.boats = []; this.head = []; this.speed = []; this.spinT = [];
    this.idx = []; this.held = []; this.botItemT = []; this.cruiseMul = []; this.done = [];

    const startH = this.heads[0];
    ctx.players.forEach((p, i) => {
      // Line the four boats up abreast across the channel behind the start.
      const lane = (i - 1.5) * (HALF_W * 0.5);
      const perpX = Math.cos(startH), perpZ = -Math.sin(startH); // right-hand perp of forward
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
      this.cruiseMul[p.index] = 0.9 + Math.random() * 0.18;
      this.done[p.index] = false;
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

  // --- course -----------------------------------------------------------------
  private buildCourse() {
    const scene = this.ctx.scene;
    const pts3 = CTRL.map(([x, z]) => new THREE.Vector3(x, 0, z));
    const curve = new THREE.CatmullRomCurve3(pts3, false, 'catmullrom', 0.5);
    this.N = 500;
    this.path = curve.getPoints(this.N - 1); // N points
    this.N = this.path.length;
    this.heads = this.path.map((_, i) => {
      const a = this.path[Math.max(0, i - 1)];
      const b = this.path[Math.min(this.N - 1, i + 1)];
      return Math.atan2(b.x - a.x, b.z - a.z);
    });

    // River ribbon (water) + banks, built as triangle strips along the curve.
    const left: THREE.Vector3[] = [], right: THREE.Vector3[] = [];
    const bankL: THREE.Vector3[] = [], bankR: THREE.Vector3[] = [];
    for (let i = 0; i < this.N; i++) {
      const c = this.path[i], h = this.heads[i];
      const px = Math.cos(h), pz = -Math.sin(h); // right perp of forward (sin h, cos h)
      left.push(new THREE.Vector3(c.x - px * HALF_W, 0.32, c.z - pz * HALF_W));
      right.push(new THREE.Vector3(c.x + px * HALF_W, 0.32, c.z + pz * HALF_W));
      bankL.push(new THREE.Vector3(c.x - px * (HALF_W + 5), 0.85, c.z - pz * (HALF_W + 5)));
      bankR.push(new THREE.Vector3(c.x + px * (HALF_W + 5), 0.85, c.z + pz * (HALF_W + 5)));
    }
    const waterMat = new THREE.MeshStandardMaterial({
      color: 0x2b8fe0, roughness: 0.2, metalness: 0.35,
      emissive: 0x1466a8, emissiveIntensity: 0.6,
    });
    this.water = this.ribbon(left, right, waterMat);
    scene.add(this.water);
    // Sandy shore strip framing the water, so the channel reads clearly.
    const bankMat = new THREE.MeshStandardMaterial({ color: 0xc9a76b, roughness: 1 });
    scene.add(this.ribbon(bankL, left, bankMat));
    scene.add(this.ribbon(right, bankR, bankMat));

    // Trees crowding both banks — the forest the river winds through.
    for (let i = 6; i < this.N - 6; i += 9) {
      for (const side of [-1, 1]) {
        if (Math.random() < 0.35) continue;
        const c = this.path[i], h = this.heads[i];
        const px = Math.cos(h), pz = -Math.sin(h);
        const off = HALF_W + 6 + Math.random() * 10;
        this.addTree(c.x + px * off * side, c.z + pz * off * side);
      }
    }

    // A checkered mat on the water at the finish + a checkered banner overhead.
    this.buildFinish();

    // Track bounds for the minimap.
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const c of this.path) {
      minX = Math.min(minX, c.x); maxX = Math.max(maxX, c.x);
      minZ = Math.min(minZ, c.z); maxZ = Math.max(maxZ, c.z);
    }
    const pad = HALF_W + 6;
    this.mapBounds = { minX: minX - pad, maxX: maxX + pad, minZ: minZ - pad, maxZ: maxZ + pad };
  }

  /** Build a flat triangle-strip ribbon between two matched edge lists. */
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
      // Wind so the strip's normals face UP (toward the sky) — otherwise the top
      // face is back-culled and you'd see straight through the river.
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
    const px = Math.cos(h), pz = -Math.sin(h); // across the river

    // Checkered mat laid across the water at the line.
    const rows = 2, cols = 8, cw = (HALF_W * 2) / cols;
    for (let r = 0; r < rows; r++) {
      for (let col = 0; col < cols; col++) {
        const off = (col - (cols - 1) / 2) * cw;
        const along = (r - 0.5) * cw;
        const white = (r + col) % 2 === 0;
        const tile = new THREE.Mesh(new THREE.BoxGeometry(cw, 0.08, cw),
          new THREE.MeshStandardMaterial({ color: white ? 0xffffff : 0x111111, roughness: 0.7 }));
        tile.position.set(c.x + px * off + Math.sin(h) * along, 0.3, c.z + pz * off + Math.cos(h) * along);
        tile.rotation.y = h;
        scene.add(tile);
      }
    }

    // Two poles + a long checkered banner hung across the top of the river.
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
    banner.rotation.y = h + Math.PI / 2; // face along the river
    scene.add(banner);
    // A "FINISH" sprite floating above the banner.
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

  // --- boat + item models -----------------------------------------------------
  private makeBoat(col: number | string): THREE.Group {
    const g = new THREE.Group();
    const hullMat = new THREE.MeshStandardMaterial({ color: col, roughness: 0.4, metalness: 0.3 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x14141c, roughness: 0.7 });
    const white = new THREE.MeshStandardMaterial({ color: 0xf0f4ff, roughness: 0.5 });
    // Hull (boat faces +z = forward). A tapered wedge: wide flat stern, pointed bow.
    const hull = new THREE.Mesh(new THREE.BoxGeometry(3.0, 0.9, 5.0), hullMat);
    hull.position.y = 0.55; hull.castShadow = true; g.add(hull);
    const bow = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 1.5, 2.4, 4), hullMat);
    bow.rotation.x = Math.PI / 2; bow.rotation.y = Math.PI / 4;
    bow.position.set(0, 0.55, 3.2); g.add(bow);
    // Deck + cockpit.
    const deck = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.2, 3.4), white);
    deck.position.set(0, 1.05, 0.4); g.add(deck);
    const dash = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.9, 0.5), white);
    dash.position.set(0, 1.5, 1.1); g.add(dash);
    const seat = new THREE.Mesh(new THREE.BoxGeometry(1.6, 1.1, 0.4), dark);
    seat.position.set(0, 1.5, -1.0); g.add(seat);
    // Little windshield + steering wheel.
    const ws = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.7, 0.08),
      new THREE.MeshStandardMaterial({ color: 0x9fd8ff, roughness: 0.1, metalness: 0.2, transparent: true, opacity: 0.6 }));
    ws.position.set(0, 2.0, 1.35); ws.rotation.x = -0.3; g.add(ws);
    const wheel = new THREE.Mesh(new THREE.TorusGeometry(0.4, 0.1, 6, 12), dark);
    wheel.position.set(0, 1.55, 0.6); wheel.rotation.x = 1.1; g.add(wheel);
    // Outboard motor at the stern.
    const motor = new THREE.Mesh(new THREE.BoxGeometry(0.7, 1.1, 0.7), dark);
    motor.position.set(0, 0.9, -2.7); g.add(motor);
    return g;
  }

  private itemModel(kind: Item): THREE.Object3D {
    const g = new THREE.Group();
    if (kind === 'ball') {
      g.add(new THREE.Mesh(new THREE.IcosahedronGeometry(1.0, 1),
        new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5 })));
    } else if (kind === 'mine') {
      const drum = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.7, 1.2, 12),
        new THREE.MeshStandardMaterial({ color: 0xd23b3b, roughness: 0.5, metalness: 0.2, emissive: 0x400 }));
      g.add(drum);
      for (let i = 0; i < 4; i++) {
        const spike = new THREE.Mesh(new THREE.ConeGeometry(0.18, 0.5, 5),
          new THREE.MeshStandardMaterial({ color: 0x222 }));
        const a = (i / 4) * Math.PI * 2;
        spike.position.set(Math.cos(a) * 0.75, 0, Math.sin(a) * 0.75);
        spike.rotation.z = Math.PI / 2; spike.rotation.y = -a; g.add(spike);
      }
    } else if (kind === 'boost') {
      for (let i = 0; i < 2; i++) {
        const c = new THREE.Mesh(new THREE.ConeGeometry(0.9, 1.2, 4),
          new THREE.MeshStandardMaterial({ color: 0x2fe04a, emissive: 0x0d5a1a, emissiveIntensity: 0.6, roughness: 0.4 }));
        c.rotation.x = -Math.PI / 2; c.position.z = -0.6 + i * 1.0; g.add(c);
      }
    } else if (kind === 'zap') {
      const m = new THREE.Mesh(new THREE.OctahedronGeometry(1.1, 0),
        new THREE.MeshStandardMaterial({ color: 0xffe23a, emissive: 0xffd000, emissiveIntensity: 0.8, roughness: 0.3, flatShading: true }));
      m.scale.set(0.6, 1.5, 0.6); g.add(m);
    } else { // rocket / torpedo
      const b = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 1.8, 10),
        new THREE.MeshStandardMaterial({ color: 0x555, roughness: 0.4, metalness: 0.4 }));
      b.rotation.x = Math.PI / 2; g.add(b);
      const tip = new THREE.Mesh(new THREE.ConeGeometry(0.5, 0.9, 10),
        new THREE.MeshStandardMaterial({ color: 0xd23b3b }));
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
    this.timeLeft -= dt;
    ctx.setClock(this.timeLeft);

    for (const p of ctx.players) if (!p.dead) this.driveBoat(p, dt);
    this.separateBoats();

    // Sync boat meshes + seated drivers, with a gentle roll/bob for life.
    for (const p of ctx.players) {
      const b = this.boats[p.index];
      if (!b) continue;
      b.position.set(p.x, 0, p.z);
      b.rotation.y = this.head[p.index];
      b.rotation.z = Math.sin(elapsed * 3 + p.index) * 0.05;
      b.position.y = Math.sin(elapsed * 2.4 + p.index * 1.3) * 0.12;
      b.visible = !p.dead;
      p.standFacing = this.head[p.index];
      p.y = 0.5 + b.position.y;
    }

    this.tickPickups(dt);
    this.tickMines();
    this.tickShots(dt);
    if (this.water) (this.water.material as THREE.MeshStandardMaterial).emissiveIntensity = 0.4 + Math.sin(elapsed * 3) * 0.15;

    // Bots fire held weapons after a beat.
    for (const p of ctx.players.slice(1)) {
      if (p.dead || this.done[p.index] || !this.held[p.index]) continue;
      this.botItemT[p.index] -= dt;
      if (this.botItemT[p.index] <= 0) this.useItem(p);
    }

    this.rankBoats();
    this.updateMinimap();
    tickRoster(ctx, dt, elapsed);

    // Chase camera behind the LOCAL boat.
    const you = ctx.players[0];
    ctx.camera.chaseBehind(you.x, you.y, you.z, this.head[you.index]);

    if (this.timeLeft <= 0) this.doFinish();
  }

  private driveBoat(p: Player, dt: number) {
    const i = p.index;
    if (this.done[i]) { this.speed[i] *= 0.9; return; } // parked past the line

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
      let target = (wantBoost ? BOOST : CRUISE) * this.cruiseMul[i];
      if (p.speedT > 0) target *= 1.6;
      this.speed[i] += (target - this.speed[i]) * ACCEL * dt;
    }

    const fx = Math.sin(this.head[i]), fz = Math.cos(this.head[i]);
    p.x += fx * this.speed[i] * dt;
    p.z += fz * this.speed[i] * dt;
    p.vx = fx * this.speed[i]; p.vz = fz * this.speed[i];

    // Progress: advance the nearest-sample index within a forward window so we
    // never snap across a nearby bend.
    let best = this.idx[i], bd = Infinity;
    for (let s = Math.max(0, this.idx[i] - 4); s <= Math.min(this.N - 1, this.idx[i] + 40); s++) {
      const c = this.path[s];
      const d = (c.x - p.x) * (c.x - p.x) + (c.z - p.z) * (c.z - p.z);
      if (d < bd) { bd = d; best = s; }
    }
    this.idx[i] = best;

    // Bank collision: shove back into the channel and scrub speed (a crash).
    const c = this.path[best];
    const dx = p.x - c.x, dz = p.z - c.z, dist = Math.hypot(dx, dz);
    const lim = HALF_W - BOAT_R;
    if (dist > lim && dist > 0.001) {
      p.x = c.x + (dx / dist) * lim;
      p.z = c.z + (dz / dist) * lim;
      this.speed[i] *= 0.86;
      if (p.you && this.speed[i] > 6) SFX.bump();
    }

    // Crossed the finish line?
    if (best >= this.N - 4) this.crossFinish(p);
  }

  private botSteer(p: Player): number {
    const i = p.index;
    // Aim at a look-ahead point on the centreline, nudged toward a nearby pickup.
    const ahead = this.path[Math.min(this.N - 1, this.idx[i] + 14)];
    let tx = ahead.x, tz = ahead.z;
    if (!this.held[i]) {
      let best: Pickup | null = null, bd = 18;
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
          // Ramming scrubs a little speed off both and sparks on a hard hit.
          const rel = Math.abs(this.speed[pa.index] - this.speed[pb.index]);
          if (rel > 10) {
            this.ctx.fx.burst((pa.x + pb.x) / 2, (pa.z + pb.z) / 2, '#ffffff', 6);
            if (pa.you || pb.you) { SFX.bump(); this.ctx.fx.shake(0.8); }
          }
        }
      }
    }
  }

  private rankBoats() {
    // Score = finish placement (finishers first) then progress down the river.
    const ranked = [...this.ctx.players].sort((a, b) => this.progressScore(b) - this.progressScore(a));
    ranked.forEach((p, r) => {
      const label = this.done[p.index] ? '🏁' : ['1st', '2nd', '3rd', '4th'][r];
      setScore(p, label);
    });
  }

  private progressScore(p: Player): number {
    const fin = this.finishOrder.indexOf(p.index);
    if (fin >= 0) return 1e6 - fin; // earlier finishers rank higher
    return this.idx[p.index];
  }

  private crossFinish(p: Player) {
    if (this.done[p.index]) return;
    this.done[p.index] = true;
    this.finishOrder.push(p.index);
    this.speed[p.index] *= 0.4;
    if (p.you) {
      this.ctx.fx.banner('🏁 FINISH!', p.hero.col);
      SFX.win();
    } else {
      this.ctx.fx.banner(`${p.hero.name} finishes!`, p.hero.col);
    }
    // End when YOU cross, or once every boat is home.
    if (p.you || this.ctx.players.every((q) => this.done[q.index] || q.dead)) {
      setTimeout(() => this.doFinish(), p.you ? 700 : 300);
    }
  }

  // --- pickups ----------------------------------------------------------------
  private tickPickups(dt: number) {
    this.pickupT -= dt;
    if (this.pickupT <= 0 && this.pickups.length < 5) { this.pickupT = 1.4 + Math.random() * 1.8; this.spawnPickup(); }
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
    // Somewhere ahead on the course, offset across the channel.
    const s = 10 + Math.floor(Math.random() * (this.N - 20));
    const c = this.path[s], h = this.heads[s];
    const px = Math.cos(h), pz = -Math.sin(h);
    const off = (Math.random() - 0.5) * HALF_W * 1.3;
    const x = c.x + px * off, z = c.z + pz * off;
    const group = new THREE.Group();
    const model = this.itemModel(kind);
    model.position.y = 1.6; group.add(model);
    const spr = this.emojiSprite(ITEM_EMOJI[kind], 2.6);
    spr.position.y = 3.6; group.add(spr);
    const ring = new THREE.Mesh(new THREE.RingGeometry(1.4, 2.0, 20),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.4, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2; ring.position.y = 0.4; group.add(ring);
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

  // --- using weapons ----------------------------------------------------------
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
    } else if (kind === 'mine') {
      this.dropMine(p);
    } else if (kind === 'zap') {
      this.zapAll(p);
    } else {
      this.fireShot(p, kind);
    }
    SFX.power();
  }

  private dropMine(p: Player) {
    const bx = p.x - Math.sin(this.head[p.index]) * 3.5;
    const bz = p.z - Math.cos(this.head[p.index]) * 3.5;
    const group = new THREE.Group();
    const model = this.itemModel('mine');
    model.position.y = 0.6; group.add(model);
    group.position.set(bx, 0, bz);
    this.ctx.scene.add(group);
    this.mines.push({ x: bx, z: bz, group });
    if (p.you) this.ctx.fx.banner('🛢️ MINE dropped!', '#d23b3b');
  }

  private tickMines() {
    for (let i = this.mines.length - 1; i >= 0; i--) {
      const b = this.mines[i];
      b.group.rotation.y += 0.03;
      const hit = this.ctx.players.find((p) => !p.dead && this.spinT[p.index] <= 0 && p.freezeT <= 0 && Math.hypot(p.x - b.x, p.z - b.z) < 2.6);
      if (!hit) continue;
      this.ctx.scene.remove(b.group);
      this.mines.splice(i, 1);
      this.spinT[hit.index] = 1.3;
      SFX.bump();
      this.ctx.fx.burst(hit.x, hit.z, '#d23b3b', 12);
      this.ctx.fx.shake(1.0);
      this.ctx.fx.banner(hit.you ? 'HIT A MINE! 🛢️' : '', '#d23b3b');
    }
  }

  private zapAll(by: Player) {
    for (const p of this.ctx.players) {
      if (p === by || p.dead || this.done[p.index]) continue;
      p.freezeT = Math.max(p.freezeT, 1.0);
      p.zapped = true;
      this.ctx.fx.burst(p.x, p.z, '#ffe23a', 8);
    }
    this.ctx.fx.shake(1.4);
    if (by.you) this.ctx.fx.banner('⚡ ZAP! rivals stunned', '#ffe23a');
    else if (this.ctx.players[0].freezeT > 0) this.ctx.fx.banner('⚡ ZAPPED!', '#ffe23a');
  }

  private fireShot(p: Player, kind: 'ball' | 'rocket') {
    const speed = kind === 'rocket' ? 46 : 28;
    const fx = Math.sin(this.head[p.index]), fz = Math.cos(this.head[p.index]);
    const group = new THREE.Group();
    const model = this.itemModel(kind);
    model.position.y = 1.0; group.add(model);
    group.position.set(p.x + fx * 3.5, 0, p.z + fz * 3.5);
    this.ctx.scene.add(group);
    this.shots.push({ x: p.x + fx * 3.5, z: p.z + fz * 3.5, vx: fx * speed, vz: fz * speed, kind, owner: p.index, group, life: kind === 'rocket' ? 2.4 : 3.2 });
    if (p.you) this.ctx.fx.banner(kind === 'rocket' ? '🚀 TORPEDO!' : '⚽ FIRE!', '#FF4D4D');
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
        const sp = Math.hypot(s.vx, s.vz), cap = s.kind === 'rocket' ? 52 : 32;
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
        else this.spinT[hit.index] = 1.0;
        SFX.hit();
        this.ctx.fx.burst(hit.x, hit.z, s.kind === 'rocket' ? '#FF4D4D' : '#ffffff', 14);
        this.ctx.fx.shake(1.4);
        if (hit.you) this.ctx.fx.banner(s.kind === 'rocket' ? 'TORPEDOED! 🚀' : 'BALLED! ⚽', '#FF4D4D');
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
      <canvas id="bMap" width="150" height="150" style="position:fixed;top:70px;left:50%;transform:translateX(-50%);
        width:120px;height:120px;background:rgba(10,20,34,.55);border:2px solid rgba(255,255,255,.35);
        border-radius:12px;"></canvas>
      <div data-nostick style="position:fixed;right:20px;bottom:26px;display:flex;flex-direction:column;gap:14px;align-items:center;">
        <button id="bItem" style="pointer-events:auto;">🎁 ITEM</button>
        <button id="bSpeed" style="pointer-events:auto;">🚤 SPEED</button>
      </div>`;
    document.body.appendChild(ui);
    const btnCss = 'font-family:Bungee,system-ui,sans-serif;font-size:18px;border:none;border-radius:16px;padding:16px 22px;color:#12142e;cursor:pointer;box-shadow:0 5px 0 rgba(0,0,0,.35);touch-action:none;user-select:none;';
    this.itemBtn = ui.querySelector('#bItem')!;
    this.speedBtn = ui.querySelector('#bSpeed')!;
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
    const mx = pad + ((x - minX) / (maxX - minX)) * (w - pad * 2);
    const my = pad + ((z - minZ) / (maxZ - minZ)) * (h - pad * 2);
    return [mx, my];
  }

  private updateMinimap() {
    if (!this.mapCtx) return;
    const g = this.mapCtx;
    g.clearRect(0, 0, this.map.width, this.map.height);
    // River path.
    g.strokeStyle = 'rgba(120,200,255,.85)'; g.lineWidth = 6; g.lineJoin = 'round';
    g.beginPath();
    for (let i = 0; i < this.N; i += 6) {
      const [mx, my] = this.mapXY(this.path[i].x, this.path[i].z);
      if (i === 0) g.moveTo(mx, my); else g.lineTo(mx, my);
    }
    g.stroke();
    // Finish marker.
    const f = this.path[this.N - 4];
    const [fx, fy] = this.mapXY(f.x, f.z);
    g.fillStyle = '#fff'; g.fillRect(fx - 5, fy - 5, 10, 10);
    g.fillStyle = '#111'; g.fillRect(fx - 5, fy - 5, 5, 5); g.fillRect(fx, fy, 5, 5);
    // Boats.
    for (const p of this.ctx.players) {
      if (p.dead) continue;
      const [mx, my] = this.mapXY(p.x, p.z);
      g.beginPath(); g.arc(mx, my, p.you ? 5 : 4, 0, Math.PI * 2);
      g.fillStyle = '#' + new THREE.Color(p.hero.col).getHexString();
      g.fill();
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
    for (const b of this.mines) this.ctx.scene.remove(b.group);
    for (const s of this.shots) this.ctx.scene.remove(s.group);
    for (const p of this.ctx.players) p.sitting = false;
    const ctx = this.ctx;
    const ranked = rankBy(ctx, (p) => this.progressScore(p));
    ctx.players.forEach((p) => {
      const fin = this.finishOrder.indexOf(p.index);
      (p as any)._res = fin >= 0 ? `Finished #${fin + 1}` : `${Math.round((this.idx[p.index] / (this.N - 4)) * 100)}% down`;
    });
    ctx.finish(ranked, `${ranked[0].hero.name} takes the checkered flag!`);
  }
}
