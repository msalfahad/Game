import * as THREE from 'three';
import type { GameModule, MatchContext } from '../context';
import type { Player } from '../player';
import { HITBOX_RADIUS } from '../player';
import { setupRoster, tickRoster, rankBy } from '../freeroam';
import { SFX } from '../../core/audio';
import { markDead } from '../../ui/hud';

// MUSICAL CHAIRS (Dune Clash). Everyone marches CLOCKWISE around a ring of
// chairs — you can't steer left/right, you can only tap RUN to dash forward
// (one tap = one burst; spam taps for more). Players pass right through each
// other. A song plays; at a RANDOM, unannounced moment it cuts out and SIT!
// appears — tap SIT to drop onto the nearest free seat. One seat short each
// round, so the odd one out is eliminated (4→3→2→1 chairs). A HIT power lights
// up at random for each player and lasts 5s: use it to knock a rival flat
// (stunned on the floor 1.5s). Secret weapons (STUN / STOP-SONG) appear ON the
// walk ring. Real desert: cacti, rocks, dunes and drifting dust.

type Phase = 'walk' | 'sit' | 'gap' | 'done';

interface Chair { x: number; z: number; group: THREE.Group; occupant: number | null; }
interface Box { x: number; z: number; kind: 'stun' | 'stop'; group: THREE.Group; }

const CHAIR_R = 8.5;   // radius of the chair ring
const WALK_R = 14;     // radius of the walk circle (outside the chairs)
const SEAT_Y = 2.4;
const SIT_WINDOW = 4.0;
const ROUND_CAP = 26;

const WALK_OMEGA = 0.52;  // base clockwise march (rad/s)
const RUN_IMPULSE = 1.5;  // angular burst added per RUN tap
const RUN_DECAY = 3.4;    // how fast a run burst bleeds off
const RUN_CAP = 7;
const HIT_REACH = HITBOX_RADIUS * 2 + 6;
const HIT_WINDOW = 5;     // seconds the HIT power stays lit
const STUN_TIME = 1.5;    // stun + fall duration when hit

export class MusicalChairsGame implements GameModule {
  readonly stickMode = 'none' as const;
  title = 'Musical Chairs';
  objective = 'March around — grab a seat when the music stops!';

  private ctx!: MatchContext;

  private phase: Phase = 'walk';
  private roundT = ROUND_CAP;
  private musicOnT = 0;
  private musicStopAt = 8;
  private sitT = 0;
  private resolved = false;
  private finished = false;
  private outCount = 0;

  private chairs: Chair[] = [];
  private seatOf: (number | null)[] = [];
  private botReact: number[] = [];

  // Circular-walk state, per player index.
  private ang: number[] = [];
  private runBoost: number[] = [];
  // HIT power availability, per player index.
  private hitWinT: number[] = [];
  private hitCoolT: number[] = [];
  private fallT: number[] = []; // knocked-down timer, per player index

  private boxes: Box[] = [];
  private boxT = 4;

  // Scenery / dust.
  private dust!: THREE.Points;
  private dustV: { x: number; y: number; z: number }[] = [];

  // DOM overlay.
  private ui!: HTMLElement;
  private eqNotes: HTMLElement[] = [];
  private eqWrap!: HTMLElement;
  private sitTextEl!: HTMLElement;
  private runBtn!: HTMLButtonElement;
  private hitBtn!: HTMLButtonElement;
  private sitBtn!: HTMLButtonElement;

  init(ctx: MatchContext) {
    this.ctx = ctx;
    this.title = ctx.game.name;
    this.finished = false;

    setupRoster(ctx, '', 0.6);
    this.buildUI();
    this.buildScenery();

    this.ang = ctx.players.map(() => 0);
    this.runBoost = ctx.players.map(() => 0);
    this.hitWinT = ctx.players.map(() => 0);
    this.hitCoolT = ctx.players.map(() => 3 + Math.random() * 7); // staggered first windows
    this.fallT = ctx.players.map(() => 0);

    ctx.players.forEach((p) => { p.sitting = false; p.fallen = false; });
    this.startRound(true);
  }

