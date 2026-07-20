import * as THREE from 'three';
import type { Player } from '../player';
import type { GameModule, MatchContext } from '../context';
import { setupRoster, tickRoster, rankBy } from '../freeroam';
import { SFX } from '../../core/audio';
import { setObjective } from '../../ui/hud';

// OLYMPIC SPRINT (Pirate Cove tier 4 slot — builds its own stadium). A 4-player
// FREE-FOR-ALL 100 m dash in a roaring modern Olympic stadium. Each hero runs in
// their own lane; you build speed by MASHING RUN with a good rhythm (steady taps
// beat frantic ones). PUNCH floors the runner in the lane beside you for a
// second; DASH is a short cooldown burst for the final straight. First across the
// line wins gold. Camera is a behind-and-above isometric chase that keeps all
// four runners framed and zooms in for the finish.

const LANE_X = [-8.25, -2.75, 2.75, 8.25];   // fixed x per lane / player
const START_Z = 45;
const FINISH_Z = -55;
const RACE_LEN = START_Z - FINISH_Z;         // 100 world units == 100 m
const TRACK_HALF = 12;                        // half track width (lane edges)

// Run feel.
const MAX_SPEED = 17;      // top running speed (units/s)
const OPT_RATE = 7;        // taps/sec that reaches top speed
const MAX_RATE = 11;
const MIN_TAP = 0.045;     // ignore taps closer than this (spam / corner+button dedupe)
const RATE_DECAY = 2.3;    // tap-rate falls when you stop tapping
const ACCEL = 5;           // how fast speed eases to the cadence target
const COMBO_MAX = 8;

// Abilities.
const DASH_CD = 3.6;
const DASH_TIME = 0.55;
const DASH_ADD = 9;        // extra speed during a dash burst
const PUNCH_CD = 1.4;
const PUNCH_REACH = 5.6;   // z-distance to a neighbouring-lane rival
const KNOCK_TIME = 1.0;    // floored for 1 second
const RECOVER_INVULN = 0.6;

const COUNT_START = 3.2;
const TIME_CAP = 45;
const END_HOLD = 1.4;      // linger after you cross (fireworks) before results

interface FirePart { m: THREE.Mesh; vx: number; vy: number; vz: number; life: number; }

export class SprintGame implements GameModule {
  readonly stickMode = 'none' as const;
  title = 'Olympic Sprint';
  objective = '🏃 MASH RUN! · PUNCH the lane beside you · DASH the final straight';

  private ctx!: MatchContext;
  private finished = false;

  // per-player race state (indexed by player.index 0..3)
  private speed = [0, 0, 0, 0];
  private tapRate = [0, 0, 0, 0];
  private combo = [0, 0, 0, 0];
  private lastTap = [-9, -9, -9, -9];
  private lastInt = [0.15, 0.15, 0.15, 0.15];
  private knockT = [0, 0, 0, 0];
  private dashT = [0, 0, 0, 0];
  private punchCd = [0, 0, 0, 0];
  private place = [0, 0, 0, 0];       // finishing position (1..4), 0 = still running
  private finishTime = [0, 0, 0, 0];
  private botAcc = [0, 0, 0, 0];
  private botInt = [0.15, 0.15, 0.15, 0.15];
  private botSkill = [0, 0, 0, 0];

  private raceT = 0;
  private countdown = COUNT_START;
  private countShown = 99;
  private finishCount = 0;
  private endT = 0;
  private finalCalled = false;

  // scenery hooks for per-frame life
  private leds: THREE.Mesh[] = [];
  private flame: THREE.Mesh | null = null;
  private flameLight: THREE.PointLight | null = null;
  private fire: FirePart[] = [];

  // UI
  private root!: HTMLElement;
  private timerEl!: HTMLElement;
  private rows: { fill: HTMLElement; rank: HTMLElement; row: HTMLElement }[] = [];
  private runBtn!: HTMLButtonElement;
  private punchBtn!: HTMLButtonElement;
  private dashBtn!: HTMLButtonElement;

  init(ctx: MatchContext) {
    this.ctx = ctx;
    this.title = ctx.game.name;
    this.finished = false;
    this.speed = [0, 0, 0, 0]; this.tapRate = [0, 0, 0, 0]; this.combo = [0, 0, 0, 0];
    this.lastTap = [-9, -9, -9, -9]; this.lastInt = [0.15, 0.15, 0.15, 0.15];
    this.knockT = [0, 0, 0, 0]; this.dashT = [0, 0, 0, 0]; this.punchCd = [0, 0, 0, 0];
    this.place = [0, 0, 0, 0]; this.finishTime = [0, 0, 0, 0];
    this.botAcc = [0, 0, 0, 0]; this.fire = []; this.leds = [];
    this.raceT = 0; this.countdown = COUNT_START; this.countShown = 99;
    this.finishCount = 0; this.endT = 0; this.finalCalled = false;

    // Warm stadium haze, far draw so the crowd fills the backdrop.
    ctx.scene.fog = new THREE.Fog(new THREE.Color(0x9fc4e8).getHex(), 120, 360);
    ctx.scene.add(new THREE.AmbientLight(0xfff2e0, 0.5));

    this.buildStadium();
    setupRoster(ctx, '', 0.5);

    ctx.players.forEach((p, i) => {
      p.x = LANE_X[i]; p.z = START_Z; p.y = 0; p.vx = 0; p.vz = 0;
      p.dead = false; p.fallen = false; p.sitting = false; p.riding = false;
      p.standFacing = Math.PI;           // face down the track (away from camera)
      p.dashCd = 0; p.invulnT = 0;
      if (i > 0) {
        this.botSkill[i] = Math.min(1.06, 0.72 + ctx.diff.cap * 0.3 + (Math.random() * 0.14 - 0.05));
        this.botInt[i] = 1 / (OPT_RATE * this.botSkill[i]);
        this.botAcc[i] = Math.random() * this.botInt[i];
      }
    });

    this.buildUI();
    setObjective(this.objective);
    ctx.fx.banner('🏟️ ON YOUR MARKS…', '#FFD23F');
  }

