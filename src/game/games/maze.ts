import * as THREE from 'three';
import type { GameModule, MatchContext } from '../context';
import type { Player } from '../player';
import { HITBOX_RADIUS } from '../player';
import { setupRoster, localMove, botMove, tickRoster, rankBy } from '../freeroam';
import { matchTime } from '../../core/tuning';
import { SFX } from '../../core/audio';
import { markDead, setObjective } from '../../ui/hud';

// NIGHT HEIST (Dune Clash). A pitch-dark square MAZE, viewed top-down. One of the
// four is the COP; the other three are ROBBERS. The cop sees in the dark and is
// 1.5x faster, and tags robbers by touching them FROM BEHIND. The robbers are
// blind except for a torch: hold the torch-beam on the cop for 5 seconds TOTAL
// and the cop is blinded — robbers win. The torch has a 3-bar battery (3s per
// bar); fewer bars = a shorter beam. It recharges (5s/bar) whenever it's off.
// Cop wins by tagging all three robbers first.

interface Wall { x: number; z: number; hw: number; hd: number; }

const POLICE_SPEED = 1.5;
const CATCH_R = HITBOX_RADIUS * 2 + 1.5;
const EXPOSE_LIMIT = 5;          // cop blinded after 5s of torchlight
const BATTERY_MAX = 9;           // 3 bars x 3s
const BAR_SEC = 3;
const RECHARGE_PER_SEC = 1 / 5;  // 5s per bar
const RANGE_BY_BARS = [0, 11, 16, 22];
const CONE_BY_BARS = [0, 0.42, 0.5, 0.6]; // half-angle (rad)

export class MazeGame implements GameModule {
  readonly stickMode = 'float' as const;
  title = 'Night Heist';
  objective = '';

  private ctx!: MatchContext;
  private policeIdx = 0;
  private youPolice = false;
  private walls: Wall[] = [];
  private timeLeft = 80;
  private finished = false;
  private outCount = 0;
  private exposure = 0;
  private startGrace = 2;

  private battery: number[] = [];
  private lightOn: boolean[] = [];
  private faceAng: number[] = [];
  private spot: (THREE.SpotLight | null)[] = [];
  private spotTarget: (THREE.Object3D | null)[] = [];
  private selfLantern: THREE.PointLight | null = null;
  private torchGlow: (THREE.PointLight | null)[] = [];
  private labels: (THREE.Sprite | null)[] = [];

  // Lights-on reveal: a 4s look at the whole map before night falls, plus two
  // random 2s "lightning" flashes during the match.
  private revealT = 4;
  private flashTimes: number[] = [];
  private flashed: boolean[] = [];
  private nightFell = false;
  private revealLight: THREE.AmbientLight | null = null;

  private ui!: HTMLElement;
  private exposeFill!: HTMLElement;
  private barsEl: HTMLElement[] = [];
  private lightBtn!: HTMLButtonElement;
  private infoEl!: HTMLElement;