  // --- round lifecycle -------------------------------------------------------
  private startRound(first = false) {
    const ctx = this.ctx;
    const alive = ctx.players.filter((p) => !p.dead);
    if (alive.length <= 1) return this.doFinish();

    this.buildChairs(alive.length - 1);
    this.seatOf = ctx.players.map(() => null);
    this.phase = 'walk';
    this.resolved = false;
    this.roundT = ROUND_CAP;
    this.musicOnT = 0;
    this.musicStopAt = 5 + Math.random() * 10; // random, unannounced cut-out
    this.clearBoxes();
    this.boxT = 3 + Math.random() * 2;

    // Space the survivors evenly around the walk ring, all facing clockwise.
    alive.forEach((p, i) => {
      p.sitting = false; p.fallen = false; p.freezeT = 0;
      this.ang[p.index] = (i / alive.length) * Math.PI * 2;
      this.runBoost[p.index] = 0;
      p.x = Math.cos(this.ang[p.index]) * WALK_R;
      p.z = Math.sin(this.ang[p.index]) * WALK_R;
      p.vx = 0; p.vz = 0;
      p.group.position.set(p.x, 0, p.z);
    });

    SFX.playMusic(ctx.family.id);
    this.setMusicPlaying(true);
    this.sitTextEl.style.opacity = '0';
    this.updateButtons();
    if (!first) ctx.fx.banner(`${alive.length} left · ${this.chairs.length} chairs`, '#FFD23F');
  }

  private stopSong() {
    if (this.phase !== 'walk') return;
    this.phase = 'sit';
    this.sitT = SIT_WINDOW;
    SFX.stopMusic();
    SFX.out();
    this.setMusicPlaying(false);
    this.sitTextEl.style.opacity = '1';
    // Bot reaction times — harder bots react faster; all within the sit window so
    // exactly one player is left seatless. Fallen bots are slower (they scramble).
    const win = this.sitT;
    const react = Math.min(0.2 + (1 - this.ctx.diff.cap) * 0.9, win * 0.45);
    this.botReact = this.ctx.players.map((p, i) =>
      i === 0 ? Infinity : react + Math.random() * Math.max(0.15, win - react - 0.35) + (p.fallen ? 1.2 : 0));
    this.ctx.fx.banner('SIT!', '#FF4D4D');
    this.ctx.fx.shake(1.5);
    this.updateButtons();
  }