  // --- input ------------------------------------------------------------------
  // The whole bottom-right corner (RUN button) taps run; PUNCH / DASH are their
  // own buttons placed outside that corner.
  ability() { this.runTap(0); }
  jump() { this.runTap(0); }

  private runTap(i: number) {
    if (this.finished || this.countdown > 0 || this.place[i] > 0 || this.knockT[i] > 0) return;
    const now = this.raceT;
    const interval = now - this.lastTap[i];
    if (interval < MIN_TAP) return;   // throttle: caps spam + dedupes corner+button
    this.lastTap[i] = now;
    const inst = Math.min(MAX_RATE, 1 / Math.max(interval, 0.05));
    this.tapRate[i] = this.tapRate[i] * 0.55 + inst * 0.45;
    // Steady rhythm builds a combo; erratic tapping erodes it.
    if (Math.abs(interval - this.lastInt[i]) < 0.05) this.combo[i] = Math.min(COMBO_MAX, this.combo[i] + 1);
    else this.combo[i] = Math.max(0, this.combo[i] - 2);
    this.lastInt[i] = interval;
    this.speed[i] = Math.min(this.speedCap(i), this.speed[i] + 0.5); // snappy nudge
    if (i === 0) {
      SFX.tick();
      if (this.runBtn) { this.runBtn.style.transform = 'scale(0.93)'; setTimeout(() => this.runBtn && (this.runBtn.style.transform = ''), 70); }
    }
  }

  private speedCap(i: number) { return this.dashT[i] > 0 ? MAX_SPEED + DASH_ADD : MAX_SPEED; }

  private dash(i = 0) {
    if (this.finished || this.countdown > 0 || this.place[i] > 0 || this.knockT[i] > 0) return;
    const p = this.ctx.players[i];
    if (p.dashCd > 0) return;
    p.dashCd = DASH_CD;
    this.dashT[i] = DASH_TIME;
    this.speed[i] = Math.min(MAX_SPEED + DASH_ADD, this.speed[i] + DASH_ADD);
    SFX.power();
    this.ctx.fx.burst(p.x, p.z, p.hero.col, 10);
    if (i === 0) { this.ctx.fx.banner('💨 DASH!', '#7CF07C'); this.ctx.fx.shake(0.6); }
  }

  private punch(i = 0) {
    if (this.finished || this.countdown > 0 || this.place[i] > 0 || this.knockT[i] > 0 || this.punchCd[i] > 0) return;
    this.punchCd[i] = PUNCH_CD;
    const me = this.ctx.players[i];
    let target: Player | null = null; let best = PUNCH_REACH;
    for (const o of this.ctx.players) {
      if (o.index === i) continue;
      if (Math.abs(o.index - i) !== 1) continue;         // only a NEIGHBOURING lane
      if (this.place[o.index] > 0 || this.knockT[o.index] > 0 || o.invulnT > 0) continue;
      const dz = Math.abs(me.z - o.z);
      if (dz < best) { best = dz; target = o; }
    }
    if (target) {
      this.knockDown(target, i);
    } else if (i === 0) {
      SFX.bump();
      if (this.punchBtn) { this.punchBtn.style.transform = 'scale(0.9)'; setTimeout(() => this.punchBtn && (this.punchBtn.style.transform = ''), 90); }
    }
  }

  private knockDown(o: Player, by: number) {
    const j = o.index;
    this.knockT[j] = KNOCK_TIME;
    this.speed[j] *= 0.15;
    this.tapRate[j] *= 0.3;
    this.combo[j] = 0;
    o.fallen = true;
    SFX.hit();
    this.ctx.fx.burst(o.x, o.z + 1, '#FFD23F', 16);
    this.ctx.fx.shake(1.3);
    if (by === 0) this.ctx.fx.banner('👊 KNOCKED DOWN!', '#FF5A5A');
    else if (j === 0) this.ctx.fx.banner('😵 You got floored!', '#FF5A5A');
  }