  init(ctx: MatchContext) {
    this.ctx = ctx;
    this.title = ctx.game.name;
    this.finished = false;
    this.timeLeft = matchTime(60);
    this.walls = [];
    this.exposure = 0;
    this.outCount = 0;
    this.revealT = 4;          // 4s bright reveal before night
    this.startGrace = 4;       // no catching / exposure during the reveal
    this.nightFell = false;
    // Two random 2s bright flashes somewhere in the middle of the match.
    const T = this.timeLeft;
    const a = 12 + Math.random() * (T - 26);
    let bt = 12 + Math.random() * (T - 26);
    while (Math.abs(bt - a) < 9) bt = 12 + Math.random() * (T - 26);
    this.flashTimes = [Math.max(a, bt), Math.min(a, bt)]; // as timeLeft thresholds
    this.flashed = [false, false];

    setupRoster(ctx, '', 0.72);
    this.policeIdx = Math.floor(Math.random() * ctx.players.length);
    this.youPolice = this.policeIdx === 0;
    this.buildMaze();

    this.battery = ctx.players.map(() => BATTERY_MAX);
    this.lightOn = ctx.players.map(() => false);
    this.faceAng = ctx.players.map(() => 0);
    this.spot = ctx.players.map(() => null);
    this.spotTarget = ctx.players.map(() => null);

    // Spawn spread to the corners; the cop starts in a corner too.
    const H = ctx.halfSize;
    const spots = [[H * 0.7, H * 0.7], [-H * 0.7, H * 0.7], [-H * 0.7, -H * 0.7], [H * 0.7, -H * 0.7]];
    ctx.players.forEach((p, i) => {
      p.x = spots[i][0]; p.z = spots[i][1]; p.vx = 0; p.vz = 0;
      p.invulnT = 0;
      this.faceAng[p.index] = Math.atan2(-p.x, -p.z); // face roughly inward
    });

    this.setupLighting();
    this.buildLabels();
    this.buildUI();

    this.objective = this.youPolice
      ? '🚔 Tag all 3 robbers from behind!'
      : '🔦 Torch the cop for 5s — mind your back!';
    setObjective(this.objective);
    ctx.fx.banner(this.youPolice ? 'COP 🚔 — memorise the map!' : 'ROBBER 🔦 — memorise the map!', this.youPolice ? '#4DA6FF' : '#FFD23F');
  }

  private police(): Player { return this.ctx.players[this.policeIdx]; }
  private robbers(): Player[] { return this.ctx.players.filter((p) => p.index !== this.policeIdx); }
  private aliveRobbers(): Player[] { return this.robbers().filter((p) => !p.dead); }

