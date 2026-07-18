import * as THREE from 'three';
import type { GameModule, MatchContext } from '../context';
import type { Player } from '../player';
import { setupRoster, tickRoster, rankBy } from '../freeroam';
import { matchTime } from '../../core/tuning';
import { SFX } from '../../core/audio';
import { setScore } from '../../ui/hud';

// RACE KART (Dune Clash). Four karts race CLOCKWISE... no — anticlockwise round a
// desert ring track. You always cruise forward; hold SPEED to floor it and steer
// with the stick to weave for item pickups. Grab an item (shown above your kart)
// and tap ITEM to use it:
//   ⚽ football  – rolls forward and homes on the kart in front, bumping it
//   🍌 banana    – drop it behind you; anyone who drives over it spins out
//   👟 boost     – 1.5x speed for a few seconds
//   ⚡ zap        – stuns every rival for 1s (they black out)
//   🚀 rocket     – fires forward and slams the kart in front
// Most laps when the 1-minute clock runs out wins. Item pickups respawn at
// random spots and clearly show what they are.

type Item = 'ball' | 'banana' | 'boost' | 'zap' | 'rocket';
const ITEM_EMOJI: Record<Item, string> = { ball: '⚽', banana: '🍌', boost: '👟', zap: '⚡', rocket: '🚀' };
const ALL_ITEMS: Item[] = ['ball', 'banana', 'boost', 'zap', 'rocket'];

interface Pickup { x: number; z: number; kind: Item; group: THREE.Group; }
interface Banana { x: number; z: number; group: THREE.Group; }
interface Shot { x: number; z: number; vx: number; vz: number; kind: 'ball' | 'rocket'; owner: number; group: THREE.Group; life: number; }

const CRUISE = 15;
const BOOST = 25;
const ACCEL = 2.4;
const TURN = 2.4;
const AUTOCURVE = 2.0;

export class KartGame implements GameModule {
  readonly stickMode = 'float' as const;
  title = 'Race Kart';
  objective = '🏁 Race! Grab items — most laps wins!';

  private ctx!: MatchContext;
  private innerR = 12;
  private outerR = 27;
  private midR = 19.5;
  private timeLeft = 60;
  private finished = false;

  private karts: THREE.Group[] = [];
  private head: number[] = [];
  private speed: number[] = [];
  private spinT: number[] = [];
  private progress: number[] = [];
  private lastTheta: number[] = [];
  private laps: number[] = [];
  private held: (Item | null)[] = [];
  private botItemT: number[] = [];
  private cruiseMul: number[] = [];

  private pickups: Pickup[] = [];
  private bananas: Banana[] = [];
  private shots: Shot[] = [];
  private pickupT = 2;

  private boosting = false;
  private itemBtn!: HTMLButtonElement;
  private speedBtn!: HTMLButtonElement;

  init(ctx: MatchContext) {
    this.ctx = ctx;
    this.title = ctx.game.name;
    this.finished = false;
    this.timeLeft = matchTime(60);
    this.outerR = ctx.halfSize - 3;
    this.innerR = ctx.halfSize * 0.42;
    this.midR = (this.innerR + this.outerR) / 2;

    setupRoster(ctx, 'Lap 1', 0.5);
    this.buildTrack();
    this.buildUI();

    this.karts = []; this.head = []; this.speed = []; this.spinT = [];
    this.progress = []; this.lastTheta = []; this.laps = []; this.held = []; this.botItemT = [];
    this.cruiseMul = [];

    // Grid start: strung out behind the finish line (θ = 0, +x axis) so they don't
    // start in a pile, alternating lanes, all pointing anticlockwise.
    ctx.players.forEach((p, i) => {
      const lane = this.innerR + 4 + (i % 2) * (this.outerR - this.innerR - 8);
      const th = -0.16 - i * 0.34; // each kart a bit further back
      p.x = Math.cos(th) * lane;
      p.z = Math.sin(th) * lane;
      p.vx = 0; p.vz = 0; p.y = 0.55;   // lifted to sit in the kart seat
      p.sitting = true;                 // sit in the kart
      this.head[p.index] = this.tangentHead(p.x, p.z);
      this.speed[p.index] = 0;
      this.spinT[p.index] = 0;
      this.progress[p.index] = 0;
      this.lastTheta[p.index] = Math.atan2(p.z, p.x);
      this.laps[p.index] = 0;
      this.held[p.index] = null;
      this.botItemT[p.index] = 0;
      this.cruiseMul[p.index] = 0.92 + Math.random() * 0.16; // slight per-kart pace
      p.standFacing = this.head[p.index];
      const kart = this.makeKart(p.hero.col);
      kart.position.set(p.x, 0, p.z);
      kart.rotation.y = this.head[p.index];
      ctx.scene.add(kart);
      this.karts[p.index] = kart;
      setScore(p, 'Lap 1');
    });

    ctx.fx.banner('GO! 🏁', '#7ED321');
  }