  // --- tick -------------------------------------------------------------------
  tick(dt: number, elapsed: number) {
    if (this.finished) return;
    const ctx = this.ctx;

    // Countdown 3·2·1·GO before the gun.
    if (this.countdown > 0) {
      this.countdown -= dt;
      const n = Math.ceil(this.countdown);
      if (n !== this.countShown) {
        this.countShown = n;
        if (n > 0) { ctx.fx.banner(String(n), '#FFD23F'); SFX.tick(); }
      }
      if (this.countdown <= 0) { ctx.fx.banner('GO! 🔫', '#7CF07C'); SFX.gem(); }
      this.syncRunners(dt, elapsed);
      this.aimCamera(elapsed);
      this.animScenery(dt);
      tickRoster(ctx, dt, elapsed);
      return;
    }

    this.raceT += dt;

    // Cooldowns / timers.
    for (let i = 0; i < 4; i++) {
      this.punchCd[i] = Math.max(0, this.punchCd[i] - dt);
      this.dashT[i] = Math.max(0, this.dashT[i] - dt);
      const p = ctx.players[i];
      p.dashCd = Math.max(0, p.dashCd - dt);
      if (this.knockT[i] > 0) {
        this.knockT[i] -= dt;
        if (this.knockT[i] <= 0) { p.fallen = false; p.invulnT = RECOVER_INVULN; }
      }
    }

    // Bots auto-tap + fight.
    for (let i = 1; i < 4; i++) this.tickBot(i, dt);

    // Advance every runner from its current speed.
    for (let i = 0; i < 4; i++) this.advance(i, dt);

    this.syncRunners(dt, elapsed);
    this.aimCamera(elapsed);
    this.animScenery(dt);
    this.updateUI();
    tickRoster(ctx, dt, elapsed);

    // Final-straight drama: leader inside the last 18 m.
    if (!this.finalCalled && this.leaderDist() >= RACE_LEN - 18) {
      this.finalCalled = true;
      ctx.fx.banner('🔥 FINAL SPRINT!', '#FFD23F');
      SFX.win();
    }

    // End: you crossed, everyone crossed, or the clock ran out.
    if (this.endT > 0) {
      this.endT -= dt;
      if (this.endT <= 0) return this.doFinish();
    } else if (this.place[0] > 0 || this.finishCount >= 4 || this.raceT >= TIME_CAP) {
      this.endT = END_HOLD;
      this.spawnFireworks();
    }
  }

  private advance(i: number, dt: number) {
    const p = this.ctx.players[i];
    if (this.place[i] > 0) { p.vz = 0; p.x = LANE_X[i]; return; }
    if (this.knockT[i] > 0) {
      this.speed[i] += (0 - this.speed[i]) * 5 * dt;   // slump to a stop while down
      p.vz = -this.speed[i]; p.x = LANE_X[i];
      p.z -= this.speed[i] * dt;
      return;
    }
    // Cadence → target speed. Tap-rate decays, so you must keep tapping.
    this.tapRate[i] = Math.max(0, this.tapRate[i] - this.tapRate[i] * RATE_DECAY * dt);
    const cap = this.speedCap(i);
    const rhythmMul = 1 + (this.combo[i] / COMBO_MAX) * 0.22;
    let target = MAX_SPEED * Math.min(1, this.tapRate[i] / OPT_RATE) * rhythmMul;
    if (this.dashT[i] > 0) target += DASH_ADD;
    target = Math.min(target, cap);
    this.speed[i] += (target - this.speed[i]) * ACCEL * dt;
    this.speed[i] = Math.min(this.speed[i], cap);
    // Move down the lane (toward −z).
    p.z -= this.speed[i] * dt;
    p.vz = -this.speed[i]; p.vx = 0; p.x = LANE_X[i];
    if (p.z <= FINISH_Z) this.crossLine(i);
  }

  private crossLine(i: number) {
    const p = this.ctx.players[i];
    p.z = FINISH_Z;
    this.place[i] = ++this.finishCount;
    this.finishTime[i] = this.raceT;
    const label = ['🥇 1st!', '🥈 2nd', '🥉 3rd', '4th'][this.place[i] - 1];
    if (i === 0) {
      SFX.win();
      this.ctx.fx.banner(this.place[i] === 1 ? '🥇 GOLD! You win!' : `You finish ${label}`, this.place[i] === 1 ? '#FFD23F' : '#4DC3FF');
    } else if (this.place[i] === 1) {
      this.ctx.fx.banner('🏁 ' + p.hero.name + ' takes the lead line!', '#ff7a3a');
    }
    this.ctx.fx.burst(p.x, 1, p.hero.col, 20);
  }

  private tickBot(i: number, dt: number) {
    if (this.place[i] > 0 || this.knockT[i] > 0) return;
    const p = this.ctx.players[i];
    // Tap the run on the bot's cadence, with jitter so its rhythm isn't perfect.
    this.botAcc[i] += dt;
    if (this.botAcc[i] >= this.botInt[i]) {
      this.botAcc[i] = 0;
      this.botInt[i] = (1 / (OPT_RATE * this.botSkill[i])) * (0.82 + Math.random() * 0.36);
      this.runTap(i);
    }
    // Punch a neighbour who's alongside (slightly ahead preferred).
    if (this.punchCd[i] <= 0) {
      for (const o of this.ctx.players) {
        if (Math.abs(o.index - i) !== 1) continue;
        if (this.place[o.index] > 0 || this.knockT[o.index] > 0 || o.invulnT > 0) continue;
        if (Math.abs(o.z - p.z) < PUNCH_REACH * 0.8 && Math.random() < (0.7 + this.ctx.diff.cap) * dt) {
          this.punch(i); break;
        }
      }
    }
    // Dash to chase when trailing the leader.
    if (p.dashCd <= 0 && (this.leaderZ() < p.z - 9) && Math.random() < 0.4 * dt) this.dash(i);
  }