  // --- maze -------------------------------------------------------------------
  private buildMaze() {
    const H = this.ctx.halfSize;
    const wallMat = new THREE.MeshStandardMaterial({ color: 0x39415a, roughness: 1, flatShading: true, emissive: 0x0a0e1a });
    const capMat = new THREE.MeshStandardMaterial({ color: 0x4a5474, roughness: 1, flatShading: true });
    const height = 5;
    const wall = (cx: number, cz: number, hw: number, hd: number) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(hw * 2, height, hd * 2), wallMat);
      m.position.set(cx, height / 2, cz); m.castShadow = true; m.receiveShadow = true;
      this.ctx.scene.add(m);
      const cap = new THREE.Mesh(new THREE.BoxGeometry(hw * 2 + 0.4, 0.6, hd * 2 + 0.4), capMat);
      cap.position.set(cx, height + 0.05, cz); this.ctx.scene.add(cap);
      this.walls.push({ x: cx, z: cz, hw, hd });
    };
    // An OPEN arena with scattered cover — thin, isolated blocks with wide gaps
    // everywhere, an open middle and no enclosed rooms or dead-ends, so you can
    // walk anywhere between them.
    const T = 1.0; // thin walls
    const layout: [number, number, number, number][] = [
      // 4 short mid walls (light cover around the centre)
      [0, -13, 3.5, T], [0, 13, 3.5, T], [-13, 0, T, 3.5], [13, 0, T, 3.5],
      // 4 inner pillars on the diagonals (open cross through the middle)
      [-9, -9, 1.4, 1.4], [9, -9, 1.4, 1.4], [-9, 9, 1.4, 1.4], [9, 9, 1.4, 1.4],
      // 4 outer short walls near the edges
      [0, -21, 3.5, T], [0, 21, 3.5, T], [-21, 0, T, 3.5], [21, 0, T, 3.5],
    ];
    for (const [cx, cz, hw, hd] of layout) wall(cx, cz, hw, hd);
    void H;
  }

  // --- lighting ---------------------------------------------------------------
  private setupLighting() {
    const scene = this.ctx.scene;
    // If YOU are the cop you see a bright, normal map so you can hunt.
    if (this.youPolice) {
      scene.add(new THREE.AmbientLight(0xdce6ff, 2.6));
      scene.add(new THREE.HemisphereLight(0xffffff, 0x445066, 1.6));
      const d = new THREE.DirectionalLight(0xffffff, 1.4); d.position.set(10, 60, 20); scene.add(d);
    } else {
      // You're a robber: a faint self-lantern so you can just make out your feet
      // (decay 0 so it doesn't vanish at the top-down camera distance).
      this.selfLantern = new THREE.PointLight(0xffe8b0, 16, 14, 0);
      scene.add(this.selfLantern);
    }
    // Reveal fill — flips the whole scene bright during the 4s opening look and
    // the two lightning flashes (drives the robber's view like the cop's).
    this.revealLight = new THREE.AmbientLight(0xdce6ff, 0);
    scene.add(this.revealLight);
    // Every robber carries a torch (spotlight) plus a small glow so a lit-up
    // robber is a visible beacon to the others (they can regroup). The local
    // robber's torch casts shadows so walls hide the cop; a 512 map keeps it
    // cheap. decay 0 keeps beams bright across the top-down distance.
    for (const p of this.robbers()) {
      const isLocal = p.index === 0;
      const s = new THREE.SpotLight(0xfff3d0, 0, RANGE_BY_BARS[3], CONE_BY_BARS[3], 0.35, 0);
      s.castShadow = isLocal;
      if (isLocal) { s.shadow.mapSize.set(512, 512); s.shadow.camera.near = 1; s.shadow.camera.far = 30; }
      const tgt = new THREE.Object3D();
      scene.add(tgt); s.target = tgt;
      scene.add(s);
      this.spot[p.index] = s;
      this.spotTarget[p.index] = tgt;
      const glow = new THREE.PointLight(0xffdf9a, 0, 9, 0);
      scene.add(glow);
      this.torchGlow[p.index] = glow;
    }
  }

  // Floating role tags above each head: the cop is "FIND THEM" (red), the three
  // robbers are "ESCAPE" (green). A robber only sees another player's tag when
  // their own light is on them — so the cop still has to be found in the dark.
  private buildLabels() {
    for (const p of this.ctx.players) {
      const cop = p.index === this.policeIdx;
      const sp = this.makeLabel(cop ? 'FIND THEM' : 'ESCAPE', cop ? '#ff3b3b' : '#5cf07a');
      sp.position.y = 7.2;
      p.group.add(sp);
      this.labels[p.index] = sp;
    }
  }

  private makeLabel(text: string, color: string): THREE.Sprite {
    const c = document.createElement('canvas'); c.width = 320; c.height = 72;
    const x = c.getContext('2d')!;
    x.font = '900 46px Bungee, Nunito, sans-serif';
    x.textAlign = 'center'; x.textBaseline = 'middle';
    x.lineWidth = 9; x.strokeStyle = 'rgba(0,0,0,0.9)'; x.strokeText(text, 160, 40);
    x.fillStyle = color; x.fillText(text, 160, 40);
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false }));
    sp.scale.set(11, 2.5, 1);
    return sp;
  }

  private updateLabels() {
    const you = this.ctx.players[0];
    for (const p of this.ctx.players) {
      const lbl = this.labels[p.index];
      if (!lbl) continue;
      if (p.dead) { lbl.visible = false; continue; }
      lbl.visible = p.index === 0 || this.youPolice || this.litForLocal(p, you);
    }
  }

  // Can the LOCAL robber currently see player p (self-lantern pool, torch cone,
  // or — for a fellow robber — because THEIR torch is on, giving them away so
  // the robbers can find and regroup with each other)?
  private litForLocal(p: Player, you: Player): boolean {
    if (this.revealT > 0) return true; // everything visible during a reveal/flash
    if (p.index !== this.policeIdx && this.emitting(p.index)) return true; // lit-up ally
    const d = Math.hypot(p.x - you.x, p.z - you.z);
    if (d < 7) return true;
    if (this.emitting(0)) {
      const b = this.bars(0);
      if (d < RANGE_BY_BARS[b] && d > 0.001) {
        const fx = Math.sin(this.faceAng[0]), fz = Math.cos(this.faceAng[0]);
        const cosang = ((p.x - you.x) / d) * fx + ((p.z - you.z) / d) * fz;
        if (cosang > Math.cos(CONE_BY_BARS[b]) && this.segClear(you.x, you.z, p.x, p.z)) return true;
      }
    }
    return false;
  }

  // --- helpers ----------------------------------------------------------------
  private bars(i: number): number { return Math.min(3, Math.ceil(this.battery[i] / BAR_SEC - 1e-6)); }
  private emitting(i: number): boolean { return this.lightOn[i] && this.battery[i] > 0.001; }

  private segClear(x0: number, z0: number, x1: number, z1: number): boolean {
    const dx = x1 - x0, dz = z1 - z0, dist = Math.hypot(dx, dz);
    const steps = Math.max(2, Math.ceil(dist / 1.4));
    for (let s = 1; s < steps; s++) {
      const t = s / steps, x = x0 + dx * t, z = z0 + dz * t;
      for (const c of this.walls) if (Math.abs(x - c.x) < c.hw && Math.abs(z - c.z) < c.hd) return false;
    }
    return true;
  }

  // --- tick -------------------------------------------------------------------
  ability() { if (!this.youPolice) this.toggleLight(); }

  tick(dt: number, elapsed: number) {
    if (this.finished) return;
    const ctx = this.ctx;
    this.timeLeft -= dt;
    ctx.setClock(this.timeLeft);
    this.startGrace = Math.max(0, this.startGrace - dt);
    const police = this.police();

    // Reveal / flashes: 4s bright opening, then two random 2s flashes.
    if (this.revealT > 0) {
      this.revealT -= dt;
      if (this.revealT <= 0 && !this.nightFell) { this.nightFell = true; ctx.fx.banner('🌙 LIGHTS OUT!', '#4DA6FF'); }
    }
    for (let k = 0; k < this.flashTimes.length; k++) {
      if (!this.flashed[k] && this.nightFell && this.timeLeft <= this.flashTimes[k]) {
        this.flashed[k] = true;
        this.revealT = Math.max(this.revealT, 2);
        ctx.fx.banner('⚡ LIGHTS!', '#ffe66d');
      }
    }
    if (this.revealLight) this.revealLight.intensity = this.revealT > 0 ? 4.0 : 0;

    // Movement.
    if (this.policeIdx === 0) this.moveLocal(police, dt);
    else this.moveBotPolice(police, dt);
    for (const p of this.aliveRobbers()) {
      if (p.index === 0) this.moveLocal(p, dt);
      else this.moveBotRobber(p, dt);
    }

    // Walls.
    for (const p of ctx.players) if (!p.dead) { this.resolveWalls(p); this.clampWalls(p); }

    // Facing: normally follows motion, but a bot robber shining its torch AIMS
    // at the cop (so its beam actually lands) regardless of which way it moves.
    for (const p of ctx.players) {
      if (p.dead) continue;
      if (p.index !== 0 && p.index !== this.policeIdx && this.emitting(p.index)) {
        this.faceAng[p.index] = Math.atan2(police.x - p.x, police.z - p.z);
      } else if (Math.hypot(p.vx, p.vz) > 1.5) {
        this.faceAng[p.index] = Math.atan2(p.vx, p.vz);
      }
    }

    // Torch battery + beams.
    this.tickTorches(dt);

    // Exposure: is the cop caught in any live torch beam (in cone + line of sight)?
    let lit = false;
    for (const p of this.aliveRobbers()) {
      if (!this.emitting(p.index)) continue;
      const b = this.bars(p.index);
      const dx = police.x - p.x, dz = police.z - p.z, d = Math.hypot(dx, dz) || 1;
      if (d > RANGE_BY_BARS[b]) continue;
      const fx = Math.sin(this.faceAng[p.index]), fz = Math.cos(this.faceAng[p.index]);
      const cosang = (dx / d) * fx + (dz / d) * fz;
      if (cosang < Math.cos(CONE_BY_BARS[b])) continue;
      if (!this.segClear(p.x, p.z, police.x, police.z)) continue;
      lit = true; break;
    }
    if (lit && this.startGrace <= 0) {
      // The torchlight only fills the "blinded" meter — the cop is NOT frozen and
      // can keep running away; just a spark cue so you can tell he's lit.
      this.exposure = Math.min(EXPOSE_LIMIT, this.exposure + dt);
      if (Math.random() < dt * 4) this.ctx.fx.burst(police.x, police.z, '#fff6c0', 4);
    }

    // Catches — the cop tags a robber only FROM BEHIND.
    if (this.startGrace <= 0 && this.exposure < EXPOSE_LIMIT) {
      for (const p of this.aliveRobbers()) {
        const dx = police.x - p.x, dz = police.z - p.z, d = Math.hypot(dx, dz);
        if (d > CATCH_R || d < 0.001) continue;
        const fx = Math.sin(this.faceAng[p.index]), fz = Math.cos(this.faceAng[p.index]);
        if ((dx / d) * fx + (dz / d) * fz < -0.1) this.catchRobber(p); // cop is behind
      }
    }

    tickRoster(ctx, dt, elapsed);
    this.syncTorchMeshes();
    this.updateLabels();
    this.updateUI();

    // Win / lose.
    if (this.exposure >= EXPOSE_LIMIT) this.doFinish(false, 'The cop was blinded — robbers escape!');
    else if (this.aliveRobbers().length === 0) this.doFinish(true, 'The cop caught everyone!');
    else if (this.timeLeft <= 0) this.doFinish(false, 'Dawn breaks — the robbers got away!');
  }

  private speedMul(p: Player): number { return p.index === this.policeIdx ? POLICE_SPEED : 1; }
  private moveLocal(p: Player, dt: number) { localMove(this.ctx, dt, { noClamp: true, speedMul: this.speedMul(p) }); }

  private toggleLight() {
    const i = 0;
    if (this.battery[i] <= 0.1) return; // dead battery
    this.lightOn[i] = !this.lightOn[i];
    SFX.tick();
  }

  private tickTorches(dt: number) {
    for (const p of this.robbers()) {
      const i = p.index;
      if (this.emitting(i)) {
        this.battery[i] = Math.max(0, this.battery[i] - dt);
        if (this.battery[i] <= 0) this.lightOn[i] = false;
      } else {
        this.battery[i] = Math.min(BATTERY_MAX, this.battery[i] + dt * RECHARGE_PER_SEC);
      }
    }
  }

  private syncTorchMeshes() {
    for (const p of this.robbers()) {
      const s = this.spot[p.index], tgt = this.spotTarget[p.index];
      if (!s || !tgt) continue;
      const on = this.emitting(p.index) && !p.dead;
      const b = this.bars(p.index);
      s.intensity = on ? (p.index === 0 ? 55 : 32) : 0;
      s.distance = RANGE_BY_BARS[b] || 1;
      s.angle = CONE_BY_BARS[b] || 0.3;
      const fx = Math.sin(this.faceAng[p.index]), fz = Math.cos(this.faceAng[p.index]);
      s.position.set(p.x, 3.2, p.z);
      tgt.position.set(p.x + fx * 10, 1.2, p.z + fz * 10);
      const glow = this.torchGlow[p.index];
      if (glow) { glow.intensity = on ? 7 : 0; glow.position.set(p.x, 3, p.z); }
    }
    if (this.selfLantern) {
      const you = this.ctx.players[0];
      this.selfLantern.position.set(you.x, 4, you.z);
      this.selfLantern.visible = !you.dead;
    }
  }

  // --- bot AI -----------------------------------------------------------------
  private moveBotPolice(p: Player, dt: number) {
    p.retarget -= dt;
    const prey = this.aliveRobbers();
    if (!prey.length) return;
    if (p.retarget <= 0) {
      p.retarget = 0.3;
      // Chase the nearest robber, aiming for the spot just BEHIND them.
      let t = prey[0], best = Infinity;
      for (const q of prey) { const d = Math.hypot(q.x - p.x, q.z - p.z); if (d < best) { best = d; t = q; } }
      const fx = Math.sin(this.faceAng[t.index]), fz = Math.cos(this.faceAng[t.index]);
      p.tx = t.x - fx * 4; p.tz = t.z - fz * 4;
    }
    botMove(this.ctx, p, p.tx, p.tz, dt, { noClamp: true, speedMul: POLICE_SPEED });
  }

  private moveBotRobber(p: Player, dt: number) {
    const i = p.index, police = this.police();
    const gd = Math.hypot(police.x - p.x, police.z - p.z);
    const los = this.segClear(p.x, p.z, police.x, police.z);
    // Shine the torch whenever the cop is in beam range with clear line of sight
    // and there's battery; it auto-aims at him (see the facing block in tick).
    this.lightOn[i] = gd < 20 && los && this.battery[i] > 0.6;
    p.retarget -= dt;
    if (p.retarget <= 0) {
      p.retarget = 0.28 + Math.random() * 0.22;
      if (!los || gd > 16) {
        // Hunt the cop — close in until he's in torch range (and in sight).
        p.tx = police.x; p.tz = police.z;
      } else if (gd < 10) {
        // Too close (risking a behind-tag) — back off to torch distance.
        const ax = p.x - police.x, az = p.z - police.z, L = Math.hypot(ax, az) || 1;
        p.tx = p.x + (ax / L) * 13; p.tz = p.z + (az / L) * 13;
      } else {
        // Sweet spot — orbit the cop, holding the beam on him.
        const ax = police.x - p.x, az = police.z - p.z, L = Math.hypot(ax, az) || 1;
        const s = (i % 2 === 0) ? 1 : -1;
        p.tx = p.x - (az / L) * 9 * s + (ax / L) * 2;
        p.tz = p.z + (ax / L) * 9 * s + (az / L) * 2;
      }
    }
    botMove(this.ctx, p, p.tx, p.tz, dt, { noClamp: true });
  }

  private catchRobber(p: Player) {
    p.dead = true;
    (p as any)._outAt = ++this.outCount;
    this.lightOn[p.index] = false;
    const s = this.spot[p.index]; if (s) s.intensity = 0;
    markDead(p);
    SFX.hit();
    this.ctx.fx.burst(p.x, p.z, p.hero.col, 18);
    this.ctx.fx.shake(1.6);
    this.ctx.fx.banner(p.you ? 'YOU GOT NABBED!' : `${p.hero.name} nabbed!`, '#4DA6FF');
    setObjective(`Robbers left: ${this.aliveRobbers().length}`);
    this.startGrace = 0.5;
  }

  // --- walls ------------------------------------------------------------------
  private resolveWalls(p: Player) {
    for (const c of this.walls) {
      const dx = p.x - c.x, dz = p.z - c.z;
      const clampX = Math.max(-c.hw, Math.min(c.hw, dx));
      const clampZ = Math.max(-c.hd, Math.min(c.hd, dz));
      const nx = c.x + clampX, nz = c.z + clampZ;
      let ox = p.x - nx, oz = p.z - nz;
      let d = Math.hypot(ox, oz);
      if (d >= HITBOX_RADIUS) continue;
      if (d < 0.0001) {
        const px = c.hw - Math.abs(dx), pz = c.hd - Math.abs(dz);
        if (px < pz) { ox = Math.sign(dx) || 1; oz = 0; d = 1; } else { ox = 0; oz = Math.sign(dz) || 1; d = 1; }
      }
      const push = HITBOX_RADIUS - d, ux = ox / d, uz = oz / d;
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

  // --- DOM overlay ------------------------------------------------------------
  private buildUI() {
    document.getElementById('mzUI')?.remove();
    const ui = document.createElement('div');
    ui.id = 'mzUI';
    ui.style.cssText = 'position:fixed;inset:0;z-index:8;pointer-events:none;font-family:Nunito,system-ui,sans-serif;color:#fff;';
    ui.innerHTML = `
      <div style="position:fixed;top:120px;left:50%;transform:translateX(-50%);font-family:Bungee,cursive;font-size:22px;
        letter-spacing:2px;text-shadow:0 3px 0 rgba(0,0,0,.6);color:${this.youPolice ? '#ff3b3b' : '#5cf07a'};white-space:nowrap;">
        ${this.youPolice ? '🚔 FIND THEM' : '🏃 ESCAPE'}</div>
      <div style="position:fixed;top:160px;left:50%;transform:translateX(-50%);text-align:center;">
        <div style="font-family:Bungee,cursive;font-size:13px;letter-spacing:1px;text-shadow:0 2px 0 rgba(0,0,0,.6);">🔦 COP BLINDED</div>
        <div style="width:200px;height:14px;background:rgba(0,0,0,.5);border-radius:8px;overflow:hidden;margin-top:3px;border:2px solid rgba(255,255,255,.25);">
          <div id="mzExpose" style="height:100%;width:0%;background:linear-gradient(90deg,#ffe66d,#ff9f1c);transition:width .1s;"></div>
        </div>
      </div>
      <div id="mzInfo" style="position:fixed;top:212px;left:50%;transform:translateX(-50%);display:none;font-family:Bungee,cursive;font-size:15px;text-shadow:0 2px 0 rgba(0,0,0,.6);"></div>
      <div id="mzRobber" style="position:fixed;left:0;right:0;bottom:24px;display:none;flex-direction:column;align-items:center;gap:10px;">
        <div style="display:flex;gap:6px;">
          <span class="mzBar"></span><span class="mzBar"></span><span class="mzBar"></span>
        </div>
        <button id="mzLight" style="pointer-events:auto;">🔦 TORCH</button>
      </div>`;
    document.body.appendChild(ui);
    this.ui = ui;
    this.exposeFill = ui.querySelector('#mzExpose')!;
    this.infoEl = ui.querySelector('#mzInfo')!;
    this.barsEl = Array.from(ui.querySelectorAll('.mzBar')) as HTMLElement[];
    for (const bar of this.barsEl) bar.style.cssText = 'width:34px;height:12px;border-radius:4px;background:#2fe04a;box-shadow:0 0 8px rgba(47,224,74,.6);';
    this.lightBtn = ui.querySelector('#mzLight')!;
    this.lightBtn.style.cssText += 'font-family:Bungee,cursive;font-size:18px;border:none;border-radius:14px;padding:14px 26px;color:#12142e;background:#FFD23F;cursor:pointer;box-shadow:0 5px 0 rgba(0,0,0,.35);';
    this.lightBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); this.toggleLight(); });
    if (this.youPolice) {
      (ui.querySelector('#mzInfo') as HTMLElement).style.display = 'block';
    } else {
      (ui.querySelector('#mzRobber') as HTMLElement).style.display = 'flex';
    }
  }

  private updateUI() {
    if (!this.ui) return;
    this.exposeFill.style.width = `${(this.exposure / EXPOSE_LIMIT) * 100}%`;
    if (this.youPolice) {
      this.infoEl.textContent = `🚔 Robbers left: ${this.aliveRobbers().length}`;
    } else {
      const b = this.bars(0);
      const on = this.emitting(0);
      this.barsEl.forEach((bar, k) => {
        const lit = k < b;
        bar.style.background = lit ? (on ? '#ffd23f' : '#2fe04a') : 'rgba(255,255,255,.15)';
        bar.style.boxShadow = lit ? `0 0 8px ${on ? 'rgba(255,210,63,.7)' : 'rgba(47,224,74,.6)'}` : 'none';
      });
      this.lightBtn.style.opacity = this.battery[0] > 0.1 ? '1' : '0.4';
      this.lightBtn.textContent = on ? '🔦 ON' : '🔦 TORCH';
    }
  }

  private doFinish(policeWon: boolean, subtitle: string) {
    if (this.finished) return;
    this.finished = true;
    document.getElementById('mzUI')?.remove();
    for (const p of this.ctx.players) { const l = this.labels[p.index]; if (l) p.group.remove(l); }
    const ctx = this.ctx;
    ctx.players.forEach((p) => {
      if (p.index === this.policeIdx) (p as any)._res = policeWon ? '🚔 CAUGHT ALL' : '😵 BLINDED';
      else (p as any)._res = p.dead ? 'NABBED' : '🔦 ESCAPED';
    });
    ctx.finish(rankBy(ctx, (p) => {
      if (p.index === this.policeIdx) return policeWon ? 1e6 : -1;
      if (!p.dead) return 1e5;
      return (p as any)._outAt ?? 0;
    }), subtitle);
  }
}
