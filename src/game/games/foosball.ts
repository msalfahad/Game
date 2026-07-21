import * as THREE from 'three';
import type { Player } from '../player';
import { HITBOX_RADIUS } from '../player';
import type { GameModule, MatchContext } from '../context';
import { setupRoster, tickRoster, rankBy } from '../freeroam';
import { matchTime } from '../../core/tuning';
import { SFX } from '../../core/audio';
import { setScore, setObjective } from '../../ui/hud';

// FOOT BRAWL (Wildwood tier 4). A simple, chunky, zoomed-in 2v2 table-football
// (Mario-Party ice-hockey feel). BLUE (left) vs RED (right); an ATTACKER + a
// DEFENDER per team slide up/down their rails and whack a fast ball into the
// rival goal. Two team abilities that reward playing together:
//   • SMASH — a cannon shot (needs the ball, 3s), stuns the first blocker.
//   • WIDEN — opens the ENEMY goal wide for a few seconds (no ball, 6s) so a
//     team-mate can slam one in. First team to 3 goals in a 1-minute match.

const BALL_R = 1.1;
const BALL_SPEED = 20;        // calmer, controllable ball
const BALL_MAX = 34;
const SMASH_V = 42;
const MOVE_SPEED = 22;        // steady side-to-side
const WIN_GOALS = 3;
const SMASH_CD = 3;           // reliable — one smash every 3s
const STUN_TIME = 1.2;
const WIDEN_CD = 6;           // open the enemy goal every 6s
const WIDEN_TIME = 3.5;       // how long it stays open
const WIDEN_MUL = 1.8;        // how much wider
const MATCH_SECS = 60;        // 1-minute match

export class FoosballGame implements GameModule {
  readonly stickMode = 'float' as const;
  title = 'Foot Brawl';
  objective = '⚽ Slide up/down · SMASH on the ball · WIDEN the enemy goal — first to 3!';

  private ctx!: MatchContext;
  private finished = false;
  private timeLeft = MATCH_SECS;
  private X = 20; private Z = 12; private goalHalf = 5;

  private railX: number[] = [];
  private ball!: THREE.Mesh;
  private bx = 0; private bz = 0; private bvx = 0; private bvz = 0;
  private score = [0, 0];            // [blue, red]
  private resetT = 1.4;
  private smashCd = [0, 0, 0, 0];    // per-player smash cooldown
  private widenCd = [0, 0, 0, 0];    // per-player widen cooldown
  private stunT = [0, 0, 0, 0];      // per-player dizzy timer
  private widenT = [0, 0];           // per-goal "wide open" timer (0=left, 1=right)
  private goalGroups: THREE.Group[] = [];
  private dots: THREE.Mesh[] = [];   // tiny team marker under each hero
  private hitFx = 0;

  private smashBtn!: HTMLButtonElement;
  private widenBtn!: HTMLButtonElement;
  private blueEl!: HTMLElement; private redEl!: HTMLElement;