  private leaderZ() { return Math.min(...this.ctx.players.map((p) => p.z)); }
  private leaderDist() { return START_Z - this.leaderZ(); }

  // --- runners / camera / scenery --------------------------------------------
  private syncRunners(_dt: number, _elapsed: number) {
    for (let i = 0; i < 4; i++) {
      const p = this.ctx.players[i];
      p.x = LANE_X[i];
      if (this.place[i] === 0 && this.knockT[i] <= 0) p.standFacing = Math.PI;
    }
  }

  private aimCamera(_elapsed: number) {
    // Follow the pack: sit behind the last runner, look toward the finish. Zoom
    // in a touch as the leader nears the tape.
    const zs = this.ctx.players.map((p) => p.z);
    const avg = zs.reduce((a, b) => a + b, 0) / 4;
    const packZ = avg * 0.55 + Math.min(...zs) * 0.45;   // bias slightly toward the leader
    const closing = Math.max(0, Math.min(1, (this.leaderDist() - (RACE_LEN - 22)) / 22));
    const dist = 33 - closing * 6;
    const height = 27 - closing * 4;
    this.ctx.camera.chaseBehind(0, 1.4, packZ, Math.PI, dist, height);
  }

  private animScenery(dt: number) {
    const t = performance.now() / 1000;
    for (const led of this.leds) {
      const m = led.material as THREE.MeshStandardMaterial;
      m.emissiveIntensity = 0.7 + Math.sin(t * 2 + led.position.x) * 0.25;
    }
    if (this.flame) { const s = 1 + Math.sin(t * 9) * 0.12; this.flame.scale.set(s, 1 + Math.sin(t * 7) * 0.18, s); }
    if (this.flameLight) this.flameLight.intensity = 1.4 + Math.sin(t * 11) * 0.4;
    // Firework particles.
    if (this.fire.length) {
      this.fire = this.fire.filter((f) => {
        f.life -= dt * 0.8;
        if (f.life <= 0) { this.ctx.scene.remove(f.m); return false; }
        f.m.position.x += f.vx * dt; f.m.position.y += f.vy * dt; f.m.position.z += f.vz * dt;
        f.vy -= 22 * dt;
        (f.m.material as THREE.MeshBasicMaterial).opacity = Math.max(0, f.life);
        return true;
      });
    }
  }