  // Anticlockwise tangent heading (model faces +z at 0, so angle = atan2(fx,fz)).
  private tangentHead(x: number, z: number): number {
    const r = Math.hypot(x, z) || 0.001;
    const ux = x / r, uz = z / r;
    return Math.atan2(-uz, ux); // tangent = (-uz, ux)
  }

  // --- track ------------------------------------------------------------------
  private buildTrack() {
    const scene = this.ctx.scene;
    // Asphalt ring the karts drive on — a mid grey road that reads clearly (a
    // gentle emissive lift keeps it from crushing to black under the grade).
    const asphalt = new THREE.Mesh(
      new THREE.RingGeometry(this.innerR, this.outerR, 72),
      new THREE.MeshStandardMaterial({ color: 0x8b8e94, roughness: 0.92, emissive: 0x1a1c20, emissiveIntensity: 0.6 }),
    );
    asphalt.rotation.x = -Math.PI / 2;
    asphalt.position.y = 0.04;
    asphalt.receiveShadow = true;
    scene.add(asphalt);
    // A dashed centre lane line down the middle of the road.
    const dashN = 40;
    for (let i = 0; i < dashN; i++) {
      if (i % 2) continue;
      const a = (i / dashN) * Math.PI * 2;
      const dash = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.05, 1.6),
        new THREE.MeshStandardMaterial({ color: 0xf2e9c0, emissive: 0x3a3520, roughness: 0.8 }));
      dash.position.set(Math.cos(a) * this.midR, 0.09, Math.sin(a) * this.midR);
      dash.rotation.y = -a;
      scene.add(dash);
    }

    // Black & yellow chevron kerbs on the inner and outer edges.
    this.buildKerb(this.outerR + 0.2, 0.9);
    this.buildKerb(this.innerR - 0.2, 0.9);

    // Raised centre hub (the infield island). castShadow OFF so it doesn't
    // drop the whole ring into darkness; kept low and sandy-topped.
    const hub = new THREE.Mesh(
      new THREE.CylinderGeometry(this.innerR - 1, this.innerR - 0.4, 2, 40),
      new THREE.MeshStandardMaterial({ color: 0x8a7550, roughness: 1, flatShading: true }),
    );
    hub.position.y = 1; hub.castShadow = false; hub.receiveShadow = true;
    scene.add(hub);
    const hubTop = new THREE.Mesh(
      new THREE.CylinderGeometry(this.innerR - 1.6, this.innerR - 1, 0.6, 40),
      new THREE.MeshStandardMaterial({ color: 0xc9a25b, roughness: 1 }),
    );
    hubTop.position.y = 2.2; scene.add(hubTop);

    // Checkered black/white finish line across the track at θ = 0 (+x axis).
    this.buildFinishLine();

    // Direction arrows painted on the asphalt.
    for (const a of [Math.PI * 0.5, Math.PI, Math.PI * 1.5]) this.paintArrow(a);

    // Desert dressing outside the ring so the whole thing reads as a track in a
    // real desert (the dune family already themes the ground + sky sandy).
    this.buildDesert();
  }

  private buildKerb(radius: number, y: number) {
    const scene = this.ctx.scene;
    const n = 48;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const col = i % 2 === 0 ? 0x111111 : 0xf2c200;
      const block = new THREE.Mesh(
        new THREE.BoxGeometry(1.7, y, 1.7),
        new THREE.MeshStandardMaterial({ color: col, roughness: 0.7, emissive: i % 2 ? 0x3a2c00 : 0x000000 }),
      );
      block.position.set(Math.cos(a) * radius, y / 2, Math.sin(a) * radius);
      block.rotation.y = a;
      block.castShadow = true;
      scene.add(block);
    }
  }

  private buildFinishLine() {
    const scene = this.ctx.scene;
    const rows = 10, cols = 3;
    const w = (this.outerR - this.innerR) / rows;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const rad = this.innerR + (r + 0.5) * w;
        const dz = (c - (cols - 1) / 2) * 1.4;
        const col = (r + c) % 2 === 0 ? 0xffffff : 0x111111;
        const tile = new THREE.Mesh(
          new THREE.BoxGeometry(w, 0.12, 1.4),
          new THREE.MeshStandardMaterial({ color: col, roughness: 0.7 }),
        );
        tile.position.set(rad, 0.11, dz);
        scene.add(tile);
      }
    }
  }

  private paintArrow(a: number) {
    const scene = this.ctx.scene;
    const g = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5, side: THREE.DoubleSide });
    for (let i = 0; i < 2; i++) {
      const bar = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 1.0), mat);
      bar.rotation.x = -Math.PI / 2;
      bar.rotation.z = i === 0 ? 0.6 : -0.6;
      bar.position.set(i === 0 ? -0.9 : 0.9, 0, 0);
      g.add(bar);
    }
    // Orient the chevron along the anticlockwise tangent at this angle.
    g.position.set(Math.cos(a) * this.midR, 0.09, Math.sin(a) * this.midR);
    g.rotation.y = -this.tangentHead(Math.cos(a) * this.midR, Math.sin(a) * this.midR) + Math.PI / 2;
    scene.add(g);
  }

  private buildDesert() {
    const scene = this.ctx.scene;
    const H = this.ctx.halfSize;
    const duneMat = new THREE.MeshStandardMaterial({ color: 0xd7ad64, roughness: 1 });
    const cactusMat = new THREE.MeshStandardMaterial({ color: 0x3f7a34, roughness: 0.9 });
    const rockMat = new THREE.MeshStandardMaterial({ color: 0xa8794c, roughness: 1, flatShading: true });
    // Low dunes ringing the track.
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + 0.3, r = H * (1.15 + Math.random() * 0.5);
      const dune = new THREE.Mesh(new THREE.SphereGeometry(10 + Math.random() * 10, 12, 6), duneMat);
      dune.scale.set(1, 0.16, 1); dune.position.set(Math.cos(a) * r, -0.5, Math.sin(a) * r); scene.add(dune);
    }
    // A few saguaro cacti + rocks in the sand.
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2 + 0.8, r = H * (1.08 + Math.random() * 0.25);
      const g = new THREE.Group();
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 1.1, 9, 8), cactusMat);
      trunk.position.y = 4.5; g.add(trunk);
      const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.5, 2.6, 7), cactusMat);
      arm.position.set(1.4, 5.5, 0); arm.rotation.z = Math.PI / 2; g.add(arm);
      const up = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.5, 2.6, 7), cactusMat);
      up.position.set(2.6, 6.8, 0); g.add(up);
      g.position.set(Math.cos(a) * r, 0, Math.sin(a) * r); scene.add(g);
    }
    for (let i = 0; i < 10; i++) {
      const a = Math.random() * Math.PI * 2, r = H * (1.05 + Math.random() * 0.4);
      const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(1 + Math.random() * 2, 0), rockMat);
      rock.position.set(Math.cos(a) * r, 0.3, Math.sin(a) * r); scene.add(rock);
    }
  }

  // --- kart + item models -----------------------------------------------------
  private makeKart(col: number | string): THREE.Group {
    const g = new THREE.Group();
    const body = new THREE.MeshStandardMaterial({ color: col, roughness: 0.5, metalness: 0.3 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x1a1a1e, roughness: 0.7 });
    // Low chassis (kart faces +z = forward).
    const chassis = new THREE.Mesh(new THREE.BoxGeometry(3.0, 0.7, 4.2), body);
    chassis.position.y = 0.7; chassis.castShadow = true; g.add(chassis);
    // Nose cone at the front.
    const nose = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 1.2, 1.6, 8), body);
    nose.rotation.x = Math.PI / 2; nose.position.set(0, 0.7, 2.6); g.add(nose);
    // Seat back behind the driver.
    const seat = new THREE.Mesh(new THREE.BoxGeometry(2.2, 1.6, 0.5), dark);
    seat.position.set(0, 1.5, -1.5); g.add(seat);
    // Four fat wheels.
    for (const [wx, wz] of [[-1.6, 1.4], [1.6, 1.4], [-1.6, -1.4], [1.6, -1.4]] as const) {
      const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.85, 0.85, 0.7, 12), dark);
      wheel.rotation.z = Math.PI / 2; wheel.position.set(wx, 0.6, wz); wheel.castShadow = true; g.add(wheel);
    }
    // A little steering wheel in front of the driver.
    const sw = new THREE.Mesh(new THREE.TorusGeometry(0.5, 0.12, 6, 12), dark);
    sw.position.set(0, 1.5, 0.9); sw.rotation.x = 1.1; g.add(sw);
    return g;
  }

  private itemModel(kind: Item): THREE.Object3D {
    const g = new THREE.Group();
    if (kind === 'ball') {
      g.add(new THREE.Mesh(new THREE.IcosahedronGeometry(1.0, 1),
        new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5 })));
      const spot = new THREE.Mesh(new THREE.IcosahedronGeometry(0.4, 0),
        new THREE.MeshStandardMaterial({ color: 0x111111 }));
      spot.position.set(0, 0.7, 0.7); g.add(spot);
    } else if (kind === 'banana') {
      const m = new THREE.Mesh(new THREE.CapsuleGeometry(0.42, 1.4, 4, 8),
        new THREE.MeshStandardMaterial({ color: 0xffe23a, roughness: 0.5, emissive: 0x3a3000 }));
      m.rotation.z = 0.7; m.scale.set(1, 1, 0.7); g.add(m);
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
    } else { // rocket
      const b = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 1.8, 10),
        new THREE.MeshStandardMaterial({ color: 0xd23b3b, roughness: 0.4, metalness: 0.3 }));
      b.rotation.x = Math.PI / 2; g.add(b);
      const tip = new THREE.Mesh(new THREE.ConeGeometry(0.5, 0.9, 10),
        new THREE.MeshStandardMaterial({ color: 0xeeeeee }));
      tip.rotation.x = Math.PI / 2; tip.position.z = 1.3; g.add(tip);
    }
    return g;
  }

  private emojiSprite(txt: string, scale = 4): THREE.Sprite {
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

    for (const p of ctx.players) if (!p.dead) this.driveKart(p, dt);
    this.separateKarts();
    for (const p of ctx.players) if (!p.dead) this.clampToTrack(p); // keep bumps on-track

    // Sync kart meshes + seated drivers to their karts.
    for (const p of ctx.players) {
      const k = this.karts[p.index];
      if (!k) continue;
      k.position.set(p.x, 0, p.z);
      k.rotation.y = this.head[p.index];
      k.visible = !p.dead;
      p.standFacing = this.head[p.index];
    }

    this.tickPickups(dt);
    this.tickBananas();
    this.tickShots(dt);

    // Bots fire their held item after a beat.
    for (const p of ctx.players.slice(1)) {
      if (p.dead || !this.held[p.index]) continue;
      this.botItemT[p.index] -= dt;
      if (this.botItemT[p.index] <= 0) this.useItem(p);
    }

    tickRoster(ctx, dt, elapsed);
    if (this.timeLeft <= 0) this.doFinish();
  }

  private driveKart(p: Player, dt: number) {
    const i = p.index;
    // Spin-out (banana): whirl the heading, crawl forward, no control.
    if (this.spinT[i] > 0) {
      this.spinT[i] -= dt;
      this.head[i] += dt * 12;
      this.speed[i] += (CRUISE * 0.15 - this.speed[i]) * ACCEL * dt;
    } else if (p.freezeT > 0) {
      // Zapped: dead stop.
      this.speed[i] += (0 - this.speed[i]) * 6 * dt;
    } else {
      // Steer: player stick or bot AI, plus auto-curve toward the ring tangent.
      const tHead = this.tangentHead(p.x, p.z);
      let steer = 0;
      if (i === 0) steer = -this.ctx.input.ax; // stick left/right
      else steer = this.botSteer(p);
      this.head[i] += steer * TURN * dt;
      let d = tHead - this.head[i];
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      this.head[i] += d * AUTOCURVE * dt;
      // Speed: cruise, boosted by the SPEED button (you) / AI, faster with a 👟.
      const wantBoost = i === 0 ? this.boosting : this.botBoost();
      let target = (wantBoost ? BOOST : CRUISE) * this.cruiseMul[i];
      if (p.speedT > 0) target *= 1.5;
      this.speed[i] += (target - this.speed[i]) * ACCEL * dt;
    }

    const fx = Math.sin(this.head[i]), fz = Math.cos(this.head[i]);
    p.x += fx * this.speed[i] * dt;
    p.z += fz * this.speed[i] * dt;
    p.vx = fx * this.speed[i]; p.vz = fz * this.speed[i];
    if (this.clampToTrack(p)) this.speed[i] *= 0.92; // scrub speed on the kerb

    // Lap progress (anticlockwise = increasing θ). Cross the line → next lap.
    const th = Math.atan2(p.z, p.x);
    let dth = th - this.lastTheta[i];
    while (dth > Math.PI) dth -= Math.PI * 2;
    while (dth < -Math.PI) dth += Math.PI * 2;
    this.progress[i] += dth;
    this.lastTheta[i] = th;
    const lap = Math.floor(this.progress[i] / (Math.PI * 2));
    if (lap > this.laps[i]) {
      this.laps[i] = lap;
      setScore(p, `Lap ${lap + 1}`);
      if (p.you) { SFX.gem(); this.ctx.fx.banner(`LAP ${lap + 1}!`, p.hero.col); }
    }
  }

  private botSteer(p: Player): number {
    // Drift toward the nearest item pickup that's roughly ahead.
    let best: Pickup | null = null, bd = 16;
    for (const pk of this.pickups) {
      const d = Math.hypot(pk.x - p.x, pk.z - p.z);
      if (d < bd) { bd = d; best = pk; }
    }
    if (!best || this.held[p.index]) return (Math.random() - 0.5) * 0.2;
    // Steer toward it: compare bearing to current heading.
    const want = Math.atan2(best.x - p.x, best.z - p.z);
    let d = want - this.head[p.index];
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return Math.max(-1, Math.min(1, d * 1.5));
  }

  private botBoost(): boolean {
    return Math.random() < 0.65; // bots floor it most of the time
  }

  /** Snap a kart back between the inner and outer kerbs. Returns true if it was
   *  off the track (so the caller can scrub some speed). */
  private clampToTrack(p: Player): boolean {
    const r = Math.hypot(p.x, p.z) || 0.001;
    const lo = this.innerR + 1.6, hi = this.outerR - 1.6;
    if (r < lo || r > hi) {
      const clamped = Math.max(lo, Math.min(hi, r));
      p.x = (p.x / r) * clamped; p.z = (p.z / r) * clamped;
      return true;
    }
    return false;
  }

  private separateKarts() {
    const ps = this.ctx.players;
    for (let a = 0; a < ps.length; a++) {
      for (let b = a + 1; b < ps.length; b++) {
        const pa = ps[a], pb = ps[b];
        if (pa.dead || pb.dead) continue;
        const dx = pb.x - pa.x, dz = pb.z - pa.z, d = Math.hypot(dx, dz);
        if (d > 0.001 && d < 3.4) {
          const push = (3.4 - d) / 2, nx = dx / d, nz = dz / d;
          pa.x -= nx * push; pa.z -= nz * push;
          pb.x += nx * push; pb.z += nz * push;
        }
      }
    }
  }

  // --- pickups ----------------------------------------------------------------
  private tickPickups(dt: number) {
    this.pickupT -= dt;
    if (this.pickupT <= 0 && this.pickups.length < 5) { this.pickupT = 1.5 + Math.random() * 2; this.spawnPickup(); }
    for (const pk of this.pickups) pk.group.rotation.y += dt * 1.5;
    // Collection.
    for (let i = this.pickups.length - 1; i >= 0; i--) {
      const pk = this.pickups[i];
      const taker = this.ctx.players.find((p) => !p.dead && !this.held[p.index] && Math.hypot(p.x - pk.x, p.z - pk.z) < 4);
      if (!taker) continue;
      this.ctx.scene.remove(pk.group);
      this.pickups.splice(i, 1);
      this.giveItem(taker, pk.kind);
      SFX.gem();
    }
  }

  private spawnPickup() {
    const kind = ALL_ITEMS[Math.floor(Math.random() * ALL_ITEMS.length)];
    const a = Math.random() * Math.PI * 2;
    // Near the racing line so karts sweep them up as they pass.
    const r = this.midR + (Math.random() - 0.5) * 7;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const group = new THREE.Group();
    const model = this.itemModel(kind);
    model.position.y = 1.8;
    group.add(model);
    const spr = this.emojiSprite(ITEM_EMOJI[kind], 3);
    spr.position.y = 4.2; group.add(spr);
    const ring = new THREE.Mesh(new THREE.RingGeometry(1.6, 2.2, 20),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.4, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2; ring.position.y = 0.12; group.add(ring);
    group.position.set(x, 0, z);
    this.ctx.scene.add(group);
    this.pickups.push({ x, z, kind, group });
  }

  private giveItem(p: Player, kind: Item) {
    this.held[p.index] = kind;
    p.setStatusIcon(ITEM_EMOJI[kind], 999);
    if (p.index !== 0) this.botItemT[p.index] = 0.8 + Math.random() * 2.5;
    else { this.updateItemBtn(); this.ctx.fx.banner(`${ITEM_EMOJI[kind]} GOT IT! tap ITEM`, '#FFD23F'); }
  }

  // --- using items ------------------------------------------------------------
  private useItem(p: Player) {
    const kind = this.held[p.index];
    if (!kind || p.dead || this.finished) return;
    this.held[p.index] = null;
    p.setStatusIcon(null);
    if (p.index === 0) this.updateItemBtn();
    if (kind === 'boost') {
      p.speedT = Math.max(p.speedT, 2.6);
      this.ctx.fx.burst(p.x, p.z, '#2fe04a', 10);
      if (p.you) this.ctx.fx.banner('👟 BOOST!', '#2fe04a');
    } else if (kind === 'banana') {
      this.dropBanana(p);
    } else if (kind === 'zap') {
      this.zapAll(p);
    } else {
      this.fireShot(p, kind); // ball or rocket
    }
    SFX.power();
  }

  private dropBanana(p: Player) {
    // Drop it just behind the kart.
    const bx = p.x - Math.sin(this.head[p.index]) * 3;
    const bz = p.z - Math.cos(this.head[p.index]) * 3;
    const group = new THREE.Group();
    const model = this.itemModel('banana');
    model.position.y = 0.6; group.add(model);
    group.position.set(bx, 0, bz);
    this.ctx.scene.add(group);
    this.bananas.push({ x: bx, z: bz, group });
    if (p.you) this.ctx.fx.banner('🍌 dropped!', '#ffe23a');
  }

  private tickBananas() {
    for (let i = this.bananas.length - 1; i >= 0; i--) {
      const b = this.bananas[i];
      const hit = this.ctx.players.find((p) => !p.dead && this.spinT[p.index] <= 0 && p.freezeT <= 0 && Math.hypot(p.x - b.x, p.z - b.z) < 2.4);
      if (!hit) continue;
      this.ctx.scene.remove(b.group);
      this.bananas.splice(i, 1);
      this.spinT[hit.index] = 1.3;
      SFX.bump();
      this.ctx.fx.burst(hit.x, hit.z, '#ffe23a', 10);
      this.ctx.fx.banner(hit.you ? 'SLIPPED! 🍌' : '', '#ffe23a');
    }
  }

  private zapAll(by: Player) {
    for (const p of this.ctx.players) {
      if (p === by || p.dead) continue;
      p.freezeT = Math.max(p.freezeT, 1.0);
      p.zapped = true;
      this.ctx.fx.burst(p.x, p.z, '#ffe23a', 8);
    }
    this.ctx.fx.shake(1.4);
    if (by.you) this.ctx.fx.banner('⚡ ZAP! everyone stunned', '#ffe23a');
    else if (this.ctx.players[0].freezeT > 0) this.ctx.fx.banner('⚡ ZAPPED!', '#ffe23a');
  }

  /** Ball / rocket: launch forward, homing on the kart directly AHEAD. */
  private fireShot(p: Player, kind: 'ball' | 'rocket') {
    const speed = kind === 'rocket' ? 44 : 26;
    const fx = Math.sin(this.head[p.index]), fz = Math.cos(this.head[p.index]);
    const group = new THREE.Group();
    const model = this.itemModel(kind);
    model.position.y = kind === 'ball' ? 1.0 : 1.2;
    if (kind === 'rocket') model.rotation.y = 0; // points +z, aligned by group rotation
    group.add(model);
    group.position.set(p.x + fx * 3, 0, p.z + fz * 3);
    this.ctx.scene.add(group);
    this.shots.push({ x: p.x + fx * 3, z: p.z + fz * 3, vx: fx * speed, vz: fz * speed, kind, owner: p.index, group, life: kind === 'rocket' ? 2.2 : 3.2 });
    if (p.you) this.ctx.fx.banner(kind === 'rocket' ? '🚀 FIRE!' : '⚽ KICK!', '#FF4D4D');
  }

  private aheadOf(owner: number): Player | null {
    // The kart with the least progress lead over the owner (i.e. just ahead).
    let best: Player | null = null, bd = Infinity;
    for (const p of this.ctx.players) {
      if (p.index === owner || p.dead) continue;
      const lead = this.progress[p.index] - this.progress[owner];
      if (lead > 0 && lead < bd) { bd = lead; best = p; }
    }
    // Nobody ahead (owner is leading): fall back to the nearest kart.
    if (!best) {
      let nd = Infinity; const o = this.ctx.players[owner];
      for (const p of this.ctx.players) {
        if (p.index === owner || p.dead) continue;
        const d = Math.hypot(p.x - o.x, p.z - o.z);
        if (d < nd) { nd = d; best = p; }
      }
    }
    return best;
  }

  private tickShots(dt: number) {
    for (let i = this.shots.length - 1; i >= 0; i--) {
      const s = this.shots[i];
      s.life -= dt;
      const tgt = this.aheadOf(s.owner);
      if (tgt) {
        // Home toward the target ahead.
        const dx = tgt.x - s.x, dz = tgt.z - s.z, L = Math.hypot(dx, dz) || 1;
        const homing = s.kind === 'rocket' ? 120 : 70;
        s.vx += (dx / L) * homing * dt; s.vz += (dz / L) * homing * dt;
        const sp = Math.hypot(s.vx, s.vz), cap = s.kind === 'rocket' ? 50 : 30;
        if (sp > cap) { s.vx = (s.vx / sp) * cap; s.vz = (s.vz / sp) * cap; }
      }
      s.x += s.vx * dt; s.z += s.vz * dt;
      s.group.position.set(s.x, 0, s.z);
      s.group.rotation.y = Math.atan2(s.vx, s.vz);
      // Keep shots over the track; expire off-radius.
      const r = Math.hypot(s.x, s.z);
      let hit: Player | null = null;
      for (const p of this.ctx.players) {
        if (p.index === s.owner || p.dead) continue;
        if (Math.hypot(p.x - s.x, p.z - s.z) < 2.6) { hit = p; break; }
      }
      if (hit) {
        if (s.kind === 'rocket') { hit.freezeT = Math.max(hit.freezeT, 0.9); hit.zapped = true; this.spinT[hit.index] = 0.6; }
        else this.spinT[hit.index] = 1.0;
        SFX.hit();
        this.ctx.fx.burst(hit.x, hit.z, s.kind === 'rocket' ? '#FF4D4D' : '#ffffff', 14);
        this.ctx.fx.shake(1.4);
        if (hit.you) this.ctx.fx.banner(s.kind === 'rocket' ? 'ROCKETED! 🚀' : 'BALLED! ⚽', '#FF4D4D');
        this.ctx.scene.remove(s.group); this.shots.splice(i, 1);
      } else if (s.life <= 0 || r < this.innerR - 2 || r > this.outerR + 2) {
        this.ctx.scene.remove(s.group); this.shots.splice(i, 1);
      }
    }
  }

  // --- DOM overlay ------------------------------------------------------------
  private buildUI() {
    document.getElementById('kartUI')?.remove();
    const ui = document.createElement('div');
    ui.id = 'kartUI';
    ui.style.cssText = 'position:fixed;inset:0;z-index:8;pointer-events:none;font-family:Nunito,system-ui,sans-serif;';
    ui.innerHTML = `
      <div data-nostick style="position:fixed;right:20px;bottom:26px;display:flex;flex-direction:column;gap:14px;align-items:center;">
        <button id="kItem" style="pointer-events:auto;">🎁 ITEM</button>
        <button id="kSpeed" style="pointer-events:auto;">🏁 SPEED</button>
      </div>`;
    document.body.appendChild(ui);
    const btnCss = 'font-family:Bungee,cursive;font-size:18px;border:none;border-radius:16px;padding:16px 22px;color:#12142e;cursor:pointer;box-shadow:0 5px 0 rgba(0,0,0,.35);touch-action:none;user-select:none;';
    this.itemBtn = ui.querySelector('#kItem')!;
    this.speedBtn = ui.querySelector('#kSpeed')!;
    this.itemBtn.style.cssText += btnCss + 'background:#FFD23F;opacity:0.45;';
    this.speedBtn.style.cssText += btnCss + 'background:#4DC3FF;';
    // ITEM: tap to use.
    this.itemBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); this.useItem(this.ctx.players[0]); });
    // SPEED: hold to floor it.
    const down = (e: Event) => { e.preventDefault(); e.stopPropagation(); this.boosting = true; this.speedBtn.style.filter = 'brightness(1.25)'; };
    const up = (e: Event) => { e.preventDefault(); this.boosting = false; this.speedBtn.style.filter = ''; };
    this.speedBtn.addEventListener('pointerdown', down);
    this.speedBtn.addEventListener('pointerup', up);
    this.speedBtn.addEventListener('pointerleave', up);
    this.speedBtn.addEventListener('pointercancel', up);
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
    document.getElementById('kartUI')?.remove();
    for (const pk of this.pickups) this.ctx.scene.remove(pk.group);
    for (const b of this.bananas) this.ctx.scene.remove(b.group);
    for (const s of this.shots) this.ctx.scene.remove(s.group);
    const ctx = this.ctx;
    const ranked = rankBy(ctx, (p) => this.progress[p.index]);
    ctx.players.forEach((p) => ((p as any)._res = `${this.laps[p.index]} laps`));
    ctx.finish(ranked, `${ranked[0].hero.name} takes the checkered flag!`);
  }
}