  init(ctx: MatchContext) {
    this.ctx = ctx;
    this.title = ctx.game.name;
    this.finished = false;
    this.timeLeft = matchTime(MATCH_SECS);
    ctx.scene.fog = null;
    ctx.scene.add(new THREE.AmbientLight(0xffffff, 0.6));
    ctx.scene.add(new THREE.HemisphereLight(0xffe8c8, 0x3a5a3a, 0.5));
    // Designed sunset-stadium sky instead of a black backdrop.
    ctx.scene.background = this.skyTexture();
    // A small pitch (in world units) with BIG goals — the heroes look chunky
    // and scoring is easy. Goals sit on the left/right ends.
    this.X = ctx.halfSize * 0.52; this.Z = ctx.halfSize * 0.42; this.goalHalf = this.Z * 0.44;
    this.score = [0, 0]; this.resetT = 1.6;
    this.smashCd = [0, 0, 0, 0]; this.widenCd = [0, 0, 0, 0]; this.stunT = [0, 0, 0, 0]; this.widenT = [0, 0];

    // Rails: attacker mid-field, defender back near their own goal.
    this.railX = [-this.X * 0.34, -this.X * 0.80, this.X * 0.34, this.X * 0.80];

    this.buildPitch();
    this.buildStadiumFrame();
    setupRoster(ctx, '', 0.5);
    this.buildDots();

    ctx.players.forEach((p) => {
      const blue = p.index < 2;
      p.x = this.railX[p.index]; p.z = (p.index % 2 === 0 ? -1 : 1) * this.Z * 0.28;
      p.vx = 0; p.vz = 0; p.dead = false;
      // Angle toward the camera so we see the heroes' fronts (turned a touch
      // toward the goal they attack).
      p.standFacing = blue ? 0.5 : -0.5;
      // The character body IS the hitbox — hide the big marker rings.
      if (p.ring) p.ring.visible = false;
      if (p.glow) p.glow.visible = false;
      setScore(p, blue ? '🔵' : '🔴');
    });

    this.ball = new THREE.Mesh(new THREE.SphereGeometry(BALL_R, 18, 14),
      new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5 }));
    const spot = new THREE.Mesh(new THREE.SphereGeometry(BALL_R * 0.42, 8, 8), new THREE.MeshStandardMaterial({ color: 0x111111 }));
    spot.position.set(0.4, 0.4, 0.3); this.ball.add(spot);
    this.ball.castShadow = true; ctx.scene.add(this.ball);
    this.bx = 0; this.bz = 0; this.bvx = 0; this.bvz = 0;

    // Angled 3/4 "stadium" view so the heroes read as standing figures.
    ctx.camera.frameAngled(this.X + 4, this.Z + 5);

    this.buildUI();
    setObjective(this.objective);
    ctx.fx.banner('⚽ FOOT BRAWL — FIRST TO 3!', '#7CF07C');
  }

  private teamOf(p: Player): number { return p.index < 2 ? 0 : 1; }
  private enemyGoalSide(team: number): number { return team === 0 ? 1 : 0; }
  private effGoalHalf(side: number): number { return this.goalHalf * (this.widenT[side] > 0 ? WIDEN_MUL : 1); }

  // --- pitch ------------------------------------------------------------------
  private buildPitch() {
    const scene = this.ctx.scene, X = this.X, Z = this.Z;
    const stripes = 10;
    for (let i = 0; i < stripes; i++) {
      const w = (X * 2) / stripes;
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, Z * 2),
        new THREE.MeshStandardMaterial({ color: i % 2 ? 0x3f8a3a : 0x357a32, roughness: 1 }));
      m.rotation.x = -Math.PI / 2; m.position.set(-X + w * (i + 0.5), 0.02, 0); m.receiveShadow = true; scene.add(m);
    }
    const line = (x: number, z: number, w: number, d: number) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, 0.08, d), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6 }));
      m.position.set(x, 0.1, z); scene.add(m);
    };
    line(0, 0, 0.5, Z * 2);                       // halfway line
    line(-X + 0.4, 0, 0.5, Z * 2); line(X - 0.4, 0, 0.5, Z * 2);
    line(0, Z - 0.4, X * 2, 0.5); line(0, -Z + 0.4, X * 2, 0.5);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(Z * 0.34, 0.22, 6, 40), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6 }));
    ring.rotation.x = -Math.PI / 2; ring.position.y = 0.1; scene.add(ring);
    for (const sx of [-1, 1]) {
      line(sx * (X - 6), Z * 0.5, 0.5, Z); line(sx * (X - 6), -Z * 0.5, 0.5, Z);
      line(sx * (X - 3), Z * 0.55, 6, 0.5); line(sx * (X - 3), -Z * 0.55, 6, 0.5);
    }

    // Boards around the pitch (ball bounces off), goal-coloured on the ends.
    const board = (x: number, z: number, w: number, d: number, col: number) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, 2.2, d), new THREE.MeshStandardMaterial({ color: col, roughness: 0.7, emissive: (col & 0xfefefe) >> 1, emissiveIntensity: 0.15 }));
      m.position.set(x, 1.1, z); m.castShadow = true; scene.add(m);
    };
    board(0, Z + 0.6, X * 2 + 2, 1.2, 0xece8d8); board(0, -Z - 0.6, X * 2 + 2, 1.2, 0xece8d8);
    const seg = (Z - this.goalHalf) / 2;
    for (const [sx, col] of [[-1, 0x2f6bd8], [1, 0xd8452f]] as const) {
      board(sx * (X + 0.6), (this.goalHalf + seg), 1.2, seg * 2, col);
      board(sx * (X + 0.6), -(this.goalHalf + seg), 1.2, seg * 2, col);
      this.buildGoal(sx, col);
    }

    // Coloured rails + up/down arrowheads (like the reference art).
    [-1, -1, 1, 1].forEach((s, i) => {
      const col = s < 0 ? 0x2f6bd8 : 0xd8452f;
      const rail = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.06, Z * 2 - 2),
        new THREE.MeshStandardMaterial({ color: col, emissive: s < 0 ? 0x123a7a : 0x7a1a12, emissiveIntensity: 0.5, roughness: 0.5 }));
      rail.position.set(this.railX[i], 0.12, 0); scene.add(rail);
      const arrowMat = new THREE.MeshStandardMaterial({ color: col, emissive: col, emissiveIntensity: 0.5, roughness: 0.5 });
      for (const sz of [-1, 1]) {
        const arrow = new THREE.Mesh(new THREE.ConeGeometry(1.0, 1.6, 4), arrowMat);
        arrow.rotation.x = sz < 0 ? Math.PI / 2 : -Math.PI / 2;
        arrow.position.set(this.railX[i], 0.2, sz * (Z - 2.2)); scene.add(arrow);
      }
    });
  }

  private buildGoal(sx: number, col: number) {
    const X = this.X, gh = this.goalHalf;
    const g = new THREE.Group();               // scaled in z when the goal is "widened"
    const mat = new THREE.MeshStandardMaterial({ color: col, roughness: 0.4, metalness: 0.2, emissive: (col & 0xfefefe) >> 2, emissiveIntensity: 0.5 });
    const depth = 4.5, postR = 0.45, H = 3.6;
    for (const sz of [-gh, gh]) { const post = new THREE.Mesh(new THREE.CylinderGeometry(postR, postR, H, 10), mat); post.position.set(sx * (X + 0.2), H / 2, sz); g.add(post); }
    const bar = new THREE.Mesh(new THREE.CylinderGeometry(postR, postR, gh * 2, 10), mat); bar.rotation.x = Math.PI / 2; bar.position.set(sx * (X + 0.2), H, 0); g.add(bar);
    for (const sz of [-gh, gh]) { const bp = new THREE.Mesh(new THREE.CylinderGeometry(postR, postR, H, 10), mat); bp.position.set(sx * (X + depth), H / 2, sz); g.add(bp); }
    const netMat = new THREE.MeshBasicMaterial({ color: 0xffffff, wireframe: true, transparent: true, opacity: 0.5 });
    const back = new THREE.Mesh(new THREE.PlaneGeometry(gh * 2, H, 6, 4), netMat); back.rotation.y = Math.PI / 2; back.position.set(sx * (X + depth), H / 2, 0); g.add(back);
    const top = new THREE.Mesh(new THREE.PlaneGeometry(depth, gh * 2, 4, 6), netMat); top.rotation.x = -Math.PI / 2; top.position.set(sx * (X + depth / 2 + 0.1), H, 0); g.add(top);
    for (const sz of [-gh, gh]) { const side = new THREE.Mesh(new THREE.PlaneGeometry(depth, H, 4, 4), netMat); side.position.set(sx * (X + depth / 2 + 0.1), H / 2, sz); g.add(side); }
    // Glowing goal-mouth on the floor (grows when the goal is widened).
    const mouth = new THREE.Mesh(new THREE.PlaneGeometry(3.0, gh * 2),
      new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.5, side: THREE.DoubleSide }));
    mouth.rotation.x = -Math.PI / 2; mouth.position.set(sx * (X - 1.5), 0.13, 0); g.add(mouth);
    this.ctx.scene.add(g);
    this.goalGroups[sx < 0 ? 0 : 1] = g;
  }

  // OPEN stadium: no enclosing walls — just two rows of cheering fans on a low
  // riser above and below the pitch (goal ends stay clear), plus corner flags.
  private buildStadiumFrame() {
    const scene = this.ctx.scene, X = this.X, Z = this.Z;
    const spanX = X * 2 + 8, oz = Z + 1.4;
    for (const sz of [-1, 1]) {
      // Low riser the fans stand on.
      const riser = new THREE.Mesh(new THREE.BoxGeometry(spanX, 1.4, 4.5),
        new THREE.MeshStandardMaterial({ color: 0x394055, roughness: 1 }));
      riser.position.set(0, 0.7, sz * (oz + 2.6)); scene.add(riser);
      this.buildFans(sz, spanX, oz);
    }
    // Painted backdrop behind the far side: sunset sky + distant stands +
    // floodlights, so the background is a designed theme (not a flat void).
    const back = new THREE.Mesh(new THREE.PlaneGeometry(340, 130),
      new THREE.MeshBasicMaterial({ map: this.backdropTexture(), depthWrite: false }));
    back.position.set(0, 30, -(Z + 30)); scene.add(back);
    // Corner flags (blue left, red right) — a touch of stadium flavour.
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const px = sx * (X + 2.5), pz = sz * (oz + 1);
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 5, 6), new THREE.MeshStandardMaterial({ color: 0xdddddd, roughness: 0.5 }));
      pole.position.set(px, 2.5, pz); scene.add(pole);
      const teamCol = sx < 0 ? 0x2f6bd8 : 0xd8452f;
      const flag = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 1.5),
        new THREE.MeshStandardMaterial({ color: teamCol, emissive: teamCol, emissiveIntensity: 0.4, roughness: 0.7, side: THREE.DoubleSide }));
      flag.position.set(px + 1.3, 4.2, pz); scene.add(flag);
    }
  }

  // Two rows of instanced spectators on one long side (coloured body + head),
  // facing the pitch to cheer.
  private buildFans(sz: number, spanX: number, innerZ: number) {
    const scene = this.ctx.scene;
    const rows = 2, cols = Math.max(12, Math.round(spanX / 2.2));
    const n = rows * cols;
    const bodyGeo = new THREE.CapsuleGeometry(0.55, 1.1, 3, 6);
    const headGeo = new THREE.SphereGeometry(0.46, 6, 6);
    const bodies = new THREE.InstancedMesh(bodyGeo, new THREE.MeshStandardMaterial({ roughness: 0.9 }), n);
    const heads = new THREE.InstancedMesh(headGeo, new THREE.MeshStandardMaterial({ roughness: 0.9 }), n);
    bodies.castShadow = false; heads.castShadow = false;
    const cloth = ['#ff5a5a', '#4dc3ff', '#ffd23f', '#7cf07c', '#b06bff', '#ff7a3a', '#ffffff', '#2f6bd8', '#e8e8e8', '#d84550'];
    const skin = ['#f2cda2', '#d9a06a', '#a06a40', '#ffe0b8', '#8a5a34'];
    const m = new THREE.Matrix4(); const col = new THREE.Color();
    let k = 0;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x = -spanX / 2 + (c + 0.5) * (spanX / cols) + (Math.random() - 0.5) * 0.6;
        const z = sz * (innerZ + 1.6 + r * 2.4);
        const y = 1.4 + r * 1.2;
        const s = 0.9 + Math.random() * 0.35;
        m.makeScale(s, s, s); m.setPosition(x, y, z);
        bodies.setMatrixAt(k, m); bodies.setColorAt(k, col.set(cloth[(Math.random() * cloth.length) | 0]));
        m.setPosition(x, y + 1.15 * s, z);
        heads.setMatrixAt(k, m); heads.setColorAt(k, col.set(skin[(Math.random() * skin.length) | 0]));
        k++;
      }
    }
    bodies.instanceMatrix.needsUpdate = true; heads.instanceMatrix.needsUpdate = true;
    scene.add(bodies); scene.add(heads);
  }

  // Designed sunset-stadium sky (vertical gradient) — no more black backdrop.
  private skyTexture(): THREE.CanvasTexture {
    const c = document.createElement('canvas'); c.width = 16; c.height = 256;
    const x = c.getContext('2d')!;
    const g = x.createLinearGradient(0, 0, 0, 256);
    g.addColorStop(0.0, '#243a7a');   // deep sky
    g.addColorStop(0.45, '#5a6bb0');
    g.addColorStop(0.72, '#d98a6a');  // warm haze
    g.addColorStop(1.0, '#f0b070');   // horizon glow
    x.fillStyle = g; x.fillRect(0, 0, 16, 256);
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  // A painted stadium backdrop: sunset sky, a distant crowd stand, and a few
  // floodlight pylons.
  private backdropTexture(): THREE.CanvasTexture {
    const c = document.createElement('canvas'); c.width = 1024; c.height = 384;
    const x = c.getContext('2d')!;
    const g = x.createLinearGradient(0, 0, 0, 384);
    g.addColorStop(0.0, '#213a80'); g.addColorStop(0.4, '#5a6bb4'); g.addColorStop(0.68, '#e0906a'); g.addColorStop(0.82, '#ffb56a');
    x.fillStyle = g; x.fillRect(0, 0, 1024, 384);
    // Distant tiered stand across the bottom (kept low so the sky shows above).
    const standTop = 286;
    x.fillStyle = '#2a3350'; x.fillRect(0, standTop, 1024, 384 - standTop);
    for (let row = 0; row < 3; row++) {
      const y = standTop + 14 + row * 24;
      x.fillStyle = row % 2 ? '#333c5c' : '#2c3452'; x.fillRect(0, y - 8, 1024, 18);
      for (let i = 0; i < 150; i++) {
        x.fillStyle = ['#ff5a5a', '#4dc3ff', '#ffd23f', '#7cf07c', '#ffffff', '#ff7a3a', '#b06bff'][(Math.random() * 7) | 0];
        x.beginPath(); x.arc(Math.random() * 1024, y + (Math.random() - 0.5) * 8, 2.4, 0, Math.PI * 2); x.fill();
      }
    }
    // Floodlight pylons with glowing banks.
    for (const px of [120, 380, 640, 900]) {
      x.strokeStyle = '#20263a'; x.lineWidth = 6; x.beginPath(); x.moveTo(px, standTop); x.lineTo(px, 70); x.stroke();
      x.fillStyle = '#fff6d8'; x.fillRect(px - 34, 48, 68, 26);
      x.fillStyle = 'rgba(255,246,200,0.35)'; x.beginPath(); x.arc(px, 61, 40, 0, Math.PI * 2); x.fill();
    }
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  private buildDots() {
    this.dots = this.ctx.players.map((p) => {
      const col = this.teamOf(p) === 0 ? 0x2f6bd8 : 0xd8452f;
      const dot = new THREE.Mesh(new THREE.CylinderGeometry(1.0, 1.0, 0.3, 16),
        new THREE.MeshStandardMaterial({ color: col, emissive: col, emissiveIntensity: 0.7, roughness: 0.5 }));
      dot.position.set(this.railX[p.index], 0.14, p.z);
      this.ctx.scene.add(dot);
      return dot;
    });
  }

  // --- input ------------------------------------------------------------------
  ability() { this.doSmash(0); }
  jump() { this.doSmash(0); }

  private doSmash(i: number) {
    if (this.finished || this.resetT > 0 || this.stunT[i] > 0 || this.smashCd[i] > 0) return;
    const p = this.ctx.players[i];
    const d = Math.hypot(this.bx - p.x, this.bz - p.z);
    if (d >= HITBOX_RADIUS + BALL_R + 4) { if (i === 0) SFX.tick(); return; } // not on the ball → no cd spent
    this.smashCd[i] = SMASH_CD;
    const dir = this.teamOf(p) === 0 ? 1 : -1;
    const dz = this.bz - p.z, L = Math.hypot(dir * 7, dz) || 1;
    this.bx = p.x + dir * (HITBOX_RADIUS + BALL_R + 0.6);
    this.bvx = (dir * 7 / L) * SMASH_V; this.bvz = (dz / L) * SMASH_V;
    this.hitFx = 0.3;
    SFX.hit(); this.ctx.fx.burst(this.bx, this.bz, '#FFD23F', 18); this.ctx.fx.shake(1.6);
    if (i === 0) this.ctx.fx.banner('⚡ SMASH!', '#FFD23F');
    this.stunFirstInPath(i, dir);
  }

  private stunFirstInPath(shooter: number, dir: number) {
    let victim = -1, bestT = Infinity;
    for (const o of this.ctx.players) {
      if (o.index === shooter) continue;
      const ahead = (o.x - this.bx) * dir;
      if (ahead <= 0) continue;
      const t = (o.x - this.bx) / this.bvx;
      if (t <= 0) continue;
      const predZ = this.bz + this.bvz * t;
      if (Math.abs(o.z - predZ) > HITBOX_RADIUS + BALL_R + 1.5) continue;
      if (t < bestT) { bestT = t; victim = o.index; }
    }
    if (victim >= 0) this.applyStun(victim);
  }

  private applyStun(i: number) {
    const o = this.ctx.players[i];
    this.stunT[i] = STUN_TIME;
    o.setStatusIcon('🐦💫🐦', STUN_TIME);
    this.ctx.fx.burst(o.x, o.z, '#FFE23A', 12);
    if (i === 0) this.ctx.fx.banner('😵 DIZZY!', '#FFD23F');
  }

  // WIDEN — throw the ENEMY goal wide open for a few seconds so a team-mate can
  // score. No ball needed; 6s cooldown.
  private doWiden(i: number) {
    if (this.finished || this.resetT > 0 || this.stunT[i] > 0 || this.widenCd[i] > 0) return;
    this.widenCd[i] = WIDEN_CD;
    const side = this.enemyGoalSide(this.teamOf(this.ctx.players[i]));
    this.widenT[side] = WIDEN_TIME;
    const col = side === 1 ? '#ff4da6' : '#4DC3FF';
    this.ctx.fx.burst(side === 0 ? -this.X : this.X, 0, col, 18);
    SFX.power();
    if (i === 0) this.ctx.fx.banner('🥅 GOAL WIDE OPEN — shoot!', '#7CF07C');
  }

  // --- tick -------------------------------------------------------------------
  tick(dt: number, elapsed: number) {
    if (this.finished) return;
    const ctx = this.ctx;
    this.timeLeft -= dt; ctx.setClock(this.timeLeft);
    this.hitFx = Math.max(0, this.hitFx - dt);
    for (let i = 0; i < 4; i++) {
      this.smashCd[i] = Math.max(0, this.smashCd[i] - dt);
      this.widenCd[i] = Math.max(0, this.widenCd[i] - dt);
      if (this.stunT[i] > 0) {
        this.stunT[i] -= dt;
        ctx.players[i].group.rotation.y = (1 - Math.max(0, this.stunT[i]) / STUN_TIME) * Math.PI * 4;
        if (this.stunT[i] <= 0) ctx.players[i].group.rotation.y = 0;
      }
    }
    // Widen timers + goal scale animation.
    for (const side of [0, 1]) {
      this.widenT[side] = Math.max(0, this.widenT[side] - dt);
      const g = this.goalGroups[side];
      if (g) { const target = this.widenT[side] > 0 ? WIDEN_MUL : 1; g.scale.z += (target - g.scale.z) * Math.min(1, 8 * dt); }
    }

    if (this.resetT > 0) {
      this.resetT -= dt;
      if (this.resetT <= 0) this.kickoff();
    } else {
      this.moveLocal(dt);
      for (const p of ctx.players.slice(1)) this.moveBot(p, dt);
      this.tickBall(dt);
    }

    for (const p of ctx.players) {
      p.x = this.railX[p.index]; if (this.stunT[p.index] <= 0) p.standFacing = this.teamOf(p) === 0 ? 0.5 : -0.5;
      const dot = this.dots[p.index]; if (dot) dot.position.set(this.railX[p.index], 0.14, p.z);
    }
    this.ball.position.set(this.bx, BALL_R + 0.1, this.bz);
    this.ball.rotation.z -= this.bvx * dt * 0.4; this.ball.rotation.x += this.bvz * dt * 0.4;
    this.ball.scale.setScalar(1 + this.hitFx * 0.6);

    this.updateUI();
    tickRoster(ctx, dt, elapsed);

    if (this.score[0] >= WIN_GOALS) return this.doFinish(0, 'BLUE team wins the brawl!');
    if (this.score[1] >= WIN_GOALS) return this.doFinish(1, 'RED team wins the brawl!');
    if (this.timeLeft <= 0) return this.doFinish(this.score[0] >= this.score[1] ? 0 : 1, `Time! ${this.score[0] >= this.score[1] ? 'BLUE' : 'RED'} wins.`);
  }

  private moveLocal(dt: number) {
    const p = this.ctx.players[0];
    if (this.stunT[0] > 0) { p.vz = 0; return; }
    const ay = this.ctx.input.ay; // stick up → slide up (−z)
    p.z += ay * MOVE_SPEED * dt;
    p.vz = ay * MOVE_SPEED; p.vx = 0;
    p.z = Math.max(-this.Z + HITBOX_RADIUS, Math.min(this.Z - HITBOX_RADIUS, p.z));
  }

  private moveBot(p: Player, dt: number) {
    if (this.stunT[p.index] > 0) { p.vz = 0; return; }
    const lead = this.bz + this.bvz * 0.18;
    const err = (1 - this.ctx.diff.cap) * this.Z * 0.5 * (Math.random() - 0.5);
    const target = lead + err;
    const onMySide = this.teamOf(p) === 0 ? this.bx < 4 : this.bx > -4;
    // Bots move a bit slower than you, so you can out-slide them and score.
    const spd = MOVE_SPEED * (onMySide ? 0.9 : 0.6) * (0.55 + this.ctx.diff.cap * 0.35);
    const dz = target - p.z;
    p.z += Math.max(-spd * dt, Math.min(spd * dt, dz));
    p.vz = Math.sign(dz) * Math.min(Math.abs(dz) / dt, spd); p.vx = 0;
    p.z = Math.max(-this.Z + HITBOX_RADIUS, Math.min(this.Z - HITBOX_RADIUS, p.z));
    // Bot SMASH when it's on the ball.
    if (this.smashCd[p.index] <= 0 && Math.hypot(this.bx - p.x, this.bz - p.z) < HITBOX_RADIUS + BALL_R + 3 && Math.random() < (0.6 + this.ctx.diff.cap) * dt) {
      this.doSmash(p.index);
    }
    // Bot WIDEN when the ball is in the team's attacking half (help a team-mate).
    const attacking = this.teamOf(p) === 0 ? this.bx > 2 : this.bx < -2;
    if (this.widenCd[p.index] <= 0 && attacking && Math.random() < 0.5 * dt) this.doWiden(p.index);
  }

  private tickBall(dt: number) {
    this.bx += this.bvx * dt; this.bz += this.bvz * dt;
    if (this.bz > this.Z - BALL_R) { this.bz = this.Z - BALL_R; this.bvz = -Math.abs(this.bvz); SFX.tick(); }
    if (this.bz < -this.Z + BALL_R) { this.bz = -this.Z + BALL_R; this.bvz = Math.abs(this.bvz); SFX.tick(); }
    for (const sx of [-1, 1]) {
      if (sx < 0 ? this.bx < -this.X + BALL_R : this.bx > this.X - BALL_R) {
        const side = sx < 0 ? 0 : 1;
        if (Math.abs(this.bz) < this.effGoalHalf(side)) { this.onGoal(sx < 0 ? 1 : 0); return; }
        this.bx = sx < 0 ? -this.X + BALL_R : this.X - BALL_R; this.bvx = -this.bvx; SFX.bump();
      }
    }
    for (const p of this.ctx.players) {
      if (this.stunT[p.index] > 0) continue;                 // dizzy — can't block
      const dx = this.bx - p.x, dz = this.bz - p.z, d = Math.hypot(dx, dz), min = HITBOX_RADIUS + BALL_R;
      if (d < min && d > 0.001) {
        const nz = dz / d;
        const sp = Math.hypot(this.bvx, this.bvz);
        const dir = this.teamOf(p) === 0 ? 1 : -1;
        this.bx = p.x + dir * (min + 0.4);
        this.bz = p.z + nz * min;
        this.bvx = dir * Math.max(sp * 0.72, BALL_SPEED * 0.85);
        this.bvz = nz * sp * 0.6 + p.vz * 0.5;
        this.hitFx = 0.16; SFX.bump(); this.ctx.fx.burst(this.bx, this.bz, p.hero.col, 6);
      }
    }
    let sp = Math.hypot(this.bvx, this.bvz);
    if (sp < BALL_SPEED) { const k = BALL_SPEED / (sp || 1); this.bvx *= k; this.bvz *= k; }
    else if (sp > BALL_MAX) { const k = BALL_MAX / sp; this.bvx *= k; this.bvz *= k; }
  }

  private onGoal(scorer: number) {
    this.score[scorer]++;
    SFX.win(); this.ctx.fx.shake(2.4); this.ctx.fx.burst(this.bx, this.bz, scorer === 0 ? '#4DC3FF' : '#ff4da6', 26);
    this.ctx.fx.banner(scorer === 0 ? '🔵 BLUE GOAL!' : '🔴 RED GOAL!', scorer === 0 ? '#4DC3FF' : '#ff4da6');
    this.bx = 0; this.bz = 0; this.bvx = 0; this.bvz = 0;
    this.resetT = 1.4;
    this.widenT = [0, 0];
    this.ctx.players.forEach((p) => {
      p.z = (p.index % 2 === 0 ? -1 : 1) * this.Z * 0.28; p.vz = 0;
      this.stunT[p.index] = 0; p.group.rotation.y = 0; p.setStatusIcon(null);
    });
  }

  private kickoff() {
    const dir = Math.random() < 0.5 ? 1 : -1;
    this.bvx = dir * BALL_SPEED * 0.8; this.bvz = (Math.random() - 0.5) * BALL_SPEED * 0.6;
    this.ctx.fx.banner('GO! ⚽', '#FFD23F'); SFX.gem();
  }

  // --- HUD --------------------------------------------------------------------
  private buildUI() {
    document.getElementById('fbUI')?.remove();
    const ui = document.createElement('div');
    ui.id = 'fbUI';
    ui.style.cssText = 'position:fixed;inset:0;z-index:8;pointer-events:none;font-family:Bungee,system-ui,sans-serif;';
    const bar = (side: string, col: string, label: string) =>
      `<div id="fb${side}" style="position:fixed;top:66px;${side === 'Blue' ? 'left:16px' : 'right:16px'};background:${col};color:#fff;
        padding:6px 12px;border-radius:12px;font-size:14px;box-shadow:0 3px 0 rgba(0,0,0,.4);display:flex;gap:6px;align-items:center;">
        ${side === 'Blue' ? label + ' ' : ''}<span class="balls"></span>${side === 'Red' ? ' ' + label : ''}</div>`;
    ui.innerHTML = `
      ${bar('Blue', '#2f6bd8', 'BLUE')}
      ${bar('Red', '#d8452f', 'RED')}
      <button id="fbWiden" data-nostick style="pointer-events:auto;position:fixed;right:158px;bottom:30px;">🥅<br>WIDEN</button>
      <button id="fbSmash" data-nostick style="pointer-events:auto;position:fixed;right:18px;bottom:22px;">⚡<br>SMASH</button>`;
    document.body.appendChild(ui);
    const round = 'font-family:Bungee,system-ui,sans-serif;border:none;cursor:pointer;box-shadow:0 6px 0 rgba(0,0,0,.35);touch-action:none;user-select:none;text-align:center;line-height:1.05;border-radius:50%;';
    this.smashBtn = ui.querySelector('#fbSmash')!;
    this.widenBtn = ui.querySelector('#fbWiden')!;
    this.smashBtn.style.cssText += round + 'width:118px;height:118px;font-size:19px;color:#12142e;background:#FFD23F;';
    this.widenBtn.style.cssText += round + 'width:100px;height:100px;font-size:15px;color:#08320f;background:#3bd45a;';
    this.smashBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); this.doSmash(0); });
    this.widenBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); this.doWiden(0); });
    this.blueEl = ui.querySelector('#fbBlue .balls')!; this.redEl = ui.querySelector('#fbRed .balls')!;
  }

  private updateUI() {
    const balls = (n: number) => '⚽'.repeat(n) + '·'.repeat(Math.max(0, WIN_GOALS - n));
    if (this.blueEl) this.blueEl.textContent = balls(this.score[0]);
    if (this.redEl) this.redEl.textContent = balls(this.score[1]);
    if (this.smashBtn) {
      const cd = this.smashCd[0];
      this.smashBtn.style.opacity = cd > 0 ? '0.5' : '1';
      this.smashBtn.innerHTML = cd > 0 ? `⚡<br>${Math.ceil(cd)}s` : '⚡<br>SMASH';
    }
    if (this.widenBtn) {
      const cd = this.widenCd[0];
      this.widenBtn.style.opacity = cd > 0 ? '0.5' : '1';
      this.widenBtn.innerHTML = cd > 0 ? `🥅<br>${Math.ceil(cd)}s` : '🥅<br>WIDEN';
    }
  }

  private doFinish(winTeam: number, sub: string) {
    if (this.finished) return;
    this.finished = true;
    document.getElementById('fbUI')?.remove();
    this.ctx.scene.remove(this.ball);
    const ctx = this.ctx;
    ctx.players.forEach((p) => { (p as any)._res = this.teamOf(p) === winTeam ? `🏆 ${this.score[winTeam]}–${this.score[1 - winTeam]}` : `${this.score[this.teamOf(p)]} goals`; });
    if (winTeam === 0) { this.ctx.fx.banner('🔵 BLUE WINS!', '#4DC3FF'); } else { this.ctx.fx.banner('🔴 RED WINS!', '#ff4da6'); }
    ctx.finish(rankBy(ctx, (p) => this.teamOf(p) === winTeam ? 1e6 : 0), sub);
  }
}