  private spawnFireworks() {
    for (let b = 0; b < 4; b++) {
      const cx = (Math.random() - 0.5) * 40;
      const cz = FINISH_Z - 6 - Math.random() * 20;
      const cy = 26 + Math.random() * 12;
      const col = new THREE.Color().setHSL(Math.random(), 0.9, 0.6).getHex();
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 2, sp = 6 + Math.random() * 6;
        const m = new THREE.Mesh(new THREE.SphereGeometry(0.5, 6, 6),
          new THREE.MeshBasicMaterial({ color: col, transparent: true }));
        m.position.set(cx, cy, cz);
        this.ctx.scene.add(m);
        this.fire.push({ m, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp * 0.6 + 3, vz: Math.sin(a) * sp * 0.5, life: 1 });
      }
    }
    SFX.win();
  }

  // --- stadium ----------------------------------------------------------------
  private buildStadium() {
    const scene = this.ctx.scene;
    const midZ = (START_Z + FINISH_Z) / 2;
    const trackLen = RACE_LEN + 40;

    // Running track (red) + darker run-off aprons.
    const track = new THREE.Mesh(new THREE.PlaneGeometry(TRACK_HALF * 2, trackLen),
      new THREE.MeshStandardMaterial({ color: 0xb8402a, roughness: 0.95 }));
    track.rotation.x = -Math.PI / 2; track.position.set(0, 0.02, midZ); track.receiveShadow = true; scene.add(track);

    // Lane lines (5 white stripes) running the length of the track.
    for (let l = 0; l <= 4; l++) {
      const x = -TRACK_HALF + (l / 4) * TRACK_HALF * 2;
      const line = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.05, trackLen - 4),
        new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.7 }));
      line.position.set(x, 0.08, midZ); scene.add(line);
    }

    // Start line + starting blocks + lane numbers.
    const white = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.7 });
    const startLine = new THREE.Mesh(new THREE.BoxGeometry(TRACK_HALF * 2, 0.06, 0.7), white);
    startLine.position.set(0, 0.09, START_Z + 2); scene.add(startLine);
    for (let i = 0; i < 4; i++) {
      const block = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.6, 1.4),
        new THREE.MeshStandardMaterial({ color: 0x2a2f3a, roughness: 0.6 }));
      block.position.set(LANE_X[i], 0.3, START_Z + 3.2); block.rotation.x = -0.5; scene.add(block);
      const num = this.textSprite(String(i + 1), '#ffffff', 74);
      num.scale.set(2.6, 2.6, 1); num.position.set(LANE_X[i], 2.2, START_Z + 5.5); scene.add(num);
    }
    // "100 M" painted flat on the track (a decal, not a billboard).
    const bigM = new THREE.Mesh(new THREE.PlaneGeometry(16, 5), this.decalMat('100 M'));
    bigM.rotation.x = -Math.PI / 2; bigM.rotation.z = Math.PI; bigM.position.set(0, 0.11, START_Z - 10); scene.add(bigM);

    // Finish line (checkered) + finish gate.
    this.buildFinishGate();

    // Green infield / outfield base beyond the aprons.
    for (const s of [-1, 1]) {
      const grass = new THREE.Mesh(new THREE.PlaneGeometry(60, trackLen + 30),
        new THREE.MeshStandardMaterial({ color: 0x2f6a34, roughness: 1 }));
      grass.rotation.x = -Math.PI / 2; grass.position.set(s * (TRACK_HALF + 32), -0.02, midZ); scene.add(grass);
    }

    // Trackside ad boards (blue "BASH ARENA") along both sides.
    const adTex = this.adTexture();
    for (const s of [-1, 1]) {
      const board = new THREE.Mesh(new THREE.BoxGeometry(0.6, 2.4, trackLen),
        new THREE.MeshStandardMaterial({ map: this.adMap(adTex, trackLen), color: 0xffffff, roughness: 0.6 }));
      board.position.set(s * (TRACK_HALF + 0.8), 1.3, midZ); board.castShadow = true; scene.add(board);
    }

    // Raked side stands packed with crowd, plus a big end stand behind the finish.
    this.buildStand(TRACK_HALF + 2, 46, START_Z + 14, FINISH_Z - 14, 'x+');
    this.buildStand(-(TRACK_HALF + 2), -46, START_Z + 14, FINISH_Z - 14, 'x-');
    this.buildEndStand();

    // Flags along the top of the side stands.
    this.buildFlags();

    // Corner floodlight towers.
    for (const sx of [-1, 1]) for (const sz of [START_Z + 12, FINISH_Z - 12]) this.buildFloodlight(sx * 40, sz);

    // Olympic cauldron by the finish.
    this.buildCauldron(-18, FINISH_Z - 2);
  }

  private buildFinishGate() {
    const scene = this.ctx.scene;
    // Checkered finish line painted across the track.
    const cols = 12;
    for (let r = 0; r < 3; r++) for (let c = 0; c < cols; c++) {
      const tile = new THREE.Mesh(new THREE.PlaneGeometry(TRACK_HALF * 2 / cols, 1.1),
        new THREE.MeshStandardMaterial({ color: (r + c) % 2 ? 0x111111 : 0xffffff, roughness: 0.7 }));
      tile.rotation.x = -Math.PI / 2;
      tile.position.set(-TRACK_HALF + (c + 0.5) * (TRACK_HALF * 2 / cols), 0.09, FINISH_Z + r * 1.1 - 1.1);
      scene.add(tile);
    }
    // Gate posts + top beam.
    const postMat = new THREE.MeshStandardMaterial({ color: 0x2f6bd8, roughness: 0.5, metalness: 0.3, emissive: 0x102a55, emissiveIntensity: 0.4 });
    for (const s of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.9, 12, 10), postMat);
      post.position.set(s * (TRACK_HALF + 1.5), 6, FINISH_Z); post.castShadow = true; scene.add(post);
    }
    const beam = new THREE.Mesh(new THREE.BoxGeometry(TRACK_HALF * 2 + 5, 2.4, 1.6), postMat);
    beam.position.set(0, 11.4, FINISH_Z); scene.add(beam);
    // Checkered banner strip under the beam.
    const bcols = 20;
    for (let r = 0; r < 2; r++) for (let c = 0; c < bcols; c++) {
      const tile = new THREE.Mesh(new THREE.PlaneGeometry((TRACK_HALF * 2 + 4) / bcols, 0.9),
        new THREE.MeshStandardMaterial({ color: (r + c) % 2 ? 0xffffff : 0x111111, side: THREE.DoubleSide }));
      tile.position.set(-(TRACK_HALF + 2) + (c + 0.5) * ((TRACK_HALF * 2 + 4) / bcols), 10.4 - r * 0.9, FINISH_Z - 0.9);
      scene.add(tile);
    }
    const label = this.textSprite('FINISH', '#ffffff', 84);
    label.scale.set(12, 3, 1); label.position.set(0, 11.4, FINISH_Z - 1); scene.add(label);
    // Two LED screens flanking the gate.
    for (const s of [-1, 1]) {
      const led = new THREE.Mesh(new THREE.PlaneGeometry(9, 5),
        new THREE.MeshStandardMaterial({ map: this.ledTexture(), emissive: 0xffffff, emissiveIntensity: 0.8, emissiveMap: this.ledTexture(), color: 0x111111 }));
      led.position.set(s * (TRACK_HALF + 8), 9, FINISH_Z - 0.5); led.rotation.y = -s * 0.5; scene.add(led);
      this.leds.push(led);
    }
  }

  private buildStand(xInner: number, xOuter: number, z0: number, z1: number, tag: string) {
    const scene = this.ctx.scene;
    const yb = 2.6, yt = 34;
    // Raked seating quad (inner-bottom → outer-top) textured with crowd.
    const a = new THREE.Vector3(xInner, yb, z0), b = new THREE.Vector3(xInner, yb, z1);
    const c = new THREE.Vector3(xOuter, yt, z0), d = new THREE.Vector3(xOuter, yt, z1);
    const zlen = Math.abs(z1 - z0);
    const seats = this.quad(a, b, d, c, this.crowdMat(Math.round(zlen / 4), 9));
    scene.add(seats);
    // Front wall below the seating.
    const wall = new THREE.Mesh(new THREE.BoxGeometry(0.8, yb, zlen),
      new THREE.MeshStandardMaterial({ color: 0x223a6a, roughness: 0.7, emissive: 0x0a1830, emissiveIntensity: 0.3 }));
    wall.position.set(xInner, yb / 2, (z0 + z1) / 2); scene.add(wall);
    // Simple roof lip along the top.
    const roof = new THREE.Mesh(new THREE.BoxGeometry(6, 0.8, zlen),
      new THREE.MeshStandardMaterial({ color: 0x39435a, roughness: 0.6, metalness: 0.3 }));
    roof.position.set(xOuter - 1, yt + 1.5, (z0 + z1) / 2); roof.rotation.z = tag === 'x+' ? 0.15 : -0.15; scene.add(roof);
  }

  private buildEndStand() {
    const scene = this.ctx.scene;
    const z0 = FINISH_Z - 10, z1 = FINISH_Z - 42;
    const yb = 3, yt = 38, xhalf = 52;
    const a = new THREE.Vector3(-xhalf, yb, z0), b = new THREE.Vector3(xhalf, yb, z0);
    const c = new THREE.Vector3(-xhalf, yt, z1), d = new THREE.Vector3(xhalf, yt, z1);
    scene.add(this.quad(a, b, d, c, this.crowdMat(26, 9)));
    // A giant LED screen high on the end stand.
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(30, 12),
      new THREE.MeshStandardMaterial({ map: this.ledTexture(), emissive: 0xffffff, emissiveIntensity: 0.8, emissiveMap: this.ledTexture(), color: 0x111111 }));
    screen.position.set(0, 24, z1 + 6); screen.rotation.x = 0.2; scene.add(screen);
    this.leds.push(screen);
  }

  private buildFlags() {
    const scene = this.ctx.scene;
    const cols = [0x4dc3ff, 0xff4da6, 0xffd23f, 0x7cf07c, 0xb06bff, 0xff7a3a];
    for (const s of [-1, 1]) {
      for (let z = START_Z + 6; z > FINISH_Z - 6; z -= 16) {
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 6, 6),
          new THREE.MeshStandardMaterial({ color: 0xdddddd, roughness: 0.5 }));
        pole.position.set(s * 47, 36, z); scene.add(pole);
        const flag = new THREE.Mesh(new THREE.PlaneGeometry(3, 1.8),
          new THREE.MeshStandardMaterial({ color: cols[Math.floor(Math.random() * cols.length)], roughness: 0.7, side: THREE.DoubleSide }));
        flag.position.set(s * (47 + 1.6), 38, z); scene.add(flag);
      }
    }
  }

  private buildFloodlight(x: number, z: number) {
    const scene = this.ctx.scene;
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.9, 46, 8),
      new THREE.MeshStandardMaterial({ color: 0x4a5464, roughness: 0.7, metalness: 0.4 }));
    pole.position.set(x, 23, z); scene.add(pole);
    const bank = new THREE.Mesh(new THREE.BoxGeometry(7, 4, 1),
      new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff2d0, emissiveIntensity: 0.9 }));
    bank.position.set(x, 46, z); bank.lookAt(0, 0, (START_Z + FINISH_Z) / 2); scene.add(bank);
  }

  private buildCauldron(x: number, z: number) {
    const scene = this.ctx.scene;
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 1.2, 10, 8),
      new THREE.MeshStandardMaterial({ color: 0xbfc6d0, roughness: 0.4, metalness: 0.6 }));
    stem.position.set(x, 5, z); scene.add(stem);
    const bowl = new THREE.Mesh(new THREE.CylinderGeometry(2.4, 1.2, 2.2, 12),
      new THREE.MeshStandardMaterial({ color: 0x8a6a3a, roughness: 0.5, metalness: 0.5 }));
    bowl.position.set(x, 11, z); scene.add(bowl);
    this.flame = new THREE.Mesh(new THREE.ConeGeometry(1.8, 4.5, 10),
      new THREE.MeshBasicMaterial({ color: 0xff8a1e }));
    this.flame.position.set(x, 14, z); scene.add(this.flame);
    this.flameLight = new THREE.PointLight(0xff9030, 1.6, 60);
    this.flameLight.position.set(x, 15, z); scene.add(this.flameLight);
  }

  // --- geometry / texture helpers --------------------------------------------
  private quad(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3, mat: THREE.Material): THREE.Mesh {
    // Two triangles a-b-c, a-c-d with a full 0..1 UV so the material's repeat tiles.
    const pos = new Float32Array([a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z, d.x, d.y, d.z]);
    const uv = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    geo.computeVertexNormals();
    const m = new THREE.Mesh(geo, mat); m.receiveShadow = true; return m;
  }

  private crowdCanvas(): HTMLCanvasElement {
    const c = document.createElement('canvas'); c.width = 128; c.height = 128;
    const x = c.getContext('2d')!;
    x.fillStyle = '#333a54'; x.fillRect(0, 0, 128, 128);
    const pal = ['#ff5a5a', '#4dc3ff', '#ffd23f', '#7cf07c', '#b06bff', '#ff7a3a', '#ffffff', '#f0c8a0', '#c98a5a', '#7a8ad0'];
    for (let row = 0; row < 16; row++) {
      for (let i = 0; i < 34; i++) {
        x.fillStyle = pal[(Math.random() * pal.length) | 0];
        const px = Math.random() * 128, py = row * 8 + 4 + (Math.random() - 0.5) * 3;
        x.beginPath(); x.arc(px, py, 2.1, 0, Math.PI * 2); x.fill();
      }
    }
    return c;
  }

  private crowdMat(nx: number, ny: number): THREE.MeshStandardMaterial {
    const tex = new THREE.CanvasTexture(this.crowdCanvas());
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(Math.max(1, nx), Math.max(1, ny));
    // Self-lit a touch so the far (shadowed) stands stay colourful, not murky.
    return new THREE.MeshStandardMaterial({ map: tex, emissiveMap: tex, emissive: 0xffffff, emissiveIntensity: 0.4, roughness: 1, side: THREE.DoubleSide });
  }

  private decalMat(txt: string): THREE.MeshBasicMaterial {
    const c = document.createElement('canvas'); c.width = 512; c.height = 160;
    const x = c.getContext('2d')!;
    x.font = '900 120px Bungee, system-ui, sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillStyle = 'rgba(255,255,255,0.8)'; x.fillText(txt, 256, 88);
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
    return new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false });
  }

  private adTexture(): THREE.CanvasTexture {
    const c = document.createElement('canvas'); c.width = 512; c.height = 128;
    const x = c.getContext('2d')!;
    x.fillStyle = '#1f3f8a'; x.fillRect(0, 0, 512, 128);
    x.fillStyle = '#ffd23f'; x.font = '900 66px Bungee, system-ui, sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillText('BASH ARENA', 256, 68);
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    return tex;
  }
  private adMap(tex: THREE.CanvasTexture, len: number): THREE.CanvasTexture {
    const t = tex.clone(); t.needsUpdate = true; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(Math.max(1, Math.round(len / 18)), 1); return t;
  }

  private ledTexture(): THREE.CanvasTexture {
    const c = document.createElement('canvas'); c.width = 256; c.height = 128;
    const x = c.getContext('2d')!;
    const grd = x.createLinearGradient(0, 0, 256, 128);
    grd.addColorStop(0, '#1636a0'); grd.addColorStop(1, '#3a1a7a');
    x.fillStyle = grd; x.fillRect(0, 0, 256, 128);
    x.fillStyle = '#ffd23f'; x.font = '900 40px Bungee, system-ui, sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillText('BASH', 128, 48); x.fillText('ARENA', 128, 92);
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; return tex;
  }

  private textSprite(txt: string, fill: string, px: number): THREE.Sprite {
    const c = document.createElement('canvas'); c.width = 512; c.height = 160;
    const x = c.getContext('2d')!;
    x.font = `900 ${px}px Bungee, system-ui, sans-serif`; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.lineWidth = 10; x.strokeStyle = '#12142e'; x.strokeText(txt, 256, 84);
    x.fillStyle = fill; x.fillText(txt, 256, 84);
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
    sp.scale.set(8, 2.5, 1); return sp;
  }

  // --- HUD --------------------------------------------------------------------
  private buildUI() {
    document.getElementById('spUI')?.remove();
    const ui = document.createElement('div');
    ui.id = 'spUI';
    ui.style.cssText = 'position:fixed;inset:0;z-index:8;pointer-events:none;font-family:Bungee,system-ui,sans-serif;';
    // Progress panel (top-left) + timer (top-centre).
    let rowsHtml = '';
    const cols = ['#4DC3FF', '#ff7a3a', '#b06bff', '#ff4da6'];
    for (let i = 0; i < 4; i++) {
      rowsHtml += `<div class="sprow" data-i="${i}" style="display:flex;align-items:center;gap:6px;margin:3px 0;opacity:.96;">
        <span style="width:16px;text-align:center;color:#fff;font-size:12px;">${i + 1}</span>
        <div style="position:relative;width:120px;height:13px;background:rgba(10,18,40,.6);border-radius:7px;overflow:hidden;border:1px solid rgba(255,255,255,.25);">
          <div class="fill" style="position:absolute;left:0;top:0;bottom:0;width:0%;background:${cols[i]};"></div>
        </div>
        <span class="rk" style="width:34px;color:#fff;font-size:12px;">–</span></div>`;
    }
    ui.innerHTML = `
      <div style="position:fixed;top:60px;left:14px;background:rgba(10,18,40,.42);padding:8px 10px;border-radius:12px;">
        <div style="color:#FFD23F;font-size:11px;margin-bottom:3px;">🏁 100 M SPRINT</div>${rowsHtml}</div>
      <div id="spTimer" style="position:fixed;top:58px;left:50%;transform:translateX(-50%);color:#fff;font-size:30px;
        text-shadow:0 3px 0 rgba(0,0,0,.5);letter-spacing:1px;">00:00.00</div>
      <button id="spDash" data-nostick style="pointer-events:auto;position:fixed;left:22px;bottom:30px;">💨<br>DASH</button>
      <button id="spPunch" data-nostick style="pointer-events:auto;position:fixed;right:182px;bottom:30px;">👊<br>PUNCH</button>
      <button id="spRun" data-nostick style="pointer-events:auto;position:fixed;right:22px;bottom:22px;">🏃<br>RUN</button>`;
    document.body.appendChild(ui);
    this.root = ui;
    this.timerEl = ui.querySelector('#spTimer')!;
    this.rows = Array.from(ui.querySelectorAll('.sprow')).map((row) => ({
      row: row as HTMLElement,
      fill: row.querySelector('.fill') as HTMLElement,
      rank: row.querySelector('.rk') as HTMLElement,
    }));
    // Mark the local player's row.
    this.rows[0].row.style.outline = '2px solid #FFD23F'; this.rows[0].row.style.borderRadius = '8px';
    this.rows[0].rank.textContent = 'YOU';

    const round = 'font-family:Bungee,system-ui,sans-serif;border:none;color:#12142e;cursor:pointer;box-shadow:0 6px 0 rgba(0,0,0,.35);touch-action:none;user-select:none;text-align:center;line-height:1.05;border-radius:50%;';
    this.runBtn = ui.querySelector('#spRun')!;
    this.punchBtn = ui.querySelector('#spPunch')!;
    this.dashBtn = ui.querySelector('#spDash')!;
    this.runBtn.style.cssText += round + 'width:132px;height:132px;font-size:22px;background:#3bd45a;color:#08320f;';
    this.punchBtn.style.cssText += round + 'width:104px;height:104px;font-size:17px;background:#ff4d4d;color:#3a0808;';
    this.dashBtn.style.cssText += round + 'width:98px;height:98px;font-size:16px;background:#FFD23F;';
    this.runBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); this.runTap(0); });
    this.punchBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); this.punch(0); });
    this.dashBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); this.dash(0); });
  }

  private updateUI() {
    // Timer mm:ss.cc counting up.
    const t = this.raceT;
    const m = Math.floor(t / 60), s = Math.floor(t % 60), cs = Math.floor((t * 100) % 100);
    if (this.timerEl) this.timerEl.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
    // Live ranking by distance covered (finished players keep their place).
    const order = [...this.ctx.players].sort((a, b) => {
      const sa = this.place[a.index] ? 1000 - this.place[a.index] : (START_Z - a.z) / RACE_LEN;
      const sb = this.place[b.index] ? 1000 - this.place[b.index] : (START_Z - b.z) / RACE_LEN;
      return sb - sa;
    });
    const rankOf: number[] = [];
    order.forEach((p, r) => { rankOf[p.index] = r + 1; });
    const medal = ['🥇', '🥈', '🥉', '4th'];
    for (let i = 0; i < 4; i++) {
      const r = this.rows[i]; if (!r) continue;
      const frac = Math.max(0, Math.min(1, (START_Z - this.ctx.players[i].z) / RACE_LEN));
      r.fill.style.width = (frac * 100) + '%';
      const label = this.place[i] ? medal[this.place[i] - 1] : medal[rankOf[i] - 1];
      r.rank.textContent = i === 0 ? `${label} YOU` : label;
    }
    // Cooldown dimming.
    if (this.dashBtn) this.dashBtn.style.opacity = this.ctx.players[0].dashCd > 0 ? '0.45' : '1';
    if (this.punchBtn) this.punchBtn.style.opacity = this.punchCd[0] > 0 ? '0.45' : '1';
  }

  // --- results ----------------------------------------------------------------
  private doFinish() {
    if (this.finished) return;
    this.finished = true;
    this.root?.remove();
    const ctx = this.ctx;
    // Anyone who never crossed is ranked behind finishers by distance.
    const running = ctx.players.filter((p) => this.place[p.index] === 0)
      .sort((a, b) => a.z - b.z);
    running.forEach((p) => { this.place[p.index] = ++this.finishCount; });
    const medal = ['🥇 1st', '🥈 2nd', '🥉 3rd', '4th'];
    ctx.players.forEach((p) => {
      const pl = this.place[p.index];
      const time = this.finishTime[p.index];
      (p as any)._res = time > 0 ? `${medal[pl - 1]} · ${time.toFixed(2)}s` : `${medal[pl - 1]} · ${Math.round(START_Z - p.z)}m`;
    });
    const winner = ctx.players.find((p) => this.place[p.index] === 1)!;
    if (winner.you) { SFX.win(); ctx.fx.banner('🥇 GOLD MEDAL!', '#FFD23F'); }
    else { SFX.lose(); ctx.fx.banner(`🏅 ${winner.hero.name} takes gold`, '#4DC3FF'); }
    ctx.finish(rankBy(ctx, (p) => 1000 - this.place[p.index]), winner.you ? 'You win the 100 m dash!' : `${winner.hero.name} wins the 100 m dash.`);
  }
}