  // --- 3D content ------------------------------------------------------------
  private buildChairs(count: number) {
    for (const c of this.chairs) this.ctx.scene.remove(c.group);
    this.chairs = [];
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 - Math.PI / 2;
      const x = Math.cos(a) * CHAIR_R, z = Math.sin(a) * CHAIR_R;
      const group = this.makeChairMesh();
      group.position.set(x, 0, z);
      group.rotation.y = -a + Math.PI / 2;
      this.ctx.scene.add(group);
      this.chairs.push({ x, z, group, occupant: null });
    }
  }

  private makeChairMesh(): THREE.Group {
    const g = new THREE.Group();
    const wood = new THREE.MeshStandardMaterial({ color: 0xb9762f, roughness: 0.7, emissive: 0x2a1608 });
    const seat = new THREE.Mesh(new THREE.BoxGeometry(3.4, 0.6, 3.4), wood);
    seat.position.y = 2.1; seat.castShadow = true; g.add(seat);
    const back = new THREE.Mesh(new THREE.BoxGeometry(3.4, 3.2, 0.5), wood);
    back.position.set(0, 3.6, -1.5); back.castShadow = true; g.add(back);
    for (const [lx, lz] of [[-1.4, -1.4], [1.4, -1.4], [-1.4, 1.4], [1.4, 1.4]] as const) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.5, 2.1, 0.5), wood);
      leg.position.set(lx, 1.05, lz); g.add(leg);
    }
    const cushion = new THREE.Mesh(
      new THREE.BoxGeometry(3.0, 0.3, 3.0),
      new THREE.MeshStandardMaterial({ color: 0xffd23f, emissive: 0xffb020, emissiveIntensity: 0.6, roughness: 0.5 }),
    );
    cushion.position.y = 2.5;
    (g as any).__cushion = cushion; g.add(cushion);
    return g;
  }

  /** Desert dressing: a few saguaro cacti, scattered rocks, low dunes and a
   *  drifting dust haze — all placed OUTSIDE the walk ring so they never block
   *  the players. */
  private buildScenery() {
    const scene = this.ctx.scene;
    const H = this.ctx.halfSize;
    const cactusMat = new THREE.MeshStandardMaterial({ color: 0x3f7a34, roughness: 0.9 });
    const rockMat = new THREE.MeshStandardMaterial({ color: 0xa8794c, roughness: 1, flatShading: true });
    const duneMat = new THREE.MeshStandardMaterial({ color: 0xd7ad64, roughness: 1 });

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
      g.position.set(x, 0, z); g.rotation.y = Math.random() * 6; scene.add(g);
    };
    // 3 cacti spaced around the far edge, well outside the walk ring.
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2 + 1.1, r = H * 0.94;
      saguaro(Math.cos(a) * r, Math.sin(a) * r, 0.85 + Math.random() * 0.4);
    }
    // Rocks just past the walk ring.
    for (let i = 0; i < 7; i++) {
      const a = Math.random() * Math.PI * 2, r = WALK_R + 4 + Math.random() * (H - WALK_R - 6);
      const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(0.9 + Math.random() * 1.8, 0), rockMat);
      rock.position.set(Math.cos(a) * r, 0.3, Math.sin(a) * r);
      rock.rotation.set(Math.random(), Math.random() * 6, Math.random());
      rock.castShadow = true; scene.add(rock);
    }
    // Low dunes on the horizon.
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2 + 0.9, r = H * (1.05 + Math.random() * 0.4);
      const dune = new THREE.Mesh(new THREE.SphereGeometry(8 + Math.random() * 8, 12, 6), duneMat);
      dune.scale.set(1, 0.16, 1); dune.position.set(Math.cos(a) * r, -0.4, Math.sin(a) * r); scene.add(dune);
    }
    // Drifting dust: a haze of tiny motes blown across the yard.
    const N = 70;
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      pos[i * 3] = (Math.random() - 0.5) * H * 2;
      pos[i * 3 + 1] = 0.6 + Math.random() * 6;
      pos[i * 3 + 2] = (Math.random() - 0.5) * H * 2;
      this.dustV.push({ x: 5 + Math.random() * 4, y: (Math.random() - 0.5) * 0.6, z: (Math.random() - 0.5) * 2 });
    }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.dust = new THREE.Points(geo, new THREE.PointsMaterial({
      color: 0xe8d3a0, size: 0.9, transparent: true, opacity: 0.5, depthWrite: false,
    }));
    scene.add(this.dust);
  }

  private spawnBox() {
    const kind: Box['kind'] = Math.random() < 0.55 ? 'stun' : 'stop';
    const a = Math.random() * Math.PI * 2;
    // ON the walk ring so players pick it up as they march past.
    const x = Math.cos(a) * WALK_R, z = Math.sin(a) * WALK_R;
    const group = new THREE.Group();
    const col = kind === 'stun' ? 0x4da6ff : 0xff3d9e;
    const cube = new THREE.Mesh(
      new THREE.BoxGeometry(2.2, 2.2, 2.2),
      new THREE.MeshStandardMaterial({ color: col, emissive: col, emissiveIntensity: 0.5, roughness: 0.4, metalness: 0.3 }),
    );
    cube.position.y = 2.2; group.add(cube);
    const ring = new THREE.Mesh(new THREE.RingGeometry(1.5, 2.1, 20),
      new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.5, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2; ring.position.y = 0.15; group.add(ring);
    group.position.set(x, 0, z);
    this.ctx.scene.add(group);
    this.boxes.push({ x, z, kind, group });
  }

  private clearBoxes() {
    for (const b of this.boxes) this.ctx.scene.remove(b.group);
    this.boxes = [];
  }

  // --- main tick -------------------------------------------------------------
  tick(dt: number, elapsed: number) {
    if (this.finished) return;
    const ctx = this.ctx;

    if (this.phase === 'walk') this.tickWalk(dt);
    else if (this.phase === 'sit') this.tickSit(dt);

    // Knocked-down players get back up when their fall timer runs out.
    for (const p of ctx.players) {
      if (this.fallT[p.index] > 0) {
        this.fallT[p.index] -= dt;
        if (this.fallT[p.index] <= 0) p.fallen = false;
      }
    }

    // Free-seat glow.
    for (const c of this.chairs) {
      const cushion = (c.group as any).__cushion as THREE.Mesh;
      if (cushion) {
        cushion.visible = c.occupant === null;
        (cushion.material as THREE.MeshStandardMaterial).emissiveIntensity = 0.4 + Math.sin(elapsed * 5) * 0.2;
      }
    }
    for (const b of this.boxes) b.group.rotation.y += dt * 2;
    this.tickDust(dt);

    tickRoster(ctx, dt, elapsed);
    // Pin seated players onto their seat (physics may have nudged them).
    for (const p of ctx.players) {
      if (p.sitting && this.seatOf[p.index] != null) {
        const c = this.chairs[this.seatOf[p.index]!];
        p.x = c.x; p.z = c.z; p.vx = 0; p.vz = 0;
        p.group.position.set(c.x, SEAT_Y, c.z);
      }
    }
  }

  private tickWalk(dt: number) {
    const ctx = this.ctx;
    this.roundT -= dt;
    ctx.setClock(this.roundT);
    this.musicOnT += dt;
    this.animateEq();

    // HIT power timers (per player): a 5s window that lights at random.
    for (let i = 0; i < ctx.players.length; i++) {
      if (ctx.players[i].dead) continue;
      if (this.hitWinT[i] > 0) {
        this.hitWinT[i] -= dt;
        if (this.hitWinT[i] <= 0) { this.hitWinT[i] = 0; this.hitCoolT[i] = 5 + Math.random() * 7; }
      } else {
        this.hitCoolT[i] -= dt;
        if (this.hitCoolT[i] <= 0) this.hitWinT[i] = HIT_WINDOW;
      }
    }
    this.updateButtons();

    // Everyone marches clockwise; run bursts decay. Fallen/stunned stay put.
    for (const p of ctx.players) {
      if (p.dead || p.sitting) continue;
      if (p.fallen || p.freezeT > 0) { p.vx = 0; p.vz = 0; continue; }
      // Bots march along; when a HIT is lit they RUN hard to catch whoever's
      // ahead and swing every frame (only lands in reach), otherwise the odd
      // casual run burst.
      if (p.index !== 0) {
        if (this.hitWinT[p.index] > 0) {
          if (Math.random() < dt * 4) this.addRun(p.index);
          this.hit(p);
        } else if (Math.random() < dt * 0.5) {
          this.addRun(p.index);
        }
      }
      this.runBoost[p.index] = Math.max(0, this.runBoost[p.index] - this.runBoost[p.index] * RUN_DECAY * dt);
      this.ang[p.index] -= (WALK_OMEGA + this.runBoost[p.index]) * dt; // clockwise
      p.x = Math.cos(this.ang[p.index]) * WALK_R;
      p.z = Math.sin(this.ang[p.index]) * WALK_R;
      p.vx = 0; p.vz = 0;
    }

    // Secret-weapon spawns on the ring + pickups.
    this.boxT -= dt;
    if (this.boxT <= 0 && this.boxes.length < 2) { this.boxT = 4 + Math.random() * 3; this.spawnBox(); }
    this.checkBoxPickups();

    // The song cuts out at its random moment, or the round safety-caps out.
    if (this.musicOnT >= this.musicStopAt || this.roundT <= 0.5) this.stopSong();
  }

  private tickSit(dt: number) {
    const ctx = this.ctx;
    this.sitT -= dt;

    for (const p of ctx.players.slice(1)) {
      if (p.dead || p.sitting || this.seatOf[p.index] != null || p.freezeT > 0 || p.fallen) continue;
      this.botReact[p.index] -= dt;
      if (this.botReact[p.index] <= 0) this.claimSeat(p);
    }

    // Slide committed players onto their seat.
    for (const p of ctx.players) {
      const ci = this.seatOf[p.index];
      if (ci == null || p.dead || p.sitting) continue;
      const c = this.chairs[ci];
      const dx = c.x - p.x, dz = c.z - p.z, d = Math.hypot(dx, dz);
      if (d < 0.6) { p.sitting = true; p.x = c.x; p.z = c.z; }
      else { const step = Math.min(d, dt * 34); p.x += (dx / d) * step; p.z += (dz / d) * step; }
      p.vx = 0; p.vz = 0;
    }

    const seated = ctx.players.filter((p) => this.seatOf[p.index] != null).length;
    if (this.sitT <= 0 || seated >= this.chairs.length) this.resolveRound();
  }

  // --- actions ---------------------------------------------------------------
  private addRun(i: number) {
    this.runBoost[i] = Math.min(RUN_CAP, this.runBoost[i] + RUN_IMPULSE);
  }

  private run() {
    const you = this.ctx.players[0];
    if (this.phase !== 'walk' || you.dead || you.fallen || you.freezeT > 0) return;
    this.addRun(0);
    SFX.tick();
  }

  /** HIT: only works while your power is lit — knock the nearest rival flat. */
  private hit(by: Player) {
    if (this.phase !== 'walk' || by.dead || by.fallen || by.freezeT > 0) return;
    if (this.hitWinT[by.index] <= 0) return;
    let target: Player | null = null, bestD = HIT_REACH;
    for (const p of this.ctx.players) {
      if (p === by || p.dead || p.fallen) continue;
      const d = Math.hypot(p.x - by.x, p.z - by.z);
      if (d < bestD) { bestD = d; target = p; }
    }
    if (!target) return;
    // Consume the power and knock the target flat (physical fall — no tint).
    this.hitWinT[by.index] = 0;
    this.hitCoolT[by.index] = 5 + Math.random() * 7;
    target.fallen = true;
    this.fallT[target.index] = STUN_TIME;
    SFX.bump();
    this.ctx.fx.burst(target.x, target.z, '#FFD23F', 12);
    this.ctx.fx.shake(1.4);
    this.ctx.fx.banner(by.you ? 'BAM! 👊' : target.you ? 'YOU GOT HIT!' : '', '#FFD23F');
    if (by.index === 0) this.updateButtons();
  }

  private claimSeat(p: Player): boolean {
    if (this.seatOf[p.index] != null || p.dead || p.freezeT > 0 || p.fallen) return false;
    let best = -1, bestD = Infinity;
    for (let i = 0; i < this.chairs.length; i++) {
      if (this.chairs[i].occupant != null) continue;
      const d = Math.hypot(this.chairs[i].x - p.x, this.chairs[i].z - p.z);
      if (d < bestD) { bestD = d; best = i; }
    }
    if (best < 0) return false;
    this.chairs[best].occupant = p.index;
    this.seatOf[p.index] = best;
    SFX.tick();
    this.ctx.fx.burst(this.chairs[best].x, this.chairs[best].z, p.hero.col, 10);
    if (p.you) this.ctx.fx.banner('SAFE!', '#7ED321');
    return true;
  }

  private resolveRound() {
    if (this.resolved) return;
    this.resolved = true;
    const ctx = this.ctx;
    this.sitTextEl.style.opacity = '0';
    this.updateButtons();

    const out: Player[] = [];
    for (const p of ctx.players) { if (!p.dead && this.seatOf[p.index] == null) out.push(p); }
    for (const p of out) {
      p.dead = true; p.sitting = false; p.fallen = false;
      (p as any)._outAt = ++this.outCount;
      markDead(p);
      SFX.fall();
      ctx.fx.burst(p.x, p.z, p.hero.col, 18);
      ctx.fx.banner(p.you ? 'YOU ARE OUT!' : `${p.hero.name} — OUT!`, '#FF4D4D');
    }

    const alive = ctx.players.filter((p) => !p.dead);
    this.phase = 'gap';
    if (alive.length <= 1) { setTimeout(() => this.doFinish(), 1100); return; }
    setTimeout(() => {
      for (const p of alive) { p.sitting = false; this.seatOf[p.index] = null; }
      this.startRound(false);
    }, 1400);
  }

  private checkBoxPickups() {
    for (let i = this.boxes.length - 1; i >= 0; i--) {
      const b = this.boxes[i];
      let taker: Player | null = null;
      for (const p of this.ctx.players) {
        if (p.dead || p.fallen) continue;
        if (Math.hypot(p.x - b.x, p.z - b.z) < HITBOX_RADIUS + 1.6) { taker = p; break; }
      }
      if (!taker) continue;
      this.ctx.scene.remove(b.group);
      this.boxes.splice(i, 1);
      if (b.kind === 'stun') this.applyStun(taker);
      else this.applyStop(taker);
    }
  }

  private applyStun(by: Player) {
    let victim: Player | null = null, bestD = Infinity;
    for (const p of this.ctx.players) {
      if (p === by || p.dead || p.fallen) continue;
      const d = Math.hypot(p.x - by.x, p.z - by.z);
      if (d < bestD) { bestD = d; victim = p; }
    }
    if (!victim) return;
    // The electric secret weapon freezes them stiff on the spot (blue zap look).
    victim.freezeT = Math.max(victim.freezeT, STUN_TIME);
    victim.zapped = true;
    SFX.zap();
    this.ctx.fx.burst(victim.x, victim.z, '#4DA6FF', 12);
    this.ctx.fx.banner(by.you ? '❄️ STUN!' : victim.you ? 'STUNNED!' : '', '#4DA6FF');
  }

  private applyStop(by: Player) {
    // Whoever grabs it cuts the music NOW — they saw it coming, the rest didn't.
    SFX.power();
    this.ctx.fx.banner(by.you ? '⏹ YOU STOPPED THE SONG!' : '', '#FF3D9E');
    this.stopSong();
  }

  private tickDust(dt: number) {
    if (!this.dust) return;
    const H = this.ctx.halfSize;
    const arr = (this.dust.geometry.getAttribute('position') as THREE.BufferAttribute).array as Float32Array;
    for (let i = 0; i < this.dustV.length; i++) {
      const v = this.dustV[i];
      arr[i * 3] += v.x * dt;
      arr[i * 3 + 1] += v.y * dt;
      arr[i * 3 + 2] += v.z * dt;
      if (arr[i * 3] > H * 1.2) { arr[i * 3] = -H * 1.2; arr[i * 3 + 2] = (Math.random() - 0.5) * H * 2; }
      const y = arr[i * 3 + 1];
      if (y < 0.4 || y > 7) v.y = -v.y;
    }
    (this.dust.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
  }

  // Input hooks (match wires ability/jump; DOM buttons call the same).
  ability() { if (this.phase === 'sit') this.claimSeat(this.ctx.players[0]); else this.run(); }
  jump() { if (this.phase === 'walk') this.hit(this.ctx.players[0]); }

  // --- DOM overlay -----------------------------------------------------------
  private buildUI() {
    document.getElementById('mcUI')?.remove();
    const ui = document.createElement('div');
    ui.id = 'mcUI';
    ui.style.cssText = 'position:fixed;inset:0;z-index:8;pointer-events:none;font-family:Nunito,system-ui,sans-serif;';
    ui.innerHTML = `
      <div id="mcEq" style="position:fixed;top:112px;left:50%;transform:translateX(-50%);display:flex;align-items:flex-end;
        gap:9px;height:46px;background:rgba(13,16,38,.55);border-radius:16px;padding:8px 18px;">
        <span class="mcN">🎵</span><span class="mcN">🎶</span><span class="mcN">🎵</span><span class="mcN">🎶</span>
      </div>
      <div id="mcSit" style="position:fixed;top:108px;left:50%;transform:translateX(-50%);font-family:Bungee,cursive;
        font-size:48px;color:#FF4D4D;text-shadow:0 4px 0 rgba(0,0,0,.5);opacity:0;transition:opacity .08s;">SIT!</div>
      <div style="position:fixed;left:0;right:0;bottom:24px;display:flex;justify-content:center;gap:14px;">
        <button id="mcRun" style="pointer-events:auto;">🏃 RUN</button>
        <button id="mcHit" style="pointer-events:auto;display:none;">👊 HIT!</button>
        <button id="mcSitBtn" style="pointer-events:auto;display:none;">🪑 SIT</button>
      </div>`;
    document.body.appendChild(ui);
    const btnCss = 'font-family:Bungee,cursive;font-size:18px;border:none;border-radius:14px;padding:14px 24px;color:#12142e;cursor:pointer;box-shadow:0 5px 0 rgba(0,0,0,.35);';
    this.ui = ui;
    this.eqWrap = ui.querySelector('#mcEq')!;
    this.eqNotes = Array.from(ui.querySelectorAll('.mcN')) as HTMLElement[];
    for (const n of this.eqNotes) n.style.cssText = 'font-size:24px;line-height:1;display:inline-block;transition:none;';
    this.sitTextEl = ui.querySelector('#mcSit')!;
    this.runBtn = ui.querySelector('#mcRun')!;
    this.hitBtn = ui.querySelector('#mcHit')!;
    this.sitBtn = ui.querySelector('#mcSitBtn')!;
    this.runBtn.style.cssText += btnCss + 'background:#4DC3FF;';
    this.hitBtn.style.cssText += btnCss + 'background:#FFD23F;';
    this.sitBtn.style.cssText += btnCss + 'background:#7ED321;';
    const tap = (el: HTMLElement, fn: () => void) => el.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); fn(); });
    tap(this.runBtn, () => this.run());
    tap(this.hitBtn, () => this.hit(this.ctx.players[0]));
    tap(this.sitBtn, () => this.claimSeat(this.ctx.players[0]));
  }

  private updateButtons() {
    if (!this.ui) return;
    const walk = this.phase === 'walk';
    const you = this.ctx.players[0];
    const canAct = walk && !you.dead && !you.fallen;
    this.runBtn.style.display = canAct ? 'inline-block' : 'none';
    this.hitBtn.style.display = canAct && this.hitWinT[0] > 0 ? 'inline-block' : 'none';
    this.sitBtn.style.display = this.phase === 'sit' && !you.dead ? 'inline-block' : 'none';
  }

  private setMusicPlaying(on: boolean) {
    if (!this.eqWrap) return;
    this.eqWrap.style.opacity = on ? '1' : '0.25';
    if (!on) for (const n of this.eqNotes) n.style.transform = 'translateY(6px) scale(0.8)';
  }

  /** Lively, RANDOM equalizer bounce — all 4 notes stay lit and jiggle so it
   *  never hints how long the music has left (no count-down). */
  private animateEq() {
    const t = performance.now() / 1000;
    for (let i = 0; i < this.eqNotes.length; i++) {
      const h = Math.abs(Math.sin(t * (5 + i * 1.7) + i)) * 0.6 + Math.random() * 0.25;
      const y = -h * 12;
      this.eqNotes[i].style.transform = `translateY(${y.toFixed(1)}px) scale(${(0.85 + h * 0.4).toFixed(2)})`;
    }
  }

  private doFinish() {
    if (this.finished) return;
    this.finished = true;
    this.phase = 'done';
    SFX.playMusic(this.ctx.family.id);
    document.getElementById('mcUI')?.remove();
    for (const c of this.chairs) this.ctx.scene.remove(c.group);
    this.chairs = [];
    this.clearBoxes();
    const ctx = this.ctx;
    ctx.players.forEach((p) => ((p as any)._res = p.dead ? 'OUT' : '🪑 SEATED'));
    ctx.finish(rankBy(ctx, (p) => (p.dead ? ((p as any)._outAt ?? 0) : Infinity)), 'Last one seated wins!');
  }
}
